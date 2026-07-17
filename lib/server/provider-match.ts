import { resolveUsCatalogRecording, type CatalogCandidate, type ResolutionRequest } from "../catalog/resolver.ts";
import type { MusicProvider } from "../provider-state-engine.ts";
import { createProviderHandoffLinks } from "../providers/handoff.ts";
import { normalizeCatalogText, parseConnectorCandidate, parseConnectorEnvelope, stableRecordingIdentity } from "./catalog-resolution.ts";
import { connectorJsonRequest, type ConnectorProxyEnv } from "./connector-proxy.ts";

export type ProviderMatchMethod = "provider_id" | "isrc" | "metadata" | "user_correction";

export class ProviderMatchConflictError extends Error {
  constructor() {
    super("A provider recording is already bound to a different canonical recording");
    this.name = "ProviderMatchConflictError";
  }
}

export class ProviderMatchReviewRequiredError extends Error {
  constructor() {
    super("A confirmed user correction requires an attributable account review");
    this.name = "ProviderMatchReviewRequiredError";
  }
}

export type ProviderMatchEdge = {
  readonly candidate: Pick<CatalogCandidate, "provider" | "providerRecordingId">;
  readonly method: ProviderMatchMethod;
  readonly evidence: readonly string[];
  readonly deterministic: boolean;
  readonly status?: "matched" | "confirmed";
};

export type ProviderMatchReview = {
  readonly accountId: string;
  readonly roomId: string;
  readonly participantId: string;
};

export type ProviderCorrectionAuthority =
  | { readonly kind: "room_local" }
  | { readonly kind: "reviewed"; readonly review: ProviderMatchReview };

/** Anonymous guests may grant a correction only inside their current room. */
export function providerCorrectionAuthority(input: {
  readonly accountId: string | null;
  readonly roomId: string;
  readonly participantId: string;
}): ProviderCorrectionAuthority {
  return input.accountId === null
    ? { kind: "room_local" }
    : {
        kind: "reviewed",
        review: {
          accountId: input.accountId,
          roomId: input.roomId,
          participantId: input.participantId,
        },
      };
}

export type CatalogPrincipal =
  | { readonly kind: "public" }
  | { readonly kind: "account"; readonly accountId: string };

export type ProviderMatchBackfill =
  | { readonly status: "matched"; readonly providerRecordingId: string; readonly providerUrl: string; readonly cached: boolean }
  | { readonly status: "review"; readonly reason: "canonical_metadata_missing" | "no_match" | "ambiguous_match" | "stable_identifier_missing" }
  | { readonly status: "provider_error"; readonly response: Response };

type CanonicalRecordingRow = {
  readonly recording_id: string;
  readonly isrc: string | null;
  readonly normalized_title: string;
  readonly normalized_artist: string;
  readonly album: string | null;
  readonly duration_ms: number | null;
  readonly explicit: number | null;
  readonly version_label: string | null;
};

type ExistingProviderMatchRow = {
  readonly recording_id: string;
  readonly provider: MusicProvider;
  readonly provider_recording_id: string;
};

const PROVIDER_MATCH_QUERY_BATCH_SIZE = 80;
export const MAX_PREVIEW_BACKFILLS_PER_REQUEST = 8;

function publicProvider(provider: MusicProvider): "spotify" | "apple-music" {
  return provider === "apple_music" ? "apple-music" : "spotify";
}

function candidateRequest(row: CanonicalRecordingRow, provider: MusicProvider): ResolutionRequest {
  return {
    provider,
    storefront: "US",
    title: row.normalized_title,
    artists: row.normalized_artist.split(",").map((value) => value.trim()).filter(Boolean),
    ...(row.album ? { album: row.album } : {}),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.isrc ? { isrc: row.isrc } : {}),
    ...(row.explicit === null ? {} : { explicit: row.explicit === 1 }),
    ...(row.version_label ? { version: row.version_label as ResolutionRequest["version"] } : {}),
  };
}

