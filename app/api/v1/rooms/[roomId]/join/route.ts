import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { exchangeGuestCapability, GuestCapabilityError, normalizeV1RoomId, roomStub, actorHeaders, type RoomAuthorityEnv } from "@/lib/server/room-authority";
import { consumeAuthRateLimit, requestIp } from "@/lib/server/auth-rate-limit";
import { hashOpaqueToken } from "@/lib/server/secure-token";
import { authenticateHost } from "@/lib/server/host-session";

type RouteContext = { params: Promise<{ roomId: string }> };

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("PLATFORM_UNAVAILABLE", "Room authority is unavailable", 503, true);
  try {
    const roomId = normalizeV1RoomId((await context.params).roomId);
    const body = await request.json() as { capability?: unknown; nickname?: unknown };
    if (typeof body.capability !== "string" || typeof body.nickname !== "string") {
      return apiError("INVALID_INVITE_EXCHANGE", "Invite capability and nickname are required", 400);
    }
    const capabilityFingerprint = await hashOpaqueToken(body.capability);
    const [ipAllowed, capabilityAllowed] = await Promise.all([
      consumeAuthRateLimit(env.DB, `guest-join-ip:${requestIp(request)}`, 20, 15 * 60_000),
      consumeAuthRateLimit(env.DB, `guest-join-capability:${capabilityFingerprint}`, 40, 15 * 60_000),
    ]);
    if (!ipAllowed || !capabilityAllowed) return apiError("JOIN_RATE_LIMITED", "Too many join attempts; try again later", 429, true);
    const runtime = env as RoomAuthorityEnv;
    // An account enriches a successful invite exchange; it never grants room
    // entry or changes the room-scoped participant role by itself.
    const account = await authenticateHost(env.DB, request);
    const session = await exchangeGuestCapability(runtime, roomId, body.capability, body.nickname, account?.account_id ?? null);
    const joined = await roomStub(runtime, roomId).fetch(new Request("https://room.internal/commands", {
      method: "POST",
      headers: { ...Object.fromEntries(actorHeaders(session.actor, roomId)), "Content-Type": "application/json" },
      body: JSON.stringify({ commandId: `join_${crypto.randomUUID()}`, action: "participant.join", payload: {} }),
    }));
    if (!joined.ok) {
      await env.DB.batch([
        env.DB.prepare("UPDATE guest_sessions SET revoked_at_ms = ? WHERE session_id = ? AND revoked_at_ms IS NULL")
          .bind(Date.now(), session.sessionId),
        env.DB.prepare("DELETE FROM room_memberships WHERE room_id = ? AND participant_id = ?")
          .bind(roomId, session.actor.participantId),
      ]);
      const rejection = await joined.json().catch(() => null) as { code?: string; message?: string } | null;
      const code = rejection?.code === "ROOM_LOCKED" || rejection?.code === "ROOM_FULL" ? rejection.code : "ROOM_JOIN_FAILED";
      return apiError(code, rejection?.message ?? "Room rejected the participant session", joined.status);
    }
    return apiResponse({ roomId, participantId: session.actor.participantId, role: session.actor.role }, {
      status: 201,
      headers: { "Set-Cookie": session.cookie },
    });
  } catch (cause) {
    if (cause instanceof GuestCapabilityError) return apiError(cause.code, cause.message, cause.status);
    return apiError("INVALID_INVITE_EXCHANGE", "The invite exchange request is invalid", 400);
  }
}
