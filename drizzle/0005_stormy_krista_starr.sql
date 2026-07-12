CREATE TABLE `room_rate_buckets` (
	`scope` text NOT NULL,
	`bucket_start_ms` integer NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`expires_at_ms` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_rate_buckets_scope_window_idx` ON `room_rate_buckets` (`scope`,`bucket_start_ms`);--> statement-breakpoint
CREATE INDEX `room_rate_buckets_expiry_idx` ON `room_rate_buckets` (`expires_at_ms`);