async function providerMatchIdentity(candidate: Pick<CatalogCandidate, "provider" | "providerRecordingId">) {
  return stableRecordingIdentity({
    provider: candidate.provider,
    providerRecordingId: candidate.providerRecordingId,
    title: "provider match",
    artists: ["provider match"],
  });
}

async function assertProviderMatchAvailable(
  db: D1Database,
  recordingId: string,
  edge: ProviderMatchEdge,
  matchId: string,
): Promise<void> {
  const [byIdentity, bySlot] = await Promise.all([
    db.prepare(
      "SELECT recording_id, provider, provider_recording_id FROM provider_matches WHERE match_id = ? LIMIT 1",
    ).bind(matchId).first<ExistingProviderMatchRow>(),
    db.prepare(
      `SELECT recording_id, provider, provider_recording_id FROM provider_matches
       WHERE recording_id = ? AND provider = ? AND storefront = 'us' LIMIT 1`,
    ).bind(recordingId, edge.candidate.provider).first<ExistingProviderMatchRow>(),
  ]);
  if (
    byIdentity && (
      byIdentity.recording_id !== recordingId ||
      byIdentity.provider !== edge.candidate.provider ||
      byIdentity.provider_recording_id !== edge.candidate.providerRecordingId
    )
  ) throw new ProviderMatchConflictError();
  if (bySlot && bySlot.provider_recording_id !== edge.candidate.providerRecordingId) {
    throw new ProviderMatchConflictError();
  }
}

function providerMatchStatement(
  db: D1Database,
  recordingId: string,
  matchId: string,
  edge: ProviderMatchEdge,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO provider_matches
     (match_id, recording_id, provider, storefront, provider_recording_id, method, confidence_basis_json, status, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, 'us', ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recording_id, provider, storefront) DO UPDATE SET
       match_id = CASE
         WHEN provider_matches.provider_recording_id = excluded.provider_recording_id
         THEN provider_matches.match_id
         ELSE NULL
       END,
       method = excluded.method,
       confidence_basis_json = excluded.confidence_basis_json,
       status = excluded.status,
       updated_at_ms = excluded.updated_at_ms`,
  ).bind(
    matchId,
    recordingId,
    edge.candidate.provider,
    edge.candidate.providerRecordingId,
    edge.method,
    JSON.stringify({
      evidence: [...new Set(edge.evidence)],
      deterministic: edge.deterministic,
      storefront: "US",
    }),
    edge.status ?? (edge.method === "user_correction" ? "confirmed" : "matched"),
    now,
    now,
  );
}

function providerMatchReviewStatement(
  db: D1Database,
  matchId: string,
  edge: ProviderMatchEdge,
  review: ProviderMatchReview,
  now: number,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO provider_match_reviews
     (review_id, match_id, account_id, decision, provenance_json, created_at_ms)
     VALUES (?, ?, ?, 'confirmed', ?, ?)`,
  ).bind(
    `review_${crypto.randomUUID()}`,
    matchId,
    review.accountId,
    JSON.stringify({
      source: "room_manual_selection",
      roomId: review.roomId,
      participantId: review.participantId,
      provider: edge.candidate.provider,
      providerRecordingId: edge.candidate.providerRecordingId,
      evidence: [...new Set(edge.evidence)],
    }),
    now,
  );
}

