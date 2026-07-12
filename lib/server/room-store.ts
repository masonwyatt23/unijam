import { env } from "cloudflare:workers";

import { normalizeRoomId, type RoomCapabilityRole } from "../live-room-events.ts";

export type RoomRecord = {
  room_id: string;
  host_token_hash: string;
  guest_token_hash: string;
  guest_can_contribute: number;
  locked: number;
  host_approval: number;
  guest_expires_at_ms: number | null;
  revision: number;
  live_snapshot_json: string | null;
  snapshot_sequence: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export type AuthorizedRoom = {
  role: RoomCapabilityRole;
  room: RoomRecord;
};

export type ParticipantRecord = {
  participant_id: string;
  room_id: string;
  token_hash: string;
  capability_token_hash: string;
  join_nonce_hash: string;
  capability_role: RoomCapabilityRole;
  participant_role: "host" | "editor" | "viewer";
  nickname: string;
  preferred_service: "spotify" | "apple" | "ask";
  session_epoch: number;
  expires_at_ms: number;
  last_seen_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
};

const roomTableSql = `CREATE TABLE IF NOT EXISTS rooms (
  room_id TEXT PRIMARY KEY,
  host_token_hash TEXT NOT NULL,
  guest_token_hash TEXT NOT NULL,
  guest_can_contribute INTEGER NOT NULL DEFAULT 1,
  locked INTEGER NOT NULL DEFAULT 0,
  host_approval INTEGER NOT NULL DEFAULT 1,
  guest_expires_at_ms INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  live_snapshot_json TEXT,
  snapshot_sequence INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
)`;
const eventTableSql = `CREATE TABLE IF NOT EXISTS room_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  room_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(room_id, event_id)
)`;
const roomSequenceIndexSql = "CREATE INDEX IF NOT EXISTS room_events_room_sequence_idx ON room_events(room_id, sequence)";
const roomCreatedIndexSql = "CREATE INDEX IF NOT EXISTS room_events_room_created_idx ON room_events(room_id, created_at_ms)";
const participantTableSql = `CREATE TABLE IF NOT EXISTS room_participants (
  participant_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  capability_token_hash TEXT NOT NULL,
  join_nonce_hash TEXT NOT NULL,
  capability_role TEXT NOT NULL CHECK(capability_role IN ('host', 'guest')),
  participant_role TEXT NOT NULL CHECK(participant_role IN ('host', 'editor', 'viewer')),
  nickname TEXT NOT NULL,
  preferred_service TEXT NOT NULL CHECK(preferred_service IN ('spotify', 'apple', 'ask')),
  session_epoch INTEGER NOT NULL DEFAULT 1,
  expires_at_ms INTEGER NOT NULL,
  last_seen_at_ms INTEGER NOT NULL,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL
)`;
const participantTokenIndexSql = "CREATE UNIQUE INDEX IF NOT EXISTS room_participants_token_idx ON room_participants(token_hash)";
const participantJoinIndexSql = "CREATE UNIQUE INDEX IF NOT EXISTS room_participants_join_idx ON room_participants(room_id, capability_token_hash, join_nonce_hash)";
const participantRoomExpiryIndexSql = "CREATE INDEX IF NOT EXISTS room_participants_room_expiry_idx ON room_participants(room_id, expires_at_ms)";
const rateBucketTableSql = `CREATE TABLE IF NOT EXISTS room_rate_buckets (
  scope TEXT NOT NULL,
  bucket_start_ms INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  expires_at_ms INTEGER NOT NULL,
  PRIMARY KEY(scope, bucket_start_ms)
)`;
const rateBucketExpiryIndexSql = "CREATE INDEX IF NOT EXISTS room_rate_buckets_expiry_idx ON room_rate_buckets(expires_at_ms)";

let schemaPromise: Promise<void> | null = null;

export function roomDatabase(): D1Database | null {
  return env.DB ?? null;
}

export async function ensureRoomSchema(db: D1Database): Promise<void> {
  schemaPromise ??= (async () => {
    await db.batch([
      db.prepare(roomTableSql),
      db.prepare(eventTableSql),
      db.prepare(roomSequenceIndexSql),
      db.prepare(roomCreatedIndexSql),
      db.prepare(participantTableSql),
      db.prepare(participantTokenIndexSql),
      db.prepare(participantJoinIndexSql),
      db.prepare(participantRoomExpiryIndexSql),
      db.prepare(rateBucketTableSql),
      db.prepare(rateBucketExpiryIndexSql),
    ]);
    const columns = await db.prepare("PRAGMA table_info(rooms)").all<{ name: string }>();
    if (!(columns.results ?? []).some(({ name }) => name === "guest_expires_at_ms")) {
      await db.prepare("ALTER TABLE rooms ADD COLUMN guest_expires_at_ms INTEGER").run();
    }
    if (!(columns.results ?? []).some(({ name }) => name === "revision")) {
      await db.prepare("ALTER TABLE rooms ADD COLUMN revision INTEGER NOT NULL DEFAULT 1").run();
    }
    if (!(columns.results ?? []).some(({ name }) => name === "live_snapshot_json")) {
      await db.prepare("ALTER TABLE rooms ADD COLUMN live_snapshot_json TEXT").run();
    }
    if (!(columns.results ?? []).some(({ name }) => name === "snapshot_sequence")) {
      await db.prepare("ALTER TABLE rooms ADD COLUMN snapshot_sequence INTEGER NOT NULL DEFAULT 0").run();
    }
    await db.prepare("DELETE FROM room_rate_buckets WHERE expires_at_ms < ?").bind(Date.now()).run();
  })().catch((error) => {
    schemaPromise = null;
    throw error;
  });
  await schemaPromise;
}

export function normalizeCapabilityToken(value: unknown, field = "capability token"): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{31,191}$/.test(token)) {
    throw new Error(`${field} is malformed`);
  }
  return token;
}

export async function hashCapabilityToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalHash(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export async function authorizeRoomRequest(
  db: D1Database,
  request: Request,
  rawRoomId: string,
): Promise<AuthorizedRoom | null> {
  const roomId = normalizeRoomId(rawRoomId);
  const authorization = request.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  let token: string;
  try {
    token = normalizeCapabilityToken(authorization.slice(7));
  } catch {
    return null;
  }
  const row = await db.prepare(
    `SELECT room_id, host_token_hash, guest_token_hash, guest_can_contribute, locked, host_approval, guest_expires_at_ms, revision, live_snapshot_json, snapshot_sequence, created_at_ms, updated_at_ms
     FROM rooms WHERE room_id = ? LIMIT 1`,
  ).bind(roomId).first<RoomRecord>();
  if (!row) return null;
  const tokenHash = await hashCapabilityToken(token);
  if (equalHash(tokenHash, row.host_token_hash)) return { role: "host", room: row };
  if (equalHash(tokenHash, row.guest_token_hash)) {
    if (row.guest_expires_at_ms !== null && row.guest_expires_at_ms <= Date.now()) return null;
    return { role: "guest", room: row };
  }
  return null;
}
