export type MetaValues = {
  /** これまでに振った通し番号の最大値 */
  seq: number;
  /** 最後に日付の切り替えを終えた日（論理日付。まだなら ""） */
  lastRolloverOn: string;
  /** 物理削除した行の seq の最大値 */
  purgedThroughSeq: number;
};

/** meta の行（key と value）を読み取る。行はマイグレーションで入れてある */
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
