import { normalizeRoomId, type RoomCapabilityRole } from "../live-room-events.ts";
import {
  hashCapabilityToken,
  normalizeCapabilityToken,
  type AuthorizedRoom,
  type ParticipantRecord,
  type RoomRecord,
} from "./room-store.ts";
import { consumeRateLimit } from "./rate-limit.ts";

export const PARTICIPANT_SESSION_TTL_MS = 6 * 60 * 60 * 1_000;
export const PARTICIPANT_HEARTBEAT_WRITE_INTERVAL_MS = 30_000;

export type ParticipantService = "spotify" | "apple" | "ask";
export type ParticipantRole = "host" | "editor" | "viewer";

export type ParticipantJoinInput = {
  nickname: string;
  preferredService: ParticipantService;
  joinNonce: string;
};

export type PublicParticipant = {
  id: string;
  nickname: string;
  role: ParticipantRole;
  capabilityRole: RoomCapabilityRole;
  preferredService: ParticipantService;
  expiresAtMs: number;
  lastSeenAtMs: number;
};

export type RoomContributionSettings = {
  roomId: string;
  revision: number;
  canContribute: boolean;
  guestCanContribute: boolean;
  locked: boolean;
  hostApproval: boolean;
  guestExpiresAtMs: number | null;
};

export type ParticipantSessionResult = {
  participant: PublicParticipant;
  sessionToken: string;
  expiresAtMs: number;
  created: boolean;
  renewed: boolean;
  room: RoomContributionSettings;
};

export type AuthorizedParticipant = {
  role: RoomCapabilityRole;
  participantRole: ParticipantRole;
  participant: ParticipantRecord;
  room: RoomRecord;
};

