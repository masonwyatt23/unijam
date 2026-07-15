import assert from "node:assert/strict";
import test from "node:test";

import { commandIntent, parseRoomCommand, roomActionRateLimit, shouldResetRoomState, stableJson } from "./protocol.ts";

test("stable JSON normalizes object key order", () => {
  assert.equal(stableJson({ b: 2, a: { d: 4, c: 3 } }), stableJson({ a: { c: 3, d: 4 }, b: 2 }));
});

test("command intent is stable and actor scoped", () => {
  const command = parseRoomCommand({ commandId: "command_12345678", action: "queue.vote", payload: { vote: true, occurrenceId: "occ_12345678" } });
  const first = commandIntent(command, { participantId: "p_one", nickname: "One", role: "guest" });
  const replay = commandIntent({ ...command, payload: { occurrenceId: "occ_12345678", vote: true } }, { participantId: "p_one", nickname: "Renamed", role: "guest" });
  const otherActor = commandIntent(command, { participantId: "p_two", nickname: "Two", role: "guest" });
  assert.equal(first, replay);
  assert.notEqual(first, otherActor);
});

test("rejects malformed commands before persistence", () => {
  assert.throws(() => parseRoomCommand({ commandId: "short", action: "queue.vote", payload: {} }), /commandId/);
  assert.throws(() => parseRoomCommand({ commandId: "command_12345678", action: "Queue Vote", payload: {} }), /action/);
  let deeplyNested: Record<string, unknown> = {};
  for (let depth = 0; depth < 30; depth += 1) deeplyNested = { child: deeplyNested };
  assert.throws(() => parseRoomCommand({ commandId: "command_12345678", action: "queue.vote", payload: deeplyNested }), /too complex/);
});

test("fresh room state requests receive a canonical snapshot", () => {
  assert.equal(shouldResetRoomState(null, 0, 0), true);
  assert.equal(shouldResetRoomState("0", 0, 0), true);
  assert.equal(shouldResetRoomState("42", 42, 10), false);
  assert.equal(shouldResetRoomState("9", 9, 10), true);
});

test("high-volume actions receive focused rate limits", () => {
  assert.equal(roomActionRateLimit("suggestion.stage"), 3);
  assert.equal(roomActionRateLimit("reaction.add"), 20);
  assert.equal(roomActionRateLimit("queue.vote"), 30);
  assert.equal(roomActionRateLimit("room.rules.update"), 60);
});
