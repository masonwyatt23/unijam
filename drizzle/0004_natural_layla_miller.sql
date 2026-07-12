CREATE TABLE `room_participants` (
	`participant_id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`capability_token_hash` text NOT NULL,
	`join_nonce_hash` text NOT NULL,
	`capability_role` text NOT NULL,
	`participant_role` text NOT NULL,
	`nickname` text NOT NULL,
	`preferred_service` text NOT NULL,
	`session_epoch` integer DEFAULT 1 NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`last_seen_at_ms` integer NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_participants_token_idx` ON `room_participants` (`token_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `room_participants_join_idx` ON `room_participants` (`room_id`,`capability_token_hash`,`join_nonce_hash`);--> statement-breakpoint
CREATE INDEX `room_participants_room_expiry_idx` ON `room_participants` (`room_id`,`expires_at_ms`);--> statement-breakpoint
ALTER TABLE `rooms` ADD `live_snapshot_json` text;--> statement-breakpoint
ALTER TABLE `rooms` ADD `snapshot_sequence` integer DEFAULT 0 NOT NULL;