import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { compareRank, rankAfter, ranksBetween } from "../../shared/rank";
import { getDb } from "../db/client";
import { appliedMutations, meta, projects, tasks } from "../db/schema";
import {
  apiApp,
  insertRawProject,
  insertRawTask,
  resetSyncTables,
  setMeta,
} from "../test/sync-app";
import { rolloverIfDue } from "./rollover";

const db = getDb(env.DB);

beforeEach(async () => {
  await resetSyncTables(db);
});

const YESTERDAY = "2026-09-27";
const TODAY = "2026-09-28";
const TOMORROW = "2026-09-29";
/** 論理日付が TODAY になる時刻（Asia/Tokyo の正午） */
const NOW = new Date(`${TODAY}T12:00:00+09:00`);

async function taskById(id: string) {
  return db.select().from(tasks).where(eq(tasks.id, id)).get();
}

describe("★ 予定と締切の各条件", () => {
  it("予定の日付が今日より前と今日のものは移り、明日のものは残る。締切が今日以前ならどこにあっても移り、先なら残る。完了済み・削除済みは移らない", async () => {
    const scheduledPast = await insertRawTask(db, {
      bucket: "scheduled",
      scheduledOn: YESTERDAY,
      seq: 1,
    });
    const scheduledToday = await insertRawTask(db, {
      bucket: "scheduled",
      scheduledOn: TODAY,
      seq: 2,
    });
    const scheduledFuture = await insertRawTask(db, {
      bucket: "scheduled",
      scheduledOn: TOMORROW,
      seq: 3,
    });
    const deadlineInbox = await insertRawTask(db, { bucket: "inbox", deadlineOn: TODAY, seq: 4 });
    const deadlineFuture = await insertRawTask(db, {
      bucket: "later",
      deadlineOn: TOMORROW,
      seq: 5,
    });
    const completedPast = await insertRawTask(db, {
      bucket: "scheduled",
      scheduledOn: YESTERDAY,
      completedAt: NOW.toISOString(),
      seq: 6,
    });
    const deletedPast = await insertRawTask(db, {
      bucket: "scheduled",
      scheduledOn: YESTERDAY,
      deletedAt: NOW.toISOString(),
      seq: 7,
    });
    const alreadyToday = await insertRawTask(db, {
      bucket: "today",
      arrivedOn: "2026-09-20",
      rank: rankAfter(null),
      seq: 8,
    });
    // scheduled だが、締切の方が早く来て動くケース（移ったあと scheduledOn は空になる）
    const deadlineWinsOverFutureSchedule = await insertRawTask(db, {
      bucket: "scheduled",
      scheduledOn: TOMORROW,
      deadlineOn: TODAY,
      seq: 9,
    });
    await setMeta(db, "seq", "9");

    const result = await rolloverIfDue(db, NOW, "Asia/Tokyo");
    expect(result.ran).toBe(true);
    expect(result.moved).toBe(4);

    for (const moved of [
      scheduledPast,
      scheduledToday,
      deadlineInbox,
      deadlineWinsOverFutureSchedule,
    ]) {
      const row = await taskById(moved.id);
      expect(row?.bucket).toBe("today");
      expect(row?.arrivedOn).toBe(TODAY);
      expect(row?.scheduledOn).toBeNull();
      expect(row?.updatedAt).toBe(NOW.toISOString());
      expect(row?.seq).toBeGreaterThan(9);
    }
    // 締切自体は変わらない
    expect((await taskById(deadlineInbox.id))?.deadlineOn).toBe(TODAY);
    expect((await taskById(deadlineWinsOverFutureSchedule.id))?.deadlineOn).toBe(TODAY);

    // 残るもの
    expect(await taskById(scheduledFuture.id)).toEqual(scheduledFuture);
    expect(await taskById(deadlineFuture.id)).toEqual(deadlineFuture);
    expect(await taskById(completedPast.id)).toEqual(completedPast);
    expect(await taskById(deletedPast.id)).toEqual(deletedPast);

    // すでに今日にあるものは rank・arrivedOn・seq が変わらない
    expect(await taskById(alreadyToday.id)).toEqual(alreadyToday);
  });
});