async function persistProviderEdges(
  db: D1Database,
  recordingId: string,
  edges: readonly ProviderMatchEdge[],
  prefix: readonly D1PreparedStatement[] = [],
  review?: ProviderMatchReview,
): Promise<void> {
  const corrections = edges.filter((edge) => edge.method === "user_correction");
  if (corrections.length > 0 && !review) throw new ProviderMatchReviewRequiredError();
  const identities = await Promise.all(edges.map(({ candidate }) => providerMatchIdentity(candidate)));
  for (let index = 0; index < edges.length; index += 1) {
    await assertProviderMatchAvailable(db, recordingId, edges[index], identities[index].matchId);
  }
  const now = Date.now();
  try {
    await db.batch([
      ...prefix,
      ...edges.map((edge, index) => providerMatchStatement(db, recordingId, identities[index].matchId, edge, now)),
      ...edges.flatMap((edge, index) => edge.method === "user_correction" && review
        ? [providerMatchReviewStatement(db, identities[index].matchId, edge, review, now)]
        : []),
    ]);
    // A different provider ID for the same canonical slot assigns NULL to the
    // NOT NULL match_id, aborting and rolling back the complete D1 batch.
    // Verify the committed rows before any caller can issue a room grant.
    for (let index = 0; index < edges.length; index += 1) {
      await assertProviderMatchAvailable(db, recordingId, edges[index], identities[index].matchId);
    }
  } catch (error) {
    // A conflicting writer may win after the preflight reads. Re-read every
    // stable provider identity so that races become an explicit 409 rather
    // than a generic database/provider failure.
    for (let index = 0; index < edges.length; index += 1) {
      await assertProviderMatchAvailable(db, recordingId, edges[index], identities[index].matchId);
    }
    throw error;
  }
}

/** Persists one reviewed provider edge without rewriting canonical metadata. */
export async function persistProviderMatchForRecording(input: {
  readonly db: D1Database;
  readonly recordingId: string;
  readonly review?: ProviderMatchReview;
} & ProviderMatchEdge): Promise<void> {
  await persistProviderEdges(input.db, input.recordingId, [input], [], input.review);
}

/**
 * Atomically stores canonical metadata and every provider edge before a room
 * grant is issued. Stable provider IDs may never point at two recordings.
 */
export async function persistCanonicalRecordingMatches(input: {
  readonly db: D1Database;
  readonly candidate: CatalogCandidate;
  readonly identityBasis?: "canonical" | "provider";
  readonly primary: Omit<ProviderMatchEdge, "candidate">;
  readonly related?: readonly ProviderMatchEdge[];
  readonly review?: ProviderMatchReview;
}): Promise<{ readonly recordingId: string; readonly matchId: string }> {
  const edges: ProviderMatchEdge[] = [
    { candidate: input.candidate, ...input.primary },
    ...(input.related ?? []),
  ];
  const [derivedIdentity, ...edgeIdentities] = await Promise.all([
    stableRecordingIdentity(input.candidate, input.identityBasis),
    ...edges.map(({ candidate }) => providerMatchIdentity(candidate)),
  ]);
  const existingEdges = await Promise.all(edgeIdentities.map(({ matchId }) => input.db.prepare(
    "SELECT recording_id, provider, provider_recording_id FROM provider_matches WHERE match_id = ? LIMIT 1",
  ).bind(matchId).first<ExistingProviderMatchRow>()));
  const existingRecordingIds = new Set<string>();
  for (let index = 0; index < existingEdges.length; index += 1) {
    const existing = existingEdges[index];
    if (!existing) continue;
    const candidate = edges[index].candidate;
    if (existing.provider !== candidate.provider || existing.provider_recording_id !== candidate.providerRecordingId) {
      throw new ProviderMatchConflictError();
    }
    existingRecordingIds.add(existing.recording_id);
  }
  if (existingRecordingIds.size > 1) throw new ProviderMatchConflictError();
  // A stable provider edge is stronger continuity evidence than newly fetched
  // metadata. Reuse its canonical ID so a later richer direct lookup cannot
  // split or reject an earlier title-only reviewed match.
  const recordingId = existingRecordingIds.values().next().value ?? derivedIdentity.recordingId;
  const identity = { recordingId, matchId: edgeIdentities[0].matchId };
  const now = Date.now();
  const canonical = input.db.prepare(
    `INSERT INTO canonical_recordings
     (recording_id, isrc, normalized_title, normalized_artist, album, duration_ms, explicit, version_label, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(recording_id) DO UPDATE SET
       isrc = COALESCE(canonical_recordings.isrc, excluded.isrc),
       normalized_title = excluded.normalized_title,
       normalized_artist = excluded.normalized_artist,
       album = COALESCE(excluded.album, canonical_recordings.album),
       duration_ms = COALESCE(excluded.duration_ms, canonical_recordings.duration_ms),
       explicit = COALESCE(excluded.explicit, canonical_recordings.explicit),
       version_label = COALESCE(excluded.version_label, canonical_recordings.version_label),
       updated_at_ms = excluded.updated_at_ms`,
  ).bind(
    identity.recordingId,
    input.candidate.isrc ?? null,
    normalizeCatalogText(input.candidate.title),
    normalizeCatalogText(input.candidate.artists.join(", ")),
    input.candidate.album ?? null,
    input.candidate.durationMs ?? null,
    input.candidate.explicit === undefined ? null : input.candidate.explicit ? 1 : 0,
    input.candidate.version ?? null,
    now,
    now,
  );
  await persistProviderEdges(input.db, identity.recordingId, edges, [canonical], input.review);
  return identity;
}

