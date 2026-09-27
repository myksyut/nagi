import { FolderIcon } from "lucide-react";
import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { registerKeyBindings } from "@/keyboard/keymap";
import { cn } from "@/lib/utils";
import {
  DETAIL_ORDER,
  ROW_META_ORDER,
  registerDetailField,
  registerRowMeta,
  type TaskSlotProps,
} from "@/tasks/extensions";
import { chipClassName } from "@/tasks/task-detail";
import { useUi } from "@/tasks/ui-context";
import { ProjectPickerHost, projectPickerOf } from "./picker";

/**
 * 6 の登録：p（プロジェクト）、行の右側のプロジェクト名、開いたタスクのプロジェクトのボタン。
 * プロジェクトの画面とサイドバーの一覧、あとでのまとまりは、それぞれ project-screen・project-nav・later-sections
 */

registerKeyBindings({
  id: "task.project",
  label: "プロジェクト",
  group: "タスク",
  keys: ["p"],
  when: ({ ui }) => ui.selected !== undefined,
  run: ({ ui }) => {
    const task = ui.selected;
    if (task) projectPickerOf(ui).open(task.id);
  },
});

/** 付いているプロジェクト（削除済みなら出さない。アーカイブ済みは完了ログなどのために出す） */
function useProjectOf(projectId: string | null) {
  const store = useStore();
  const project = projectId === null ? undefined : store.project(projectId);
  return project && project.deletedAt === null ? project : undefined;
}

/**
 * 行の右側：プロジェクト名。プロジェクトの画面と、プロジェクトごとにまとまるあとでは、名前が見出しと重なるので出さない。
 * p の候補もここから描く（行から広がる）
 */
const ProjectName = observer(function ProjectName({ task, view }: TaskSlotProps) {
  const project = useProjectOf(task.projectId);
  const showName = project !== undefined && view.kind !== "project" && view.kind !== "later";
  return (
    <>
      {showName && <span className="max-w-40 truncate">{project.name}</span>}
      <ProjectPickerHost task={task} />
    </>
  );
});

registerRowMeta({ id: "project", order: ROW_META_ORDER.project, Component: ProjectName });

/** 開いたタスクの一番下の列：プロジェクト。押すと p と同じ候補が、このボタンから広がる */
const ProjectChip = observer(function ProjectChip({ task }: TaskSlotProps) {
  const ui = useUi();
  const project = useProjectOf(task.projectId);
  return (
    <button
      type="button"
      aria-label={project ? `プロジェクト：${project.name}` : "プロジェクトを付ける"}
      className={cn(
        chipClassName,
        "max-w-56 outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70",
        !project && "border-dashed text-muted-foreground/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        projectPickerOf(ui).open(task.id, event.currentTarget);
      }}
    >
      <FolderIcon aria-hidden="true" className="size-3 flex-none" />
      <span className="truncate">{project ? project.name : "プロジェクト"}</span>
    </button>
  );
});

registerDetailField({
  id: "project",
  placement: "chip",
  order: DETAIL_ORDER.project,
  Component: ProjectChip,
});
