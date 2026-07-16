import assert from "node:assert/strict";
import test from "node:test";
import { parseConnectorCandidate, parseSpotifyOEmbedSource, stableRecordingIdentity } from "./catalog-resolution.ts";

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
