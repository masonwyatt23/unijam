import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { authenticateHost, isRecentPasskey } from "@/lib/server/host-session";
import { actorHeaders, getRoomRegistry, normalizeV1RoomId, roomStub, type RoomAuthorityEnv } from "@/lib/server/room-authority";
import { hashOpaqueToken, randomToken } from "@/lib/server/secure-token";
import { publicAppOrigin } from "@/lib/server/connector-proxy";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("PLATFORM_UNAVAILABLE", "Room authority is unavailable", 503, true);
  const host = await authenticateHost(env.DB, request);
  if (!host || !isRecentPasskey(host)) return apiError("RECENT_PASSKEY_REQUIRED", "Confirm a passkey before rotating an invite", 403);
  const roomId = normalizeV1RoomId((await context.params).roomId);
  const registry = await getRoomRegistry(env.DB, roomId);
  if (!registry || registry.owner_account_id !== host.account_id) return apiError("ROOM_NOT_FOUND", "Room is unavailable", 404);
  const capability = randomToken();
  const nextEpoch = registry.invite_epoch + 1;
  const now = Date.now();
  const runtime = env as RoomAuthorityEnv;
  const authority = await roomStub(runtime, roomId).fetch(new Request("https://room.internal/commands", {
    method: "POST",
    headers: { ...Object.fromEntries(actorHeaders({ participantId: host.account_id, role: "host", nickname: host.display_name }, roomId)), "Content-Type": "application/json", "X-UniJam-Control-Action": "true" },
    // The target epoch is the operation identity. If D1 fails after the DO
    // commits, the retry replays this exact intent and can finalize D1.
    body: JSON.stringify({ commandId: `rotate_${roomId}_${nextEpoch}`, action: "room.invite.rotate", payload: { inviteEpoch: nextEpoch } }),
  }));
  if (!authority.ok) return apiError("INVITE_ROTATION_CONFLICT", "Invite changed in another host session", 409, true);
  const [rotation] = await env.DB.batch([
    env.DB.prepare("UPDATE room_registry SET guest_capability_hash = ?, invite_epoch = ?, updated_at_ms = ? WHERE room_id = ? AND invite_epoch = ?")
      .bind(await hashOpaqueToken(capability), nextEpoch, now, roomId, registry.invite_epoch),
    env.DB.prepare("UPDATE guest_sessions SET revoked_at_ms = ? WHERE room_id = ? AND revoked_at_ms IS NULL").bind(now, roomId),
  ]);
  if ((rotation.meta.changes ?? 0) !== 1) return apiError("INVITE_ROTATION_CONFLICT", "Invite changed in another host session", 409, true);
  return apiResponse({
    roomId,
    inviteEpoch: nextEpoch,
    guestInvite: `${publicAppOrigin(env)}/join/${roomId}#cap=${encodeURIComponent(capability)}`,
    roomEventRecorded: true,
  });
}
