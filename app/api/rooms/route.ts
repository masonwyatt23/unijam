import {
  ensureRoomSchema,
  hashCapabilityToken,
  normalizeCapabilityToken,
  roomDatabase,
  type RoomRecord,
} from "@/lib/server/room-store";
import { normalizeRoomId } from "@/lib/live-room-events";

type BootstrapInput = {
  roomId?: unknown;
  hostToken?: unknown;
  guestToken?: unknown;
  guestCanContribute?: unknown;
  locked?: unknown;
  hostApproval?: unknown;
  guestExpiresAtMs?: unknown;
  expectedRevision?: unknown;
};

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const db = roomDatabase();
    if (!db) return json({ error: "Room persistence is not configured", mode: "local" }, 503);
    const input = await request.json() as BootstrapInput;
    const roomId = normalizeRoomId(String(input.roomId ?? ""));
    const hostToken = normalizeCapabilityToken(input.hostToken, "hostToken");
    const guestToken = normalizeCapabilityToken(input.guestToken, "guestToken");
    const expectedRevision = Number(input.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return json({ error: "expectedRevision must be a non-negative safe integer" }, 400);
    }
    if (typeof input.guestCanContribute !== "boolean" || typeof input.locked !== "boolean" || typeof input.hostApproval !== "boolean") {
      return json({ error: "Room settings must be boolean" }, 400);
    }
    const guestExpiresAtMs = input.guestExpiresAtMs === null
      ? null
      : Number.isSafeInteger(input.guestExpiresAtMs) && Number(input.guestExpiresAtMs) > Date.now()
        ? Number(input.guestExpiresAtMs)
        : undefined;
    if (guestExpiresAtMs === undefined) return json({ error: "guestExpiresAtMs must be null or a future timestamp" }, 400);
    await ensureRoomSchema(db);
    const now = Date.now();
    const hostHash = await hashCapabilityToken(hostToken);
    const guestHash = await hashCapabilityToken(guestToken);
    const insert = await db.prepare(
      `INSERT OR IGNORE INTO rooms
       (room_id, host_token_hash, guest_token_hash, guest_can_contribute, locked, host_approval, guest_expires_at_ms, revision, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      roomId,
      hostHash,
      guestHash,
      input.guestCanContribute ? 1 : 0,
      input.locked ? 1 : 0,
      input.hostApproval ? 1 : 0,
      guestExpiresAtMs,
      now,
      now,
    ).run();
    const existing = await db.prepare(
      `SELECT room_id, host_token_hash, guest_token_hash, guest_can_contribute, locked, host_approval, guest_expires_at_ms, revision, created_at_ms, updated_at_ms
       FROM rooms WHERE room_id = ? LIMIT 1`,
    ).bind(roomId).first<RoomRecord>();
    if (!existing || existing.host_token_hash !== hostHash) {
      return json({ error: "Room identity already exists with different capabilities" }, 409);
    }
    let revision = 1;
    if ((insert.meta.changes ?? 0) === 0) {
      if (existing.revision !== expectedRevision) {
        const desiredStateAlreadyCommitted =
          existing.guest_token_hash === guestHash &&
          existing.guest_can_contribute === (input.guestCanContribute ? 1 : 0) &&
          existing.locked === (input.locked ? 1 : 0) &&
          existing.host_approval === (input.hostApproval ? 1 : 0) &&
          existing.guest_expires_at_ms === guestExpiresAtMs;
        if (desiredStateAlreadyCommitted) {
          return json({
            roomId,
            revision: existing.revision,
            guestCanContribute: input.guestCanContribute,
            locked: input.locked,
            hostApproval: input.hostApproval,
            guestExpiresAtMs,
            recovered: true,
          });
        }
        return json({ error: "Room changed in another host session", currentRevision: existing.revision }, 409);
      }
      const update = await db.prepare(
        `UPDATE rooms SET guest_token_hash = ?, guest_can_contribute = ?, locked = ?, host_approval = ?, guest_expires_at_ms = ?, updated_at_ms = ?, revision = revision + 1
         WHERE room_id = ? AND host_token_hash = ? AND revision = ?`,
      ).bind(
        guestHash,
        input.guestCanContribute ? 1 : 0,
        input.locked ? 1 : 0,
        input.hostApproval ? 1 : 0,
        guestExpiresAtMs,
        now,
        roomId,
        hostHash,
        expectedRevision,
      ).run();
      if ((update.meta.changes ?? 0) !== 1) {
        return json({ error: "Room changed while saving" }, 409);
      }
      revision = expectedRevision + 1;
    }
    return json({
      roomId,
      revision,
      guestCanContribute: input.guestCanContribute,
      locked: input.locked,
      hostApproval: input.hostApproval,
      guestExpiresAtMs,
    }, 201);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Unable to create room" }, 400);
  }
}
