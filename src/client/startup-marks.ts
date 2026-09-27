import { when } from "mobx";
import type { AppStore } from "./data";

/**
 * 起動の速さを測るための印（Performance API の mark）。技術計画の「速さの目安」を実際のブラウザで確かめるときに、
 * `performance.getEntriesByType("mark")` で、ページを開き始めてからの時間として読む。
 * - `nagi:local-loaded`：手元の控え（IndexedDB）を読み終えた（2回目以降の起動は、ここから今日を描ける）
 * - `nagi:list-ready`：手元のデータで一覧を描き終えた（キーの操作を受け付ける）
 * - `nagi:first-sync`：起動して最初の差分の取得を終え、その内容を描き終えた（初めての起動は、ここで行が出る）
 * 「描き終えた」は、描き直しのあとの次のフレームで印を付ける（画面に出るまでを含めるため、1 フレームほど多めになる）
 */
export function markStartup(store: AppStore): void {
  if (typeof performance?.mark !== "function") return;
  when(
    () => store.loaded,
    () => {
      performance.mark("nagi:local-loaded");
      afterPaint(() => performance.mark("nagi:list-ready"));
    },
  );
  when(
    () => store.synced,
    () => afterPaint(() => performance.mark("nagi:first-sync")),
  );
}

/** 次に画面が描かれたあとで呼ぶ（React の描き直しを待ってから、もう1フレーム待つ） */
function afterPaint(callback: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(callback));
}
