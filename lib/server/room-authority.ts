import type { RoomActor } from "../platform/protocol.ts";
import { authenticateHost } from "./host-session.ts";
import { GUEST_SESSION_COOKIE, readCookie, sessionCookie } from "./session-cookie.ts";
import { hashOpaqueToken, randomToken, timingSafeEqual } from "./secure-token.ts";

export type RoomAuthorityEnv = Cloudflare.Env & {
  DB: D1Database;
  ROOM_OBJECTS: DurableObjectNamespace;
};

type RegistryRow = {
  room_id: string;
  owner_account_id: string;
  durable_object_id: string;
  guest_capability_hash: string;
  invite_epoch: number;
  lifecycle: string;
};

type GuestRow = {
  session_id: string;
  participant_id: string;
  account_id: string | null;
  nickname: string;
  role: RoomActor["role"];
  invite_epoch: number;
  expires_at_ms: number;
};

export class GuestCapabilityError extends Error {
  constructor(readonly code: "INVITE_INVALID" | "INVITE_INVALID_OR_ROTATED" | "ROOM_ENDED" | "INVALID_NICKNAME" | "ROOM_FULL", message: string, readonly status: number) {
    super(message);
    this.name = "GuestCapabilityError";
  }
}

export type RoomSessionContext = {
  kind: "host" | "guest";
  sessionId: string;
  /** The account bound to this exact authenticated session, when one exists. */
  accountId: string | null;
  expiresAtMs: number;
  inviteEpoch: number;
};

export async function getRoomRegistry(db: D1Database, roomId: string): Promise<RegistryRow | null> {
  return db.prepare(
    `SELECT room_id, owner_account_id, durable_object_id, guest_capability_hash, invite_epoch, lifecycle
     FROM room_registry WHERE room_id = ? LIMIT 1`,
  ).bind(roomId).first<RegistryRow>();
}

export function normalizeV1RoomId(value: string): string {
  const roomId = value.trim().toUpperCase();
  if (!/^[A-Z0-9]{6,16}$/.test(roomId)) throw new Error("Room ID is malformed");
  return roomId;
}

