import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { authenticateHost, isRecentPasskey } from "@/lib/server/host-session";
import { actorHeaders, createRoomAuthority, roomStub, type RoomAuthorityEnv } from "@/lib/server/room-authority";
import { hashOpaqueToken, timingSafeEqual } from "@/lib/server/secure-token";
import { publicAppOrigin } from "@/lib/server/connector-proxy";

type Context = { params: Promise<{ legacyRoomId: string }> };
type ImportRow = { legacy_room_id: string; export_hash: string; export_json: string; legacy_host_capability_hash: string; status: string; claim_deadline_ms: number };

export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("PLATFORM_UNAVAILABLE", "Migration is unavailable", 503, true);
  const host = await authenticateHost(env.DB, request);
  if (!host || !isRecentPasskey(host)) return apiError("RECENT_PASSKEY_REQUIRED", "Confirm a passkey before claiming a room", 403);
  const legacyRoomId = (await context.params).legacyRoomId.trim().toUpperCase();
  const body = await request.json() as { legacyHostCapability?: unknown };
  const row = await env.DB.prepare(
    `SELECT legacy_room_id, export_hash, export_json, legacy_host_capability_hash, status, claim_deadline_ms
     FROM legacy_room_imports WHERE legacy_room_id = ? LIMIT 1`,
  ).bind(legacyRoomId).first<ImportRow>();
  if (!row || row.status !== "imported" || row.claim_deadline_ms < Date.now() || typeof body.legacyHostCapability !== "string") {
    return apiError("LEGACY_CLAIM_UNAVAILABLE", "Legacy room cannot be claimed", 404);
  }
  if (!timingSafeEqual(await hashOpaqueToken(body.legacyHostCapability), row.legacy_host_capability_hash)) {
    return apiError("LEGACY_CLAIM_UNAVAILABLE", "Legacy room cannot be claimed", 404);
  }
  const reservationId = crypto.randomUUID();
  const reservedAt = Date.now();
  const reservation = await env.DB.prepare(
    `UPDATE legacy_room_imports SET status = 'claiming', owner_account_id = ?, claim_reservation_id = ?, reserved_at_ms = ?
     WHERE legacy_room_id = ? AND status = 'imported' AND claim_deadline_ms >= ?`,
  ).bind(host.account_id, reservationId, reservedAt, legacyRoomId, reservedAt).run();
  if ((reservation.meta.changes ?? 0) !== 1) return apiError("LEGACY_CLAIM_CONFLICT", "Legacy room was claimed elsewhere", 409);
  const runtime = env as RoomAuthorityEnv;
  let room;
  try { room = await createRoomAuthority(runtime, host.account_id, host.display_name); }
  catch {
    await env.DB.prepare("UPDATE legacy_room_imports SET status = 'imported', owner_account_id = NULL, claim_reservation_id = NULL, reserved_at_ms = NULL WHERE legacy_room_id = ? AND claim_reservation_id = ?")
      .bind(legacyRoomId, reservationId).run();
    return apiError("LEGACY_CLAIM_FAILED", "Legacy room claim could not be completed", 503, true);
  }
  const exportValue = JSON.parse(row.export_json) as Record<string, unknown>;
  const importResponse = await roomStub(runtime, room.roomId).fetch(new Request("https://room.internal/internal/legacy-import", {
    method: "POST",
    headers: { ...Object.fromEntries(actorHeaders({ participantId: host.account_id, role: "host", nickname: host.display_name }, room.roomId)), "Content-Type": "application/json", "X-UniJam-Control-Action": "true" },
    body: JSON.stringify({ exportHash: row.export_hash, export: exportValue }),
  }));
  if (!importResponse.ok) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM room_registry WHERE room_id = ? AND owner_account_id = ?").bind(room.roomId, host.account_id),
      env.DB.prepare("UPDATE legacy_room_imports SET status = 'imported', owner_account_id = NULL, claim_reservation_id = NULL, reserved_at_ms = NULL WHERE legacy_room_id = ? AND claim_reservation_id = ?")
        .bind(legacyRoomId, reservationId),
    ]);
    return apiError("LEGACY_IMPORT_FAILED", "Legacy room data could not be imported into the new room authority", 503, true);
  }
  const now = Date.now();
  const claimed = await env.DB.prepare(
    `UPDATE legacy_room_imports SET status = 'claimed', owner_account_id = ?, new_room_id = ?, claimed_at_ms = ?
     WHERE legacy_room_id = ? AND status = 'claiming' AND claim_reservation_id = ?`,
  ).bind(host.account_id, room.roomId, now, legacyRoomId, reservationId).run();
  if ((claimed.meta.changes ?? 0) !== 1) return apiError("LEGACY_CLAIM_CONFLICT", "Legacy room was claimed elsewhere", 409);
  return apiResponse({
    legacyRoomId, roomId: room.roomId, exportHash: row.export_hash, claimRecorded: true, fullExportImportedIntoAuthority: true,
    guestInvite: `${publicAppOrigin(env)}/join/${room.roomId}#cap=${encodeURIComponent(room.guestCapability)}`,
  }, { status: 201 });
}
