import assert from "node:assert/strict";
import test from "node:test";

import { createProviderHandoffLinks, isAllowlistedHandoffUrl } from "./handoff.ts";
import { decryptTokenEnvelope, encryptTokenEnvelope } from "./token-envelope.ts";

test("handoff links are generated only from allowlisted provider IDs", () => {
  const spotify = createProviderHandoffLinks("spotify", "4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(spotify.universalUrl, "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
  assert.equal(spotify.nativeUri, "spotify:track:4uLU6hMCjMI75M1A2tKUQC");
  assert.ok(isAllowlistedHandoffUrl(spotify.universalUrl));
  assert.ok(isAllowlistedHandoffUrl(spotify.nativeUri));

  const apple = createProviderHandoffLinks("apple_music", "1440833098");
  assert.ok(isAllowlistedHandoffUrl(apple.universalUrl));
  assert.ok(isAllowlistedHandoffUrl(apple.nativeUri));

  assert.throws(() => createProviderHandoffLinks("spotify", "../../callback"), /invalid spotify/);
  assert.equal(isAllowlistedHandoffUrl("https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC"), false);
  assert.equal(isAllowlistedHandoffUrl("https://music.apple.com/us/song/123?at=redirect"), false);
  assert.equal(isAllowlistedHandoffUrl("javascript:alert(1)"), false);
});

test("AES-GCM token envelopes round trip and bind ciphertext to connection context", async () => {
  const key = await globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  const context = {
    accountId: "account-fixture",
    connectionId: "connection-fixture",
    provider: "spotify" as const,
  };
  const envelope = await encryptTokenEnvelope({
    plaintext: "synthetic-token-never-a-real-secret ",
    key,
    keyVersion: "key-2026-07",
    context,
    encryptedAtMs: 1_000,
    iv: Uint8Array.from({ length: 12 }, (_, index) => index + 1),
  });
  assert.equal(envelope.algorithm, "AES-GCM");
  assert.equal(envelope.keyVersion, "key-2026-07");
  assert.equal(await decryptTokenEnvelope({ envelope, key, context }), "synthetic-token-never-a-real-secret ");

  await assert.rejects(
    decryptTokenEnvelope({ envelope, key, context: { ...context, connectionId: "other" } }),
  );
  await assert.rejects(
    decryptTokenEnvelope({
      envelope: {
        ...envelope,
        ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`,
      },
      key,
      context,
    }),
  );

  const weakKey = await globalThis.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 128 },
    false,
    ["encrypt"],
  );
  await assert.rejects(
    encryptTokenEnvelope({
      plaintext: "synthetic-token",
      key: weakKey,
      keyVersion: "weak",
      context,
      encryptedAtMs: 1_000,
    }),
    /256-bit AES-GCM/,
  );
});
