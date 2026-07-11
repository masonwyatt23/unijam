CREATE TABLE `room_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`room_id` text NOT NULL,
	`event_id` text NOT NULL,
	`client_id` text NOT NULL,
	`actor_name` text NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_events_room_event_idx` ON `room_events` (`room_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `room_events_room_sequence_idx` ON `room_events` (`room_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `room_events_room_created_idx` ON `room_events` (`room_id`,`created_at_ms`);