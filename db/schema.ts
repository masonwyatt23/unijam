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

export const accounts = sqliteTable("accounts", {
  accountId: text("account_id").primaryKey(), displayName: text("display_name").notNull(),
  createdAtMs: integer("created_at_ms").notNull(), updatedAtMs: integer("updated_at_ms").notNull(), deletedAtMs: integer("deleted_at_ms"),
});

export const passkeys = sqliteTable("passkeys", {
  credentialId: text("credential_id").primaryKey(), accountId: text("account_id").notNull(), publicKeyBase64: text("public_key_base64").notNull(),
  counter: integer("counter").notNull().default(0), transportsJson: text("transports_json").notNull().default("[]"), deviceType: text("device_type").notNull(),
  backedUp: integer("backed_up", { mode: "boolean" }).notNull().default(false), createdAtMs: integer("created_at_ms").notNull(),
  lastUsedAtMs: integer("last_used_at_ms").notNull(), revokedAtMs: integer("revoked_at_ms"),
}, (table) => [index("passkeys_account_idx").on(table.accountId)]);

export const passkeyChallenges = sqliteTable("passkey_challenges", {
  challengeHash: text("challenge_hash").primaryKey(), challenge: text("challenge").notNull(), kind: text("kind").notNull(), accountId: text("account_id"),
  enrollmentCodeHash: text("enrollment_code_hash"), expiresAtMs: integer("expires_at_ms").notNull(), consumedAtMs: integer("consumed_at_ms"), createdAtMs: integer("created_at_ms").notNull(),
}, (table) => [uniqueIndex("passkey_challenges_value_idx").on(table.challenge), index("passkey_challenges_expiry_idx").on(table.expiresAtMs)]);

export const hostEnrollmentCodes = sqliteTable("host_enrollment_codes", {
  codeHash: text("code_hash").primaryKey(), label: text("label").notNull(), expiresAtMs: integer("expires_at_ms").notNull(),
  createdAtMs: integer("created_at_ms").notNull(), usedAtMs: integer("used_at_ms"), usedByAccountId: text("used_by_account_id"),
}, (table) => [index("host_enrollment_codes_expiry_idx").on(table.expiresAtMs)]);

export const authRateBuckets = sqliteTable("auth_rate_buckets", {
  scopeHash: text("scope_hash").notNull(), bucketStartMs: integer("bucket_start_ms").notNull(), requestCount: integer("request_count").notNull().default(0),
  expiresAtMs: integer("expires_at_ms").notNull(),
}, (table) => [uniqueIndex("auth_rate_buckets_scope_window_idx").on(table.scopeHash, table.bucketStartMs), index("auth_rate_buckets_expiry_idx").on(table.expiresAtMs)]);

export const hostSessions = sqliteTable("host_sessions", {
  sessionId: text("session_id").primaryKey(), tokenHash: text("token_hash").notNull(), accountId: text("account_id").notNull(),
  authenticatedAtMs: integer("authenticated_at_ms").notNull(), passkeyVerifiedAtMs: integer("passkey_verified_at_ms"), expiresAtMs: integer("expires_at_ms").notNull(), createdAtMs: integer("created_at_ms").notNull(),
  lastSeenAtMs: integer("last_seen_at_ms").notNull(), revokedAtMs: integer("revoked_at_ms"),
  recoveryEnrollmentExpiresAtMs: integer("recovery_enrollment_expires_at_ms"), recoveryEnrollmentConsumedAtMs: integer("recovery_enrollment_consumed_at_ms"),
}, (table) => [uniqueIndex("host_sessions_token_idx").on(table.tokenHash), index("host_sessions_account_expiry_idx").on(table.accountId, table.expiresAtMs)]);

