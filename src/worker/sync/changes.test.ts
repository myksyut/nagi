import { env } from "cloudflare:test";
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { tasks } from "../db/schema";
import {
  apiApp,
  insertRawProjects,
  insertRawTasks,
  mutationBatch,
  resetSyncTables,
  setMeta,
  syncBody,
  taskInput,
} from "../test/sync-app";
import { readChanges } from "./changes";

const db = getDb(env.DB);

beforeEach(async () => {
  await resetSyncTables(db);
});

describe("★ カーソルとページ分けで取りこぼしがない", () => {
  it("500行を超えるデータ（タスクとプロジェクトを混ぜる）をページでたどると、全行がちょうど1回ずつseqの順に並ぶ", async () => {
    await insertRawTasks(db, 300, 1);
    await insertRawProjects(db, 300, 301);
    await setMeta(db, "seq", "600");

    const { post } = apiApp();
    const page1 = await syncBody(await post("/api/sync", { cursor: 0, baseCursor: 0 }));
    expect(page1.rows).toHaveLength(500);
    expect(page1.hasMore).toBe(true);
    const lastOfPage1 = page1.rows.at(-1);
    if (lastOfPage1 === undefined) throw new Error("page1.rows が空です");
    expect(page1.nextCursor).toBe(lastOfPage1.row.seq);

    const page2 = await syncBody(
      await post("/api/sync", { cursor: page1.nextCursor, baseCursor: 0 }),
    );
    expect(page2.rows).toHaveLength(100);
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBe(600);

    const seqs = [...page1.rows, ...page2.rows].map((r) => r.row.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(600);
    expect(Math.min(...seqs)).toBe(1);
    expect(Math.max(...seqs)).toBe(600);
  });

  it("ページのあいだに1ページ目の行を更新すると、その行が新しいseqで後のページに入る", async () => {
    const rawTasks = await insertRawTasks(db, 300, 1);
    await insertRawProjects(db, 300, 301);
    await setMeta(db, "seq", "600");

    const { post } = apiApp();
    const page1 = await syncBody(await post("/api/sync", { cursor: 0, baseCursor: 0 }));
    expect(page1.rows).toHaveLength(500);

    const updatedId = rawTasks[0]?.id;
    if (updatedId === undefined) throw new Error("rawTasks が空です");
    await db.update(tasks).set({ seq: 601 }).where(eq(tasks.id, updatedId));
    await setMeta(db, "seq", "601");

    const page2 = await syncBody(
      await post("/api/sync", { cursor: page1.nextCursor, baseCursor: 0 }),
    );
    expect(page2.hasMore).toBe(false);
    expect(page2.nextCursor).toBe(601);
    expect(page2.rows).toHaveLength(101);
    const updatedRow = page2.rows.filter((r) => r.row.id === updatedId);
    expect(updatedRow).toHaveLength(1);
    expect(updatedRow[0]?.row.seq).toBe(601);
  });

  it("小さいpageSizeでreadChangesを直接呼び、境目も確かめる", async () => {
    await insertRawTasks(db, 7, 1);
    await setMeta(db, "seq", "7");
    const pageSize = 3;
    let cursor = 0;
    const collected: number[] = [];
    for (let i = 0; i < 10; i++) {
      const res = await readChanges(db, { cursor, baseCursor: 0 }, pageSize);
      if (res.reset) throw new Error("予期しない reset");
      expect(res.rows.length).toBeLessThanOrEqual(pageSize);
      collected.push(...res.rows.map((r) => r.row.seq));
      cursor = res.nextCursor;
      if (!res.hasMore) break;
    }
    expect(collected).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("★ 同期と書き込みを同時に走らせても取りこぼさない", () => {
  it("mutateを何本も同時に投げながら同期でカーソルをたどると、最終的にDBの全行と一致する", async () => {
    const { post } = apiApp();
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());

    let mutatesDone = false;
    const mutatePromise = Promise.all(
      ids.map((id) =>
        post("/api/mutate", mutationBatch([{ type: "task.create", task: taskInput({ id }) }])),
      ),
    ).then((responses) => {
      mutatesDone = true;
      return responses;
    });

    const collected = new Map<string, number>();
    const state = { cursor: 0, baseCursor: 0 };
    const drainOnce = async () => {
      const body = await syncBody(await post("/api/sync", state));
      for (const row of body.rows) {
        if (row.kind === "task") collected.set(row.row.id, row.row.seq);
      }
      state.cursor = body.nextCursor;
      return body.hasMore;
    };

    while (!mutatesDone) {
      await drainOnce();
    }
    const responses = await mutatePromise;
    for (const res of responses) expect(res.status).toBe(200);
    // 最後のカーソルでもう一度同期して残りを取り切る
    let hasMore = await drainOnce();
    while (hasMore) hasMore = await drainOnce();

    const dbRows = await db.select().from(tasks).where(inArray(tasks.id, ids));
    expect(dbRows).toHaveLength(ids.length);
    expect(collected.size).toBe(dbRows.length);
    for (const row of dbRows) {
      expect(collected.get(row.id)).toBe(row.seq);
    }
  });
});

describe("★ reset", () => {
  it("baseCursorが0なら、purged_through_seqが0より大きくてもresetにならない", async () => {
    await setMeta(db, "seq", "5");
    await setMeta(db, "purged_through_seq", "3");
    const res = await readChanges(db, { cursor: 0, baseCursor: 0 });
    expect(res.reset).toBe(false);
  });

  it("0 < baseCursor < purged_through_seq ならreset。baseCursor == purged_through_seq ならresetにならない", async () => {
    await setMeta(db, "seq", "10");
    await setMeta(db, "purged_through_seq", "5");
    expect((await readChanges(db, { cursor: 0, baseCursor: 3 })).reset).toBe(true);
    expect((await readChanges(db, { cursor: 0, baseCursor: 5 })).reset).toBe(false);
  });

  it("baseCursorやcursorがmeta.seqより大きいならreset", async () => {
    await setMeta(db, "seq", "10");
    await setMeta(db, "purged_through_seq", "0");
    expect((await readChanges(db, { cursor: 0, baseCursor: 11 })).reset).toBe(true);
    expect((await readChanges(db, { cursor: 11, baseCursor: 0 })).reset).toBe(true);
  });

  it("★ 無限ループにならない：物理削除のあと（消した行のseqが残っている行のseqより大きい場合を含む）に、baseCursor: 0から小さいpageSizeでページをたどると、resetが一度も返らずに最後までたどり着く。最後のnextCursorをbaseCursorにして次の同期をしてもresetにならない", async () => {
    await insertRawTasks(db, 20, 1);
    // seq 15〜20 を物理削除。消した行の最大seq（20）をpurged_through_seqに、meta.seqは進めない
    await db.delete(tasks).where(and(gte(tasks.seq, 15), lte(tasks.seq, 20)));
    await setMeta(db, "purged_through_seq", "20");
    await setMeta(db, "seq", "20");

    let cursor = 0;
    const baseCursor = 0;
    const collected: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await readChanges(db, { cursor, baseCursor }, 3);
      if (res.reset) throw new Error("予期しない reset");
      collected.push(...res.rows.map((r) => r.row.seq));
      cursor = res.nextCursor;
      if (!res.hasMore) break;
    }
    expect(collected).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(cursor).toBe(20);

    const next = await readChanges(db, { cursor, baseCursor: cursor });
    expect(next.reset).toBe(false);
  });
});
