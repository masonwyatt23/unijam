import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { authenticateHost, isRecentPasskey } from "@/lib/server/host-session";
import { actorHeaders, getRoomRegistry, normalizeV1RoomId, roomStub, type RoomAuthorityEnv } from "@/lib/server/room-authority";

type Context = { params: Promise<{ roomId: string }> };
export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("PLATFORM_UNAVAILABLE", "Room authority is unavailable", 503, true);
  const host = await authenticateHost(env.DB, request);
  if (!host || !isRecentPasskey(host)) return apiError("RECENT_PASSKEY_REQUIRED", "Confirm a passkey before ending a room", 403);
  const roomId = normalizeV1RoomId((await context.params).roomId);
  const registry = await getRoomRegistry(env.DB, roomId);
  if (!registry || registry.owner_account_id !== host.account_id) return apiError("ROOM_NOT_FOUND", "Room is unavailable", 404);
  const now = Date.now();
  const runtime = env as RoomAuthorityEnv;
  const authority = await roomStub(runtime, roomId).fetch(new Request("https://room.internal/commands", {
    method: "POST",
    headers: { ...Object.fromEntries(actorHeaders({ participantId: host.account_id, role: "host", nickname: host.display_name }, roomId)), "Content-Type": "application/json", "X-UniJam-Control-Action": "true" },
    // Deterministic control IDs let a retry receive the original DO result and
    // finish the D1 projection if the first request stopped between phases.
    body: JSON.stringify({ commandId: `end_${roomId}_v1`, action: "room.end", payload: {} }),
  }));
  if (!authority.ok) return apiError("ROOM_END_CONFLICT", "Room could not be ended from its latest canonical state", 409, true);
  const authorityBody = await authority.json().catch(() => null) as {
    events?: Array<{ type?: string; createdAtMs?: number }>;
  } | null;
  const canonicalEndedAt = authorityBody?.events?.find((event) => event.type === "room.ended")?.createdAtMs;
  const endedAtMs = typeof canonicalEndedAt === "number" && Number.isSafeInteger(canonicalEndedAt) ? canonicalEndedAt : now;
  await env.DB.batch([
    env.DB.prepare("UPDATE room_registry SET lifecycle = 'ended', ended_at_ms = COALESCE(ended_at_ms, ?), updated_at_ms = ? WHERE room_id = ?").bind(endedAtMs, now, roomId),
    env.DB.prepare("UPDATE guest_sessions SET revoked_at_ms = ? WHERE room_id = ? AND revoked_at_ms IS NULL").bind(now, roomId),
  ]);
  return apiResponse({ roomId, ended: true, roomEventRecorded: true });
}
