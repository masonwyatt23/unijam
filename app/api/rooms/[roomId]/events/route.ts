import {
  parseEventCursor,
  validateLiveRoomEventInput,
  validateLiveRoomEventPayload,
  type StoredLiveRoomEvent,
} from "@/lib/live-room-events";
import {
  authorizeRoomRequest,
  ensureRoomSchema,
  roomDatabase,
} from "@/lib/server/room-store";

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

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
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

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  try {
    const db = roomDatabase();
    if (!db) return json({ error: "Room persistence is not configured", mode: "local" }, 503);
    const roomId = (await context.params).roomId;
    const after = parseEventCursor(new URL(request.url).searchParams.get("after"));
    await ensureRoomSchema(db);
    const authorization = await authorizeRoomRequest(db, request, roomId);
    if (!authorization) return json({ error: "Room capability is missing or invalid" }, 401);
    const authorizedRoomId = authorization.room.room_id;
    const query = await db.prepare(
      `SELECT sequence, room_id, event_id, client_id, actor_name, event_type, payload_json, created_at_ms
       FROM room_events
       WHERE room_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT 200`,
    ).bind(authorizedRoomId, after).all<EventRow>();
    const events = (query.results ?? []).map(storedEvent);
    return json({
      events,
      cursor: events.at(-1)?.sequence ?? after,
      hasMore: events.length === 200,
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
    const db = roomDatabase();
    if (!db) return json({ error: "Room persistence is not configured", mode: "local" }, 503);
    const roomId = (await context.params).roomId;
    const input = validateLiveRoomEventInput(await request.json());
    await ensureRoomSchema(db);
    const authorization = await authorizeRoomRequest(db, request, roomId);
    if (!authorization) return json({ error: "Room capability is missing or invalid" }, 401);
    const authorizedRoomId = authorization.room.room_id;
    const guestReadOnly = authorization.role === "guest" && (
      authorization.room.guest_can_contribute !== 1 || authorization.room.locked === 1
    );
    if (guestReadOnly && input.type !== "participant_joined" && input.type !== "handoff_requested") {
      return json({ error: "This room capability is viewing only" }, 403);
    }
    let payload;
    try {
      payload = validateLiveRoomEventPayload(input.type, input.payload, authorization.role);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : "Event is not permitted" }, 403);
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
        submittedBy: input.actorName,
      }, "host");
    }
    const createdAtMs = Date.now();
    const insert = await db.prepare(
      `INSERT OR IGNORE INTO room_events
       (room_id, event_id, client_id, actor_name, event_type, payload_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      authorizedRoomId,
      input.eventId,
      input.clientId,
      input.actorName,
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
      const conflicts = row.client_id !== input.clientId ||
        row.actor_name !== input.actorName ||
        row.event_type !== storedType ||
        JSON.stringify(JSON.parse(row.payload_json)) !== JSON.stringify(storedPayload);
      if (conflicts) return json({ error: "Event ID was already used for different content" }, 409);
    }
    return json({ event: storedEvent(row), duplicate }, duplicate ? 200 : 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to store room event" }, 400);
  }
}
