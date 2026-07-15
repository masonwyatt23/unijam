import { env } from "cloudflare:workers";

import { apiError, apiResponse } from "@/lib/server/api-response";
import { actorHeaders, getRoomRegistry, roomStub, type RoomAuthorityEnv } from "@/lib/server/room-authority";
import { GUEST_SESSION_COOKIE, sessionCookie } from "@/lib/server/session-cookie";
import { hashOpaqueToken, randomToken, timingSafeEqual } from "@/lib/server/secure-token";

type Context = { params: Promise<{ legacyRoomId: string }> };
type ExchangeRow = { legacy_guest_capability_hash: string | null; bearer_exchange_deadline_ms: number; new_room_id: string | null; status: string };

export async function POST(request: Request, context: Context): Promise<Response> {
  if (!env.DB || !env.ROOM_OBJECTS) return apiError("LEGACY_EXCHANGE_UNAVAILABLE", "Legacy invite exchange is unavailable", 404);
  const legacyRoomId = (await context.params).legacyRoomId.trim().toUpperCase();
  const body = await request.json() as { legacyGuestCapability?: unknown; nickname?: unknown };
  const row = await env.DB.prepare(
    `SELECT legacy_guest_capability_hash, bearer_exchange_deadline_ms, new_room_id, status
     FROM legacy_room_imports WHERE legacy_room_id = ? LIMIT 1`,
  ).bind(legacyRoomId).first<ExchangeRow>();
  if (!row || row.status !== "claimed" || !row.new_room_id || !row.legacy_guest_capability_hash || row.bearer_exchange_deadline_ms < Date.now() ||
      typeof body.legacyGuestCapability !== "string" || typeof body.nickname !== "string" ||
      !timingSafeEqual(await hashOpaqueToken(body.legacyGuestCapability), row.legacy_guest_capability_hash)) {
    return apiError("LEGACY_EXCHANGE_UNAVAILABLE", "Legacy invite exchange is unavailable", 404);
  }
  const nickname = body.nickname.trim();
  if (!nickname || nickname.length > 48) return apiError("LEGACY_EXCHANGE_UNAVAILABLE", "Legacy invite exchange is unavailable", 404);
  const runtime = env as RoomAuthorityEnv;
  const registry = await getRoomRegistry(env.DB, row.new_room_id);
  if (!registry) return apiError("LEGACY_EXCHANGE_UNAVAILABLE", "Legacy invite exchange is unavailable", 404);
  const token = randomToken();
  const participantId = `p_${crypto.randomUUID()}`;
  const now = Date.now();
  const ttl = 12 * 60 * 60;
  await env.DB.prepare(
    `INSERT INTO guest_sessions
     (session_id, token_hash, room_id, participant_id, nickname, role, invite_epoch, expires_at_ms, created_at_ms, last_seen_at_ms)
     VALUES (?, ?, ?, ?, ?, 'guest', ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), await hashOpaqueToken(token), row.new_room_id, participantId, nickname, registry.invite_epoch, now + ttl * 1_000, now, now).run();
  const actor = { participantId, role: "guest" as const, nickname };
  await roomStub(runtime, row.new_room_id).fetch(new Request("https://room.internal/commands", {
    method: "POST", headers: { ...Object.fromEntries(actorHeaders(actor, row.new_room_id)), "Content-Type": "application/json" },
    body: JSON.stringify({ commandId: `legacy_join_${crypto.randomUUID()}`, action: "participant.join", payload: {} }),
  }));
  return apiResponse({ roomId: row.new_room_id, participantId, legacyExchanged: true }, {
    status: 201, headers: { "Set-Cookie": sessionCookie(GUEST_SESSION_COOKIE, token, ttl) },
  });
}
