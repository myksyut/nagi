import { FolderIcon } from "lucide-react";
import { observer } from "mobx-react-lite";
import { useStore } from "@/data";
import { registerKeyBindings } from "@/keyboard/keymap";
import { projectColorOf } from "@/lib/project-color";
import { cn } from "@/lib/utils";
import { sidebarOf } from "@/shell/sidebar-state";
import { selectionForOperation } from "@/tasks/commands";
import { useDetailSurface } from "@/tasks/detail-surface";
import {
  DETAIL_ORDER,
  type DetailFieldProps,
  ROW_META_ORDER,
  registerDetachedHost,
  registerDetailField,
  registerRowMeta,
  type TaskSlotProps,
} from "@/tasks/extensions";
import { chipClassName } from "@/tasks/task-detail";
import { useUi } from "@/tasks/ui-context";
import { PROJECT_CREATE_BINDING_ID, projectCreatorOf } from "./create-field";
import { ProjectPickerHost, projectPickerOf } from "./picker";
import { ProjectDot } from "./project-dot";

/**
 * 6 の登録：p（プロジェクト）、行の右側のプロジェクト名、開いたタスクのプロジェクトのボタン。
 * 17 の登録：プロジェクトを作成（キーはなし。⌘K とサイドバーの ＋ から、名前の欄を開く。サイドバーを畳んでいれば広げる）。
 * プロジェクトの画面とサイドバーの一覧・名前の欄、あとでのまとまりは、それぞれ project-screen・project-nav・
 * create-field・later-sections
 */

registerKeyBindings({
  id: "task.project",
  label: "プロジェクト",
  group: "タスク",
  keys: ["p"],
  when: ({ ui }) => ui.selected !== undefined,
  // 選んでいるすべての行に、候補を1回だけ開く（選択が 500 件を超えていたら開かずに知らせる）
  run: ({ ui }) => {
    const rows = selectionForOperation(ui);
    if (rows && rows.length > 0) projectPickerOf(ui).open(rows.map((row) => row.id));
  },
});

registerKeyBindings({
  id: PROJECT_CREATE_BINDING_ID,
  label: "プロジェクトを作成",
  group: "リスト",
  // キーはなし（⌘K からは名前の欄を開くだけ。名前は欄で打つ）
  keys: [],
  run: ({ ui }) => {
    // 畳んだサイドバー（帯）には名前の欄を出さないので、広げてから開く
    sidebarOf(ui).setRail(false);
    projectCreatorOf(ui).show();
  },
});

/** 付いているプロジェクト（削除済みなら出さない。アーカイブ済みは完了ログなどのために出す） */
function useProjectOf(projectId: string | null) {
  const store = useStore();
  const project = projectId === null ? undefined : store.project(projectId);
  return project && project.deletedAt === null ? project : undefined;
}

/**
 * 行の右側：プロジェクト名（色の点付き）。プロジェクトの画面と、プロジェクトごとにまとまるあとでは、名前が見出しと重なるので出さない。
 * p の候補もここから描く（行から広がる）
 */
const ProjectName = observer(function ProjectName({ task, view }: TaskSlotProps) {
  const store = useStore();
  const project = useProjectOf(task.projectId);
  const showName = project !== undefined && view.kind !== "project" && view.kind !== "later";
  return (
    <>
      {showName && (
        <span className="flex max-w-40 items-center gap-1.5">
          <ProjectDot color={projectColorOf(store, project.id)} className="size-[7px]" />
          <span className="truncate">{project.name}</span>
        </span>
      )}
      <ProjectPickerHost task={task} />
    </>
  );
});

registerRowMeta({ id: "project", order: ROW_META_ORDER.project, Component: ProjectName });

/**
 * 開いたタスクの一番下の列：プロジェクト。押すと p と同じ候補が、このボタンから広がる
 * （小さな詳細の中では、候補を小さな詳細の中に開く）
 */
const ProjectChip = observer(function ProjectChip({ task }: DetailFieldProps) {
  const ui = useUi();
  const { detached } = useDetailSurface();
  const project = useProjectOf(task.projectId);
  const store = useStore();
  return (
    <button
      type="button"
      aria-label={project ? `プロジェクト：${project.name}` : "プロジェクトを付ける"}
      className={cn(
        chipClassName,
        "max-w-56 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70",
        !project && "border-dashed text-muted-foreground/70",
      )}
      onClick={(event) => {
        event.stopPropagation();
        projectPickerOf(ui).open(task.id, event.currentTarget, detached);
      }}
    >
      {project ? (
        <ProjectDot color={projectColorOf(store, project.id)} className="size-[7px]" />
      ) : (
        <FolderIcon aria-hidden="true" className="size-3 flex-none" />
      )}
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

// 小さな詳細（カレンダーとタイムラインのポップオーバー）の中のプロジェクトのボタンから開いた候補は、
// 小さな詳細の中に描く（一覧に行がなくてよい）
registerDetachedHost({
  id: "project-picker",
  order: 20,
  Component: ({ task }) => <ProjectPickerHost task={task} detached />,
});
