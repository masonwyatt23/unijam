ALTER TABLE `accounts` ADD `deletion_pending_at_ms` integer;
--> statement-breakpoint
ALTER TABLE `room_registry` ADD `deletion_purged_at_ms` integer;
--> statement-breakpoint
CREATE TABLE `account_deletion_requests` (
  `account_id` text,
  `request_key_hash` text PRIMARY KEY NOT NULL,
  `status` text DEFAULT 'requested' NOT NULL CHECK (`status` IN ('requested','provider_purged','rooms_purged','completed')),
  `authorized_at_ms` integer NOT NULL,
  `created_at_ms` integer NOT NULL,
  `updated_at_ms` integer NOT NULL,
  `completed_at_ms` integer,
  `failure_code` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_deletion_requests_account_idx` ON `account_deletion_requests` (`account_id`);
--> statement-breakpoint
CREATE INDEX `account_deletion_requests_status_updated_idx` ON `account_deletion_requests` (`status`,`updated_at_ms`);
