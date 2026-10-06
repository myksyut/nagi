import { and, eq, isNull, lt, lte, ne, notExists, or, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { logicalDate } from "../../shared/logical-date";
import { arrivalRanks } from "../../shared/rank";
import type { Db } from "../db/client";
import { appliedMutations, meta, projects, tasks } from "../db/schema";
import { advanceSeq, seqFor } from "./seq";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 削除（論理削除）からこの日数たった行を物理削除する */
export const PURGE_AFTER_DAYS = 30;
/** 反映済みの操作のまとまりを覚えておく日数 */
export const APPLIED_MUTATIONS_TTL_DAYS = 7;
/**
 * 1回の切り替えで今日へ移す行の数の上限。D1 へのクエリは 1 回の呼び出しで 1000 までなので、それに収める。
 * 超えたぶんが残ると last_rollover_on は進まず、次の同期で続きを移す（今日来たタスクの後ろに並ぶので、順番は保たれる）
 */
export const ROLLOVER_BATCH_LIMIT = 400;

/** ran：切り替えを行ったか。moved：今日へ移した行の数 */
export type RolloverResult = { ran: boolean; moved: number };

/**
 * 未完了・未削除で、今日の置き場になく、予定の日付か締切が今日以前のタスク。
 * 移す行の UPDATE の WHERE にも入れるので、何度実行しても（同時に2回来ても）同じ結果になる。
 * last_rollover_on を進める条件（対象が残っていない）も、この条件と同じにする
 */
function isDue(today: string) {
  return and(
    isNull(tasks.completedAt),
    isNull(tasks.deletedAt),
    ne(tasks.bucket, "today"),
    or(lte(tasks.scheduledOn, today), lte(tasks.deadlineOn, today)),
  );
}

type Candidate = {
  id: string;
  scheduledOn: string | null;
  deadlineOn: string | null;
  createdAt: string;
};

/** 今日に入るきっかけになった日付（予定の日付と締切のうち、今日以前で早いほう） */
function arrivalDate(task: Candidate, today: string): string {
  const dates = [task.scheduledOn, task.deadlineOn].filter(
    (date): date is string => date !== null && date <= today,
  );
  return dates.reduce((a, b) => (a < b ? a : b));
}

/** 日付の早い順、同じなら作成順（それも同じなら id の順） */
function byArrival(today: string) {
  return (a: Candidate, b: Candidate) => {
    const dateA = arrivalDate(a, today);
    const dateB = arrivalDate(b, today);
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/** 削除から 30 日たった行の物理削除と、7 日たった applied_mutations の削除 */
function purgeStatements(db: Db, now: Date) {
  const purgeBefore = new Date(now.getTime() - PURGE_AFTER_DAYS * DAY_MS).toISOString();
  const appliedBefore = new Date(now.getTime() - APPLIED_MUTATIONS_TTL_DAYS * DAY_MS).toISOString();
  return [
    // 消す前に、消す行の seq の最大値を purged_through_seq に入れる（同じバッチなので、消した行とずれない）
    db
      .update(meta)
      .set({
        value: sql`MAX(
          CAST(${meta.value} AS INTEGER),
          COALESCE((SELECT MAX(seq) FROM tasks WHERE deleted_at < ${purgeBefore}), 0),
          COALESCE((SELECT MAX(seq) FROM projects WHERE deleted_at < ${purgeBefore}), 0)
        )`,
      })
      .where(eq(meta.key, "purged_through_seq")),
    db.delete(tasks).where(lt(tasks.deletedAt, purgeBefore)),
    db.delete(projects).where(lt(projects.deletedAt, purgeBefore)),
    db.delete(appliedMutations).where(lt(appliedMutations.appliedAt, appliedBefore)),
  ];
}

/**
 * 日付の切り替え（午前4時）。last_rollover_on が論理日付より前なら行う（/api/sync の最初に呼ぶ）。
 * 1. 予定の日付か締切が今日以前のタスクを、今日の「今日来たタスクの後ろ、それ以外の前」へ移す
 *    （日付の早い順、同じなら作成順。arrivedOn に今日を入れ、scheduledOn は空にする）
 * 2. 同じバッチで、削除から 30 日たった行を物理削除し、7 日たった applied_mutations を消す
 * 3. 同じバッチの最後で、移す対象がもう残っていなければ last_rollover_on を今日にする
 *    （残っていれば進めず、次の同期でもう一度行う。途中で止まった状態は残さない）
 */
export async function rolloverIfDue(
  db: Db,
  now: Date,
  timeZone: string,
  limit: number = ROLLOVER_BATCH_LIMIT,
): Promise<RolloverResult> {
  const today = logicalDate(now, timeZone);
  const last = await db.select().from(meta).where(eq(meta.key, "last_rollover_on")).get();
  if (!last) throw new Error("meta.last_rollover_on がありません");
  if (last.value >= today) return { ran: false, moved: 0 };

  const [candidates, todayTasks] = await db.batch([
    db
      .select({
        id: tasks.id,
        scheduledOn: tasks.scheduledOn,
        deadlineOn: tasks.deadlineOn,
        createdAt: tasks.createdAt,
      })
      .from(tasks)
      .where(isDue(today)),
    db
      .select({ id: tasks.id, rank: tasks.rank, arrivedOn: tasks.arrivedOn })
      .from(tasks)
      .where(and(eq(tasks.bucket, "today"), isNull(tasks.completedAt), isNull(tasks.deletedAt))),
  ]);

  const moving = candidates.sort(byArrival(today)).slice(0, limit);
  const ranks = arrivalRanks(todayTasks, today, moving.length);
  const updatedAt = now.toISOString();
  const count = moving.length;

  const statements: BatchItem<"sqlite">[] = [];
  if (count > 0) statements.push(advanceSeq(db, count));
  const firstMove = statements.length;
  moving.forEach((task, i) => {
    const rank = ranks[i];
    if (rank === undefined) throw new Error("並び順キーの数が足りません");
    statements.push(
      db
        .update(tasks)
        .set({
          bucket: "today",
          rank,
          arrivedOn: today,
          scheduledOn: null,
          updatedAt,
          seq: seqFor(count, i),
        })
        .where(and(eq(tasks.id, task.id), isDue(today))),
    );
  });
  statements.push(...purgeStatements(db, now));
  // バッチの最後で、移す対象（isDue と同じ条件）がもう残っていないときだけ last_rollover_on を進める。
  // 候補を読んだあとに期限の来たタスクが確定していたり、limit で残したりしたら進めず、次の同期でやり直す
  statements.push(
    db
      .update(meta)
      .set({ value: today })
      .where(
        and(
          eq(meta.key, "last_rollover_on"),
          lt(meta.value, today),
          notExists(db.select({ id: tasks.id }).from(tasks).where(isDue(today))),
        ),
      ),
  );
  const results = await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
  // 同時に来たほかの切り替えが先に移していた行は、WHERE に当たらず書き換わらない
  const moved = results
    .slice(firstMove, firstMove + count)
    .reduce((sum: number, result) => sum + (result as D1Result).meta.changes, 0);
  return { ran: true, moved };
}
