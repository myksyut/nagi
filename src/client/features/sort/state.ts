import { type ObservableMap, observable, runInAction } from "mobx";
import { isTaskSort, sortTasks, type TaskSort } from "@/data";
import type { ListUi, TaskSection } from "@/tasks/list-ui";

/**
 * 並び方（手動・優先度・工数が少ない順・工数が多い順）を、画面ごとに覚える。今日・あとで・各プロジェクトの画面で選べ、
 * 今日とプロジェクトはリストとボードで同じ並び方を使う。localStorage に残す（再読み込みしても残る。残せないときは、
 * そのタブのあいだだけ覚える）。画面の名前は、その画面の一覧の名前（ListView.key。今日は `today`、
 * あとでは `later`、プロジェクトは `project:<id>`）。
 * 並べ替えは表示だけで、rank は書き換えない（手動に戻すと元の並び）
 */

const STORAGE_KEY = "nagi:task-sorts";

/** 手動以外の並び方にしている画面（一覧の状態ごとに1つ。アプリの外枠ごとに1つ） */
const sorts = new WeakMap<ListUi, ObservableMap<string, TaskSort>>();

function sortsOf(ui: ListUi): ObservableMap<string, TaskSort> {
  let value = sorts.get(ui);
  if (!value) {
    value = observable.map<string, TaskSort>();
    try {
      const saved: object = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
      for (const [screen, sort] of Object.entries(saved)) {
        if (isTaskSort(sort)) value.set(screen, sort);
      }
    } catch {
      // 読めなければ、どの画面も手動
    }
    sorts.set(ui, value);
  }
  return value;
}

/** その画面の並び方（覚えていなければ手動） */
export function sortOf(ui: ListUi, screen: string): TaskSort {
  return sortsOf(ui).get(screen) ?? "manual";
}

/** その画面の並び方を変えて、覚える */
export function setSort(ui: ListUi, screen: string, sort: TaskSort): void {
  const map = sortsOf(ui);
  runInAction(() => {
    if (sort === "manual") map.delete(screen);
    else map.set(screen, sort);
  });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // 書けなければ（容量切れなど）、このタブのあいだだけ覚える
  }
}

/**
 * 画面のまとまりを、その画面の並び方で並べる。並べるのは並べ替えられるまとまり（reorderable。今日の未完了、
 * あとでのプロジェクトごと、プロジェクトの画面の今日とあとで、ボードの列）の中だけで、完了のまとまりや予定の日付の順は
 * 変えない。手動以外で並べたまとまりには sorted を付ける（⌥↑↓ とドラッグの並べ替えを止める）。
 * 選択（↑↓・⇧↑↓・完了のあとの次の行）は、並べたあとの表示の並びのとおりに動く（ListUi がまとまりの行の順で動くため）
 */
export function sortSections(ui: ListUi, screen: string, sections: TaskSection[]): TaskSection[] {
  const sort = sortOf(ui, screen);
  if (sort === "manual") return sections;
  return sections.map((section) =>
    section.reorderable
      ? { ...section, rows: sortTasks(section.rows, sort), sorted: true }
      : section,
  );
}
