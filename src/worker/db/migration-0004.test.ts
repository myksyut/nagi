import { applyD1Migrations, env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { getDb } from "./client";
import { OWNER_USER_ID, tasks } from "./schema";

/**
 * migrations/0004_users.sql の確認。DB とは別の空の D1（MIGRATION_0004_TEST_DB）を使い、0003 まで当てて
 * 既存の行（セッション・プロジェクト・いろいろな状態のタスク・反映済みの操作・進んだ meta）を入れてから、0004 を当てる。
 * 0004 を当てる前は、schema.ts が持つ user_id の列がまだない（drizzle での select はできない）ので、
 * 生の D1 の prepare で読み書きする。当てたあとは schema.ts と一致するので、drizzle でも読む
 */
describe("マイグレーション 0004：利用者", () => {
  it("既存の行をすべて、中身も seq も変えずに、利用者 owner のものとして引き継ぐ。主キー・索引・外部キー・CHECK は利用者ごとの形になる", async () => {
    const raw = env.MIGRATION_0004_TEST_DB;
    const all = async (sql: string, ...binds: unknown[]) =>
      (
        await raw
          .prepare(sql)
          .bind(...binds)
          .all()
      ).results;
    const insert = (table: string, columns: Record<string, unknown>) => {
      const names = Object.keys(columns);
      return raw
        .prepare(
          `INSERT INTO ${table} (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        )
        .bind(...Object.values(columns))
        .run();
    };

    // 0003 まで当てる（同じ D1 に対して複数回このテストを走らせても、当て済みの版は飛ばされる）
    await applyD1Migrations(raw, env.TEST_MIGRATIONS.slice(0, 4));
    // 0004 がまだ当たっていないこと（前の状態が残っていて、当てずに通ってしまうのを防ぐ）
    const tableNames = async () =>
      (await all("SELECT name FROM sqlite_master WHERE type = 'table'")).map((row) => row.name);
    expect(await tableNames()).not.toContain("users");

    const now = "2026-01-01T00:00:00.000Z";
    const later = "2026-01-02T03:04:05.678Z";
    const projectId = crypto.randomUUID();
    const base = (seq: number) => ({
      id: crypto.randomUUID(),
      title: `タスク ${seq}`,
      rank: `a${seq}`,
      created_at: now,
      updated_at: later,
      seq,
    });
    await insert("sessions", {
      id: "a".repeat(64),
      expires_at: "2027-01-01T00:00:00.000Z",
      created_at: now,
    });
    await insert("sessions", {
      id: "b".repeat(64),
      expires_at: "2027-06-01T00:00:00.000Z",
      created_at: later,
    });
    await insert("projects", {
      id: projectId,
      name: "色つき",
      color: "sky",
      created_at: now,
      updated_at: now,
      seq: 1,
    });
    await insert("projects", {
      id: crypto.randomUUID(),
      name: "アーカイブして削除",
      archived_at: now,
      deleted_at: later,
      created_at: now,
      updated_at: later,
      seq: 2,
    });
    await insert("tasks", {
      ...base(3),
      bucket: "today",
      started_at: now,
      project_id: projectId,
      arrived_on: "2026-01-01",
    });
    await insert("tasks", {
      ...base(4),
      bucket: "inbox",
      memo: "メモ\n2 行目 'quote' \"double\"",
      deadline_on: "2026-01-05",
      priority: "high",
      points: 5,
      checklist: JSON.stringify([{ id: "c1", title: "項目", done: true }]),
    });
    await insert("tasks", { ...base(5), bucket: "scheduled", scheduled_on: "2026-02-01" });
    await insert("tasks", { ...base(6), bucket: "later", completed_at: later });
    await insert("tasks", { ...base(7), bucket: "inbox", deleted_at: later });
    await insert("applied_mutations", { id: crypto.randomUUID(), applied_at: now });
    await insert("applied_mutations", { id: crypto.randomUUID(), applied_at: later });
    await raw.batch([
      raw.prepare("UPDATE meta SET value = '7' WHERE key = 'seq'"),
      raw.prepare("UPDATE meta SET value = '2026-01-02' WHERE key = 'last_rollover_on'"),
      raw.prepare("UPDATE meta SET value = '2' WHERE key = 'purged_through_seq'"),
    ]);

    const TABLES = {
      sessions: "id",
      projects: "seq",
      tasks: "seq",
      applied_mutations: "id",
      meta: "key",
    } as const;
    const before: Record<string, Record<string, unknown>[]> = {};
    for (const [table, order] of Object.entries(TABLES)) {
      before[table] = await all(`SELECT * FROM ${table} ORDER BY ${order}`);
    }
    expect(before.sessions).toHaveLength(2);
    expect(before.projects).toHaveLength(2);
    expect(before.tasks).toHaveLength(5);
    expect(before.applied_mutations).toHaveLength(2);
    expect(before.meta).toHaveLength(3);

    // 0004 を当てる
    await applyD1Migrations(raw, env.TEST_MIGRATIONS.slice(0, 5));

    // 利用者は owner の 1 人。GitHub のユーザーはまだ入っていない
    const userRows = await all("SELECT * FROM users");
    expect(userRows).toEqual([
      { id: OWNER_USER_ID, github_user_id: null, created_at: expect.any(String) },
    ]);
    // created_at は、JS の toISOString() と同じ形
    const createdAt = String(userRows[0]?.created_at);
    expect(new Date(createdAt).toISOString()).toBe(createdAt);

    // どの表の行も、数・中身・seq はそのままで、user_id に owner が入る。
    // セッションの表は、名前が user_sessions に変わる（古い版の Worker が読めないように）
    for (const [table, order] of Object.entries(TABLES)) {
      const after = table === "sessions" ? "user_sessions" : table;
      expect(await all(`SELECT * FROM ${after} ORDER BY ${order}`), table).toEqual(
        before[table]?.map((row) => ({ ...row, user_id: OWNER_USER_ID })),
      );
    }
    expect(await tableNames()).not.toContain("sessions");
    // 作り直しの途中の表は残っていない
    expect((await tableNames()).filter((name) => String(name).startsWith("__new_"))).toEqual([]);

    // schema.ts と一致するので drizzle で読める（JSON のチェックリストも読める）
    const db = getDb(raw);
    const viaDrizzle = await db.select().from(tasks).orderBy(tasks.seq);
    expect(viaDrizzle.map((row) => [row.userId, row.seq])).toEqual(
      [3, 4, 5, 6, 7].map((seq) => [OWNER_USER_ID, seq]),
    );
    expect(viaDrizzle[1]?.checklist).toEqual([{ id: "c1", title: "項目", done: true }]);
    expect(viaDrizzle[1]?.memo).toBe("メモ\n2 行目 'quote' \"double\"");

    // --- ここからは、当てたあとの表の形
    await insert("users", { id: "u2", github_user_id: 2002, created_at: now });
    const existing = viaDrizzle[0];
    if (!existing) throw new Error("既存のタスクがありません");
    const task = (userId: string, seq: number, overrides: Record<string, unknown> = {}) => ({
      user_id: userId,
      ...base(seq),
      bucket: "inbox",
      ...overrides,
    });

    // 主キーは user_id と id：別の利用者なら、同じ id・同じ seq の行を持てる。同じ利用者では持てない
    await insert("tasks", task("u2", existing.seq, { id: existing.id }));
    await expect(insert("tasks", task("u2", 100, { id: existing.id }))).rejects.toThrow(
      /UNIQUE constraint failed: tasks\.user_id, tasks\.id/,
    );
    await expect(insert("tasks", task(OWNER_USER_ID, existing.seq))).rejects.toThrow(
      /UNIQUE constraint failed: tasks\.user_id, tasks\.seq/,
    );
    await insert("projects", {
      user_id: "u2",
      id: projectId,
      name: "同じ id",
      created_at: now,
      updated_at: now,
      seq: 1,
    });
    await expect(
      insert("projects", {
        user_id: "u2",
        id: projectId,
        name: "重なり",
        created_at: now,
        updated_at: now,
        seq: 9,
      }),
    ).rejects.toThrow(/UNIQUE constraint failed: projects\.user_id, projects\.id/);
    await expect(
      insert("projects", {
        user_id: "u2",
        id: crypto.randomUUID(),
        name: "seq の重なり",
        created_at: now,
        updated_at: now,
        seq: 1,
      }),
    ).rejects.toThrow(/UNIQUE constraint failed: projects\.user_id, projects\.seq/);
    const appliedId = String(before.applied_mutations?.[0]?.id);
    await insert("applied_mutations", { user_id: "u2", id: appliedId, applied_at: now });
    await expect(
      insert("applied_mutations", { user_id: OWNER_USER_ID, id: appliedId, applied_at: now }),
    ).rejects.toThrow(
      /UNIQUE constraint failed: applied_mutations\.user_id, applied_mutations\.id/,
    );
    await insert("meta", { user_id: "u2", key: "seq", value: "0" });
    await expect(insert("meta", { user_id: "u2", key: "seq", value: "1" })).rejects.toThrow(
      /UNIQUE constraint failed: meta\.user_id, meta\.key/,
    );

    // user_id は必須で、いる利用者だけを指せる（外部キー）
    await expect(insert("tasks", { ...base(200), bucket: "inbox" })).rejects.toThrow(
      /NOT NULL constraint failed: tasks\.user_id/,
    );
    for (const [table, columns] of [
      ["tasks", task("nobody", 201)],
      [
        "projects",
        { user_id: "nobody", id: "p", name: "p", created_at: now, updated_at: now, seq: 1 },
      ],
      [
        "user_sessions",
        { user_id: "nobody", id: "c".repeat(64), expires_at: later, created_at: now },
      ],
      ["applied_mutations", { user_id: "nobody", id: "m", applied_at: now }],
      ["meta", { user_id: "nobody", key: "seq", value: "0" }],
    ] as const) {
      await expect(insert(table, columns), table).rejects.toThrow(/FOREIGN KEY constraint failed/);
    }
    // GitHub のユーザー ID は、利用者の中で重ならない
    await expect(
      insert("users", { id: "u3", github_user_id: 2002, created_at: now }),
    ).rejects.toThrow(/UNIQUE constraint failed: users\.github_user_id/);

    // タスクの CHECK は、作り直したあとも残っている
    const started = await db.select().from(tasks).where(eq(tasks.seq, 3)).get();
    await expect(
      raw.prepare("UPDATE tasks SET bucket = 'inbox' WHERE id = ?").bind(started?.id).run(),
    ).rejects.toThrow(/CHECK constraint failed: tasks_started_at_check/);
    for (const [overrides, check] of [
      [{ bucket: "unknown" }, "tasks_bucket_check"],
      [{ bucket: "scheduled" }, "tasks_scheduled_on_check"],
      [{ priority: "urgent" }, "tasks_priority_check"],
      [{ points: 4 }, "tasks_points_check"],
    ] as const) {
      await expect(insert("tasks", task("u2", 300, overrides)), check).rejects.toThrow(
        new RegExp(`CHECK constraint failed: ${check}`),
      );
    }

    // 索引は、どれも user_id から始まる
    const indexSql = Object.fromEntries(
      (
        await all("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL")
      ).map((row) => [row.name, String(row.sql).replace(/[`"\s]/g, "")]),
    );
    expect(indexSql.tasks_seq_idx).toContain("UNIQUEINDEXtasks_seq_idxONtasks(user_id,seq)");
    expect(indexSql.tasks_bucket_scheduled_on_idx).toContain(
      "ONtasks(user_id,bucket,scheduled_on)",
    );
    expect(indexSql.tasks_deadline_on_idx).toContain("ONtasks(user_id,deadline_on)");
    expect(indexSql.projects_seq_idx).toContain(
      "UNIQUEINDEXprojects_seq_idxONprojects(user_id,seq)",
    );
    expect(indexSql.users_github_user_id_idx).toContain("ONusers(github_user_id)");
  });

  it("空の D1 に最後まで当てると、利用者 owner と、その meta の初期値ができる", async () => {
    // テスト用の DB（env.DB）は、各テストファイルの前に最後まで当ててある。ほかのテストは owner の行を消さない
    const users = (
      await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(OWNER_USER_ID).all()
    ).results;
    expect(users).toEqual([{ id: OWNER_USER_ID }]);
    const keys = (
      await env.DB.prepare("SELECT key FROM meta WHERE user_id = ? ORDER BY key")
        .bind(OWNER_USER_ID)
        .all()
    ).results.map((row) => row.key);
    expect(keys).toEqual(["last_rollover_on", "purged_through_seq", "seq"]);
  });
});