export class ParticipantSessionError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(message: string, status = 400, retryAfterSeconds?: number) {
    super(message);
    this.name = "ParticipantSessionError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const participantColumns = `participant_id, room_id, token_hash, capability_token_hash,
  join_nonce_hash, capability_role, participant_role, nickname, preferred_service,
  session_epoch, expires_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms`;

const roomColumns = `room_id, host_token_hash, guest_token_hash, guest_can_contribute,
  locked, host_approval, guest_expires_at_ms, revision, live_snapshot_json,
  snapshot_sequence, created_at_ms, updated_at_ms`;

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

export function normalizeParticipantNickname(value: unknown): string {
  const nickname = typeof value === "string"
    ? value.normalize("NFKC").replace(/\s+/gu, " ").trim()
    : "";
  if (!nickname || nickname.length > 48) {
    throw new ParticipantSessionError("nickname must contain 1–48 characters");
  }
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(nickname)) {
    throw new ParticipantSessionError("nickname contains unsupported control characters");
  }
  return nickname;
}

export function normalizeParticipantService(value: unknown): ParticipantService {
  if (value !== "spotify" && value !== "apple" && value !== "ask") {
    throw new ParticipantSessionError("preferredService must be spotify, apple, or ask");
  }
  return value;
}

export function normalizeJoinNonce(value: unknown): string {
  const nonce = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{21,127}$/.test(nonce)) {
    throw new ParticipantSessionError("joinNonce must be a random 22–128 character identifier");
  }
  return nonce;
}

export function parseParticipantJoinInput(value: unknown): ParticipantJoinInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ParticipantSessionError("participant body must be an object");
  }
  const input = value as Record<string, unknown>;
  return {
    nickname: normalizeParticipantNickname(input.nickname),
    preferredService: normalizeParticipantService(input.preferredService),
    joinNonce: normalizeJoinNonce(input.joinNonce),
  };
}

export function participantRoleForRoom(
  capabilityRole: RoomCapabilityRole,
  room: Pick<RoomRecord, "guest_can_contribute" | "locked">,
): ParticipantRole {
  if (capabilityRole === "host") return "host";
  return room.guest_can_contribute === 1 && room.locked !== 1 ? "editor" : "viewer";
}

export function roomContributionSettings(
  room: RoomRecord,
  role: ParticipantRole,
): RoomContributionSettings {
  return {
    roomId: room.room_id,
    revision: room.revision,
    canContribute: role === "host" || role === "editor",
    guestCanContribute: room.guest_can_contribute === 1,
    locked: room.locked === 1,
    hostApproval: room.host_approval === 1,
    guestExpiresAtMs: room.guest_expires_at_ms,
  };
}

export function readBearerToken(request: Request): string | null {
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  try {
    return normalizeCapabilityToken(authorization.slice(7));
  } catch {
    return null;
  }
}

export function normalizeParticipantToken(value: unknown): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!/^ujp_[a-zA-Z0-9_-]{43}$/.test(token)) {
    throw new ParticipantSessionError("participant session token is malformed", 401);
  }
  return token;
}

export async function deriveParticipantToken(
  capabilityToken: string,
  joinNonce: string,
  participantId: string,
  sessionEpoch: number,
): Promise<string> {
  const material = [
    "unijam-participant-session-v1",
    capabilityToken,
    joinNonce,
    participantId,
    String(sessionEpoch),
  ].join("\u0000");
  return `ujp_${base64Url(await sha256Bytes(material))}`;
}

function publicParticipant(participant: ParticipantRecord): PublicParticipant {
  return {
    id: participant.participant_id,
    nickname: participant.nickname,
    role: participant.participant_role,
    capabilityRole: participant.capability_role,
    preferredService: participant.preferred_service,
    expiresAtMs: participant.expires_at_ms,
    lastSeenAtMs: participant.last_seen_at_ms,
  };
}

function sessionExpiry(authorization: AuthorizedRoom, now: number): number {
  const defaultExpiry = now + PARTICIPANT_SESSION_TTL_MS;
  if (authorization.role !== "guest" || authorization.room.guest_expires_at_ms === null) {
    return defaultExpiry;
  }
  return Math.min(defaultExpiry, authorization.room.guest_expires_at_ms);
}

async function findParticipantByJoin(
  db: D1Database,
  roomId: string,
  capabilityTokenHash: string,
  joinNonceHash: string,
): Promise<ParticipantRecord | null> {
  return db.prepare(
    `SELECT ${participantColumns} FROM room_participants
     WHERE room_id = ? AND capability_token_hash = ? AND join_nonce_hash = ? LIMIT 1`,
  ).bind(roomId, capabilityTokenHash, joinNonceHash).first<ParticipantRecord>();
}

async function findParticipantById(db: D1Database, participantId: string): Promise<ParticipantRecord | null> {
  return db.prepare(
    `SELECT ${participantColumns} FROM room_participants WHERE participant_id = ? LIMIT 1`,
  ).bind(participantId).first<ParticipantRecord>();
}

export async function createOrResumeParticipantSession(
  db: D1Database,
  authorization: AuthorizedRoom,
  capabilityToken: string,
  inputValue: unknown,
  now = Date.now(),
): Promise<ParticipantSessionResult> {
  const input = parseParticipantJoinInput(inputValue);
  const capabilityTokenHash = await hashCapabilityToken(capabilityToken);
  const expectedCapabilityHash = authorization.role === "host"
    ? authorization.room.host_token_hash
    : authorization.room.guest_token_hash;
  if (capabilityTokenHash !== expectedCapabilityHash) {
    throw new ParticipantSessionError("room capability is missing or invalid", 401);
  }
  const expiresAtMs = sessionExpiry(authorization, now);
  if (expiresAtMs <= now) {
    throw new ParticipantSessionError("room capability has expired", 401);
  }
  const joinNonceHash = await hashCapabilityToken(input.joinNonce);
  const role = participantRoleForRoom(authorization.role, authorization.room);
  let participant = await findParticipantByJoin(
    db,
    authorization.room.room_id,
    capabilityTokenHash,
    joinNonceHash,
  );
  let created = false;
  let renewed = false;

  if (!participant) {
    const joinPolicies = [
      { scope: `room:${authorization.room.room_id}:joins`, limit: 100 },
      { scope: `room:${authorization.room.room_id}:capability:${capabilityTokenHash}:joins`, limit: 30 },
    ];
    for (const policy of joinPolicies) {
      const decision = await consumeRateLimit(db, { ...policy, windowMs: 5 * 60_000, now });
      if (!decision.allowed) {
        throw new ParticipantSessionError(
          "This invite is receiving too many new joins. Try again shortly.",
          429,
          decision.retryAfterSeconds,
        );
      }
    }
    const activeParticipants = await db.prepare(
      "SELECT COUNT(*) AS total FROM room_participants WHERE room_id = ? AND expires_at_ms > ? AND last_seen_at_ms >= ?",
    ).bind(authorization.room.room_id, now, now - 45_000).first<{ total: number }>();
    if ((activeParticipants?.total ?? 0) >= 100) {
      throw new ParticipantSessionError("This room has reached its active participant limit.", 429, 300);
    }
    const participantId = `ptc_${crypto.randomUUID().replaceAll("-", "")}`;
    const sessionEpoch = 1;
    const sessionToken = await deriveParticipantToken(
      capabilityToken,
      input.joinNonce,
      participantId,
      sessionEpoch,
    );
    const tokenHash = await hashCapabilityToken(sessionToken);
    const insert = await db.prepare(
      `INSERT OR IGNORE INTO room_participants
       (participant_id, room_id, token_hash, capability_token_hash, join_nonce_hash,
        capability_role, participant_role, nickname, preferred_service, session_epoch,
        expires_at_ms, last_seen_at_ms, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      participantId,
      authorization.room.room_id,
      tokenHash,
      capabilityTokenHash,
      joinNonceHash,
      authorization.role,
      role,
      input.nickname,
      input.preferredService,
      sessionEpoch,
      expiresAtMs,
      now,
      now,
      now,
    ).run();
    created = (insert.meta.changes ?? 0) === 1;
    participant = await findParticipantByJoin(
      db,
      authorization.room.room_id,
      capabilityTokenHash,
      joinNonceHash,
    );
  }

  if (!participant) throw new ParticipantSessionError("participant session could not be created", 500);
  if (participant.nickname !== input.nickname) {
    throw new ParticipantSessionError("joinNonce was already used with a different participant nickname", 409);
  }

  if (participant.expires_at_ms <= now) {
    const nextEpoch = participant.session_epoch + 1;
    const nextToken = await deriveParticipantToken(
      capabilityToken,
      input.joinNonce,
      participant.participant_id,
      nextEpoch,
    );
    const nextTokenHash = await hashCapabilityToken(nextToken);
    const update = await db.prepare(
      `UPDATE room_participants
       SET token_hash = ?, participant_role = ?, preferred_service = ?, session_epoch = ?, expires_at_ms = ?,
           last_seen_at_ms = ?, updated_at_ms = ?
       WHERE participant_id = ? AND session_epoch = ? AND expires_at_ms <= ?`,
    ).bind(
      nextTokenHash,
      role,
      input.preferredService,
      nextEpoch,
      expiresAtMs,
      now,
      now,
      participant.participant_id,
      participant.session_epoch,
      now,
    ).run();
    renewed = (update.meta.changes ?? 0) === 1;
    participant = await findParticipantById(db, participant.participant_id);
    if (!participant) throw new ParticipantSessionError("participant session could not be renewed", 500);
  } else {
    const boundedExpiry = Math.min(participant.expires_at_ms, expiresAtMs);
    await db.prepare(
      `UPDATE room_participants SET participant_role = ?, preferred_service = ?, expires_at_ms = ?,
       last_seen_at_ms = ?, updated_at_ms = ? WHERE participant_id = ?`,
    ).bind(role, input.preferredService, boundedExpiry, now, now, participant.participant_id).run();
    participant = {
      ...participant,
      participant_role: role,
      preferred_service: input.preferredService,
      expires_at_ms: boundedExpiry,
      last_seen_at_ms: now,
      updated_at_ms: now,
    };
  }

  const sessionToken = await deriveParticipantToken(
    capabilityToken,
    input.joinNonce,
    participant.participant_id,
    participant.session_epoch,
  );
  const derivedTokenHash = await hashCapabilityToken(sessionToken);
  if (derivedTokenHash !== participant.token_hash) {
    throw new ParticipantSessionError("joinNonce belongs to a different participant session", 409);
  }
  return {
    participant: publicParticipant(participant),
    sessionToken,
    expiresAtMs: participant.expires_at_ms,
    created,
    renewed,
    room: roomContributionSettings(authorization.room, participant.participant_role),
  };
}

