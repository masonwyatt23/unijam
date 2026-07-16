ALTER TABLE `guest_sessions` ADD `account_id` text;
--> statement-breakpoint
CREATE INDEX `guest_sessions_account_idx` ON `guest_sessions` (`account_id`);
--> statement-breakpoint
CREATE TABLE `room_memberships` (
  `membership_id` text PRIMARY KEY NOT NULL,
  `account_id` text NOT NULL,
  `room_id` text NOT NULL,
  `participant_id` text NOT NULL,
  `nickname` text NOT NULL,
  `joined_at_ms` integer NOT NULL,
  `last_joined_at_ms` integer NOT NULL,
  CONSTRAINT `room_memberships_identity_check` CHECK (length(`account_id`) > 0 AND length(`room_id`) > 0 AND length(`participant_id`) > 0),
  CONSTRAINT `room_memberships_nickname_check` CHECK (length(trim(`nickname`)) BETWEEN 1 AND 48),
  CONSTRAINT `room_memberships_joined_order_check` CHECK (`last_joined_at_ms` >= `joined_at_ms`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_memberships_account_room_idx` ON `room_memberships` (`account_id`,`room_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `room_memberships_room_participant_idx` ON `room_memberships` (`room_id`,`participant_id`);
--> statement-breakpoint
CREATE INDEX `room_memberships_account_last_joined_idx` ON `room_memberships` (`account_id`,`last_joined_at_ms`);
--> statement-breakpoint
CREATE INDEX `room_memberships_room_last_joined_idx` ON `room_memberships` (`room_id`,`last_joined_at_ms`);
