import {
  parseEventCursor,
  validateLiveRoomEventInput,
  validateLiveRoomEventPayload,
  type StoredLiveRoomEvent,
} from "@/lib/live-room-events";
import {
  authorizeLegacyRoomApi,
  authorizeRoomRequest,
  ensureRoomSchema,
  roomDatabase,
} from "@/lib/server/room-store";
import { authorizeParticipantRequest } from "@/lib/server/participant-session";
import { consumeRateLimit } from "@/lib/server/rate-limit";
import {
  parseLiveRoomSnapshot,
  reduceLiveRoomEvent,
  type LiveRoomSnapshot,
} from "@/lib/live-room-snapshot";

type RouteContext = { params: Promise<{ roomId: string }> };

type EventRow = {
  sequence: number;
  room_id: string;
  event_id: string;
  client_id: string;
  actor_name: string;
  event_type: StoredLiveRoomEvent["type"];
  payload_json: string;
  created_at_ms: number;
};

type SnapshotRow = {
  live_snapshot_json: string | null;
  snapshot_sequence: number;
};

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

async function rateLimitRoomEvent(
  db: D1Database,
  roomId: string,
  clientId: string,
  type: StoredLiveRoomEvent["type"],
  now: number,
): Promise<Response | null> {
  const actionLimit = type === "reaction_added" ? 20
    : type === "vote_changed" ? 30
      : type === "suggestion_staged" ? 3
        : 60;
  const actionScope = type === "suggestion_staged" ? "suggestion" : type;
  const policies = [
    { scope: `room:${roomId}:all`, limit: 240 },
    { scope: `room:${roomId}:participant:${clientId}:all`, limit: 60 },
    { scope: `room:${roomId}:participant:${clientId}:${actionScope}`, limit: actionLimit },
  ];
  for (const policy of policies) {
    const decision = await consumeRateLimit(db, { ...policy, windowMs: 60_000, now });
    if (!decision.allowed) {
      return json({
        error: "Room activity is moving too quickly. Try again in a moment.",
        retryAfterSeconds: decision.retryAfterSeconds,
        limit: decision.limit,
      }, 429, { "Retry-After": String(decision.retryAfterSeconds) });
    }
  }
  return null;
}

function storedEvent(row: EventRow): StoredLiveRoomEvent {
  return {
    sequence: row.sequence,
    roomId: row.room_id,
    eventId: row.event_id,
    clientId: row.client_id,
    actorName: row.actor_name,
    type: row.event_type,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAtMs: row.created_at_ms,
  };
}

type SnapshotRefresh = { snapshot: LiveRoomSnapshot; complete: boolean };

