import assert from "node:assert/strict";
import test from "node:test";

import { createInitialLiveRoomSnapshot, mergeRoomSnapshot, reduceLiveRoomEvent } from "./live-room-snapshot.ts";
import type { LiveRoomEventType, StoredLiveRoomEvent } from "./live-room-events.ts";

function event(sequence: number, type: LiveRoomEventType, payload: Record<string, unknown>, clientId = "guest-1", actorName = "Jordan"): StoredLiveRoomEvent {
  return { sequence, roomId: "room-1", eventId: `event-${sequence}`, clientId, actorName, type, payload, createdAtMs: 1_000 + sequence };
}

test("snapshot deterministically reconstructs participants, suggestions, votes, and playback", () => {
  let snapshot = createInitialLiveRoomSnapshot();
  snapshot = reduceLiveRoomEvent(snapshot, event(1, "participant_joined", { role: "guest", service: "apple" }));
  snapshot = reduceLiveRoomEvent(snapshot, event(2, "ready_changed", { ready: true, trackId: 1 }));
  snapshot = reduceLiveRoomEvent(snapshot, event(3, "suggestion_staged", { suggestionId: "suggestion-1", title: "Dreams", service: "apple" }));
  snapshot = reduceLiveRoomEvent(snapshot, event(4, "vote_changed", { trackId: 2, delta: 1 }));
  snapshot = reduceLiveRoomEvent(snapshot, event(5, "suggestion_approved", { suggestionId: "suggestion-1", title: "Dreams", submittedBy: "Jordan", service: "apple" }, "host-1", "Mason"));
  snapshot = reduceLiveRoomEvent(snapshot, event(6, "handoff_requested", { role: "host", trackId: 1, service: "spotify" }, "host-1", "Mason"));
  snapshot = reduceLiveRoomEvent(snapshot, event(7, "playback_confirmed", { trackId: 1, service: "spotify" }, "host-1", "Mason"));

  assert.equal(snapshot.sequence, 7);
  assert.equal(snapshot.participants["guest-1"].ready, true);
  assert.equal(snapshot.suggestions["suggestion-1"].status, "approved");
  assert.deepEqual(snapshot.votes["2"], ["guest-1"]);
  assert.equal(snapshot.phase, "started");
  assert.equal(snapshot.startedAtMs, 1_007);
});

test("duplicate or stale events are ignored and track advance resets transient state", () => {
  let snapshot = reduceLiveRoomEvent(createInitialLiveRoomSnapshot(), event(1, "participant_joined", { role: "guest", service: "spotify" }));
  snapshot = reduceLiveRoomEvent(snapshot, event(2, "ready_changed", { ready: true, trackId: 1 }));
  const stale = reduceLiveRoomEvent(snapshot, event(2, "reaction_added", { trackId: 1, reaction: "heart" }));
  assert.strictEqual(stale, snapshot);
  const advanced = reduceLiveRoomEvent(snapshot, event(3, "track_advanced", { trackIndex: 2 }, "host-1", "Mason"));
  assert.equal(advanced.nowTrackIndex, 2);
  assert.equal(advanced.participants["guest-1"].ready, false);
  assert.equal(advanced.reactionCount, 0);
});