describe("★ 並ぶ位置", () => {
  it("今日来たタスクの後ろ・それ以外の前に並ぶ。移った行どうしはきっかけの日付の早い順、同じなら作成順", async () => {
    const [arrivedTodayRankSeed, otherTodayRankSeed] = ranksBetween(null, null, 2);
    if (arrivedTodayRankSeed === undefined || otherTodayRankSeed === undefined) {
      throw new Error("rank が生成できていません");
    }
    const arrivedToday = await insertRawTask(db, {
      bucket: "today",
      arrivedOn: TODAY,
      rank: arrivedTodayRankSeed,
      seq: 1,
    });
    const otherToday = await insertRawTask(db, {
      bucket: "today",
      arrivedOn: "2026-09-01",
      rank: otherTodayRankSeed,
      seq: 2,
    });

    const t0 = new Date(NOW.getTime() - 3000).toISOString();
    const t1 = new Date(NOW.getTime() - 2000).toISOString();
    const t2 = new Date(NOW.getTime() - 1000).toISOString();
    // 早い順に来るはずの3件：締切3日前、締切1日前、締切が同じ今日で作成順の異なる2件
    const earliest = await insertRawTask(db, {
      bucket: "later",
      deadlineOn: "2026-09-25",
      createdAt: t0,
      seq: 3,
    });
    const middle = await insertRawTask(db, {
      bucket: "later",
      deadlineOn: "2026-09-27",
      createdAt: t1,
      seq: 4,
    });
    const tieCreatedFirst = await insertRawTask(db, {
      bucket: "inbox",
      deadlineOn: TODAY,
      createdAt: t1,
      seq: 5,
    });
    const tieCreatedSecond = await insertRawTask(db, {
      bucket: "inbox",
      deadlineOn: TODAY,
      createdAt: t2,
      seq: 6,
    });
    await setMeta(db, "seq", "6");

    const result = await rolloverIfDue(db, NOW, "Asia/Tokyo");
    expect(result.ran).toBe(true);
    expect(result.moved).toBe(4);

    const arrivedTodayRank = (await taskById(arrivedToday.id))?.rank;
    const otherTodayRank = (await taskById(otherToday.id))?.rank;
    const earliestRank = (await taskById(earliest.id))?.rank;
    const middleRank = (await taskById(middle.id))?.rank;
    const tieFirstRank = (await taskById(tieCreatedFirst.id))?.rank;
    const tieSecondRank = (await taskById(tieCreatedSecond.id))?.rank;
    if (
      arrivedTodayRank === undefined ||
      otherTodayRank === undefined ||
      earliestRank === undefined ||
      middleRank === undefined ||
      tieFirstRank === undefined ||
      tieSecondRank === undefined
    ) {
      throw new Error("rank が読めていません");
    }

    const order = [
      { id: arrivedToday.id, rank: arrivedTodayRank },
      { id: earliest.id, rank: earliestRank },
      { id: middle.id, rank: middleRank },
      { id: tieCreatedFirst.id, rank: tieFirstRank },
      { id: tieCreatedSecond.id, rank: tieSecondRank },
      { id: otherToday.id, rank: otherTodayRank },
    ];
    for (let i = 0; i + 1 < order.length; i++) {
      const a = order[i];
      const b = order[i + 1];
      if (a === undefined || b === undefined) throw new Error("order が読めていません");
      expect(compareRank(a, b)).toBeLessThan(0);
    }
  });

  it("今日来たタスクがなければ一番上に並ぶ", async () => {
    const otherToday = await insertRawTask(db, {
      bucket: "today",
      arrivedOn: "2026-09-01",
      rank: rankAfter(null),
      seq: 1,
    });
    const moving = await insertRawTask(db, { bucket: "scheduled", scheduledOn: YESTERDAY, seq: 2 });
    await setMeta(db, "seq", "2");

    const result = await rolloverIfDue(db, NOW, "Asia/Tokyo");
    expect(result.moved).toBe(1);

    const movingRank = (await taskById(moving.id))?.rank;
    const otherTodayRank = (await taskById(otherToday.id))?.rank;
    if (movingRank === undefined || otherTodayRank === undefined)
      throw new Error("rank が読めていません");
    expect(
      compareRank({ id: moving.id, rank: movingRank }, { id: otherToday.id, rank: otherTodayRank }),
    ).toBeLessThan(0);
  });
});

