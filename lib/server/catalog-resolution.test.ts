import assert from "node:assert/strict";
import test from "node:test";
import { parseConnectorCandidate, parseSpotifyOEmbedSource, stableRecordingIdentity, titleOnlyReviewCandidates } from "./catalog-resolution.ts";
import {
  backfillPreviewProviderMatches,
  backfillProviderMatch,
  loadProviderMatches,
  MAX_PREVIEW_BACKFILLS_PER_REQUEST,
  persistCanonicalRecordingMatches,
  providerCorrectionAuthority,
  ProviderMatchConflictError,
  ProviderMatchReviewRequiredError,
} from "./provider-match.ts";

type CanonicalFixture = {
  recording_id: string;
  isrc: string | null;
  normalized_title: string;
  normalized_artist: string;
  album: string | null;
  duration_ms: number | null;
  explicit: number | null;
  version_label: string | null;
};

function backfillDatabase(canonical: CanonicalFixture) {
  const writes: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        sql,
        get bindings() { return bindings; },
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first() {
          if (sql.includes("FROM provider_matches")) return null;
          if (sql.includes("FROM canonical_recordings")) return canonical;
          return null;
        },
        async run() { writes.push(bindings); return { success: true }; },
      };
      return statement;
    },
    async batch(statements: Array<{ sql: string; bindings: unknown[] }>) {
      for (const statement of statements) {
        if (statement.sql.includes("INSERT INTO provider_matches")) writes.push(statement.bindings);
      }
      return statements.map(() => ({ success: true, results: [] }));
    },
  } as unknown as D1Database;
  return { db, writes };
}

function connectorRuntime(candidates: unknown[], requests: Array<{ path: string; body: Record<string, unknown> }>) {
  return {
    DB: {} as D1Database,
    CONNECTOR_SERVICE_TOKEN: "test-service-token",
    CONNECTORS: {
      async fetch(request: Request) {
        requests.push({ path: new URL(request.url).pathname, body: await request.json() as Record<string, unknown> });
        return Response.json({ data: candidates, error: null, requestId: "req_catalog" });
      },
    } as Fetcher,
  } as unknown as Parameters<typeof backfillProviderMatch>[0]["runtime"];
}

test("connector candidates are validated before entering the canonical catalog", () => {
  assert.equal(parseConnectorCandidate({ provider: "spotify", providerRecordingId: "track", title: "Song", artists: [] }, "spotify"), null);
  assert.equal(parseConnectorCandidate({ provider: "apple_music", providerRecordingId: "1", title: "Song", artists: ["Artist"] }, "spotify"), null);
  assert.deepEqual(parseConnectorCandidate({
    provider: "spotify", providerRecordingId: "track", title: " Song ", artists: [" Artist "], storefronts: ["US"], version: "live",
  }, "spotify"), {
    provider: "spotify", providerRecordingId: "track", title: "Song", artists: ["Artist"], storefronts: ["US"], version: "live",
  });
});

test("Spotify oEmbed source metadata is incomplete and bound to the requested track", () => {
  assert.deepEqual(parseSpotifyOEmbedSource({
    provider: "spotify",
    providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC",
    title: " Fixture Song ",
    metadataComplete: false,
  }, "4uLU6hMCjMI75M1A2tKUQC"), {
    provider: "spotify",
    providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC",
    title: "Fixture Song",
    metadataComplete: false,
  });
  assert.equal(parseSpotifyOEmbedSource({
    provider: "spotify",
    providerRecordingId: "different-track",
    title: "Fixture Song",
    metadataComplete: false,
  }, "4uLU6hMCjMI75M1A2tKUQC"), null);
  assert.equal(parseSpotifyOEmbedSource({
    provider: "spotify",
    providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC",
    title: "Fixture Song",
    metadataComplete: true,
  }, "4uLU6hMCjMI75M1A2tKUQC"), null);
});

test("ISRC creates one deterministic recording identity across providers", async () => {
  const spotify = await stableRecordingIdentity({ provider: "spotify", providerRecordingId: "track", title: "Song", artists: ["Artist"], isrc: "US-ABC-12-34567" });
  const apple = await stableRecordingIdentity({ provider: "apple_music", providerRecordingId: "123", title: "Song", artists: ["Artist"], isrc: "usabc1234567" });
  assert.equal(spotify.recordingId, apple.recordingId);
  assert.notEqual(spotify.matchId, apple.matchId);
});