test("votes use participant sets so retries cannot inflate or underflow a track", () => {
  let snapshot = createInitialLiveRoomSnapshot();
  snapshot = reduceLiveRoomEvent(snapshot, event(1, "participant_joined", { role: "guest", service: "spotify" }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(2, "participant_joined", { role: "guest", service: "apple" }, "guest-b", "Blair"));
  snapshot = reduceLiveRoomEvent(snapshot, event(3, "vote_changed", { trackId: 7, delta: 1 }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(4, "vote_changed", { trackId: 7, delta: 1 }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(5, "vote_changed", { trackId: 7, delta: 1 }, "guest-b", "Blair"));

  assert.deepEqual(snapshot.votes["7"], ["guest-a", "guest-b"]);

  snapshot = reduceLiveRoomEvent(snapshot, event(6, "vote_changed", { trackId: 7, delta: -1 }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(7, "vote_changed", { trackId: 7, delta: -1 }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(8, "vote_changed", { trackId: 8, delta: -1 }, "guest-a", "Alex"));

  assert.deepEqual(snapshot.votes["7"], ["guest-b"]);
  assert.deepEqual(snapshot.votes["8"], []);
});

test("out-of-order and duplicate sequences cannot mutate canonical state", () => {
  let snapshot = createInitialLiveRoomSnapshot();
  snapshot = reduceLiveRoomEvent(snapshot, event(1, "participant_joined", { role: "guest", service: "apple" }));
  snapshot = reduceLiveRoomEvent(snapshot, event(4, "ready_changed", { ready: true, trackId: 1 }));
  const canonical = snapshot;

  const outOfOrder = reduceLiveRoomEvent(snapshot, event(3, "ready_changed", { ready: false, trackId: 1 }));
  const duplicateSequence = reduceLiveRoomEvent(snapshot, event(4, "reaction_added", { trackId: 1, reaction: "heart" }));

  assert.strictEqual(outOfOrder, canonical);
  assert.strictEqual(duplicateSequence, canonical);
  assert.equal(canonical.participants["guest-1"].ready, true);
  assert.equal(canonical.reactionCount, 0);
  assert.equal(canonical.activity.length, 2);
});

test("suggestions move through pending, approved, and rejected without losing contributor provenance", () => {
  let snapshot = createInitialLiveRoomSnapshot();
  snapshot = reduceLiveRoomEvent(snapshot, event(1, "participant_joined", { role: "guest", service: "apple" }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(2, "suggestion_staged", {
    suggestionId: "pick-1",
    title: "Midnight City",
    service: "apple",
  }, "guest-a", "Alex"));

  assert.deepEqual(snapshot.suggestions["pick-1"], {
    id: "pick-1",
    title: "Midnight City",
    submittedBy: "Alex",
    clientId: "guest-a",
    service: "apple",
    status: "pending",
  });

  snapshot = reduceLiveRoomEvent(snapshot, event(3, "suggestion_approved", {
    suggestionId: "pick-1",
    title: "Midnight City (Host Rewrite)",
    submittedBy: "Not Alex",
    service: "spotify",
  }, "host-a", "Mason"));

  assert.deepEqual(snapshot.suggestions["pick-1"], {
    id: "pick-1",
    title: "Midnight City",
    submittedBy: "Alex",
    clientId: "guest-a",
    service: "apple",
    status: "approved",
  });

  snapshot = reduceLiveRoomEvent(snapshot, event(4, "suggestion_staged", {
    suggestionId: "pick-2",
    title: "Dreams",
    service: "apple",
  }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(5, "suggestion_rejected", {
    suggestionId: "pick-2",
    title: "Dreams",
  }, "host-a", "Mason"));

  assert.equal(snapshot.suggestions["pick-1"].status, "approved");
  assert.equal(snapshot.suggestions["pick-2"], undefined);
  assert.match(snapshot.activity[0].text, /passed on Dreams/);
});

test("a client rejoin refreshes mutable presence without rewriting stable identity", () => {
  let snapshot = reduceLiveRoomEvent(
    createInitialLiveRoomSnapshot(),
    event(1, "participant_joined", { role: "guest", service: "apple" }, "stable-client", "Jordan"),
  );
  snapshot = reduceLiveRoomEvent(
    snapshot,
    event(2, "participant_joined", { role: "host", service: "spotify" }, "stable-client", "Impostor"),
  );

  assert.deepEqual(snapshot.participants["stable-client"], {
    clientId: "stable-client",
    name: "Jordan",
    role: "guest",
    service: "spotify",
    ready: false,
    lastSeenAtMs: 1_002,
  });
});

test("track advance resets only per-track playback state for every participant", () => {
  let snapshot = createInitialLiveRoomSnapshot();
  snapshot = reduceLiveRoomEvent(snapshot, event(1, "participant_joined", { role: "host", service: "spotify" }, "host-a", "Mason"));
  snapshot = reduceLiveRoomEvent(snapshot, event(2, "participant_joined", { role: "guest", service: "apple" }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(3, "ready_changed", { ready: true, trackId: 1 }, "host-a", "Mason"));
  snapshot = reduceLiveRoomEvent(snapshot, event(4, "ready_changed", { ready: true, trackId: 1 }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(5, "reaction_added", { trackId: 1, reaction: "heart" }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(6, "suggestion_staged", { suggestionId: "pick-1", title: "Dreams", service: "apple" }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(7, "vote_changed", { trackId: 2, delta: 1 }, "guest-a", "Alex"));
  snapshot = reduceLiveRoomEvent(snapshot, event(8, "playback_confirmed", { trackId: 1, service: "spotify" }, "host-a", "Mason"));
  snapshot = reduceLiveRoomEvent(snapshot, event(9, "track_advanced", { trackIndex: 1 }, "host-a", "Mason"));

  assert.equal(snapshot.nowTrackIndex, 1);
  assert.equal(snapshot.phase, "idle");
  assert.equal(snapshot.startedAtMs, null);
  assert.equal(snapshot.reactionCount, 0);
  assert.equal(snapshot.participants["host-a"].ready, false);
  assert.equal(snapshot.participants["guest-a"].ready, false);
  assert.equal(snapshot.speakerService, "spotify");
  assert.equal(snapshot.suggestions["pick-1"].status, "pending");
  assert.deepEqual(snapshot.votes["2"], ["guest-a"]);
});

test("room-scoped hydration rejects late snapshots without blocking another room", () => {
  const sequenceEleven = { ...createInitialLiveRoomSnapshot(), sequence: 11, reactionCount: 4 };
  const staleSequenceTen = { ...createInitialLiveRoomSnapshot(), sequence: 10, reactionCount: 1 };
  const otherRoom = { ...createInitialLiveRoomSnapshot(), sequence: 2, reactionCount: 8 };
  const first = mergeRoomSnapshot({}, "room-a", sequenceEleven);
  const stale = mergeRoomSnapshot(first, "room-a", staleSequenceTen);
  assert.strictEqual(stale, first);
  const withOtherRoom = mergeRoomSnapshot(stale, "room-b", otherRoom);
  assert.equal(withOtherRoom["room-a"].sequence, 11);
  assert.equal(withOtherRoom["room-b"].reactionCount, 8);
  const forced = mergeRoomSnapshot(withOtherRoom, "room-a", { ...sequenceEleven }, true);
  assert.notStrictEqual(forced, withOtherRoom);
});

test("ordered projection enforces three active guest picks under a concurrent burst", () => {
  let snapshot = reduceLiveRoomEvent(
    createInitialLiveRoomSnapshot(),
    event(1, "participant_joined", { role: "guest", service: "apple" }, "guest-a", "Alex"),
  );
  for (let index = 1; index <= 4; index += 1) {
    snapshot = reduceLiveRoomEvent(snapshot, event(
      index + 1,
      "suggestion_staged",
      { suggestionId: `pick-${index}`, title: `Pick ${index}`, service: "apple" },
      "guest-a",
      "Alex",
    ));
  }
  assert.deepEqual(Object.keys(snapshot.suggestions).sort(), ["pick-1", "pick-2", "pick-3"]);
  assert.equal(snapshot.activity.length, 4);

  snapshot = reduceLiveRoomEvent(snapshot, event(6, "suggestion_rejected", {
    suggestionId: "pick-2",
    title: "Pick 2",
  }, "host-a", "Mason"));
  snapshot = reduceLiveRoomEvent(snapshot, event(7, "suggestion_staged", {
    suggestionId: "pick-5",
    title: "Pick 5",
    service: "apple",
  }, "guest-a", "Alex"));
  assert.deepEqual(Object.keys(snapshot.suggestions).sort(), ["pick-1", "pick-3", "pick-5"]);
});
