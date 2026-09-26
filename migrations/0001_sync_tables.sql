CREATE TABLE `applied_mutations` (
	`id` text PRIMARY KEY NOT NULL,
	`applied_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`seq` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_seq_idx` ON `projects` (`seq`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`memo` text DEFAULT '' NOT NULL,
	`bucket` text NOT NULL,
	`scheduled_on` text,
	`deadline_on` text,
	`project_id` text,
	`rank` text NOT NULL,
	`arrived_on` text,
	`checklist` text DEFAULT '[]' NOT NULL,
	`completed_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`seq` integer NOT NULL,
	CONSTRAINT "tasks_bucket_check" CHECK(bucket IN ('inbox', 'today', 'scheduled', 'later')),
	CONSTRAINT "tasks_scheduled_on_check" CHECK((bucket = 'scheduled') = (scheduled_on IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_seq_idx` ON `tasks` (`seq`);--> statement-breakpoint
CREATE INDEX `tasks_bucket_scheduled_on_idx` ON `tasks` (`bucket`,`scheduled_on`);--> statement-breakpoint
CREATE INDEX `tasks_deadline_on_idx` ON `tasks` (`deadline_on`);--> statement-breakpoint
-- meta の初期値（drizzle-kit の生成に手で足した行）。書き込みはこの行があることを前提にする
INSERT INTO `meta` (`key`, `value`) VALUES ('seq', '0'), ('last_rollover_on', ''), ('purged_through_seq', '0');
