import assert from "node:assert/strict";
import test from "node:test";
import { parseConnectorCandidate, parseSpotifyOEmbedSource, stableRecordingIdentity, titleOnlyReviewCandidates } from "./catalog-resolution.ts";

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