test("title-only Spotify metadata yields bounded manual Apple Music choices without admitting unavailable candidates", () => {
  const choices = titleOnlyReviewCandidates("Never Gonna Give You Up", "apple_music", [
    { provider: "apple_music", providerRecordingId: "3", title: "Never Gonna Give You Up (Live)", artists: ["Artist"], storefronts: ["US"] },
    { provider: "apple_music", providerRecordingId: "1", title: "Never Gonna Give You Up", artists: ["Artist"], storefronts: ["US"] },
    { provider: "apple_music", providerRecordingId: "2", title: "Never Gonna Give You Up", artists: ["Other"], storefronts: ["US"] },
    { provider: "apple_music", providerRecordingId: "4", title: "Never Gonna Give You Up", artists: ["Unavailable"], storefronts: ["GB"] },
    { provider: "apple_music", providerRecordingId: "5", title: "Never Gonna Give You Up", artists: ["Unknown"], storefronts: undefined },
    { provider: "spotify", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC", title: "Never Gonna Give You Up", artists: ["Wrong provider"], storefronts: ["US"] },
    { provider: "apple_music", providerRecordingId: "6", title: "Completely Different", artists: ["Spoof"], storefronts: ["US"] },
  ]);
  assert.deepEqual(choices.map(({ candidate }) => candidate.providerRecordingId), ["1", "2", "3"]);
  assert.equal(choices.length, 3);
  assert.ok(choices.every(({ candidate }) => candidate.provider === "apple_music" && candidate.storefronts?.includes("US")));
});

test("manual title-only choices keep provider identities distinct even when ISRC collides", async () => {
  const first = { provider: "apple_music" as const, providerRecordingId: "1", title: "Song", artists: ["Artist"], isrc: "USAAA2600001" };
  const second = { ...first, providerRecordingId: "2" };
  assert.equal((await stableRecordingIdentity(first)).recordingId, (await stableRecordingIdentity(second)).recordingId);
  assert.notEqual(
    (await stableRecordingIdentity(first, "provider")).recordingId,
    (await stableRecordingIdentity(second, "provider")).recordingId,
  );
});

for (const fixture of [
  { provider: "spotify" as const, providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC", principal: { kind: "account" as const, accountId: "acct_1" }, path: "/v1/catalog/query" },
  { provider: "apple_music" as const, providerRecordingId: "1559523357", principal: { kind: "public" as const }, path: "/v1/catalog/public-query" },
]) {
  test(`destination backfill persists an exact ${fixture.provider} ISRC match`, async () => {
    const { db, writes } = backfillDatabase({
      recording_id: "rec_shared", isrc: "USABC2600001", normalized_title: "Shared Song",
      normalized_artist: "Room Artist", album: "Shared Album", duration_ms: 201000,
      explicit: 0, version_label: "studio",
    });
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const result = await backfillProviderMatch({
      db,
      runtime: connectorRuntime([{
        provider: fixture.provider, providerRecordingId: fixture.providerRecordingId,
        title: "Shared Song", artists: ["Room Artist"], album: "Shared Album",
        durationMs: 201000, explicit: false, version: "studio", isrc: "USABC2600001", storefronts: ["US"],
      }], requests),
      recordingId: "rec_shared", provider: fixture.provider, principal: fixture.principal,
    });
    assert.deepEqual(result, {
      status: "matched", providerRecordingId: fixture.providerRecordingId,
      providerUrl: fixture.provider === "spotify"
        ? `https://open.spotify.com/track/${fixture.providerRecordingId}`
        : `https://music.apple.com/us/song/${fixture.providerRecordingId}`,
      cached: false,
    });
    assert.equal(requests[0]?.path, fixture.path);
    assert.equal(requests[0]?.body.mode, "isrc");
    assert.equal(requests[0]?.body.isrc, "USABC2600001");
    assert.equal(requests[0]?.body.accountId, fixture.provider === "spotify" ? "acct_1" : undefined);
    assert.equal(writes.length, 1);
    assert.equal(writes[0]?.[1], "rec_shared");
    assert.equal(writes[0]?.[3], fixture.providerRecordingId);
    assert.equal(writes[0]?.[4], "isrc");
  });
}

test("destination backfill refuses ambiguous ISRC candidates for explicit review", async () => {
  const { db, writes } = backfillDatabase({
    recording_id: "rec_shared", isrc: "USABC2600001", normalized_title: "Shared Song",
    normalized_artist: "Room Artist", album: null, duration_ms: null, explicit: null, version_label: null,
  });
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const result = await backfillProviderMatch({
    db,
    runtime: connectorRuntime(["first", "second"].map((providerRecordingId) => ({
      provider: "apple_music", providerRecordingId, title: "Shared Song", artists: ["Room Artist"],
      isrc: "USABC2600001", storefronts: ["US"],
    })), requests),
    recordingId: "rec_shared", provider: "apple_music", principal: { kind: "public" },
  });
  assert.deepEqual(result, { status: "review", reason: "ambiguous_match" });
  assert.equal(writes.length, 0);
});

test("canonical provider edges and attributable user-correction reviews commit together", async () => {
  const statements: Array<{ sql: string; bindings: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        sql,
        get bindings() { return bindings; },
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first() { return null; },
      };
      return statement;
    },
    async batch(batch: Array<{ sql: string; bindings: unknown[] }>) {
      statements.push(...batch);
      return batch.map(() => ({ success: true, results: [] }));
    },
  } as unknown as D1Database;
  await persistCanonicalRecordingMatches({
    db,
    candidate: {
      provider: "apple_music", providerRecordingId: "1559523357", title: "Shared Song",
      artists: ["Room Artist"], storefronts: ["US"],
    },
    identityBasis: "provider",
    primary: { method: "user_correction", evidence: ["participant_selected"], deterministic: false },
    related: [{
      candidate: { provider: "spotify", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC" },
      method: "user_correction", evidence: ["participant_selected_cross_provider_match"], deterministic: false,
    }],
    review: { accountId: "acct_reviewer", roomId: "ROOM1234", participantId: "p_reviewer" },
  });
  assert.equal(statements.length, 5);
  const edgeStatements = statements.filter(({ sql }) => sql.includes("INSERT INTO provider_matches"));
  assert.deepEqual(edgeStatements.map(({ bindings }) => bindings[6]), ["confirmed", "confirmed"]);
  const reviews = statements.filter(({ sql }) => sql.includes("INSERT INTO provider_match_reviews"));
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map(({ bindings }) => bindings[2]), ["acct_reviewer", "acct_reviewer"]);
  for (const review of reviews) {
    const provenance = JSON.parse(String(review.bindings[3])) as Record<string, unknown>;
    assert.equal(provenance.source, "room_manual_selection");
    assert.equal(provenance.roomId, "ROOM1234");
    assert.equal(provenance.participantId, "p_reviewer");
  }
});

