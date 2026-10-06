import { and, eq } from "drizzle-orm";
import { meta } from "../db/schema";

type MetaKey = "seq" | "last_rollover_on" | "purged_through_seq";

/** 利用者の meta の 1 行を指す条件（WHERE に入れる） */
export function metaRow(userId: string, key: MetaKey) {
  return and(eq(meta.userId, userId), eq(meta.key, key));
}

/** 利用者を作るときに入れる meta の行（書き込みは、この行があることを前提にする） */
export function initialMetaRows(userId: string): (typeof meta.$inferInsert)[] {
  return [
    { userId, key: "seq", value: "0" },
    { userId, key: "last_rollover_on", value: "" },
    { userId, key: "purged_through_seq", value: "0" },
  ];
}

export type MetaValues = {
  /** これまでに振った通し番号の最大値 */
  seq: number;
  /** 最後に日付の切り替えを終えた日（論理日付。まだなら ""） */
  lastRolloverOn: string;
  /** 物理削除した行の seq の最大値 */
  purgedThroughSeq: number;
};

/** 1 人の利用者の meta の行（key と value）を読み取る。行は、利用者を作るときに入れてある */
export function parseMeta(rows: readonly { key: string; value: string }[]): MetaValues {
  const values = new Map(rows.map((row) => [row.key, row.value]));
  const integer = (key: string) => {
    const value = Number(values.get(key));
    if (!Number.isSafeInteger(value)) throw new Error(`meta.${key} が整数ではありません`);
    return value;
  };
  const lastRolloverOn = values.get("last_rollover_on");
  if (lastRolloverOn === undefined) throw new Error("meta.last_rollover_on がありません");
  return {
    seq: integer("seq"),
    lastRolloverOn,
    purgedThroughSeq: integer("purged_through_seq"),
  };
}
