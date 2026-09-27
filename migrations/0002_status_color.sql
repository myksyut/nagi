-- 2 番目の版：進行中（tasks.started_at）とプロジェクトの色（projects.color）。既存の行はどちらも空のまま
-- （進行中なし、色は作成順）。
-- drizzle-kit の生成は tasks を作り直す形（__new_tasks へ写して DROP・RENAME）だったが、写す SELECT に
-- まだない列 "started_at" が入り、SQLite が二重引用符の名前を文字列として読むため、行があると
-- CHECK 制約で失敗する（今日の行だけなら、started_at に 'started_at' という文字が入ってしまう）。
-- そのため手で書き直し、列を足すときに CHECK を付ける（表を作り直さず、行を写さない）。
-- 制約の中身と名前は schema.ts の tasks_started_at_check と同じ。drizzle-kit のスナップショット（meta/0002）は
-- schema.ts から作ったもののままにしてある（次の generate で差分が出ないように）
ALTER TABLE `tasks` ADD `started_at` text CONSTRAINT "tasks_started_at_check" CHECK(started_at IS NULL OR bucket = 'today');--> statement-breakpoint
ALTER TABLE `projects` ADD `color` text;
