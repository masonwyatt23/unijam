CREATE TABLE `accounts` (`account_id` text PRIMARY KEY NOT NULL, `display_name` text NOT NULL, `created_at_ms` integer NOT NULL, `updated_at_ms` integer NOT NULL, `deleted_at_ms` integer);
--> statement-breakpoint
CREATE TABLE `passkeys` (`credential_id` text PRIMARY KEY NOT NULL, `account_id` text NOT NULL, `public_key_base64` text NOT NULL, `counter` integer DEFAULT 0 NOT NULL, `transports_json` text DEFAULT '[]' NOT NULL, `device_type` text NOT NULL, `backed_up` integer DEFAULT false NOT NULL, `created_at_ms` integer NOT NULL, `last_used_at_ms` integer NOT NULL, `revoked_at_ms` integer);
--> statement-breakpoint
CREATE INDEX `passkeys_account_idx` ON `passkeys` (`account_id`);
--> statement-breakpoint
CREATE TABLE `passkey_challenges` (`challenge_hash` text PRIMARY KEY NOT NULL, `challenge` text NOT NULL, `kind` text NOT NULL, `account_id` text, `enrollment_code_hash` text, `expires_at_ms` integer NOT NULL, `consumed_at_ms` integer, `created_at_ms` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkey_challenges_value_idx` ON `passkey_challenges` (`challenge`);
--> statement-breakpoint
CREATE INDEX `passkey_challenges_expiry_idx` ON `passkey_challenges` (`expires_at_ms`);
--> statement-breakpoint
CREATE TABLE `host_enrollment_codes` (`code_hash` text PRIMARY KEY NOT NULL, `label` text NOT NULL, `expires_at_ms` integer NOT NULL, `created_at_ms` integer NOT NULL, `used_at_ms` integer, `used_by_account_id` text);
--> statement-breakpoint
CREATE INDEX `host_enrollment_codes_expiry_idx` ON `host_enrollment_codes` (`expires_at_ms`);
--> statement-breakpoint
CREATE TABLE `auth_rate_buckets` (`scope_hash` text NOT NULL, `bucket_start_ms` integer NOT NULL, `request_count` integer DEFAULT 0 NOT NULL, `expires_at_ms` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `auth_rate_buckets_scope_window_idx` ON `auth_rate_buckets` (`scope_hash`,`bucket_start_ms`);
--> statement-breakpoint
CREATE INDEX `auth_rate_buckets_expiry_idx` ON `auth_rate_buckets` (`expires_at_ms`);
--> statement-breakpoint
CREATE TABLE `host_sessions` (`session_id` text PRIMARY KEY NOT NULL, `token_hash` text NOT NULL, `account_id` text NOT NULL, `authenticated_at_ms` integer NOT NULL, `passkey_verified_at_ms` integer, `expires_at_ms` integer NOT NULL, `created_at_ms` integer NOT NULL, `last_seen_at_ms` integer NOT NULL, `revoked_at_ms` integer);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_sessions_token_idx` ON `host_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `host_sessions_account_expiry_idx` ON `host_sessions` (`account_id`,`expires_at_ms`);
--> statement-breakpoint
CREATE TABLE `guest_sessions` (`session_id` text PRIMARY KEY NOT NULL, `token_hash` text NOT NULL, `room_id` text NOT NULL, `participant_id` text NOT NULL, `nickname` text NOT NULL, `role` text DEFAULT 'guest' NOT NULL, `invite_epoch` integer NOT NULL, `expires_at_ms` integer NOT NULL, `created_at_ms` integer NOT NULL, `last_seen_at_ms` integer NOT NULL, `revoked_at_ms` integer);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_sessions_token_idx` ON `guest_sessions` (`token_hash`);
--> statement-breakpoint
CREATE INDEX `guest_sessions_room_expiry_idx` ON `guest_sessions` (`room_id`,`expires_at_ms`);
--> statement-breakpoint
CREATE TABLE `recovery_codes` (`recovery_code_id` text PRIMARY KEY NOT NULL, `account_id` text NOT NULL, `code_hash` text NOT NULL, `created_at_ms` integer NOT NULL, `used_at_ms` integer);
--> statement-breakpoint
CREATE UNIQUE INDEX `recovery_codes_hash_idx` ON `recovery_codes` (`code_hash`);
--> statement-breakpoint
CREATE TABLE `room_registry` (`room_id` text PRIMARY KEY NOT NULL, `owner_account_id` text NOT NULL, `durable_object_id` text NOT NULL, `guest_capability_hash` text NOT NULL, `invite_epoch` integer DEFAULT 1 NOT NULL, `lifecycle` text DEFAULT 'active' NOT NULL, `created_at_ms` integer NOT NULL, `updated_at_ms` integer NOT NULL, `ended_at_ms` integer);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_registry_do_idx` ON `room_registry` (`durable_object_id`);
--> statement-breakpoint
CREATE INDEX `room_registry_owner_idx` ON `room_registry` (`owner_account_id`,`updated_at_ms`);
--> statement-breakpoint
CREATE TABLE `room_projections` (`room_id` text PRIMARY KEY NOT NULL, `sequence` integer NOT NULL, `snapshot_json` text NOT NULL, `projected_at_ms` integer NOT NULL, `source_event_id` text NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_projections_event_idx` ON `room_projections` (`source_event_id`);
--> statement-breakpoint
CREATE TABLE `room_projection_receipts` (`event_id` text PRIMARY KEY NOT NULL, `room_id` text NOT NULL, `received_at_ms` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `room_projection_receipts_room_idx` ON `room_projection_receipts` (`room_id`,`received_at_ms`);
--> statement-breakpoint
CREATE TABLE `canonical_recordings` (`recording_id` text PRIMARY KEY NOT NULL, `isrc` text, `normalized_title` text NOT NULL, `normalized_artist` text NOT NULL, `album` text, `duration_ms` integer, `explicit` integer, `version_label` text, `created_at_ms` integer NOT NULL, `updated_at_ms` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `canonical_recordings_isrc_idx` ON `canonical_recordings` (`isrc`);
--> statement-breakpoint
CREATE TABLE `provider_matches` (`match_id` text PRIMARY KEY NOT NULL, `recording_id` text NOT NULL, `provider` text NOT NULL, `storefront` text DEFAULT 'us' NOT NULL, `provider_recording_id` text NOT NULL, `method` text NOT NULL CHECK (`method` IN ('provider_id','isrc','metadata','user_correction')), `confidence_basis_json` text NOT NULL, `status` text NOT NULL, `created_at_ms` integer NOT NULL, `updated_at_ms` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_matches_recording_provider_idx` ON `provider_matches` (`recording_id`,`provider`,`storefront`);
--> statement-breakpoint
CREATE TABLE `provider_match_reviews` (`review_id` text PRIMARY KEY NOT NULL, `match_id` text NOT NULL, `account_id` text NOT NULL, `decision` text NOT NULL, `provenance_json` text NOT NULL, `created_at_ms` integer NOT NULL);
--> statement-breakpoint
CREATE TABLE `provider_connections` (`connection_id` text PRIMARY KEY NOT NULL, `account_id` text NOT NULL, `provider` text NOT NULL, `encrypted_token_json` text NOT NULL, `key_version` integer NOT NULL, `provider_account_id` text, `status` text NOT NULL, `created_at_ms` integer NOT NULL, `updated_at_ms` integer NOT NULL, `disconnected_at_ms` integer);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_connections_owner_provider_idx` ON `provider_connections` (`account_id`,`provider`);
--> statement-breakpoint
CREATE TABLE `publish_operations` (`operation_id` text PRIMARY KEY NOT NULL, `room_id` text NOT NULL, `account_id` text NOT NULL, `provider` text NOT NULL, `destination_preview_hash` text NOT NULL, `status` text NOT NULL, `attempt_count` integer DEFAULT 0 NOT NULL, `next_attempt_at_ms` integer, `created_at_ms` integer NOT NULL, `updated_at_ms` integer NOT NULL, `cancelled_at_ms` integer);
--> statement-breakpoint
CREATE INDEX `publish_operations_room_idx` ON `publish_operations` (`room_id`,`created_at_ms`);
--> statement-breakpoint
CREATE TABLE `publish_items` (`item_id` text PRIMARY KEY NOT NULL, `operation_id` text NOT NULL, `occurrence_id` text NOT NULL, `provider_recording_id` text NOT NULL, `position` integer NOT NULL, `status` text NOT NULL, `created_at_ms` integer NOT NULL, `updated_at_ms` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX `publish_items_operation_occurrence_idx` ON `publish_items` (`operation_id`,`occurrence_id`);
--> statement-breakpoint
CREATE TABLE `audit_records` (`audit_id` text PRIMARY KEY NOT NULL, `account_id` text, `room_id` text, `action` text NOT NULL, `target_type` text, `target_id` text, `metadata_json` text DEFAULT '{}' NOT NULL, `created_at_ms` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX `audit_records_room_created_idx` ON `audit_records` (`room_id`,`created_at_ms`);
--> statement-breakpoint
CREATE TABLE `dead_letters` (`dead_letter_id` text PRIMARY KEY NOT NULL, `queue_name` text NOT NULL, `message_id` text NOT NULL, `payload_json` text NOT NULL, `failure_code` text NOT NULL, `attempt_count` integer NOT NULL, `created_at_ms` integer NOT NULL, `resolved_at_ms` integer);
--> statement-breakpoint
CREATE UNIQUE INDEX `dead_letters_queue_message_idx` ON `dead_letters` (`queue_name`,`message_id`);
--> statement-breakpoint
CREATE TABLE `legacy_room_imports` (`legacy_room_id` text PRIMARY KEY NOT NULL, `export_hash` text NOT NULL, `export_json` text NOT NULL, `legacy_host_capability_hash` text NOT NULL, `legacy_guest_capability_hash` text, `status` text DEFAULT 'imported' NOT NULL, `imported_at_ms` integer NOT NULL, `claim_deadline_ms` integer NOT NULL, `bearer_exchange_deadline_ms` integer NOT NULL, `owner_account_id` text, `new_room_id` text, `claim_reservation_id` text, `reserved_at_ms` integer, `claimed_at_ms` integer, `read_only_at_ms` integer, `deleted_at_ms` integer);
--> statement-breakpoint
CREATE UNIQUE INDEX `legacy_room_imports_hash_idx` ON `legacy_room_imports` (`export_hash`);
--> statement-breakpoint
CREATE INDEX `legacy_room_imports_status_deadline_idx` ON `legacy_room_imports` (`status`,`claim_deadline_ms`);
