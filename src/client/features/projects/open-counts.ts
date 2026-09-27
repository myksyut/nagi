import { computed, type IComputedValue } from "mobx";
import type { AppStore } from "@/data";

/**
 * サイドバーに出す、プロジェクトごとの未完了の件数（受信箱・今日・予定・あとでにあるタスクの数）。
 * データ層の openTaskCountOfProject は、プロジェクトごとに完了済み（全期間）まで並べ直すので、
 * サイドバーでずっと観測すると、完了のたびに全プロジェクトぶん完了済みを数え直してしまう（2 万件で重い）。
 * ここでは未完了の区分（taskIndex.rows）だけを観測し、行の中身は peek() で読む。区分は行の出入りと
 * プロジェクトの付け替え（projectId）で知らせるので、タイトル・メモ・チェックリストの保存では数え直さない。
 * 件数が変わらなければ、読んでいる部品には知らせない
 */

type Counts = ReadonlyMap<string, number>;

const OPEN_PARTITIONS = ["inbox", "today", "scheduled", "later"] as const;

function sameCounts(a: Counts, b: Counts): boolean {
  if (a.size !== b.size) return false;
  for (const [id, count] of a) if (b.get(id) !== count) return false;
  return true;
}

/** 数える本体（テストで数え直しの回数を数えられるよう、オブジェクトのメソッドにしてある） */
export const openCountsCalculator = {
  count(store: AppStore): Counts {
    const counts = new Map<string, number>();
    const index = store.replica.taskIndex;
    for (const partition of OPEN_PARTITIONS) {
      for (const row of index.rows(partition)) {
        const { projectId } = row.peek();
        if (projectId !== null) counts.set(projectId, (counts.get(projectId) ?? 0) + 1);
      }
    }
    return counts;
  },
};

const countsByStore = new WeakMap<AppStore, IComputedValue<Counts>>();

function countsOf(store: AppStore): Counts {
  let counts = countsByStore.get(store);
  if (!counts) {
    counts = computed(() => openCountsCalculator.count(store), { equals: sameCounts });
    countsByStore.set(store, counts);
  }
  return counts.get();
}

/** そのプロジェクトの未完了の件数 */
export function openCountOfProject(store: AppStore, projectId: string): number {
  return countsOf(store).get(projectId) ?? 0;
}