/** Loads destination edges in bounded D1 batches while preserving one lookup per recording. */
export async function loadProviderMatches(
  db: D1Database,
  recordingIds: readonly string[],
  provider: MusicProvider,
): Promise<Map<string, string>> {
  const unique = [...new Set(recordingIds)];
  if (unique.length === 0) return new Map();
  const statements: D1PreparedStatement[] = [];
  for (let offset = 0; offset < unique.length; offset += PROVIDER_MATCH_QUERY_BATCH_SIZE) {
    const chunk = unique.slice(offset, offset + PROVIDER_MATCH_QUERY_BATCH_SIZE);
    statements.push(db.prepare(
      `SELECT recording_id, provider_recording_id FROM provider_matches
       WHERE provider = ? AND storefront = 'us' AND status IN ('confirmed','matched')
         AND recording_id IN (${chunk.map(() => "?").join(",")})`,
    ).bind(provider, ...chunk));
  }
  const results = await db.batch<{ recording_id: string; provider_recording_id: string }>(statements);
  return new Map(results.flatMap((result) => result.results ?? []).map((row) => [row.recording_id, row.provider_recording_id]));
}

export type PreviewBackfillBatchResult =
  | { readonly status: "complete"; readonly matches: Map<string, string> }
  | { readonly status: "partial"; readonly matches: Map<string, string>; readonly remaining: number }
  | { readonly status: "review"; readonly matches: Map<string, string> }
  | { readonly status: "provider_error"; readonly matches: Map<string, string>; readonly response: Response };

/** Performs a bounded, deterministic prefix of missing preview backfills. */
export async function backfillPreviewProviderMatches(input: {
  readonly recordingIds: readonly string[];
  readonly existing: ReadonlyMap<string, string>;
  readonly backfill: (recordingId: string) => Promise<ProviderMatchBackfill>;
  readonly limit?: number;
}): Promise<PreviewBackfillBatchResult> {
  const matches = new Map(input.existing);
  const missing = [...new Set(input.recordingIds)].filter((recordingId) => !matches.has(recordingId));
  const limit = Math.max(0, Math.min(input.limit ?? MAX_PREVIEW_BACKFILLS_PER_REQUEST, MAX_PREVIEW_BACKFILLS_PER_REQUEST));
  const batch = missing.slice(0, limit);
  for (const recordingId of batch) {
    const result = await input.backfill(recordingId);
    if (result.status === "provider_error") return { status: "provider_error", matches, response: result.response };
    if (result.status === "review") return { status: "review", matches };
    matches.set(recordingId, result.providerRecordingId);
  }
  const remaining = missing.length - batch.length;
  return remaining > 0 ? { status: "partial", matches, remaining } : { status: "complete", matches };
}

