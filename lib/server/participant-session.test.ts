import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../../scripts/cloudflare-validation-loader.mjs", import.meta.url);

const {
  deriveParticipantToken,
  normalizeJoinNonce,
  normalizeParticipantNickname,
  parseParticipantJoinInput,
  participantRoleForRoom,
  roomContributionSettings,
} = await import("./participant-session.ts");

const room = {
  room_id: "weekend-room",
  host_token_hash: "host-hash",
  guest_token_hash: "guest-hash",
  guest_can_contribute: 1,
  locked: 0,
  host_approval: 1,
  guest_expires_at_ms: null,
  revision: 4,
  live_snapshot_json: null,
  snapshot_sequence: 0,
  created_at_ms: 1,
  updated_at_ms: 1,
};

test("participant join input is normalized and bounded", () => {
  assert.deepEqual(parseParticipantJoinInput({
    nickname: "  Mía   Chen  ",
    preferredService: "apple",
    joinNonce: "01234567-89ab-4def-8123-456789abcdef",
  }), {
    nickname: "Mía Chen",
    preferredService: "apple",
    joinNonce: "01234567-89ab-4def-8123-456789abcdef",
  });
  assert.throws(() => normalizeParticipantNickname("Guest\u202eAdmin"), /control/);
  assert.throws(() => normalizeJoinNonce("short"), /joinNonce/);
});

test("participant roles reflect current contribution settings", () => {
  assert.equal(participantRoleForRoom("host", { guest_can_contribute: 0, locked: 1 }), "host");
  assert.equal(participantRoleForRoom("guest", { guest_can_contribute: 1, locked: 0 }), "editor");
  assert.equal(participantRoleForRoom("guest", { guest_can_contribute: 0, locked: 0 }), "viewer");
  assert.equal(participantRoleForRoom("guest", { guest_can_contribute: 1, locked: 1 }), "viewer");
  assert.equal(roomContributionSettings(room, "editor").canContribute, true);
  assert.equal(roomContributionSettings({ ...room, locked: 1 }, "viewer").canContribute, false);
});

test("participant tokens are opaque, deterministic per join, and epoch scoped", async () => {
  const first = await deriveParticipantToken(
    "capability-token-with-more-than-thirty-two-characters",
    "01234567-89ab-4def-8123-456789abcdef",
    "ptc_123",
    1,
  );
  const retry = await deriveParticipantToken(
    "capability-token-with-more-than-thirty-two-characters",
    "01234567-89ab-4def-8123-456789abcdef",
    "ptc_123",
    1,
  );
  const renewed = await deriveParticipantToken(
    "capability-token-with-more-than-thirty-two-characters",
    "01234567-89ab-4def-8123-456789abcdef",
    "ptc_123",
    2,
  );
  assert.match(first, /^ujp_[a-zA-Z0-9_-]{43}$/);
  assert.equal(retry, first);
  assert.notEqual(renewed, first);
  assert.equal(first.includes("capability-token"), false);
});
