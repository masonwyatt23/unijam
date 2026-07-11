CREATE TABLE `rooms` (
	`room_id` text PRIMARY KEY NOT NULL,
	`host_token_hash` text NOT NULL,
	`guest_token_hash` text NOT NULL,
	`guest_can_contribute` integer DEFAULT true NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`host_approval` integer DEFAULT true NOT NULL,
	`created_at_ms` integer NOT NULL,
	`updated_at_ms` integer NOT NULL
);
