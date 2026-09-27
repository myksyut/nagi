import { computed, type IComputedValue } from "mobx";
import type { AppStore } from "@/data";

/**
 * サイドバーに出す、プロジェクトごとの未完了の件数（受信箱・今日・予定・あとでにあるタスクの数）。
 * データ層のリスト（store.lists.inbox など）を数え直すだけの、画面側の計算。
 * データ層の openTaskCountOfProject は、プロジェクトごとに完了済み（全期間）まで並べ直すので、
 * サイドバーでずっと観測すると、完了のたびに全プロジェクトぶん完了済みを数え直してしまう（2 万件で重い）。
 * 未完了の行だけを見て、プロジェクト（行ごとに観測する）で数える。件数が変わらなければ知らせない
 */

type Counts = ReadonlyMap<string, number>;

function sameCounts(a: Counts, b: Counts): boolean {
  if (a.size !== b.size) return false;
  for (const [id, count] of a) if (b.get(id) !== count) return false;
  return true;
}

const countsByStore = new WeakMap<AppStore, IComputedValue<Counts>>();

function countsOf(store: AppStore): Counts {
  let counts = countsByStore.get(store);
  if (!counts) {
    counts = computed(
      () => {
        const next = new Map<string, number>();
        const { lists } = store;
        for (const rows of [lists.inbox, lists.today, lists.scheduled, lists.later]) {
          for (const row of rows) {
            // プロジェクトの付け替え（p）では置き場が変わらないので、行ごとに観測する
            const projectId = row.projectId;
            if (projectId !== null) next.set(projectId, (next.get(projectId) ?? 0) + 1);
          }
        }
        return next;
      },
      { equals: sameCounts },
    );
    countsByStore.set(store, counts);
  }
  return counts.get();
}

/** そのプロジェクトの未完了の件数 */
export function openCountOfProject(store: AppStore, projectId: string): number {
  return countsOf(store).get(projectId) ?? 0;
}
