import { observer } from "mobx-react-lite";
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { type AppStore, type ProjectRow, type ProjectTaskGroups, useStore } from "@/data";
import { isComposingKey } from "@/keyboard/keys";
import { HOME_PATH } from "@/navigation";
import type { AddTarget, TaskSection } from "@/tasks/list-ui";
import { TaskList } from "@/tasks/task-list";
import { useListView, useUi } from "@/tasks/ui-context";
import { archiveProject, renameProject, unarchiveProject } from "./commands";

/**
 * プロジェクトの画面：そのプロジェクトのタスクを「今日／予定／あとで／受信箱」のまとまりで並べ、
 * 一番下に、そのプロジェクトで完了したもの（全期間）の「完了 N件」（最初は閉じている）。
 * n で追加すると、そのプロジェクトの「あとで」に入る。
 * 見出しの名前を押すと名前を直せる。見出しの右の小さなボタンから、名前の変更とアーカイブ
 */

function liveProject(store: AppStore, id: string): ProjectRow | undefined {
  const project = store.project(id);
  return project && project.deletedAt === null ? project : undefined;
}

function isArchived(store: AppStore, id: string): boolean {
  return liveProject(store, id)?.archivedAt != null;
}

function projectSections(groups: ProjectTaskGroups): TaskSection[] {
  return [
    { key: "today", heading: "今日", rows: groups.today },
    { key: "scheduled", heading: "予定", rows: groups.scheduled },
    { key: "later", heading: "あとで", rows: groups.later },
    { key: "inbox", heading: "受信箱", rows: groups.inbox },
    {
      key: "completed",
      rows: groups.completed,
      fold: { label: `完了 ${groups.completed.length}件` },
    },
  ];
}

export const ProjectScreen = observer(function ProjectScreen({ id }: { id: string }) {
  const store = useStore();
  const view = useListView(() => ({
    key: `project:${id}`,
    kind: "project",
    sections: () => projectSections(store.lists.project(id)),
    // アーカイブ済みのプロジェクトには付けられないので、そのときは受信箱（プロジェクトなし）に入れる
    get addTo(): AddTarget {
      return isArchived(store, id)
        ? { bucket: "inbox", label: "受信箱に追加" }
        : { bucket: "later", projectId: id, label: "あとでに追加" };
    },
    get addInSection() {
      return isArchived(store, id) ? undefined : "later";
    },
  }));
  const project = liveProject(store, id);
  const title = project?.name ?? "";

  useEffect(() => {
    document.title = title === "" ? "nagi" : `${title} — nagi`;
  }, [title]);

  if (!store.loaded) return null;
  if (!project) {
    return (
      <p className="py-14 text-center text-muted-foreground text-sm">
        プロジェクトが見つかりません
      </p>
    );
  }
  return (
    <>
      <ProjectHeading project={project} />
      {project.archivedAt !== null && (
        <p className="mt-0.5 text-muted-foreground text-sm">アーカイブ済み</p>
      )}
      <TaskList view={view} label={project.name} empty={<ProjectEmpty id={id} />} />
    </>
  );
});

const ProjectEmpty = observer(function ProjectEmpty({ id }: { id: string }) {
  const { lists } = useStore();
  if (lists.project(id).completed.length > 0) return <p>未完了のタスクはありません</p>;
  return <p>このプロジェクトのタスクはまだありません</p>;
});

/** 見出し：名前（押すと直せる）と、右の小さな「名前を変更」「アーカイブ」 */
const ProjectHeading = observer(function ProjectHeading({ project }: { project: ProjectRow }) {
  const [editing, setEditing] = useState(false);
  if (editing) return <RenameInput project={project} onDone={() => setEditing(false)} />;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <h1 className="min-w-0 font-semibold text-[22px] tracking-tight">
        <button
          type="button"
          title="名前を変更"
          className="-mx-1 max-w-full cursor-text truncate rounded-sm px-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-ring/70"
          onClick={() => setEditing(true)}
        >
          {project.name}
        </button>
      </h1>
      <ProjectActions project={project} onRename={() => setEditing(true)} />
    </div>
  );
});

/** 名前の入力欄。Enter かフォーカスが外れたら保存、Esc でやめる。空の名前は保存しない */
function RenameInput({ project, onDone }: { project: ProjectRow; onDone: () => void }) {
  const ui = useUi();
  const [value, setValue] = useState(project.name);
  const input = useRef<HTMLInputElement>(null);
  const finished = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  const finish = (save: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (save && value.trim() !== "" && value.trim() !== project.name) {
      renameProject(ui, project, value);
    }
    onDone();
  };

  return (
    <input
      ref={input}
      aria-label="プロジェクト名"
      className="-mx-1 w-full rounded-sm bg-transparent px-1 font-semibold text-[22px] tracking-tight outline-none ring-1 ring-ring/70"
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent)) return;
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          finish(event.key === "Enter");
          ui.focusList();
        }
      }}
      onBlur={() => finish(true)}
    />
  );
}

/** 見出しの右の小さな操作。未完了のタスクが残っているときにアーカイブを押すと、残りの件数を知らせる */
const ProjectActions = observer(function ProjectActions({
  project,
  onRename,
}: {
  project: ProjectRow;
  onRename: () => void;
}) {
  const ui = useUi();
  const [, navigate] = useLocation();
  const archived = project.archivedAt !== null;
  return (
    <div className="ms-auto flex flex-none items-center gap-0.5 text-muted-foreground/80 text-xs">
      <button type="button" className={actionClassName} onClick={onRename}>
        名前を変更
      </button>
      {archived ? (
        <button
          type="button"
          className={actionClassName}
          onClick={() => unarchiveProject(ui, project)}
        >
          アーカイブを解除
        </button>
      ) : (
        <button
          type="button"
          className={actionClassName}
          onClick={() => {
            const result = archiveProject(ui, project);
            // アーカイブしたらサイドバーから消えるので、今日へ移る（「元に戻す」で戻せる）
            if (result.ok) navigate(HOME_PATH);
          }}
        >
          アーカイブ
        </button>
      )}
    </div>
  );
});

const actionClassName =
  "rounded-md px-2 py-1 outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70";
