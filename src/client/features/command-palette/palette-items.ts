import type { TaskRow } from "@/data";
import { KEY_GROUP_ORDER, type KeyContext, keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { PALETTE_BINDING_ID } from "./register";
import { locationOf, normalizeQuery, searchTasks } from "./search";

/**
 * ⌘K に並べるもの。キーマップの割り当て（今使えるものだけ。横のキーは割り当ての先頭のキーから作る）、
 * プロジェクトへの移動、ログアウト、打った文字に合うタスク。名前（打った文字を含むか）で絞り込む
 */

export type PaletteItem = {
  /** 一意の値 */
  value: string;
  label: string;
  /** 横に出すキー（キーマップから作る。手で書かない） */
  shortcut?: string;
  /** 名前の横に小さく出す補足（タスクの場所など） */
  detail?: string;
  run: () => void;
};

export type PaletteGroup = { value: string; items: PaletteItem[] };

export type PaletteActions = {
  /** キーマップの割り当てを、キーを押したときと同じ run で呼ぶ */
  runBinding: (id: string) => void;
  openProject: (projectId: string) => void;
  /** そのタスクがあるリストを開き、その行を選ぶ */
  openTask: (task: TaskRow) => void;
  logout: () => void;
};

export const PROJECT_GROUP = "プロジェクト";
export const TASK_RESULTS_GROUP = "見つかったタスク";

/** まとまりの順：キーマップのまとまり（リストのあとにプロジェクト）、最後に見つかったタスク */
const GROUP_ORDER: readonly string[] = KEY_GROUP_ORDER.flatMap((group) =>
  group === "リスト" ? [group, PROJECT_GROUP] : [group],
);

export function paletteGroups(
  context: KeyContext,
  query: string,
  actions: PaletteActions,
): PaletteGroup[] {
  const q = normalizeQuery(query);
  const matches = (label: string) => q === "" || normalizeQuery(label).includes(q);
  const groups = new Map<string, PaletteItem[]>();
  const push = (group: string, item: PaletteItem) => {
    if (!matches(item.label)) return;
    const items = groups.get(group);
    if (items) items.push(item);
    else groups.set(group, [item]);
  };

  // ⌘K を開くこと自体は並べない
  for (const binding of keymap.list()) {
    if (binding.id === PALETTE_BINDING_ID || !keymap.canRun(binding, context)) continue;
    const key = binding.keys[0];
    push(binding.group, {
      value: `key:${binding.id}`,
      label: binding.label,
      shortcut: key === undefined ? undefined : formatKey(key),
      run: () => actions.runBinding(binding.id),
    });
  }
  for (const project of context.store.lists.projects) {
    push(PROJECT_GROUP, {
      value: `project:${project.id}`,
      label: project.name,
      run: () => actions.openProject(project.id),
    });
  }
  push("全体", { value: "logout", label: "ログアウト", run: actions.logout });

  const result: PaletteGroup[] = GROUP_ORDER.flatMap((group) => {
    const items = groups.get(group);
    return items ? [{ value: group, items }] : [];
  });

  const tasks = searchTasks(context.store, query);
  if (tasks.length > 0) {
    result.push({
      value: TASK_RESULTS_GROUP,
      items: tasks.map((task) => {
        const where = locationOf(context.store, task).label;
        const project = task.projectId === null ? undefined : context.store.project(task.projectId);
        return {
          value: `task:${task.id}`,
          label: task.title,
          detail: project && project.deletedAt === null ? `${where}・${project.name}` : where,
          run: () => actions.openTask(task),
        };
      }),
    });
  }
  return result;
}
