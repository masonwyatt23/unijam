import assert from "node:assert/strict";
import test from "node:test";

import {
  cancelPublishOperation,
  confirmPublishPreview,
  createDestinationPublishState,
  createPublishPreview,
  publishRecoveryMarker,
  recoveryMarkerFromDescription,
  recordPublishAttemptOutcome,
  recordPublishReconciliation,
  startPublishAttempt,
} from "./model.ts";

function preview(provider: "spotify" | "apple_music") {
  return createPublishPreview({
    roomId: "fixture-room",
    roomRevision: 12,
    ownerAccountId: "fixture-owner",
    provider,
    playlistName: "UniJam — Fixture Room",
    items: [
      { canonicalRecordingId: "canonical-1", providerRecordingId: `${provider}-1` },
      { canonicalRecordingId: "canonical-2", providerRecordingId: `${provider}-2` },
    ],
    createdAtMs: 1_000,
  });
}

function confirmed(provider: "spotify" | "apple_music") {
  const value = preview(provider);
  return confirmPublishPreview(value, {
    previewId: value.previewId,
    payloadFingerprint: value.payloadFingerprint,
    confirmedByAccountId: value.ownerAccountId,
    confirmedAtMs: 2_000,
  });
}

test("preview, operation, and item keys are stable while owner confirmation is immutable", () => {
  assert.deepEqual(preview("spotify"), preview("spotify"));
  const value = preview("spotify");
  assert.equal(
    recoveryMarkerFromDescription(value.destination.description),
    publishRecoveryMarker(value.previewId.replace(/^preview:/, "publish:")),
  );
  assert.ok(value.destination.description.length <= 300);
  assert.equal(new Set(value.items.map(({ itemKey }) => itemKey)).size, 2);
  assert.throws(
    () => confirmPublishPreview(value, {
      previewId: value.previewId,
      payloadFingerprint: `${value.payloadFingerprint}:changed`,
      confirmedByAccountId: value.ownerAccountId,
      confirmedAtMs: 2_000,
    }),
    /changed after review/,
  );
  assert.throws(
    () => confirmPublishPreview(value, {
      previewId: value.previewId,
      payloadFingerprint: value.payloadFingerprint,
      confirmedByAccountId: "different-owner",
      confirmedAtMs: 2_000,
    }),
    /confirmed by its owner/,
  );
});

test("ambiguous writes require provider reconciliation before retry", () => {
  let state = createDestinationPublishState(confirmed("apple_music"));
  state = startPublishAttempt(state, 3_000);
  state = recordPublishAttemptOutcome(state, { kind: "ambiguous_timeout", safeError: "Provider outcome is unknown" });
  assert.equal(state.phase, "reconcile_before_retry");
  assert.throws(() => startPublishAttempt(state, 4_000), /cannot start/);

  state = recordPublishReconciliation(state, ["apple_music-1"], 5_000);
  assert.equal(state.phase, "waiting_retry");
  assert.deepEqual(state.pendingItemKeys, [state.operation.preview.items[1].itemKey]);
  assert.throws(() => startPublishAttempt(state, 4_999), /not due/);
  state = startPublishAttempt(state, 5_000);
  state = recordPublishAttemptOutcome(state, { kind: "succeeded", receiptId: "synthetic-receipt" });
  assert.equal(state.phase, "succeeded");
});

test("provider destination states fail and retry independently", () => {
  let spotify = startPublishAttempt(createDestinationPublishState(confirmed("spotify")), 3_000);
  let apple = startPublishAttempt(createDestinationPublishState(confirmed("apple_music")), 3_000);

  spotify = recordPublishAttemptOutcome(spotify, { kind: "succeeded" });
  apple = recordPublishAttemptOutcome(apple, { kind: "authorization_expired", safeError: "Reconnect Apple Music" });
  assert.equal(spotify.phase, "succeeded");
  assert.equal(apple.phase, "reconnect");

  apple = cancelPublishOperation(apple);
  assert.equal(apple.phase, "cancelled");
  assert.equal(spotify.phase, "succeeded");
});

test("rate limiting preserves pending work without requiring speculative writes", () => {
  let state = startPublishAttempt(createDestinationPublishState(confirmed("spotify")), 3_000);
  state = recordPublishAttemptOutcome(state, { kind: "rate_limited", retryAtMs: 10_000 });
  assert.equal(state.phase, "waiting_retry");
  assert.equal(state.attempt, 1);
  assert.throws(() => startPublishAttempt(state, 9_999), /not due/);
  state = startPublishAttempt(state, 10_000);
  assert.equal(state.attempt, 2);
});
