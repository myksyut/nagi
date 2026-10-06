import { type SQL, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { meta } from "../db/schema";
import { metaRow } from "./meta";

/**
 * seq（行ごとの通し番号）は、利用者ごとに、SQL の中で振る。1つのバッチで count 行を書くときは、
 * バッチの先頭でその利用者の meta.seq を count ぶん進め（advanceSeq）、i 番目の行には
 * `(SELECT meta.seq) - count + i + 1` を入れる（seqFor）。
 * JS で meta.seq を読んでから書く形にはしない。D1 はバッチを1つずつ処理するので、
 * 同時に2つ来ても番号は重ならず、seq の順と書き込みの順がそろう（差分の取得で取りこぼさない）
 */

/** 利用者の meta.seq の今の値（数） */
export function currentSeq(userId: string): SQL {
  return sql`(SELECT CAST(value AS INTEGER) FROM meta WHERE user_id = ${userId} AND key = 'seq')`;
}

/**
 * 整数をバインドせずに SQL に直接書く。D1 は JS の数を REAL としてバインドすることがあり、
 * TEXT の meta.value に "8.0" のような値が入るのを避けるため
 */
function integerLiteral(value: number): SQL {
  if (!Number.isSafeInteger(value)) throw new Error(`整数ではありません: ${value}`);
  return sql.raw(String(value));
}

/** バッチの先頭に置く文。利用者の meta.seq を count ぶん進める */
export function advanceSeq(db: Db, userId: string, count: number) {
  return db
    .update(meta)
    .set({ value: sql`CAST(${meta.value} AS INTEGER) + ${integerLiteral(count)}` })
    .where(metaRow(userId, "seq"));
}

/** advanceSeq(count) と同じバッチの、index 番目（0 始まり）の行に振る seq */
export function seqFor(userId: string, count: number, index: number): SQL {
  return sql`${currentSeq(userId)} - ${integerLiteral(count)} + ${integerLiteral(index + 1)}`;
}
