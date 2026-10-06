import { and, asc, eq, gt, lte } from "drizzle-orm";
import type { SyncRequest, SyncResponse } from "../../shared/api";
import type { Db } from "../db/client";
import { meta, projects, tasks } from "../db/schema";
import { parseMeta } from "./meta";
import { projectColumns, taskColumns, toSyncRows } from "./rows";
import { currentSeq } from "./seq";

/** 1回の応答で返す行の数の上限（応答を小さく保つため） */
export const SYNC_PAGE_SIZE = 500;

/**
 * 利用者の行のうち、cursor より新しいものを seq の順に返す（差分の取得）。論理削除した行も返す。
 *
 * reset を返すのは、手元に反映済みのカーソル（baseCursor）が
 * - 物理削除した範囲より古いとき（0 < baseCursor < purged_through_seq）：消した行の削除を受け取っていないかもしれない
 * - サーバーの seq より新しいとき（Time Travel で DB を巻き戻したときなど）
 * ページを進める cursor では判断しない（初回の取得の途中のページで reset が返り続けるのを防ぐため）
 */
export async function readChanges(
  db: Db,
  userId: string,
  { cursor, baseCursor }: SyncRequest,
  pageSize: number = SYNC_PAGE_SIZE,
): Promise<SyncResponse> {
  // meta と行は1つのバッチ（同じ時点の読み取り）で読み、行は cursor < seq <= その meta.seq に限る。
  // 最後のページの nextCursor にこの meta.seq を使うので、行を読んだあとに別の読み取りで meta.seq を
  // 読んではいけない（そのあいだに書かれた行を、次の同期で取りに行かなくなる）
  const [metaRows, taskRows, projectRows] = await db.batch([
    db.select({ key: meta.key, value: meta.value }).from(meta).where(eq(meta.userId, userId)),
    db
      .select(taskColumns)
      .from(tasks)
      .where(
        and(eq(tasks.userId, userId), gt(tasks.seq, cursor), lte(tasks.seq, currentSeq(userId))),
      )
      .orderBy(asc(tasks.seq))
      .limit(pageSize + 1),
    db
      .select(projectColumns)
      .from(projects)
      .where(
        and(
          eq(projects.userId, userId),
          gt(projects.seq, cursor),
          lte(projects.seq, currentSeq(userId)),
        ),
      )
      .orderBy(asc(projects.seq))
      .limit(pageSize + 1),
  ]);
  const { seq, purgedThroughSeq } = parseMeta(metaRows);

  const baseTooOld = baseCursor > 0 && baseCursor < purgedThroughSeq;
  // cursor は正しく使えば baseCursor 以上・meta.seq 以下。meta.seq より先なら巻き戻しの途中
  if (baseTooOld || baseCursor > seq || cursor > seq) return { reset: true };

  // 2つの表から pageSize + 1 行ずつ読めば、seq の順で先頭の pageSize 行は必ずその中にある
  const merged = toSyncRows(taskRows, projectRows);
  const hasMore = merged.length > pageSize;
  const rows = merged.slice(0, pageSize);
  const lastSeq = rows.at(-1)?.row.seq;
  // 最後のページは、そこまでの変更をすべて返したので meta.seq まで進める（seq のすき間を飛ばす）
  const nextCursor = hasMore && lastSeq !== undefined ? lastSeq : seq;
  return { reset: false, rows, nextCursor, hasMore };
}