test("a global user correction is rejected without an attributable account review", async () => {
  let batchCalls = 0;
  const db = {
    prepare(sql: string) {
      const statement = { bind() { return statement; }, async first() { return null; }, sql };
      return statement;
    },
    async batch() { batchCalls += 1; return []; },
  } as unknown as D1Database;
  await assert.rejects(() => persistCanonicalRecordingMatches({
    db,
    candidate: {
      provider: "apple_music", providerRecordingId: "1559523357", title: "Shared Song",
      artists: ["Room Artist"], storefronts: ["US"],
    },
    primary: { method: "user_correction", evidence: ["participant_selected"], deterministic: false },
  }), ProviderMatchReviewRequiredError);
  assert.equal(batchCalls, 0);
});

test("anonymous manual selections stay room-local while signed-in selections carry review attribution", () => {
  assert.deepEqual(providerCorrectionAuthority({
    accountId: null, roomId: "ROOM1234", participantId: "p_guest",
  }), { kind: "room_local" });
  assert.deepEqual(providerCorrectionAuthority({
    accountId: "acct_member", roomId: "ROOM1234", participantId: "p_member",
  }), {
    kind: "reviewed",
    review: { accountId: "acct_member", roomId: "ROOM1234", participantId: "p_member" },
  });
});

test("a reverse provider-ID race conflicts before a room grant can be issued", async () => {
  let committed = false;
  const sourceIdentity = await stableRecordingIdentity({
    provider: "spotify", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC",
    title: "provider match", artists: ["provider match"],
  });
  const db = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first() {
          if (committed && sql.includes("WHERE match_id") && bindings[0] === sourceIdentity.matchId) {
            return {
              recording_id: "rec_competing", provider: "spotify",
              provider_recording_id: "4uLU6hMCjMI75M1A2tKUQC",
            };
          }
          return null;
        },
      };
      return statement;
    },
    async batch(batch: unknown[]) {
      committed = true;
      return batch.map(() => ({ success: true, results: [] }));
    },
  } as unknown as D1Database;
  await assert.rejects(() => persistCanonicalRecordingMatches({
    db,
    candidate: {
      provider: "apple_music", providerRecordingId: "1559523357", title: "Shared Song",
      artists: ["Room Artist"], storefronts: ["US"],
    },
    identityBasis: "provider",
    primary: { method: "user_correction", evidence: ["participant_selected"], deterministic: false },
    related: [{
      candidate: { provider: "spotify", providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC" },
      method: "user_correction", evidence: ["participant_selected"], deterministic: false,
    }],
    review: { accountId: "acct_reviewer", roomId: "ROOM1234", participantId: "p_reviewer" },
  }), ProviderMatchConflictError);
});

