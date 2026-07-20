import assert from "node:assert/strict";
import test from "node:test";

import { parseCatalogInput } from "./input.ts";
import {
  resolveUsCatalogRecording,
  scoreCatalogCandidate,
  type CatalogCandidate,
  type ResolutionRequest,
} from "./resolver.ts";

const spotifyId = "4uLU6hMCjMI75M1A2tKUQC";

test("parses Spotify and Apple Music track references into US recording intent", () => {
  assert.deepEqual(parseCatalogInput(`spotify:track:${spotifyId}`), {
    kind: "provider_recording",
    inputKind: "uri",
    provider: "spotify",
    providerRecordingId: spotifyId,
    storefront: "US",
    source: `spotify:track:${spotifyId}`,
  });
  assert.equal(
    parseCatalogInput(`https://open.spotify.com/intl-de/track/${spotifyId}?si=ignored`).kind,
    "provider_recording",
  );
  assert.deepEqual(
    parseCatalogInput("https://music.apple.com/us/album/example/1440833086?i=1440833098"),
    {
      kind: "provider_recording",
      inputKind: "url",
      provider: "apple_music",
      providerRecordingId: "1440833098",
      storefront: "US",
      source: "https://music.apple.com/us/album/example/1440833086?i=1440833098",
    },
  );
  assert.equal(parseCatalogInput("applemusic:song:1440833098").kind, "provider_recording");
  assert.deepEqual(parseCatalogInput("music://music.apple.com/us/song/1440833098"), {
    kind: "provider_recording",
    inputKind: "uri",
    provider: "apple_music",
    providerRecordingId: "1440833098",
    storefront: "US",
    source: "music://music.apple.com/us/song/1440833098",
  });
});

test("structures plain text and rejects unsupported or spoofed provider links", () => {
  assert.deepEqual(parseCatalogInput("Frank Ocean — Pink + White"), {
    kind: "text_search",
    inputKind: "text",
    query: "Frank Ocean — Pink + White",
    artists: ["Frank Ocean"],
    title: "Pink + White",
    storefront: "US",
    source: "Frank Ocean — Pink + White",
  });
  assert.deepEqual(parseCatalogInput("https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC"), {
    kind: "unsupported",
    reason: "invalid_provider_reference",
    source: "https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC",
  });
  assert.equal(parseCatalogInput("https://youtube.com/watch?v=abc").kind, "unsupported");
  assert.equal(parseCatalogInput("tidal:track:123").kind, "unsupported");
  assert.equal(parseCatalogInput("spotify:playlist:abc").kind, "unsupported");
  assert.equal(parseCatalogInput("https://music.apple.com/gb/song/example/123").kind, "unsupported");
  assert.equal(parseCatalogInput("Muse: Uprising").kind, "text_search");
});

const request: ResolutionRequest = {
  provider: "spotify",
  storefront: "US",
  title: "Midnight (Live)",
  artists: ["Synthetic Band"],
  album: "Synthetic Nights Deluxe",
  durationMs: 240_000,
  isrc: "US-SYN-26-00001",
  explicit: false,
  version: "live",
  edition: "deluxe",
};

function candidate(
  id: string,
  changes: Partial<CatalogCandidate> = {},
): CatalogCandidate {
  return {
    provider: "spotify",
    providerRecordingId: id,
    title: "Midnight Live",
    artists: ["Synthetic Band"],
    album: "Synthetic Nights Deluxe",
    durationMs: 240_400,
    isrc: "USSYN2600001",
    explicit: false,
    version: "live",
    edition: "deluxe",
    storefronts: ["US"],
    ...changes,
  };
}

test("identifier-first US resolution returns deterministic evidence", () => {
  const match = candidate("synthetic-1");
  const score = scoreCatalogCandidate(request, match);
  assert.ok(score.score >= 0.98);
  assert.ok(score.evidence.includes("isrc"));

  const result = resolveUsCatalogRecording(request, [match]);
  assert.equal(result.status, "matched");
  if (result.status === "matched") {
    assert.equal(result.match.candidate.providerRecordingId, "synthetic-1");
  }
  const duplicateIsrc = resolveUsCatalogRecording(request, [
    candidate("synthetic-2", { title: "Wrong" }),
    match,
  ]);
  assert.equal(duplicateIsrc.status, "hold");
});

test("resolution holds ambiguity, variants, explicitness, duration, and availability", () => {
  const ambiguous = resolveUsCatalogRecording(request, [candidate("a"), candidate("b")]);
  assert.equal(ambiguous.status, "hold");
  if (ambiguous.status === "hold") assert.ok(ambiguous.reasons.includes("ambiguous_candidates"));

  const conflicts = resolveUsCatalogRecording(request, [candidate("conflict", {
    durationMs: 260_000,
    explicit: true,
    version: "remix",
    edition: "standard",
    storefronts: undefined,
  })]);
  assert.equal(conflicts.status, "hold");
  if (conflicts.status === "hold") {
    assert.deepEqual(new Set(conflicts.reasons), new Set([
      "duration_mismatch",
      "explicit_conflict",
      "version_conflict",
      "edition_conflict",
      "storefront_unknown",
    ]));
  }

  const unavailable = resolveUsCatalogRecording(request, [candidate("ca", { storefronts: ["CA"] })]);
  assert.equal(unavailable.status, "hold");
});

test("plain metadata matching is deterministic and weak candidates do not match", () => {
  const textRequest: ResolutionRequest = {
    provider: "apple_music",
    storefront: "US",
    title: "Signal Fire",
    artists: ["Fixture Artist"],
  };
  const candidates: CatalogCandidate[] = [
    {
      provider: "apple_music",
      providerRecordingId: "20",
      title: "Signal Fire",
      artists: ["Fixture Artist"],
      storefronts: ["US"],
    },
    {
      provider: "apple_music",
      providerRecordingId: "10",
      title: "Completely Different",
      artists: ["Someone Else"],
      storefronts: ["US"],
    },
  ];
  const result = resolveUsCatalogRecording(textRequest, candidates);
  assert.equal(result.status, "matched");
  assert.equal(resolveUsCatalogRecording({ ...textRequest, title: "Unknown" }, candidates).status, "no_match");
});