function connectorFailure(status: number): Response {
  const code = status === 401 ? "PROVIDER_RECONNECT_REQUIRED"
    : status === 403 ? "PILOT_NOT_ALLOWED"
      : status === 404 ? "PROVIDER_NOT_CONNECTED"
        : status === 429 ? "PROVIDER_RATE_LIMITED"
          : "PROVIDER_UNAVAILABLE";
  const message = status === 401 ? "Reconnect this music service before resolving tracks"
    : status === 403 ? "This account is not enabled for the provider pilot"
      : status === 404 ? "Connect this music service before resolving tracks"
        : status === 429 ? "The music service is rate limited; try again shortly"
          : "This music service could not resolve the track";
  return Response.json({ data: null, error: { code, message, retryable: status === 429 || status >= 500 }, requestId: crypto.randomUUID() }, {
    status: status === 404 ? 409 : status >= 500 ? 503 : status,
    headers: { "Cache-Control": "no-store" },
  });
}

/**
 * Backfills only an exact, unambiguous ISRC edge. Metadata-only candidates are
 * deliberately returned for review instead of silently joining recordings.
 */
export async function backfillProviderMatch(input: {
  readonly db: D1Database;
  readonly runtime: ConnectorProxyEnv;
  readonly recordingId: string;
  readonly provider: MusicProvider;
  readonly principal: CatalogPrincipal;
}): Promise<ProviderMatchBackfill> {
  const existing = await input.db.prepare(
    `SELECT provider_recording_id FROM provider_matches
     WHERE recording_id = ? AND provider = ? AND storefront = 'us' AND status IN ('confirmed','matched') LIMIT 1`,
  ).bind(input.recordingId, input.provider).first<{ provider_recording_id: string }>();
  if (existing) {
    return {
      status: "matched",
      providerRecordingId: existing.provider_recording_id,
      providerUrl: createProviderHandoffLinks(input.provider, existing.provider_recording_id).universalUrl,
      cached: true,
    };
  }

  const canonical = await input.db.prepare(
    `SELECT recording_id, isrc, normalized_title, normalized_artist, album, duration_ms, explicit, version_label
     FROM canonical_recordings WHERE recording_id = ? LIMIT 1`,
  ).bind(input.recordingId).first<CanonicalRecordingRow>();
  if (!canonical) return { status: "review", reason: "canonical_metadata_missing" };
  if (!canonical.isrc) return { status: "review", reason: "stable_identifier_missing" };

  const providerName = publicProvider(input.provider);
  const path = input.principal.kind === "public" ? "/v1/catalog/public-query" : "/v1/catalog/query";
  const connector = await connectorJsonRequest(input.runtime, path, {
    ...(input.principal.kind === "account" ? {
      accountId: input.principal.accountId,
      connectionId: `${providerName}:${input.principal.accountId}`,
    } : {}),
    provider: input.provider,
    mode: "isrc",
    isrc: canonical.isrc,
  });
  if (!connector.ok) return { status: "provider_error", response: connectorFailure(connector.status) };
  const envelope = parseConnectorEnvelope(await connector.json());
  if (!envelope || envelope.error || !Array.isArray(envelope.data)) {
    return { status: "provider_error", response: connectorFailure(502) };
  }
  const candidates = envelope.data.flatMap((value) => {
    const candidate = parseConnectorCandidate(value, input.provider);
    return candidate ? [candidate] : [];
  });
  const resolution = resolveUsCatalogRecording(candidateRequest(canonical, input.provider), candidates);
  if (resolution.status === "no_match") return { status: "review", reason: "no_match" };
  if (resolution.status === "hold" || !resolution.match.evidence.includes("isrc")) {
    return { status: "review", reason: "ambiguous_match" };
  }
  try {
    await persistProviderMatchForRecording({
      db: input.db,
      recordingId: input.recordingId,
      candidate: resolution.match.candidate,
      method: "isrc",
      evidence: [...resolution.match.evidence, "destination_backfill"],
      deterministic: true,
    });
  } catch (error) {
    if (error instanceof ProviderMatchConflictError) return { status: "review", reason: "ambiguous_match" };
    throw error;
  }
  return {
    status: "matched",
    providerRecordingId: resolution.match.candidate.providerRecordingId,
    providerUrl: createProviderHandoffLinks(input.provider, resolution.match.candidate.providerRecordingId).universalUrl,
    cached: false,
  };
}
