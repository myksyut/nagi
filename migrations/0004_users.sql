-- 4 番目の版：利用者（users）。タスク・プロジェクト・通し番号（meta）・反映済みの操作・セッションを、利用者ごとに分ける
-- （どの表にも user_id を足し、タスク・プロジェクト・反映済みの操作の主キーと seq の索引を、利用者の中で一意にする）。
-- すでにある行は、どれも利用者 'owner'（schema.ts の OWNER_USER_ID）のものにする。'owner' が誰かは、設定の
-- OWNER_GITHUB_USER_ID で決まる（その GitHub ユーザーが最初にログインしたときに、github_user_id が入る）。
-- drizzle-kit の生成は、表を作り直す形（__new_* へ写して DROP・RENAME）で、写す SELECT にまだない列 "user_id" が入り
-- （0002・0003 と同じ問題。SQLite が 'user_id' という文字として読む）、sessions は NOT NULL の列を ALTER で足す形
-- （行があると失敗する）だった。そのため手で書き直し、写すときに 'owner' を入れる。
-- sessions は、名前を user_sessions に変えて作り直す。利用者を分ける前の版の Worker は user_id を見ないので、その版が
-- この D1 で動くと、全員の行が全員に見える。名前を変えておけば、古い版はセッションを読めず、どの口も 500 になる。
-- PRAGMA foreign_keys は書かない（D1 では切れない）。作り直す表を参照する表はなく、写す行はどれも先に入れた 'owner' を
-- 指すので、外部キーに反する瞬間がない。
-- 表・制約・索引の中身は schema.ts と同じ。drizzle-kit のスナップショット（meta/0004）は schema.ts から作ったもののままに
-- してある（次の generate で差分が出ないように）
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`github_user_id` integer,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_github_user_id_idx` ON `users` (`github_user_id`);--> statement-breakpoint
-- 利用者を分ける前からあった行の持ち主（created_at は JS の toISOString() と同じ形）
INSERT INTO `users` (`id`, `github_user_id`, `created_at`) VALUES ('owner', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));--> statement-breakpoint
CREATE TABLE `user_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `user_sessions` (`id`, `user_id`, `expires_at`, `created_at`) SELECT `id`, 'owner', `expires_at`, `created_at` FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`name` text NOT NULL,
	`color` text,
	`archived_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`seq` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_projects` (`user_id`, `id`, `name`, `color`, `archived_at`, `created_at`, `updated_at`, `deleted_at`, `seq`) SELECT 'owner', `id`, `name`, `color`, `archived_at`, `created_at`, `updated_at`, `deleted_at`, `seq` FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_seq_idx` ON `projects` (`user_id`,`seq`);--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
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
	`started_at` text,
	`priority` text,
	`points` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`deleted_at` text,
	`seq` integer NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tasks_bucket_check" CHECK(bucket IN ('inbox', 'today', 'scheduled', 'later')),
	CONSTRAINT "tasks_scheduled_on_check" CHECK((bucket = 'scheduled') = (scheduled_on IS NOT NULL)),
	CONSTRAINT "tasks_started_at_check" CHECK(started_at IS NULL OR bucket = 'today'),
	CONSTRAINT "tasks_priority_check" CHECK(priority IS NULL OR priority IN ('high', 'medium', 'low')),
	CONSTRAINT "tasks_points_check" CHECK(points IS NULL OR points IN (1, 2, 3, 5, 8, 13))
);
--> statement-breakpoint
INSERT INTO `__new_tasks` (`user_id`, `id`, `title`, `memo`, `bucket`, `scheduled_on`, `deadline_on`, `project_id`, `rank`, `arrived_on`, `checklist`, `completed_at`, `started_at`, `priority`, `points`, `created_at`, `updated_at`, `deleted_at`, `seq`) SELECT 'owner', `id`, `title`, `memo`, `bucket`, `scheduled_on`, `deadline_on`, `project_id`, `rank`, `arrived_on`, `checklist`, `completed_at`, `started_at`, `priority`, `points`, `created_at`, `updated_at`, `deleted_at`, `seq` FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_seq_idx` ON `tasks` (`user_id`,`seq`);--> statement-breakpoint
CREATE INDEX `tasks_bucket_scheduled_on_idx` ON `tasks` (`user_id`,`bucket`,`scheduled_on`);--> statement-breakpoint
CREATE INDEX `tasks_deadline_on_idx` ON `tasks` (`user_id`,`deadline_on`);--> statement-breakpoint
CREATE TABLE `__new_applied_mutations` (
	`user_id` text NOT NULL,
	`id` text NOT NULL,
	`applied_at` text NOT NULL,
	PRIMARY KEY(`user_id`, `id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_applied_mutations` (`user_id`, `id`, `applied_at`) SELECT 'owner', `id`, `applied_at` FROM `applied_mutations`;--> statement-breakpoint
DROP TABLE `applied_mutations`;--> statement-breakpoint
ALTER TABLE `__new_applied_mutations` RENAME TO `applied_mutations`;--> statement-breakpoint
CREATE TABLE `__new_meta` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_meta` (`user_id`, `key`, `value`) SELECT 'owner', `key`, `value` FROM `meta`;--> statement-breakpoint
DROP TABLE `meta`;--> statement-breakpoint
ALTER TABLE `__new_meta` RENAME TO `meta`;
