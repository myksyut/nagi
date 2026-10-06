import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { POINTS, PRIORITIES } from "../../shared/priority-points";

/**
 * migrations/0003_priority_points.sql の確認。DB とは別の空の D1（MIGRATION_0003_TEST_DB）を使い、
 * 0002 まで当てて既存の行（進行中・完了・削除・予定・色のあるプロジェクト）を入れてから、0003 だけを当てる
 * （そのあとの版は当てない。ここで確かめるのは 0003 を当てた直後の形）。
 * schema.ts は最新の版の形で、この時点の表とは合わない（drizzle での select はできない）ので、
 * 生の D1 の prepare で読み書きする
 */
describe("マイグレーション 0003：優先度と工数", () => {
  it("既存の行・seq・既存の制約と索引を保ったまま列を足し、CHECK 制約（tasks_priority_check・tasks_points_check）で値を守る", async () => {
    const raw = env.MIGRATION_0003_TEST_DB;

    // 0002 まで当てる（同じ D1 に対して複数回このテストを走らせても、当て済みの版は飛ばされる）
    await applyD1Migrations(raw, env.TEST_MIGRATIONS.slice(0, 3));
    // このテストの前の実行の行が残っているかもしれないので、先に空にする
    await raw.prepare("DELETE FROM tasks").run();
    await raw.prepare("DELETE FROM projects").run();

    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const projectId = crypto.randomUUID();
    const insertTask = (columns: Record<string, unknown>) => {
      const names = Object.keys(columns);
      return raw
        .prepare(
          `INSERT INTO tasks (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        )
        .bind(...Object.values(columns))
        .run();
    };
    const base = (seq: number) => ({
      id: crypto.randomUUID(),
      title: `タスク ${seq}`,
      rank: `a${seq}`,
      created_at: now,
      updated_at: now,
      seq,
    });

    await raw
      .prepare(
        "INSERT INTO projects (id, name, color, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .bind(projectId, "既存プロジェクト", "sky", now, now, 1)
      .run();
    await insertTask({ ...base(2), bucket: "today", started_at: now, project_id: projectId });
    await insertTask({ ...base(3), bucket: "inbox", memo: "メモ", deadline_on: "2026-01-05" });
    await insertTask({ ...base(4), bucket: "scheduled", scheduled_on: "2026-02-01" });
    await insertTask({ ...base(5), bucket: "later", completed_at: now, checklist: "[]" });
    await insertTask({ ...base(6), bucket: "today", deleted_at: now, arrived_on: "2026-01-01" });
    await raw.prepare("UPDATE meta SET value = '6' WHERE key = 'seq'").run();

    // 0003 を当てる前の中身（priority・points の列はまだ存在しない）
    const beforeTasks = (await raw.prepare("SELECT * FROM tasks ORDER BY seq").all()).results;
    const beforeProjects = (await raw.prepare("SELECT * FROM projects ORDER BY seq").all()).results;
    const beforeMeta = (await raw.prepare("SELECT * FROM meta ORDER BY key").all()).results;
    expect(beforeTasks).toHaveLength(5);

    // 0003 がまだ当たっていないこと（前の状態が残っていて、当てずに通ってしまうのを防ぐ）
    const columnsOf = async (table: string) =>
      (await raw.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()).results.map(
        (row) => row.name,
      );
    expect(await columnsOf("tasks")).not.toContain("priority");
    expect(await columnsOf("tasks")).not.toContain("points");

    // 0003 を当てる
    await applyD1Migrations(raw, env.TEST_MIGRATIONS.slice(0, 4));
    expect(await columnsOf("tasks")).toEqual(expect.arrayContaining(["priority", "points"]));

    // 既存の行は、もとの列の中身も seq もそのまま。足した列は NULL
    const afterRaw = (await raw.prepare("SELECT * FROM tasks ORDER BY seq").all()).results;
    expect(afterRaw).toEqual(beforeTasks.map((row) => ({ ...row, priority: null, points: null })));
    expect((await raw.prepare("SELECT * FROM projects ORDER BY seq").all()).results).toEqual(
      beforeProjects,
    );
    expect((await raw.prepare("SELECT * FROM meta ORDER BY key").all()).results).toEqual(
      beforeMeta,
    );

    expect(afterRaw.map((row) => row.seq)).toEqual([2, 3, 4, 5, 6]);

    // 当てたあと：決まった値はすべて入る（完了済み・削除済み・進行中の行にも）。NULL に戻せる
    const [started, , , completed, deleted] = afterRaw;
    const taskById = (id: unknown) =>
      raw.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first();
    for (const priority of PRIORITIES) {
      for (const target of [started, completed, deleted]) {
        await raw
          .prepare("UPDATE tasks SET priority = ? WHERE id = ?")
          .bind(priority, target?.id)
          .run();
      }
    }
    for (const points of POINTS) {
      for (const target of [started, completed, deleted]) {
        await raw
          .prepare("UPDATE tasks SET points = ? WHERE id = ?")
          .bind(points, target?.id)
          .run();
      }
    }
    const afterSet = await taskById(started?.id);
    expect(afterSet?.priority).toBe("low");
    expect(afterSet?.points).toBe(13);
    expect(afterSet?.started_at).toBe(now);
    await raw
      .prepare("UPDATE tasks SET priority = NULL, points = NULL WHERE id = ?")
      .bind(started?.id)
      .run();
    const cleared = await taskById(started?.id);
    expect(cleared?.priority).toBeNull();
    expect(cleared?.points).toBeNull();

    // 決まった値以外は CHECK で落ちる（更新でも作成でも）
    for (const priority of ["urgent", "High", "", "none"]) {
      await expect(
        raw.prepare("UPDATE tasks SET priority = ? WHERE id = ?").bind(priority, started?.id).run(),
      ).rejects.toThrow(/CHECK constraint failed: tasks_priority_check/);
    }
    for (const points of [0, 4, 21, -1, 2.5, "abc"]) {
      await expect(
        raw.prepare("UPDATE tasks SET points = ? WHERE id = ?").bind(points, started?.id).run(),
      ).rejects.toThrow(/CHECK constraint failed: tasks_points_check/);
    }
    await expect(
      insertTask({ ...base(100), bucket: "inbox", priority: "critical" }),
    ).rejects.toThrow(/CHECK constraint failed: tasks_priority_check/);
    await expect(insertTask({ ...base(101), bucket: "inbox", points: 7 })).rejects.toThrow(
      /CHECK constraint failed: tasks_points_check/,
    );
    await insertTask({ ...base(102), bucket: "inbox", priority: "high", points: 5 });

    // 既存の CHECK（進行中なら今日・bucket の値・予定なら日付あり）も残っている
    await expect(
      raw.prepare("UPDATE tasks SET bucket = 'inbox' WHERE id = ?").bind(started?.id).run(),
    ).rejects.toThrow(/CHECK constraint failed: tasks_started_at_check/);
    await expect(insertTask({ ...base(103), bucket: "unknown" })).rejects.toThrow(
      /CHECK constraint failed: tasks_bucket_check/,
    );
    await expect(insertTask({ ...base(104), bucket: "scheduled" })).rejects.toThrow(
      /CHECK constraint failed: tasks_scheduled_on_check/,
    );
    // seq の UNIQUE も残っている
    await expect(insertTask({ ...base(2), bucket: "inbox" })).rejects.toThrow(
      /UNIQUE constraint failed/,
    );

    // 索引が残っている
    const indexNames = (
      await raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
    ).results.map((row) => row.name);
    expect(indexNames).toEqual(
      expect.arrayContaining([
        "tasks_seq_idx",
        "tasks_bucket_scheduled_on_idx",
        "tasks_deadline_on_idx",
        "projects_seq_idx",
      ]),
    );
  });
});