test("a richer direct lookup reuses the canonical ID from an earlier title-only provider edge", async () => {
  const candidate = {
    provider: "spotify" as const,
    providerRecordingId: "4uLU6hMCjMI75M1A2tKUQC",
    title: "Shared Song",
    artists: ["Room Artist"],
    isrc: "USABC2600001",
    storefronts: ["US"],
  };
  const providerIdentity = await stableRecordingIdentity(candidate);
  const existing = {
    recording_id: "rec_manual_apple_identity",
    provider: "spotify" as const,
    provider_recording_id: candidate.providerRecordingId,
  };
  const db = {
    prepare(sql: string) {
      let bindings: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) { bindings = values; return statement; },
        async first() {
          if (sql.includes("WHERE match_id") && bindings[0] === providerIdentity.matchId) return existing;
          if (sql.includes("WHERE recording_id") && bindings[0] === existing.recording_id && bindings[1] === "spotify") return existing;
          return null;
        },
      };
      return statement;
    },
    async batch(batch: unknown[]) { return batch.map(() => ({ success: true, results: [] })); },
  } as unknown as D1Database;
  const persisted = await persistCanonicalRecordingMatches({
    db,
    candidate,
    primary: { method: "provider_id", evidence: ["provider_id"], deterministic: true },
  });
  assert.equal(persisted.recordingId, existing.recording_id);
  assert.equal(persisted.matchId, providerIdentity.matchId);
});

test("preview backfill bounds a maximum room deterministically", async () => {
  const recordingIds = Array.from({ length: 500 }, (_, index) => `rec_${String(index).padStart(4, "0")}`);
  const calls: string[] = [];
  const result = await backfillPreviewProviderMatches({
    recordingIds,
    existing: new Map(),
    async backfill(recordingId) {
      calls.push(recordingId);
      return { status: "matched", providerRecordingId: `provider_${recordingId}`, providerUrl: "https://example.test", cached: false };
    },
  });
  assert.equal(result.status, "partial");
  if (result.status !== "partial") return;
  assert.equal(result.remaining, 500 - MAX_PREVIEW_BACKFILLS_PER_REQUEST);
  assert.deepEqual(calls, recordingIds.slice(0, MAX_PREVIEW_BACKFILLS_PER_REQUEST));
});

test("preview destination cache reads batch a maximum room instead of issuing per-track queries", async () => {
  const recordingIds = Array.from({ length: 500 }, (_, index) => `rec_${String(index).padStart(4, "0")}`);
  let batchSize = 0;
  const db = {
    prepare() {
      let bindings: unknown[] = [];
      const statement = {
        get bindings() { return bindings; },
        bind(...values: unknown[]) { bindings = values; return statement; },
      };
      return statement;
    },
    async batch(statements: Array<{ bindings: unknown[] }>) {
      batchSize = statements.length;
      return statements.map((statement) => ({
        success: true,
        results: statement.bindings.slice(1).map((recordingId) => ({
          recording_id: recordingId,
          provider_recording_id: `provider_${recordingId}`,
        })),
      }));
    },
  } as unknown as D1Database;
  const matches = await loadProviderMatches(db, [...recordingIds, recordingIds[0]], "spotify");
  assert.equal(batchSize, 7);
  assert.equal(matches.size, 500);
  assert.equal(matches.get(recordingIds[499]), `provider_${recordingIds[499]}`);
});

test("preview backfill stops deterministically on a provider 429", async () => {
  const calls: string[] = [];
  const rateLimit = Response.json({ data: null, error: { code: "PROVIDER_RATE_LIMITED" } }, { status: 429 });
  const result = await backfillPreviewProviderMatches({
    recordingIds: ["rec_one", "rec_two", "rec_three"],
    existing: new Map(),
    async backfill(recordingId) {
      calls.push(recordingId);
      if (recordingId === "rec_two") return { status: "provider_error", response: rateLimit };
      return { status: "matched", providerRecordingId: `provider_${recordingId}`, providerUrl: "https://example.test", cached: false };
    },
  });
  assert.equal(result.status, "provider_error");
  if (result.status !== "provider_error") return;
  assert.equal(result.response.status, 429);
  assert.deepEqual(calls, ["rec_one", "rec_two"]);
  assert.equal(result.matches.get("rec_one"), "provider_rec_one");
});
