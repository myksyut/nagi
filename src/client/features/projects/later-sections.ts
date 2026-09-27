import { computed, type IComputedValue } from "mobx";
import type { AppStore, TaskRow } from "@/data";
import type { TaskSection } from "@/tasks/list-ui";

/** あとでの「プロジェクトなし」のまとまり（一番上。n の追加欄もここに開く） */
export const LATER_NO_PROJECT = "none";

/**
 * 行ごとのプロジェクトの観測値。プロジェクトが変わったときだけ知らせる（タイトルやメモを直しても知らせない）。
 * 付け替えても あとで の中身と並びは変わらないので、store.lists.later は知らせてこない。そのため行ごとに見張る
 */
const projectIdCache = new WeakMap<TaskRow, IComputedValue<string | null>>();

function projectIdOf(row: TaskRow): string | null {
  let value = projectIdCache.get(row);
  if (!value) {
    value = computed(() => row.projectId);
    projectIdCache.set(row, value);
  }
  return value.get();
}

/**
 * あとでのまとまり：プロジェクトなしが先頭（見出しなし）、そのあとにプロジェクトごと（作成順、見出しは名前）。
 * 中の並びは自分で決めた順（rank）。アーカイブ済みのプロジェクトのタスクもそのプロジェクトのまとまりに出す
 * （アーカイブのあとに完了を外して「あとで」へ送った場合）。付いているプロジェクトが見つからなければプロジェクトなしに入れる
 */
export function laterSections(store: AppStore): TaskSection[] {
  const byProject = new Map<string, TaskRow[]>();
  const none: TaskRow[] = [];
  for (const task of store.lists.later) {
    const projectId = projectIdOf(task);
    const project = projectId === null ? undefined : store.project(projectId);
    if (projectId === null || !project || project.deletedAt !== null) {
      none.push(task);
      continue;
    }
    let rows = byProject.get(projectId);
    if (!rows) {
      rows = [];
      byProject.set(projectId, rows);
    }
    rows.push(task);
  }
  const projects = Array.from(byProject.keys(), (id) => store.project(id)).filter(
    (project) => project !== undefined,
  );
  projects.sort(
    (a, b) =>
      (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
  return [
    { key: LATER_NO_PROJECT, rows: none },
    ...projects.map((project) => ({
      key: `project:${project.id}`,
      heading: project.name,
      rows: byProject.get(project.id) ?? [],
    })),
  ];
}
