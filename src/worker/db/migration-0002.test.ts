import { applyD1Migrations, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "./client";
import { projects, tasks } from "./schema";

/**
 * migrations/0002_status_color.sql の確認。DB とは別の空の D1（MIGRATION_TEST_DB）を使い、
 * 0001 まで当てて既存の行を入れてから、残り（0002）を当てる。
 * 0002 を当てる前は、schema.ts が持つ started_at・color の列がまだない（drizzle での select はできない）ので、
 * 生の D1 の prepare で読み書きする。当てたあとは schema.ts と一致するので drizzle で読む
 */
describe("マイグレーション 0002：進行中とプロジェクトの色", () => {
  it("既存の行を保ったまま列を足し、CHECK 制約（tasks_started_at_check）と既存の制約・索引を守る", async () => {
    const raw = env.MIGRATION_TEST_DB;

    // 0001 まで当てる（同じ D1 に対して複数回このテストを走らせても、当て済みの版は飛ばされる）
    await applyD1Migrations(env.MIGRATION_TEST_DB, env.TEST_MIGRATIONS.slice(0, 2));
    // このテストの前の実行の行が残っているかもしれないので、先に空にする
    await raw.prepare("DELETE FROM tasks").run();
    await raw.prepare("DELETE FROM projects").run();

    const now = new Date("2026-01-01T00:00:00.000Z").toISOString();
    const projectId = crypto.randomUUID();
    const todayId = crypto.randomUUID();
    const inboxId = crypto.randomUUID();
    const scheduledId = crypto.randomUUID();

    await raw
      .prepare(
        "INSERT INTO projects (id, name, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(projectId, "既存プロジェクト", now, now, 1)
      .run();
    await raw
      .prepare(
        "INSERT INTO tasks (id, title, bucket, rank, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(todayId, "今日のタスク", "today", "a0", now, now, 1)
      .run();
    await raw
      .prepare(
        "INSERT INTO tasks (id, title, bucket, rank, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(inboxId, "受信箱のタスク", "inbox", "a1", now, now, 2)
      .run();
    await raw
      .prepare(
        "INSERT INTO tasks (id, title, bucket, scheduled_on, rank, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(scheduledId, "予定のタスク", "scheduled", "2026-02-01", "a2", now, now, 3)
      .run();

    // 0002 を当てる前の中身（started_at・color の列はまだ存在しない）
    const beforeTasks = await raw
      .prepare(
        "SELECT id, title, bucket, scheduled_on, rank, created_at, updated_at, seq FROM tasks ORDER BY seq",
      )
      .all();
    const beforeProjects = await raw
      .prepare("SELECT id, name, created_at, updated_at, seq FROM projects ORDER BY seq")
      .all();

    // 0002 がまだ当たっていないこと（前の状態が残っていて、当てずに通ってしまうのを防ぐ）
    const columnsOf = async (table: string) =>
      (await raw.prepare(`SELECT name FROM pragma_table_info('${table}')`).all()).results.map(
        (row) => row.name,
      );
    expect(await columnsOf("tasks")).not.toContain("started_at");
    expect(await columnsOf("projects")).not.toContain("color");

    // 残り（0002）を当てる
    await applyD1Migrations(env.MIGRATION_TEST_DB, env.TEST_MIGRATIONS);
    expect(await columnsOf("tasks")).toContain("started_at");
    expect(await columnsOf("projects")).toContain("color");

    const db = getDb(raw);
    const afterTasks = await db.select().from(tasks).orderBy(tasks.seq);
    const afterProjects = await db.select().from(projects).orderBy(projects.seq);

    // 既存の行は残り、seq も中身も変わらない。started_at と color は NULL
    expect(afterTasks.map((row) => row.id)).toEqual(beforeTasks.results.map((row) => row.id));
    afterTasks.forEach((row, i) => {
      const before = beforeTasks.results[i] as Record<string, unknown>;
      expect(row.title).toBe(before.title);
      expect(row.bucket).toBe(before.bucket);
      expect(row.scheduledOn).toBe(before.scheduled_on);
      expect(row.rank).toBe(before.rank);
      expect(row.createdAt).toBe(before.created_at);
      expect(row.updatedAt).toBe(before.updated_at);
      expect(row.seq).toBe(before.seq);
      expect(row.startedAt).toBeNull();
    });
    expect(afterProjects.map((row) => row.id)).toEqual(beforeProjects.results.map((row) => row.id));
    for (const row of afterProjects) expect(row.color).toBeNull();

    // 当てたあと：今日の行に started_at を入れるのは通る
    await raw.prepare("UPDATE tasks SET started_at = ? WHERE id = ?").bind(now, todayId).run();
    const started = await db.select().from(tasks).where(eq(tasks.id, todayId)).get();
    expect(started?.startedAt).toBe(now);

    // 今日以外で started_at を入れる書き込みは CHECK で落ちる
    await expect(
      raw
        .prepare(
          "INSERT INTO tasks (id, title, bucket, started_at, rank, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), "不正：今日以外で進行中", "inbox", now, "a9", now, now, 100)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed: tasks_started_at_check/);

    // 進行中のまま bucket を今日の外へ変える書き込みも CHECK で落ちる
    await expect(
      raw.prepare("UPDATE tasks SET bucket = 'inbox' WHERE id = ?").bind(todayId).run(),
    ).rejects.toThrow(/CHECK constraint failed: tasks_started_at_check/);

    // 既存の CHECK（bucket・scheduled_on）も残っている
    await expect(
      raw
        .prepare(
          "INSERT INTO tasks (id, title, bucket, rank, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), "不正な bucket", "unknown", "a8", now, now, 101)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      raw
        .prepare(
          "INSERT INTO tasks (id, title, bucket, rank, created_at, updated_at, seq) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(crypto.randomUUID(), "予定なのに日付なし", "scheduled", "a7", now, now, 102)
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);

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
