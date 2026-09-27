import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { appliedMutations, projects, tasks } from "../db/schema";
import { interceptedDb } from "../test/intercept-d1";
import { parseBatch, projectInput, resetSyncTables, snapshot, taskInput } from "../test/sync-app";
import { applyMutationBatch } from "./mutate";

const db = getDb(env.DB);
const now = new Date("2026-09-28T12:00:00Z");

beforeEach(async () => {
  await resetSyncTables(db);
});

describe("A: 同時の再送（isApplied のあとに先行バッチが確定する）", () => {
  it("★ task.create：isApplied の直後に先行バッチが確定しても、200 で今の内容を返し、二重に書かない", async () => {
    const batch = parseBatch([{ type: "task.create", task: taskInput() }]);

    let triggered = false;
    const idb = interceptedDb(env.DB, {
      afterQuery: async (sql) => {
        if (triggered || !sql.includes("applied_mutations")) return;
        triggered = true;
        // 先行リクエスト（同じ ID のまとまり）が、こちらの isApplied のあとに確定する
        const racer = await applyMutationBatch(db, batch, now);
        expect(racer.ok).toBe(true);
      },
    });

    const outcome = await applyMutationBatch(idb, batch, now);
    expect(triggered).toBe(true);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.duplicate).toBe(true);
    expect(outcome.rows).toHaveLength(1);

    const after = await snapshot(db);
    expect(after.seq).toBe(1);
    expect(after.tasks).toHaveLength(1);
    const appliedRows = await db
      .select()
      .from(appliedMutations)
      .where(eq(appliedMutations.id, batch.id));
    expect(appliedRows).toHaveLength(1);
  });

  it("project.create でも同じことを確かめる", async () => {
    const batch = parseBatch([{ type: "project.create", project: projectInput() }]);

    let triggered = false;
    const idb = interceptedDb(env.DB, {
      afterQuery: async (sql) => {
        if (triggered || !sql.includes("applied_mutations")) return;
        triggered = true;
        const racer = await applyMutationBatch(db, batch, now);
        expect(racer.ok).toBe(true);
      },
    });

    const outcome = await applyMutationBatch(idb, batch, now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.duplicate).toBe(true);
    expect(outcome.rows).toHaveLength(1);

    const after = await snapshot(db);
    expect(after.seq).toBe(1);
    expect(after.projects).toHaveLength(1);
  });
});

describe("B: 検証のあとで対象の行が物理削除される", () => {
  it("★ task.update：バッチ実行の直前に対象行が消えると、400 task_not_found で何も書かれない", async () => {
    const existing = await applyMutationBatch(
      db,
      parseBatch([{ type: "task.create", task: taskInput() }]),
      now,
    );
    if (!existing.ok) throw new Error("下ごしらえの作成に失敗しました");
    const existingId = existing.rows[0]?.row.id;
    if (existingId === undefined) throw new Error("下ごしらえの id が読めません");

    const before = await snapshot(db);
    const batch = parseBatch([
      { type: "task.create", task: taskInput() },
      { type: "task.update", id: existingId, changes: { deletedAt: null } },
    ]);

    const idb = interceptedDb(env.DB, {
      beforeBatch: async () => {
        // 検証が終わったあと、書き込みの直前に、別のリクエスト（物理削除）が対象行を消す
        await db.delete(tasks).where(eq(tasks.id, existingId));
      },
    });

    const outcome = await applyMutationBatch(idb, batch, now);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("task_not_found");
    expect(outcome.mutationIndex).toBe(1);

    // 新しいタスクも作られておらず、meta.seq・applied_mutations も変わらない
    // （対象行が消えたこと自体は、テストが直前に仕込んだ「別のリクエスト」によるもの）
    expect(await db.select().from(tasks).where(eq(tasks.id, existingId))).toHaveLength(0);
    const afterSeq = (await snapshot(db)).seq;
    expect(afterSeq).toBe(before.seq);
    const appliedRows = await db
      .select()
      .from(appliedMutations)
      .where(eq(appliedMutations.id, batch.id));
    expect(appliedRows).toHaveLength(0);

    // 同じ ID で送り直しても、また 400 になる（反映済みとは見なされない）
    const resend = await applyMutationBatch(db, batch, now);
    expect(resend.ok).toBe(false);
    if (resend.ok) throw new Error("unreachable");
    expect(resend.reason).toBe("task_not_found");
  });

  it("project.update でも同じことを確かめる（project_not_found）", async () => {
    const existing = await applyMutationBatch(
      db,
      parseBatch([{ type: "project.create", project: projectInput() }]),
      now,
    );
    if (!existing.ok) throw new Error("下ごしらえの作成に失敗しました");
    const existingId = existing.rows[0]?.row.id;
    if (existingId === undefined) throw new Error("下ごしらえの id が読めません");

    const before = await snapshot(db);
    const batch = parseBatch([
      { type: "task.create", task: taskInput() },
      { type: "project.update", id: existingId, changes: { name: "renamed" } },
    ]);

    const idb = interceptedDb(env.DB, {
      beforeBatch: async () => {
        await db.delete(projects).where(eq(projects.id, existingId));
      },
    });

    const outcome = await applyMutationBatch(idb, batch, now);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("project_not_found");
    expect(outcome.mutationIndex).toBe(1);

    const afterSeq = (await snapshot(db)).seq;
    expect(afterSeq).toBe(before.seq);
    const appliedRows = await db
      .select()
      .from(appliedMutations)
      .where(eq(appliedMutations.id, batch.id));
    expect(appliedRows).toHaveLength(0);
  });
});

