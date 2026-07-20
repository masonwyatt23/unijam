ALTER TABLE `host_sessions` ADD `recovery_enrollment_expires_at_ms` integer;
--> statement-breakpoint
ALTER TABLE `host_sessions` ADD `recovery_enrollment_consumed_at_ms` integer;
