-- 3 番目の版：タスクの優先度（tasks.priority）と工数（tasks.points）。既存の行はどちらも空のまま（なし）。
-- drizzle-kit の生成は、0002 と同じく tasks を作り直す形（__new_tasks へ写して DROP・RENAME）だったが、写す SELECT に
-- まだない列 "priority"・"points" が入り、SQLite が二重引用符の名前を文字列として読むため、行があると
-- CHECK 制約で失敗する（'priority' という文字は tasks_priority_check を通らない）。
-- そのため手で書き直し、列を足すときに CHECK を付ける（表を作り直さず、行を写さない。既存の行の NULL は CHECK を通る）。
-- 制約の中身と名前は schema.ts の tasks_priority_check・tasks_points_check と同じ。drizzle-kit のスナップショット
-- （meta/0003）は schema.ts から作ったもののままにしてある（次の generate で差分が出ないように）
ALTER TABLE `tasks` ADD `priority` text CONSTRAINT "tasks_priority_check" CHECK(priority IS NULL OR priority IN ('high', 'medium', 'low'));--> statement-breakpoint
ALTER TABLE `tasks` ADD `points` integer CONSTRAINT "tasks_points_check" CHECK(points IS NULL OR points IN (1, 2, 3, 5, 8, 13));