describe("D: バッチの途中の制約違反で全体が戻る", () => {
  async function withTrigger(createSql: string, dropSql: string, run: () => Promise<void>) {
    await env.DB.prepare(createSql).run();
    try {
      await run();
    } finally {
      await env.DB.prepare(dropSql).run();
    }
  }

  it("★ INSERT が制約違反で失敗すると、先に成功したはずの行・meta.seq・applied_mutations も元のまま", async () => {
    const batch = parseBatch([
      { type: "task.create", task: taskInput({ title: "normal" }) },
      { type: "task.create", task: taskInput({ title: "boom" }) },
    ]);

    await withTrigger(
      "CREATE TRIGGER test_fail_boom BEFORE INSERT ON tasks WHEN NEW.title = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END",
      "DROP TRIGGER test_fail_boom",
      async () => {
        const before = await snapshot(db);

        await expect(applyMutationBatch(db, batch, now)).rejects.toThrow();
        expect(await snapshot(db)).toEqual(before);

        // トリガーがあるあいだは、同じ ID で送り直しても失敗する
        await expect(applyMutationBatch(db, batch, now)).rejects.toThrow();
        expect(await snapshot(db)).toEqual(before);
      },
    );

    // トリガーを消してから同じ ID で送り直すと、200 で2行とも書かれる
    const outcome = await applyMutationBatch(db, batch, now);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error("unreachable");
    expect(outcome.duplicate).toBe(false);
    expect(outcome.rows).toHaveLength(2);
  });

  it("既存の行の更新が途中で失敗する場合（BEFORE UPDATE のトリガー）も、全体が戻る", async () => {
    const created = await applyMutationBatch(
      db,
      parseBatch([
        { type: "task.create", task: taskInput({ title: "task-a" }) },
        { type: "task.create", task: taskInput({ title: "task-b" }) },
      ]),
      now,
    );
    if (!created.ok) throw new Error("下ごしらえの作成に失敗しました");
    const [rowA, rowB] = created.rows;
    const idA = rowA?.row.id;
    const idB = rowB?.row.id;
    if (idA === undefined || idB === undefined) throw new Error("下ごしらえの id が読めません");

    await withTrigger(
      "CREATE TRIGGER test_fail_boom_update BEFORE UPDATE ON tasks WHEN NEW.title = 'boom-update' BEGIN SELECT RAISE(ABORT, 'boom-update'); END",
      "DROP TRIGGER test_fail_boom_update",
      async () => {
        const before = await snapshot(db);
        const batch = parseBatch([
          { type: "task.update", id: idA, changes: { title: "renamed-ok" } },
          { type: "task.update", id: idB, changes: { title: "boom-update" } },
        ]);

        await expect(applyMutationBatch(db, batch, now)).rejects.toThrow();

        expect(await snapshot(db)).toEqual(before);
        const stillA = await db.select().from(tasks).where(eq(tasks.id, idA)).get();
        expect(stillA?.title).toBe("task-a");
      },
    );
  });
});

describe("E: 検証のあとでチェックリストがほかの書き込みで変わる", () => {
  it("★ バッチの直前に配列が変わると、400 checklist_conflict で何も書かれない（バッチの中の守り）", async () => {
    const a = { id: crypto.randomUUID(), title: "A", done: false };
    const b = { id: crypto.randomUUID(), title: "B", done: false };
    const created = await applyMutationBatch(
      db,
      parseBatch([{ type: "task.create", task: taskInput({ checklist: [a, b] }) }]),
      now,
    );
    if (!created.ok) throw new Error("下ごしらえの作成に失敗しました");
    const id = created.rows[0]?.row.id;
    if (id === undefined) throw new Error("下ごしらえの id が読めません");

    const batch = parseBatch([
      {
        type: "task.update",
        id,
        changes: { checklist: [a, { ...b, done: true }] },
        baseChecklist: [a, b],
      },
    ]);
    const idb = interceptedDb(env.DB, {
      beforeBatch: async () => {
        // 検証が終わったあと、書き込みの直前に、ほかの画面の操作が A をチェックする
        const racer = await applyMutationBatch(
          db,
          parseBatch([
            {
              type: "task.update",
              id,
              changes: { checklist: [{ ...a, done: true }, b] },
              baseChecklist: [a, b],
            },
          ]),
          now,
        );
        expect(racer.ok).toBe(true);
      },
    });
    const before = await snapshot(db);

    const outcome = await applyMutationBatch(idb, batch, now);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("unreachable");
    expect(outcome.reason).toBe("checklist_conflict");

    // 割り込んだ書き込み（A のチェック）だけが残り、こちらのまとまりは何も書いていない
    const row = await db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(row?.checklist).toEqual([{ ...a, done: true }, b]);
    expect((await snapshot(db)).seq).toBe(before.seq + 1);
    const appliedRows = await db
      .select()
      .from(appliedMutations)
      .where(eq(appliedMutations.id, batch.id));
    expect(appliedRows).toHaveLength(0);
  });
});