describe("★ 2回実行しても同じ結果になる", () => {
  it("続けて2回実行すると、2回目は何もしない（ran: false）", async () => {
    await insertRawTask(db, { bucket: "scheduled", scheduledOn: YESTERDAY, seq: 1 });
    await setMeta(db, "seq", "1");

    const first = await rolloverIfDue(db, NOW, "Asia/Tokyo");
    expect(first.ran).toBe(true);
    expect(first.moved).toBe(1);

    const second = await rolloverIfDue(db, NOW, "Asia/Tokyo");
    expect(second).toEqual({ ran: false, moved: 0 });
  });

  it("last_rollover_on を '' に戻してもう一度実行しても、行（rank・seq を含む）は変わらない", async () => {
    const moving = await insertRawTask(db, { bucket: "scheduled", scheduledOn: YESTERDAY, seq: 1 });
    await setMeta(db, "seq", "1");

    await rolloverIfDue(db, NOW, "Asia/Tokyo");
    const afterFirst = await taskById(moving.id);

    await setMeta(db, "last_rollover_on", "");
    await rolloverIfDue(db, NOW, "Asia/Tokyo");
    const afterSecond = await taskById(moving.id);

    expect(afterSecond).toEqual(afterFirst);
  });

  it("Promise.allで同時に2回実行しても、各タスクは1回だけ移る（movedの合計が対象の数と同じ）。最終の状態は1回実行したときと同じになる", async () => {
    const targets = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        insertRawTask(db, { bucket: "scheduled", scheduledOn: YESTERDAY, seq: i + 1 }),
      ),
    );
    await setMeta(db, "seq", "5");

    const [r1, r2] = await Promise.all([
      rolloverIfDue(db, NOW, "Asia/Tokyo"),
      rolloverIfDue(db, NOW, "Asia/Tokyo"),
    ]);
    expect(r1.moved + r2.moved).toBe(5);

    for (const target of targets) {
      const row = await taskById(target.id);
      expect(row?.bucket).toBe("today");
      expect(row?.arrivedOn).toBe(TODAY);
    }
    const lastRolloverOn = await db
      .select()
      .from(meta)
      .where(eq(meta.key, "last_rollover_on"))
      .get();
    expect(lastRolloverOn?.value).toBe(TODAY);

    // 移った5件のrankは重ならない
    const rows = await Promise.all(targets.map((t) => taskById(t.id)));
    const ranks = new Set(rows.map((row) => row?.rank));
    expect(ranks.size).toBe(5);
  });
});

describe("limit", () => {
  it("limitを小さくすると、1回目は移せる分だけ移し、last_rollover_onは進まない。2回目で残りが移り、last_rollover_onが今日になる", async () => {
    const targets = await Promise.all(
      Array.from({ length: 3 }, (_, i) =>
        insertRawTask(db, {
          bucket: "scheduled",
          scheduledOn: YESTERDAY,
          createdAt: new Date(NOW.getTime() - (3 - i) * 1000).toISOString(),
          seq: i + 1,
        }),
      ),
    );
    await setMeta(db, "seq", "3");

    const first = await rolloverIfDue(db, NOW, "Asia/Tokyo", 2);
    expect(first.ran).toBe(true);
    expect(first.moved).toBe(2);
    const lastAfterFirst = await db
      .select()
      .from(meta)
      .where(eq(meta.key, "last_rollover_on"))
      .get();
    expect(lastAfterFirst?.value).toBe("");

    const second = await rolloverIfDue(db, NOW, "Asia/Tokyo", 2);
    expect(second.ran).toBe(true);
    expect(second.moved).toBe(1);
    const lastAfterSecond = await db
      .select()
      .from(meta)
      .where(eq(meta.key, "last_rollover_on"))
      .get();
    expect(lastAfterSecond?.value).toBe(TODAY);

    // 先に移した2件の後ろに、残りの1件が並ぶ
    const rows = await Promise.all(targets.map((t) => taskById(t.id)));
    const ranks = rows.map((row, i) => {
      const rank = row?.rank;
      if (rank === undefined) throw new Error("rank が読めていません");
      return { id: targets[i]?.id ?? "", rank };
    });
    const sorted = [...ranks].sort(compareRank);
    expect(sorted.map((r) => r.id)).toEqual(targets.map((t) => t.id));
  });
});