export const guestSessions = sqliteTable("guest_sessions", {
  sessionId: text("session_id").primaryKey(), tokenHash: text("token_hash").notNull(), roomId: text("room_id").notNull(), participantId: text("participant_id").notNull(),
  nickname: text("nickname").notNull(), role: text("role").notNull().default("guest"), inviteEpoch: integer("invite_epoch").notNull(), expiresAtMs: integer("expires_at_ms").notNull(),
  createdAtMs: integer("created_at_ms").notNull(), lastSeenAtMs: integer("last_seen_at_ms").notNull(), revokedAtMs: integer("revoked_at_ms"),
}, (table) => [uniqueIndex("guest_sessions_token_idx").on(table.tokenHash), index("guest_sessions_room_expiry_idx").on(table.roomId, table.expiresAtMs)]);

export const recoveryCodes = sqliteTable("recovery_codes", {
  recoveryCodeId: text("recovery_code_id").primaryKey(), accountId: text("account_id").notNull(), codeHash: text("code_hash").notNull(),
  createdAtMs: integer("created_at_ms").notNull(), usedAtMs: integer("used_at_ms"),
}, (table) => [uniqueIndex("recovery_codes_hash_idx").on(table.codeHash)]);

export const roomRegistry = sqliteTable("room_registry", {
  roomId: text("room_id").primaryKey(), ownerAccountId: text("owner_account_id").notNull(), durableObjectId: text("durable_object_id").notNull(),
  guestCapabilityHash: text("guest_capability_hash").notNull(), inviteEpoch: integer("invite_epoch").notNull().default(1), lifecycle: text("lifecycle").notNull().default("active"),
  createdAtMs: integer("created_at_ms").notNull(), updatedAtMs: integer("updated_at_ms").notNull(), endedAtMs: integer("ended_at_ms"),
}, (table) => [uniqueIndex("room_registry_do_idx").on(table.durableObjectId), index("room_registry_owner_idx").on(table.ownerAccountId, table.updatedAtMs)]);

export const roomProjections = sqliteTable("room_projections", {
  roomId: text("room_id").primaryKey(), sequence: integer("sequence").notNull(), snapshotJson: text("snapshot_json").notNull(),
  projectedAtMs: integer("projected_at_ms").notNull(), sourceEventId: text("source_event_id").notNull(),
}, (table) => [uniqueIndex("room_projections_event_idx").on(table.sourceEventId)]);

export const roomProjectionReceipts = sqliteTable("room_projection_receipts", {
  eventId: text("event_id").primaryKey(), roomId: text("room_id").notNull(), receivedAtMs: integer("received_at_ms").notNull(),
}, (table) => [index("room_projection_receipts_room_idx").on(table.roomId, table.receivedAtMs)]);

export const canonicalRecordings = sqliteTable("canonical_recordings", {
  recordingId: text("recording_id").primaryKey(), isrc: text("isrc"), normalizedTitle: text("normalized_title").notNull(), normalizedArtist: text("normalized_artist").notNull(),
  album: text("album"), durationMs: integer("duration_ms"), explicit: integer("explicit", { mode: "boolean" }), versionLabel: text("version_label"),
  createdAtMs: integer("created_at_ms").notNull(), updatedAtMs: integer("updated_at_ms").notNull(),
}, (table) => [index("canonical_recordings_isrc_idx").on(table.isrc)]);

export const providerMatches = sqliteTable("provider_matches", {
  matchId: text("match_id").primaryKey(), recordingId: text("recording_id").notNull(), provider: text("provider").notNull(), storefront: text("storefront").notNull().default("us"),
  providerRecordingId: text("provider_recording_id").notNull(), method: text("method").notNull(), confidenceBasisJson: text("confidence_basis_json").notNull(),
  status: text("status").notNull(), createdAtMs: integer("created_at_ms").notNull(), updatedAtMs: integer("updated_at_ms").notNull(),
}, (table) => [uniqueIndex("provider_matches_recording_provider_idx").on(table.recordingId, table.provider, table.storefront)]);

export const providerMatchReviews = sqliteTable("provider_match_reviews", {
  reviewId: text("review_id").primaryKey(), matchId: text("match_id").notNull(), accountId: text("account_id").notNull(), decision: text("decision").notNull(),
  provenanceJson: text("provenance_json").notNull(), createdAtMs: integer("created_at_ms").notNull(),
});

