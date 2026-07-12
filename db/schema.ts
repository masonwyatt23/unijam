import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const rooms = sqliteTable("rooms", {
  roomId: text("room_id").primaryKey(),
  hostTokenHash: text("host_token_hash").notNull(),
  guestTokenHash: text("guest_token_hash").notNull(),
  guestCanContribute: integer("guest_can_contribute", { mode: "boolean" }).notNull().default(true),
  locked: integer("locked", { mode: "boolean" }).notNull().default(false),
  hostApproval: integer("host_approval", { mode: "boolean" }).notNull().default(true),
  guestExpiresAtMs: integer("guest_expires_at_ms"),
  revision: integer("revision").notNull().default(1),
  liveSnapshotJson: text("live_snapshot_json"),
  snapshotSequence: integer("snapshot_sequence").notNull().default(0),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
});

export const roomEvents = sqliteTable("room_events", {
  sequence: integer("sequence").primaryKey({ autoIncrement: true }),
  roomId: text("room_id").notNull(),
  eventId: text("event_id").notNull(),
  clientId: text("client_id").notNull(),
  actorName: text("actor_name").notNull(),
  eventType: text("event_type").notNull(),
  payloadJson: text("payload_json").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
}, (table) => [
  uniqueIndex("room_events_room_event_idx").on(table.roomId, table.eventId),
  index("room_events_room_sequence_idx").on(table.roomId, table.sequence),
  index("room_events_room_created_idx").on(table.roomId, table.createdAtMs),
]);

export const roomParticipants = sqliteTable("room_participants", {
  participantId: text("participant_id").primaryKey(),
  roomId: text("room_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  capabilityTokenHash: text("capability_token_hash").notNull(),
  joinNonceHash: text("join_nonce_hash").notNull(),
  capabilityRole: text("capability_role").notNull(),
  participantRole: text("participant_role").notNull(),
  nickname: text("nickname").notNull(),
  preferredService: text("preferred_service").notNull(),
  sessionEpoch: integer("session_epoch").notNull().default(1),
  expiresAtMs: integer("expires_at_ms").notNull(),
  lastSeenAtMs: integer("last_seen_at_ms").notNull(),
  createdAtMs: integer("created_at_ms").notNull(),
  updatedAtMs: integer("updated_at_ms").notNull(),
}, (table) => [
  uniqueIndex("room_participants_token_idx").on(table.tokenHash),
  uniqueIndex("room_participants_join_idx").on(
    table.roomId,
    table.capabilityTokenHash,
    table.joinNonceHash,
  ),
  index("room_participants_room_expiry_idx").on(table.roomId, table.expiresAtMs),
]);

export const roomRateBuckets = sqliteTable("room_rate_buckets", {
  scope: text("scope").notNull(),
  bucketStartMs: integer("bucket_start_ms").notNull(),
  requestCount: integer("request_count").notNull().default(0),
  expiresAtMs: integer("expires_at_ms").notNull(),
}, (table) => [
  uniqueIndex("room_rate_buckets_scope_window_idx").on(table.scope, table.bucketStartMs),
  index("room_rate_buckets_expiry_idx").on(table.expiresAtMs),
]);