describe("物理削除", () => {
  it("削除から31日の行は消え、29日の行は残る（タスク・プロジェクトとも）。purged_through_seqは消した行のseqの最大値になる。7日前のapplied_mutationsは消え、6日前のものは残る", async () => {
    const purgeAt = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000).toISOString();
    const keepAt = new Date(NOW.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString();
    const taskPurge = await insertRawTask(db, { deletedAt: purgeAt, seq: 1 });
    const taskKeep = await insertRawTask(db, { deletedAt: keepAt, seq: 2 });
    const projectPurge = await insertRawProject(db, { deletedAt: purgeAt, seq: 3 });
    const projectKeep = await insertRawProject(db, { deletedAt: keepAt, seq: 4 });
    await setMeta(db, "seq", "4");
    await setMeta(db, "last_rollover_on", YESTERDAY);

    const appliedPurgeAt = new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const appliedKeepAt = new Date(NOW.getTime() - 6 * 24 * 60 * 60 * 1000).toISOString();
    const appliedPurgeId = crypto.randomUUID();
    const appliedKeepId = crypto.randomUUID();
    await db.insert(appliedMutations).values([
      { id: appliedPurgeId, appliedAt: appliedPurgeAt },
      { id: appliedKeepId, appliedAt: appliedKeepAt },
    ]);

    const result = await rolloverIfDue(db, NOW, "Asia/Tokyo");
    expect(result.ran).toBe(true);

    expect(await taskById(taskPurge.id)).toBeUndefined();
    expect(await taskById(taskKeep.id)).toEqual(taskKeep);
    expect(
      await db.select().from(projects).where(eq(projects.id, projectPurge.id)).get(),
    ).toBeUndefined();
    expect(await db.select().from(projects).where(eq(projects.id, projectKeep.id)).get()).toEqual(
      projectKeep,
    );

    const purgedThroughSeq = await db
      .select()
      .from(meta)
      .where(eq(meta.key, "purged_through_seq"))
      .get();
    expect(Number(purgedThroughSeq?.value)).toBe(3);

    expect(
      await db.select().from(appliedMutations).where(eq(appliedMutations.id, appliedPurgeId)).get(),
    ).toBeUndefined();
    expect(
      await db.select().from(appliedMutations).where(eq(appliedMutations.id, appliedKeepId)).get(),
    ).toBeDefined();
  });

  it("削除からちょうど 30 日の行は残り、30 日を 1 ミリ秒でも過ぎた行は消える（applied_mutations の 7 日も同じ）", async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const exactly = (days: number) => new Date(NOW.getTime() - days * DAY_MS).toISOString();
    const justOver = (days: number) => new Date(NOW.getTime() - days * DAY_MS - 1).toISOString();
    const taskKeep = await insertRawTask(db, { deletedAt: exactly(30), seq: 1 });
    const taskPurge = await insertRawTask(db, { deletedAt: justOver(30), seq: 2 });
    await setMeta(db, "seq", "2");
    await setMeta(db, "last_rollover_on", YESTERDAY);
    const appliedKeepId = crypto.randomUUID();
    const appliedPurgeId = crypto.randomUUID();
    await db.insert(appliedMutations).values([
      { id: appliedKeepId, appliedAt: exactly(7) },
      { id: appliedPurgeId, appliedAt: justOver(7) },
    ]);

    await rolloverIfDue(db, NOW, "Asia/Tokyo");

    expect(await taskById(taskKeep.id)).toEqual(taskKeep);
    expect(await taskById(taskPurge.id)).toBeUndefined();
    const purgedThroughSeq = await db
      .select()
      .from(meta)
      .where(eq(meta.key, "purged_through_seq"))
      .get();
    expect(Number(purgedThroughSeq?.value)).toBe(2);
    expect(
      await db.select().from(appliedMutations).where(eq(appliedMutations.id, appliedKeepId)).get(),
    ).toBeDefined();
    expect(
      await db.select().from(appliedMutations).where(eq(appliedMutations.id, appliedPurgeId)).get(),
    ).toBeUndefined();
  });
});

describe("★ 論理日付の境目（サーバー）", () => {
  it("last_rollover_on が 2026-09-27 のとき、now を 03:59+09:00 にしても切り替わらず、04:00 なら切り替わる", async () => {
    await insertRawTask(db, { bucket: "scheduled", scheduledOn: YESTERDAY, seq: 1 });
    await setMeta(db, "seq", "1");
    await setMeta(db, "last_rollover_on", YESTERDAY);

    const { post } = apiApp(() => new Date(`${TODAY}T03:59:00+09:00`));
    await post("/api/sync", { cursor: 0, baseCursor: 0 });
    const before = await db.select().from(meta).where(eq(meta.key, "last_rollover_on")).get();
    expect(before?.value).toBe(YESTERDAY);

    const { post: postAt4 } = apiApp(() => new Date(`${TODAY}T04:00:00+09:00`));
    await postAt4("/api/sync", { cursor: 0, baseCursor: 0 });
    const after = await db.select().from(meta).where(eq(meta.key, "last_rollover_on")).get();
    expect(after?.value).toBe(TODAY);
  });
});