export async function authorizeParticipantRequest(
  db: D1Database,
  request: Request,
  rawRoomId: string,
  now = Date.now(),
): Promise<AuthorizedParticipant | null> {
  const roomId = normalizeRoomId(rawRoomId);
  const rawToken = readBearerToken(request);
  if (!rawToken) return null;
  let token: string;
  try {
    token = normalizeParticipantToken(rawToken);
  } catch {
    return null;
  }
  const tokenHash = await hashCapabilityToken(token);
  const participant = await db.prepare(
    `SELECT ${participantColumns} FROM room_participants
     WHERE room_id = ? AND token_hash = ? LIMIT 1`,
  ).bind(roomId, tokenHash).first<ParticipantRecord>();
  if (!participant || participant.expires_at_ms <= now) return null;
  const room = await db.prepare(
    `SELECT ${roomColumns} FROM rooms WHERE room_id = ? LIMIT 1`,
  ).bind(roomId).first<RoomRecord>();
  if (!room) return null;
  const currentCapabilityHash = participant.capability_role === "host"
    ? room.host_token_hash
    : room.guest_token_hash;
  if (participant.capability_token_hash !== currentCapabilityHash) return null;
  if (
    participant.capability_role === "guest" &&
    room.guest_expires_at_ms !== null &&
    room.guest_expires_at_ms <= now
  ) return null;
  const participantRole = participantRoleForRoom(participant.capability_role, room);
  const effectiveExpiry = participant.capability_role === "guest" && room.guest_expires_at_ms !== null
    ? Math.min(participant.expires_at_ms, room.guest_expires_at_ms)
    : participant.expires_at_ms;
  const shouldWriteHeartbeat =
    now - participant.last_seen_at_ms >= PARTICIPANT_HEARTBEAT_WRITE_INTERVAL_MS ||
    participant.participant_role !== participantRole ||
    participant.expires_at_ms !== effectiveExpiry;
  if (shouldWriteHeartbeat) {
    await db.prepare(
      `UPDATE room_participants SET participant_role = ?, expires_at_ms = ?,
       last_seen_at_ms = ?, updated_at_ms = ? WHERE participant_id = ?`,
    ).bind(participantRole, effectiveExpiry, now, now, participant.participant_id).run();
  }
  return {
    role: participant.capability_role,
    participantRole,
    participant: {
      ...participant,
      participant_role: participantRole,
      expires_at_ms: effectiveExpiry,
      last_seen_at_ms: shouldWriteHeartbeat ? now : participant.last_seen_at_ms,
      updated_at_ms: shouldWriteHeartbeat ? now : participant.updated_at_ms,
    },
    room,
  };
}
