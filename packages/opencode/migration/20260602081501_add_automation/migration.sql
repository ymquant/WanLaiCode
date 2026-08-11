CREATE TABLE `automation_run` (
	`id` text PRIMARY KEY,
	`automation_id` text NOT NULL,
	`session_id` text,
	`trigger` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error` text,
	CONSTRAINT `fk_automation_run_automation_id_automation_id_fk` FOREIGN KEY (`automation_id`) REFERENCES `automation`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `automation` (
	`id` text PRIMARY KEY,
	`title` text NOT NULL,
	`enabled` integer NOT NULL,
	`template` text NOT NULL,
	`schedule_kind` text NOT NULL,
	`schedule_config` text NOT NULL,
	`prompt` text NOT NULL,
	`project_id` text,
	`directory` text,
	`agent` text,
	`model` text,
	`last_run_at` integer,
	`next_run_at` integer,
	`time_created` integer NOT NULL,
	`time_updated` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `automation_run_automation_idx` ON `automation_run` (`automation_id`);