async function refreshRoomSnapshot(db: D1Database, roomId: string): Promise<SnapshotRefresh> {
  let committedChunks = 0;
  let casFailures = 0;
  while (committedChunks < 20 && casFailures < 12) {
    const room = await db.prepare(
      "SELECT live_snapshot_json, snapshot_sequence FROM rooms WHERE room_id = ? LIMIT 1",
    ).bind(roomId).first<SnapshotRow>();
    if (!room) throw new Error("Room no longer exists");
    let snapshot = parseLiveRoomSnapshot(room.live_snapshot_json);
    const query = await db.prepare(
      `SELECT sequence, room_id, event_id, client_id, actor_name, event_type, payload_json, created_at_ms
       FROM room_events WHERE room_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 500`,
    ).bind(roomId, snapshot.sequence).all<EventRow>();
    const events = (query.results ?? []).map(storedEvent);
    if (events.length === 0) return { snapshot, complete: true };
    for (const event of events) snapshot = reduceLiveRoomEvent(snapshot, event);
    const update = await db.prepare(
      `UPDATE rooms SET live_snapshot_json = ?, snapshot_sequence = ?
       WHERE room_id = ? AND snapshot_sequence = ?`,
    ).bind(JSON.stringify(snapshot), snapshot.sequence, roomId, room.snapshot_sequence).run();
    if ((update.meta.changes ?? 0) === 1) committedChunks += 1;
    else casFailures += 1;
  }
  const latest = await db.prepare(
    "SELECT live_snapshot_json FROM rooms WHERE room_id = ? LIMIT 1",
  ).bind(roomId).first<{ live_snapshot_json: string | null }>();
  const snapshot = parseLiveRoomSnapshot(latest?.live_snapshot_json);
  const pending = await db.prepare(
    "SELECT sequence FROM room_events WHERE room_id = ? AND sequence > ? ORDER BY sequence ASC LIMIT 1",
  ).bind(roomId, snapshot.sequence).first<{ sequence: number }>();
  return { snapshot, complete: !pending };
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    if (!authorizeLegacyRoomApi(request)) return json({ error: "Legacy room API is disabled" }, 404);
    const db = roomDatabase();
    if (!db) return json({ error: "Room persistence is not configured", mode: "local" }, 503);
    const roomId = (await context.params).roomId;
    const after = parseEventCursor(new URL(request.url).searchParams.get("after"));
    await ensureRoomSchema(db);
    const authorization = await authorizeParticipantRequest(db, request, roomId)
      ?? await authorizeRoomRequest(db, request, roomId);
    if (!authorization) return json({ error: "Room capability is missing or invalid" }, 401);
    const authorizedRoomId = authorization.room.room_id;
    const refreshed = await refreshRoomSnapshot(db, authorizedRoomId);
    const snapshot = refreshed.snapshot;
    const reset = after === 0 || after < snapshot.sequence;
    const eventCursor = reset ? snapshot.sequence : after;
    const query = await db.prepare(
      `SELECT sequence, room_id, event_id, client_id, actor_name, event_type, payload_json, created_at_ms
       FROM room_events
       WHERE room_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT 200`,
    ).bind(authorizedRoomId, eventCursor).all<EventRow>();
    const events = (query.results ?? []).map(storedEvent);
    const serverNowMs = Date.now();
    const activeParticipants = await db.prepare(
      `SELECT participant_id FROM room_participants
       WHERE room_id = ? AND expires_at_ms > ? AND last_seen_at_ms >= ?
       ORDER BY created_at_ms ASC LIMIT 100`,
    ).bind(authorizedRoomId, serverNowMs, serverNowMs - 45_000).all<{ participant_id: string }>();
    return json({
      events,
      cursor: events.at(-1)?.sequence ?? eventCursor,
      hasMore: events.length === 200,
      reset,
      snapshot: reset ? snapshot : undefined,
      snapshotComplete: refreshed.complete,
      serverNowMs,
      activeParticipantIds: (activeParticipants.results ?? []).map(({ participant_id }) => participant_id),
      role: authorization.role,
      room: {
        guestCanContribute: authorization.room.guest_can_contribute === 1,
        locked: authorization.room.locked === 1,
        hostApproval: authorization.room.host_approval === 1,
      },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to read room events" }, 400);
  }
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  try {
    if (!authorizeLegacyRoomApi(request)) return json({ error: "Legacy room API is disabled" }, 404);
    const db = roomDatabase();
    if (!db) return json({ error: "Room persistence is not configured", mode: "local" }, 503);
    const roomId = (await context.params).roomId;
    const input = validateLiveRoomEventInput(await request.json());
    await ensureRoomSchema(db);
    const participantAuthorization = await authorizeParticipantRequest(db, request, roomId);
    if (!participantAuthorization) {
      return json({ error: "Establish a participant session before publishing room actions" }, 401);
    }
    const authorization = participantAuthorization;
    const authorizedRoomId = authorization.room.room_id;
    const clientId = participantAuthorization.participant.participant_id;
    const actorName = participantAuthorization.participant.nickname;
    const guestReadOnly = participantAuthorization.participantRole === "viewer";
    let payload;
    try {
      payload = validateLiveRoomEventPayload(input.type, input.payload, authorization.role);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Event is not permitted" }, 403);
    }
    const existingEvent = await db.prepare(
      `SELECT sequence, room_id, event_id, client_id, actor_name, event_type, payload_json, created_at_ms
       FROM room_events WHERE room_id = ? AND event_id = ? LIMIT 1`,
    ).bind(authorizedRoomId, input.eventId).first<EventRow>();
    if (existingEvent) {
      const existingPayload = JSON.parse(existingEvent.payload_json) as Record<string, unknown>;
      const exactIntent = existingEvent.event_type === input.type &&
        JSON.stringify(existingPayload) === JSON.stringify(payload);
      const autoApprovedIntent = input.type === "suggestion_staged" &&
        existingEvent.event_type === "suggestion_approved" &&
        existingPayload.suggestionId === payload.suggestionId &&
        existingPayload.title === payload.title &&
        existingPayload.service === payload.service &&
        existingPayload.submittedBy === actorName;
      const conflicts = existingEvent.client_id !== clientId ||
        existingEvent.actor_name !== actorName ||
        (!exactIntent && !autoApprovedIntent);
      if (conflicts) return json({ error: "Event ID was already used for different content" }, 409);
      const refreshed = await refreshRoomSnapshot(db, authorizedRoomId);
      return json({ event: storedEvent(existingEvent), duplicate: true, snapshot: refreshed.snapshot, snapshotComplete: refreshed.complete });
    }

    if (guestReadOnly && input.type !== "participant_joined" && input.type !== "participant_service_changed" && input.type !== "participant_left") {
      return json({ error: "This room capability is viewing only" }, 403);
    }
    let storedType = input.type;
    let storedPayload = payload;
    if (
      authorization.role === "guest" &&
      authorization.room.host_approval !== 1 &&
      input.type === "suggestion_staged"
    ) {
      storedType = "suggestion_approved";
      storedPayload = validateLiveRoomEventPayload("suggestion_approved", {
        ...payload,
        submittedBy: actorName,
      }, "host");
    }

    const createdAtMs = Date.now();
    const limited = await rateLimitRoomEvent(db, authorizedRoomId, clientId, input.type, createdAtMs);
    if (limited) return limited;
    const currentRefresh = await refreshRoomSnapshot(db, authorizedRoomId);
    if (!currentRefresh.complete) {
      return json({ error: "Room state is catching up. Retry this action shortly." }, 503, { "Retry-After": "1" });
    }
    const currentSnapshot = currentRefresh.snapshot;
    const participant = currentSnapshot.participants[clientId];
    if (participant && (participant.name !== actorName || participant.role !== authorization.role)) {
      return json({ error: "Participant identity does not match the joined room identity" }, 409);
    }
    if (!participant && input.type !== "participant_joined") {
      return json({ error: "Join the room before publishing room actions" }, 409);
    }
    const currentTrackId = (currentSnapshot.nowTrackIndex % 5) + 1;
    const payloadTrackId = typeof storedPayload.trackId === "number" ? storedPayload.trackId : undefined;
    if (
      (input.type === "ready_changed" || input.type === "reaction_added" || input.type === "handoff_requested" || input.type === "playback_confirmed") &&
      payloadTrackId !== currentTrackId
    ) {
      return json({ error: "That action targeted a track that is no longer current" }, 409);
    }
    if (input.type === "vote_changed") {
      const trackId = String(storedPayload.trackId);
      const alreadyVoted = currentSnapshot.votes[trackId]?.includes(clientId) ?? false;
      const addingVote = storedPayload.delta === 1;
      if (alreadyVoted === addingVote) {
        return json({ error: addingVote ? "This participant already voted for that track" : "This participant has not voted for that track" }, 409);
      }
    }
    if (input.type === "suggestion_staged") {
      const suggestionId = String(storedPayload.suggestionId);
      if (currentSnapshot.suggestions[suggestionId]) {
        return json({ error: "That suggestion already exists" }, 409);
      }
      const usedPicks = Object.values(currentSnapshot.suggestions)
        .filter((suggestion) => suggestion.clientId === clientId).length;
      if (authorization.role === "guest" && usedPicks >= 3) {
        return json({ error: "This participant has used all 3 picks for the round" }, 409);
      }
    }
    if (input.type === "suggestion_approved") {
      const suggestion = currentSnapshot.suggestions[String(storedPayload.suggestionId)];
      if (suggestion?.status === "approved") return json({ error: "That suggestion is already approved" }, 409);
    }
    if (input.type === "suggestion_rejected") {
      const suggestion = currentSnapshot.suggestions[String(storedPayload.suggestionId)];
      if (!suggestion || suggestion.status !== "pending") {
        return json({ error: "Only a pending suggestion can be passed" }, 409);
      }
    }
    if (input.type === "playback_confirmed" && (
      currentSnapshot.phase !== "handoff" || storedPayload.service !== currentSnapshot.speakerService
    )) {
      return json({ error: "Confirm playback only after the active speaker handoff" }, 409);
    }
    if (input.type === "track_advanced") {
      const expectedIndex = (currentSnapshot.nowTrackIndex + 1) % 5;
      if (storedPayload.trackIndex !== expectedIndex) {
        return json({ error: "The queue advanced elsewhere; refresh before advancing again" }, 409);
      }
    }
    const insert = await db.prepare(
      `INSERT OR IGNORE INTO room_events
       (room_id, event_id, client_id, actor_name, event_type, payload_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      authorizedRoomId,
      input.eventId,
      clientId,
      actorName,
      storedType,
      JSON.stringify(storedPayload),
      createdAtMs,
    ).run();
    const row = await db.prepare(
      `SELECT sequence, room_id, event_id, client_id, actor_name, event_type, payload_json, created_at_ms
       FROM room_events WHERE room_id = ? AND event_id = ? LIMIT 1`,
    ).bind(authorizedRoomId, input.eventId).first<EventRow>();
    if (!row) return json({ error: "Event could not be stored" }, 500);
    const duplicate = (insert.meta.changes ?? 0) === 0;
    if (duplicate) {
      const conflicts = row.client_id !== clientId ||
        row.actor_name !== actorName ||
        row.event_type !== storedType ||
        JSON.stringify(JSON.parse(row.payload_json)) !== JSON.stringify(storedPayload);
      if (conflicts) return json({ error: "Event ID was already used for different content" }, 409);
    }
    if (input.type === "participant_service_changed" && typeof storedPayload.service === "string") {
      await db.prepare(
        "UPDATE room_participants SET preferred_service = ?, updated_at_ms = ? WHERE participant_id = ?",
      ).bind(storedPayload.service, createdAtMs, clientId).run();
    }
    const refreshed = await refreshRoomSnapshot(db, authorizedRoomId);
    return json({ event: storedEvent(row), duplicate, snapshot: refreshed.snapshot, snapshotComplete: refreshed.complete }, duplicate ? 200 : 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to store room event" }, 400);
  }
}
