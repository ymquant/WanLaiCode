ALTER TABLE `automation` ADD `notification_policy` text;--> statement-breakpoint
ALTER TABLE `automation_run` ADD `read_at` integer;--> statement-breakpoint
ALTER TABLE `automation_run` ADD `archived_at` integer;--> statement-breakpoint
ALTER TABLE `automation_run` ADD `archived_reason` text;--> statement-breakpoint
ALTER TABLE `automation_run` ADD `inbox_title` text;--> statement-breakpoint
ALTER TABLE `automation_run` ADD `inbox_summary` text;--> statement-breakpoint
CREATE INDEX `automation_run_archived_at_read_at_idx` ON `automation_run` (`archived_at`,`read_at`);
