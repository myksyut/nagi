import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { compareRank } from "../../shared/rank";
import { getDb } from "../db/client";
import { meta, tasks } from "../db/schema";
import { interceptedDb } from "../test/intercept-d1";
import { insertRawTask, parseBatch, resetSyncTables, setMeta, taskInput } from "../test/sync-app";
import { applyMutationBatch } from "./mutate";
import { rolloverIfDue } from "./rollover";

const db = getDb(env.DB);

beforeEach(async () => {
  await resetSyncTables(db);
});

const TODAY = "2026-09-28";
const YESTERDAY = "2026-09-27";
/** 論理日付が TODAY になる時刻（Asia/Tokyo の正午） */
const NOW = new Date(`${TODAY}T12:00:00+09:00`);

async function taskById(id: string) {
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

async function lastRolloverOn() {
  const row = await db.select().from(meta).where(eq(meta.key, "last_rollover_on")).get();
  return row?.value;
}

describe("C: 日付の切り替えの最中に確定した期限のタスク", () => {
  it("★ 予定日：書き込みバッチの直前に期限のタスクが確定すると、last_rollover_onは進まず、次の呼び出しで移る（先に移したタスクの後ろに並ぶ）", async () => {
    const original = await insertRawTask(db, {
      bucket: "scheduled",
      scheduledOn: YESTERDAY,
      seq: 1,
    });
    await setMeta(db, "seq", "1");

    let injectedId: string | undefined;
    const idb = interceptedDb(env.DB, {
      beforeBatch: async (n) => {
        // 1回目は候補の読み取り、2回目が書き込み。書き込みの直前に、別のリクエストが
        // /api/mutate で「予定日が今日」のタスクを確定させる
        if (n !== 2) return;
        const created = await applyMutationBatch(
          db,
          parseBatch([
            { type: "task.create", task: taskInput({ bucket: "scheduled", scheduledOn: TODAY }) },
          ]),
          NOW,
        );
        if (!created.ok) throw new Error("下ごしらえの作成に失敗しました");
        injectedId = created.rows[0]?.row.id;
      },
    });

    const first = await rolloverIfDue(idb, NOW, "Asia/Tokyo");
    expect(first.ran).toBe(true);
    expect(first.moved).toBe(1); // このバッチが移すのは、読み取り時点の候補（original）だけ
    expect(await lastRolloverOn()).toBe(""); // 期限のタスクがまだ残っているので進まない

    if (injectedId === undefined) throw new Error("下ごしらえの id が読めません");
    const injectedAfterFirst = await taskById(injectedId);
    expect(injectedAfterFirst?.bucket).toBe("scheduled"); // まだ移っていない

    // もう一度呼ぶと、残っていたタスクが移り、last_rollover_on が今日になる
    const second = await rolloverIfDue(db, NOW, "Asia/Tokyo");
    expect(second.ran).toBe(true);
    expect(second.moved).toBe(1);
    expect(await lastRolloverOn()).toBe(TODAY);

    const injectedAfterSecond = await taskById(injectedId);
    expect(injectedAfterSecond?.bucket).toBe("today");
    expect(injectedAfterSecond?.arrivedOn).toBe(TODAY);
    expect(injectedAfterSecond?.scheduledOn).toBeNull();

    // 先に移した original の後ろに並ぶ
    const originalAfter = await taskById(original.id);
    if (originalAfter === undefined || injectedAfterSecond === undefined) {
      throw new Error("行が読めていません");
    }
    expect(
      compareRank(
        { id: originalAfter.id, rank: originalAfter.rank },
        { id: injectedAfterSecond.id, rank: injectedAfterSecond.rank },
      ),
    ).toBeLessThan(0);
  });

  it("締切が今日の受信箱のタスクでも同じく進まない（isDueと同じ条件であることの確認）", async () => {
    const original = await insertRawTask(db, {
      bucket: "later",
      deadlineOn: YESTERDAY,
      seq: 1,
    });
    await setMeta(db, "seq", "1");

    let injectedId: string | undefined;
    const idb = interceptedDb(env.DB, {
      beforeBatch: async (n) => {
        if (n !== 2) return;
        const created = await applyMutationBatch(
          db,
          parseBatch([
            { type: "task.create", task: taskInput({ bucket: "inbox", deadlineOn: TODAY }) },
          ]),
          NOW,
        );
        if (!created.ok) throw new Error("下ごしらえの作成に失敗しました");
        injectedId = created.rows[0]?.row.id;
      },
    });

    const first = await rolloverIfDue(idb, NOW, "Asia/Tokyo");
    expect(first.ran).toBe(true);
    expect(first.moved).toBe(1);
    expect(await lastRolloverOn()).toBe("");

    if (injectedId === undefined) throw new Error("下ごしらえの id が読めません");
    expect((await taskById(injectedId))?.bucket).toBe("inbox");

    const second = await rolloverIfDue(db, NOW, "Asia/Tokyo");
    expect(second.ran).toBe(true);
    expect(second.moved).toBe(1);
    expect(await lastRolloverOn()).toBe(TODAY);
    expect((await taskById(injectedId))?.bucket).toBe("today");
    expect((await taskById(original.id))?.bucket).toBe("today");
  });
});