export async function createRoomAuthority(
  env: RoomAuthorityEnv,
  ownerAccountId: string,
  nickname: string,
): Promise<{ roomId: string; guestCapability: string; stub: DurableObjectStub }> {
  let roomId = "";
  for (let attempts = 0; attempts < 8; attempts += 1) {
    roomId = randomToken(7).replace(/[^A-Z0-9]/gi, "").toUpperCase().slice(0, 8).padEnd(8, "U");
    if (!(await getRoomRegistry(env.DB, roomId))) break;
  }
  if (!roomId) throw new Error("Unable to allocate room identity");
  const guestCapability = randomToken();
  const durableId = env.ROOM_OBJECTS.idFromName(roomId);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO room_registry
     (room_id, owner_account_id, durable_object_id, guest_capability_hash, invite_epoch, lifecycle, created_at_ms, updated_at_ms)
     VALUES (?, ?, ?, ?, 1, 'active', ?, ?)`,
  ).bind(roomId, ownerAccountId, durableId.toString(), await hashOpaqueToken(guestCapability), now, now).run();
  const stub = env.ROOM_OBJECTS.get(durableId);
  const response = await stub.fetch(new Request("https://room.internal/internal/initialize", {
    method: "POST",
    headers: actorHeaders({ participantId: ownerAccountId, role: "host", nickname }, roomId),
  }));
  if (!response.ok) throw new Error("Room authority could not be initialized");
  return { roomId, guestCapability, stub };
}

export async function authenticateRoomActor(
  env: RoomAuthorityEnv,
  request: Request,
  roomId: string,
  options: { allowEndedOwner?: boolean } = {},
): Promise<{ actor: RoomActor; registry: RegistryRow; session: RoomSessionContext } | null> {
  const registry = await getRoomRegistry(env.DB, roomId);
  if (!registry || registry.lifecycle !== "active" && !options.allowEndedOwner) return null;
  const host = await authenticateHost(env.DB, request);
  if (host?.account_id === registry.owner_account_id) {
    return {
      actor: { participantId: host.account_id, role: "host", nickname: host.display_name }, registry,
      session: { kind: "host", sessionId: host.session_id, accountId: host.account_id, expiresAtMs: host.expires_at_ms, inviteEpoch: registry.invite_epoch },
    };
  }
  if (registry.lifecycle !== "active") return null;
  const token = readCookie(request, GUEST_SESSION_COOKIE);
  if (!token) return null;
  const guest = await env.DB.prepare(
    `SELECT session_id, participant_id, account_id, nickname, role, invite_epoch, expires_at_ms FROM guest_sessions
     WHERE token_hash = ? AND room_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ? LIMIT 1`,
  ).bind(await hashOpaqueToken(token), roomId, Date.now()).first<GuestRow>();
  if (!guest || guest.invite_epoch !== registry.invite_epoch) return null;
  await env.DB.prepare("UPDATE guest_sessions SET last_seen_at_ms = ? WHERE session_id = ?")
    .bind(Date.now(), guest.session_id).run();
  return {
    actor: { participantId: guest.participant_id, role: guest.role, nickname: guest.nickname }, registry,
    session: { kind: "guest", sessionId: guest.session_id, accountId: guest.account_id, expiresAtMs: guest.expires_at_ms, inviteEpoch: guest.invite_epoch },
  };
}

export async function exchangeGuestCapability(
  env: RoomAuthorityEnv,
  roomId: string,
  capability: string,
  nickname: string,
  accountId: string | null = null,
): Promise<{ actor: RoomActor; cookie: string; sessionId: string }> {
  const registry = await getRoomRegistry(env.DB, roomId);
  if (!registry) throw new GuestCapabilityError("INVITE_INVALID", "This invite does not identify an available room", 401);
  if (registry.lifecycle !== "active") throw new GuestCapabilityError("ROOM_ENDED", "This room has ended", 410);
  const suppliedHash = await hashOpaqueToken(capability);
  if (!timingSafeEqual(suppliedHash, registry.guest_capability_hash)) {
    throw new GuestCapabilityError("INVITE_INVALID_OR_ROTATED", "This invite is invalid or was replaced by the host", 401);
  }
  const cleanedNickname = nickname.trim();
  if (!cleanedNickname || cleanedNickname.length > 48) {
    throw new GuestCapabilityError("INVALID_NICKNAME", "Nickname must contain 1-48 characters", 400);
  }
  const token = randomToken();
  const sessionId = crypto.randomUUID();
  const participantId = `p_${crypto.randomUUID()}`;
  const now = Date.now();
  const ttl = 12 * 60 * 60;
  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO guest_sessions
       (session_id, token_hash, room_id, participant_id, account_id, nickname, role, invite_epoch, expires_at_ms, created_at_ms, last_seen_at_ms)
       SELECT ?, ?, ?, ?, ?, ?, 'guest', ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM guest_sessions WHERE room_id = ? AND revoked_at_ms IS NULL AND expires_at_ms > ?) < 25`,
    ).bind(
      sessionId, await hashOpaqueToken(token), roomId, participantId, accountId, cleanedNickname,
      registry.invite_epoch, now + ttl * 1_000, now, now, roomId, now,
    ),
    env.DB.prepare(
      `INSERT INTO room_memberships
       (membership_id, account_id, room_id, participant_id, nickname, joined_at_ms, last_joined_at_ms)
       SELECT ?, account_id, room_id, participant_id, nickname, ?, ?
       FROM guest_sessions
       WHERE session_id = ? AND account_id IS NOT NULL
       ON CONFLICT(account_id, room_id) DO UPDATE SET
         participant_id = excluded.participant_id,
         nickname = excluded.nickname,
         last_joined_at_ms = excluded.last_joined_at_ms`,
    ).bind(crypto.randomUUID(), now, now, sessionId),
  ]);
  if ((inserted.meta.changes ?? 0) !== 1) throw new GuestCapabilityError("ROOM_FULL", "This room has reached its participant limit", 409);
  return {
    actor: { participantId, role: "guest", nickname: cleanedNickname },
    cookie: sessionCookie(GUEST_SESSION_COOKIE, token, ttl),
    sessionId,
  };
}

export function roomStub(env: RoomAuthorityEnv, roomId: string): DurableObjectStub {
  return env.ROOM_OBJECTS.get(env.ROOM_OBJECTS.idFromName(roomId));
}

export function actorHeaders(actor: RoomActor, roomId?: string, session?: RoomSessionContext): Headers {
  const headers = new Headers({
    "X-UniJam-Participant-Id": actor.participantId,
    "X-UniJam-Role": actor.role,
    "X-UniJam-Nickname": actor.nickname,
  });
  if (roomId) headers.set("X-UniJam-Room-Id", roomId);
  if (session) {
    headers.set("X-UniJam-Session-Kind", session.kind);
    headers.set("X-UniJam-Session-Id", session.sessionId);
    headers.set("X-UniJam-Session-Expires-At", String(session.expiresAtMs));
    headers.set("X-UniJam-Invite-Epoch", String(session.inviteEpoch));
  }
  return headers;
}

export async function forwardRoomAuthority(
  env: RoomAuthorityEnv,
  request: Request,
  roomId: string,
  internalPath: string,
): Promise<Response> {
  const authorization = await authenticateRoomActor(env, request, roomId);
  if (!authorization) return new Response("Unauthorized", { status: 401 });
  const headers = actorHeaders(authorization.actor, roomId, authorization.session);
  for (const name of ["Content-Type", "Upgrade", "Sec-WebSocket-Protocol", "Sec-WebSocket-Key", "Sec-WebSocket-Version", "Connection"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const target = new URL(internalPath, "https://room.internal");
  const sourceUrl = new URL(request.url);
  target.search = sourceUrl.search;
  return roomStub(env, roomId).fetch(new Request(target, {
    method: request.method,
    headers,
    body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
  }));
}
