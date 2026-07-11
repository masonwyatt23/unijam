import assert from "node:assert/strict";
import test from "node:test";

import {
  canRolePublishEvent,
  normalizeRoomId,
  parseEventCursor,
  validateLiveRoomEventInput,
  validateLiveRoomEventPayload,
} from "./live-room-events.ts";

test("live-room event input is normalized and bounded", () => {
  assert.deepEqual(validateLiveRoomEventInput({
    eventId: "event-1",
    clientId: "client-1",
    actorName: " Jordan ",
    type: "suggestion_staged",
    payload: { suggestionId: "suggestion-1", title: "Dreams", service: "apple" },
  }), {
    eventId: "event-1",
    clientId: "client-1",
    actorName: "Jordan",
    type: "suggestion_staged",
    payload: { suggestionId: "suggestion-1", title: "Dreams", service: "apple" },
  });
  assert.throws(() => validateLiveRoomEventInput({
    eventId: "bad id",
    clientId: "client",
    actorName: "Jordan",
    type: "reaction_added",
    payload: {},
  }), /eventId/);
  assert.throws(() => validateLiveRoomEventInput({
    eventId: "event",
    clientId: "client",
    actorName: "Jordan",
    type: "made_up",
    payload: {},
  }), /not supported/);
});

test("room IDs and cursors reject unsafe input", () => {
  assert.equal(normalizeRoomId(" Friday-Night.Room "), "friday-night.room");
  assert.equal(parseEventCursor(null), 0);
  assert.equal(parseEventCursor("42"), 42);
  assert.throws(() => normalizeRoomId("../../room"), /roomId/);
  assert.throws(() => parseEventCursor("1.5"), /after/);
});

test("role-scoped commands and event-specific bounds are enforced", () => {
  assert.equal(canRolePublishEvent("guest", "suggestion_staged"), true);
  assert.equal(canRolePublishEvent("guest", "suggestion_approved"), false);
  assert.throws(
    () => validateLiveRoomEventPayload("suggestion_approved", {
      suggestionId: "suggestion-1",
      title: "Dreams",
      submittedBy: "Jordan",
      service: "apple",
    }, "guest"),
    /cannot publish/,
  );
  assert.throws(
    () => validateLiveRoomEventPayload("track_advanced", { trackIndex: -1 }, "host"),
    /trackIndex/,
  );
  assert.deepEqual(
    validateLiveRoomEventPayload("handoff_requested", {
      role: "host",
      service: "spotify",
      trackId: 1,
    }, "guest"),
    { role: "guest", service: "spotify", trackId: 1 },
  );
});