export const providerConnections = sqliteTable("provider_connections", {
  connectionId: text("connection_id").primaryKey(), accountId: text("account_id").notNull(), provider: text("provider").notNull(),
  encryptedTokenJson: text("encrypted_token_json").notNull(), keyVersion: integer("key_version").notNull(), providerAccountId: text("provider_account_id"),
  status: text("status").notNull(), createdAtMs: integer("created_at_ms").notNull(), updatedAtMs: integer("updated_at_ms").notNull(), disconnectedAtMs: integer("disconnected_at_ms"),
}, (table) => [uniqueIndex("provider_connections_owner_provider_idx").on(table.accountId, table.provider)]);

export const publishOperations = sqliteTable("publish_operations", {
  operationId: text("operation_id").primaryKey(), roomId: text("room_id").notNull(), accountId: text("account_id").notNull(), provider: text("provider").notNull(),
  destinationPreviewHash: text("destination_preview_hash").notNull(), status: text("status").notNull(), attemptCount: integer("attempt_count").notNull().default(0),
  nextAttemptAtMs: integer("next_attempt_at_ms"), createdAtMs: integer("created_at_ms").notNull(), updatedAtMs: integer("updated_at_ms").notNull(), cancelledAtMs: integer("cancelled_at_ms"),
}, (table) => [index("publish_operations_room_idx").on(table.roomId, table.createdAtMs)]);

export const publishItems = sqliteTable("publish_items", {
  itemId: text("item_id").primaryKey(), operationId: text("operation_id").notNull(), occurrenceId: text("occurrence_id").notNull(), providerRecordingId: text("provider_recording_id").notNull(),
  position: integer("position").notNull(), status: text("status").notNull(), createdAtMs: integer("created_at_ms").notNull(), updatedAtMs: integer("updated_at_ms").notNull(),
}, (table) => [uniqueIndex("publish_items_operation_occurrence_idx").on(table.operationId, table.occurrenceId)]);

export const auditRecords = sqliteTable("audit_records", {
  auditId: text("audit_id").primaryKey(), accountId: text("account_id"), roomId: text("room_id"), action: text("action").notNull(),
  targetType: text("target_type"), targetId: text("target_id"), metadataJson: text("metadata_json").notNull().default("{}"), createdAtMs: integer("created_at_ms").notNull(),
}, (table) => [index("audit_records_room_created_idx").on(table.roomId, table.createdAtMs)]);

export const deadLetters = sqliteTable("dead_letters", {
  deadLetterId: text("dead_letter_id").primaryKey(), queueName: text("queue_name").notNull(), messageId: text("message_id").notNull(), payloadJson: text("payload_json").notNull(),
  failureCode: text("failure_code").notNull(), attemptCount: integer("attempt_count").notNull(), createdAtMs: integer("created_at_ms").notNull(), resolvedAtMs: integer("resolved_at_ms"),
}, (table) => [uniqueIndex("dead_letters_queue_message_idx").on(table.queueName, table.messageId)]);

export const legacyRoomImports = sqliteTable("legacy_room_imports", {
  legacyRoomId: text("legacy_room_id").primaryKey(), exportHash: text("export_hash").notNull(), exportJson: text("export_json").notNull(),
  legacyHostCapabilityHash: text("legacy_host_capability_hash").notNull(), legacyGuestCapabilityHash: text("legacy_guest_capability_hash"), status: text("status").notNull().default("imported"),
  importedAtMs: integer("imported_at_ms").notNull(), claimDeadlineMs: integer("claim_deadline_ms").notNull(), bearerExchangeDeadlineMs: integer("bearer_exchange_deadline_ms").notNull(),
  ownerAccountId: text("owner_account_id"), newRoomId: text("new_room_id"), claimReservationId: text("claim_reservation_id"), reservedAtMs: integer("reserved_at_ms"),
  claimedAtMs: integer("claimed_at_ms"), readOnlyAtMs: integer("read_only_at_ms"), deletedAtMs: integer("deleted_at_ms"),
}, (table) => [uniqueIndex("legacy_room_imports_hash_idx").on(table.exportHash), index("legacy_room_imports_status_deadline_idx").on(table.status, table.claimDeadlineMs)]);
