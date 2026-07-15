import { env } from "cloudflare:workers";

import { apiError, apiResponse, redactedInternalError } from "@/lib/server/api-response";
import { authenticateHost } from "@/lib/server/host-session";
import { publicAppOrigin } from "@/lib/server/connector-proxy";
import { actorHeaders, createRoomAuthority, type RoomAuthorityEnv } from "@/lib/server/room-authority";

export async function POST(request: Request): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("PLATFORM_UNAVAILABLE", "Room authority is unavailable", 503, true);
  const host = await authenticateHost(env.DB, request);
  if (!host) return apiError("UNAUTHENTICATED", "Sign in with a passkey to create a room", 401);
  try {
    const body = await request.json() as { rules?: Record<string, unknown> };
    const rules = body.rules;
    if (!rules || !Number.isSafeInteger(rules.contributionLimit) || Number(rules.contributionLimit) < 0 || Number(rules.contributionLimit) > 20 ||
      !["host", "open"].includes(String(rules.approvalMode)) || !["allow", "hold"].includes(String(rules.explicitContent)) ||
      !["original", "any"].includes(String(rules.versionPreference))) {
      return apiError("INVALID_ROOM_RULES", "Room rules are invalid", 400);
    }
    const runtime = env as RoomAuthorityEnv;
    const room = await createRoomAuthority(runtime, host.account_id, host.display_name);
    const rulesResponse = await room.stub.fetch(new Request("https://room.internal/commands", {
      method: "POST",
      headers: { ...Object.fromEntries(actorHeaders({ participantId: host.account_id, role: "host", nickname: host.display_name }, room.roomId)), "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: `create_rules_${crypto.randomUUID()}`, action: "room.rules.update", payload: { rules } }),
    }));
    if (!rulesResponse.ok) {
      await env.DB.prepare("DELETE FROM room_registry WHERE room_id = ? AND owner_account_id = ?").bind(room.roomId, host.account_id).run();
      return apiError("ROOM_RULES_FAILED", "Room rules could not be saved", 503, true);
    }
    const origin = publicAppOrigin(env);
    return apiResponse({
      roomId: room.roomId,
      roomUrl: `${origin}/room/${room.roomId}`,
      guestInvite: `${origin}/join/${room.roomId}#cap=${encodeURIComponent(room.guestCapability)}`,
    }, { status: 201 });
  } catch (error) {
    return redactedInternalError(error, "ROOM_CREATE_FAILED", "Unable to create room", 500, true);
  }
}
