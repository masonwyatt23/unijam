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
