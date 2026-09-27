import type { AppStore, TaskRow } from "@/data";
import type { TaskSection } from "@/tasks/list-ui";

/** あとでの「プロジェクトなし」のまとまり（一番上。n の追加欄もここに開く） */
export const LATER_NO_PROJECT = "none";

/**
 * あとでのまとまり：プロジェクトなしが先頭（見出しなし）、そのあとにプロジェクトごと（作成順、見出しは名前）。
 * 中の並びは自分で決めた順（rank）。アーカイブ済みのプロジェクトのタスクもそのプロジェクトのまとまりに出す
 * （アーカイブのあとに完了を外して「あとで」へ送った場合）。付いているプロジェクトが見つからなければプロジェクトなしに入れる
 */
export function laterSections(store: AppStore): TaskSection[] {
  const byProject = new Map<string, TaskRow[]>();
  const none: TaskRow[] = [];
  for (const task of store.lists.later) {
    // プロジェクトは行ごとに観測する。付け替えても あとで の中身と並びは変わらないので、
    // store.lists.later は知らせてこない（まとまりの見た目が変わらなければ、一覧は描き直さない）
    const { projectId } = task;
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
