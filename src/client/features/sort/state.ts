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

/**
 * localStorage に残っている並び方。localStorage を使えなければ null（壊れた値は、どの画面も手動として読む）
 */
function loadSaved(): Map<string, TaskSort> | null {
  let text: string | null;
  try {
    text = localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
  const saved = new Map<string, TaskSort>();
  try {
    const parsed: object = JSON.parse(text ?? "{}");
    for (const [screen, sort] of Object.entries(parsed)) {
      if (isTaskSort(sort) && sort !== "manual") saved.set(screen, sort);
    }
  } catch {
    // 読めなければ、どの画面も手動
  }
  return saved;
}

function sortsOf(ui: ListUi): ObservableMap<string, TaskSort> {
  let value = sorts.get(ui);
  if (!value) {
    value = observable.map<string, TaskSort>(loadSaved() ?? undefined);
    sorts.set(ui, value);
  }
  return value;
}

/** その画面の並び方（覚えていなければ手動） */
export function sortOf(ui: ListUi, screen: string): TaskSort {
  return sortsOf(ui).get(screen) ?? "manual";
}

/**
 * その画面の並び方を変えて、覚える。選んでいる行の位置が変わるので、見えるところまで動かす。
 * 書くときは localStorage の最新を読み、変えた画面の分だけを差し替える（ほかのタブがほかの画面の並び方を変えていても、
 * 上書きしない）。読んだ最新は、このタブの表示にも合わせる。読み書きできないときは、このタブのあいだだけ覚える
 */
export function setSort(ui: ListUi, screen: string, sort: TaskSort): void {
  const map = sortsOf(ui);
  const next = loadSaved() ?? new Map(map);
  if (sort === "manual") next.delete(screen);
  else next.set(screen, sort);
  runInAction(() => map.replace(next));
  ui.revealSelected();
  try {
    if (next.size === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(next)));
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
