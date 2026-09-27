import { observer } from "mobx-react-lite";
import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { type AppStore, type ProjectRow, type ProjectTaskGroups, useStore } from "@/data";
import { isComposingKey } from "@/keyboard/keys";
import { projectColorOf, projectColorVar } from "@/lib/project-color";
import { HOME_PATH } from "@/navigation";
import { ScreenHeading } from "@/screens/list-screen";
import { AddHint } from "@/tasks/add-hint";
import type { AddTarget, TaskSection } from "@/tasks/list-ui";
import { TaskList } from "@/tasks/task-list";
import { useListView, useUi } from "@/tasks/ui-context";
import { archiveProject, renameProject, unarchiveProject } from "./commands";
import { projectNameDraftsOf } from "./name-drafts";
import { ProjectDot } from "./project-dot";

/**
 * プロジェクトの画面：そのプロジェクトのタスクを「今日／予定／あとで／受信箱」のまとまりで並べ、
 * 一番下に、そのプロジェクトで完了したもの（全期間）の「完了 N件」（最初は閉じている）。
 * n で追加すると、そのプロジェクトの「あとで」に入る。
 * 見出しの名前を押すと名前を直せる。見出しの右の小さなボタンから、名前の変更とアーカイブ。
 * 見出しの左にはプロジェクトの色の点（色の選び直しはチケット 11）
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
    { key: "today", heading: "今日", rows: groups.today, reorderable: true },
    { key: "scheduled", heading: "予定", rows: groups.scheduled },
    { key: "later", heading: "あとで", rows: groups.later, reorderable: true },
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
      <TaskList view={view} label={project.name} empty={<ProjectEmpty id={id} />} />
    </>
  );
});

const ProjectEmpty = observer(function ProjectEmpty({ id }: { id: string }) {
  const { lists } = useStore();
  return (
    <>
      <p>
        {lists.project(id).completed.length > 0
          ? "未完了のタスクはありません"
          : "このプロジェクトのタスクはまだありません"}
      </p>
      <AddHint />
    </>
  );
});

/**
 * 見出し：色の点、名前（押すと直せる）、その下に未完了の件数（アーカイブ済みなら「アーカイブ済み」）、
 * 右に小さな「名前を変更」「アーカイブ」（名前を直しているあいだは出さない）
 */
const ProjectHeading = observer(function ProjectHeading({ project }: { project: ProjectRow }) {
  const store = useStore();
  const [editing, setEditing] = useState(false);
  const count = store.lists.openTaskCountOfProject(project.id);
  const color = projectColorOf(store, project.id);
  const subtitle =
    project.archivedAt !== null ? "アーカイブ済み" : count > 0 ? `${count} 件` : undefined;
  return (
    <ScreenHeading
      leading={
        // リストの見出しのアイコンの台と同じ形で、プロジェクトの色を淡く敷く
        <span
          aria-hidden="true"
          className="list-tile grid size-7.5 flex-none place-items-center rounded-[9px]"
          style={{ "--tile": projectColorVar(color) } as CSSProperties}
        >
          <ProjectDot color={color} className="size-2.5" />
        </span>
      }
      subtitle={subtitle}
      actions={
        editing ? undefined : <ProjectActions project={project} onRename={() => setEditing(true)} />
      }
    >
      {editing ? (
        <RenameInput project={project} onDone={() => setEditing(false)} />
      ) : (
        <h1 className={headingTextClassName}>
          <button
            type="button"
            title="名前を変更"
            className="-mx-1 max-w-full cursor-text truncate rounded-sm px-1 text-left outline-none focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setEditing(true)}
          >
            {project.name}
          </button>
        </h1>
      )}
    </ScreenHeading>
  );
});

/** 見出しの名前の文字（リストの画面の見出しと同じ） */
const headingTextClassName = "min-w-0 font-[650] text-[26px] leading-tight tracking-[-0.01em]";

/**
 * 名前の入力欄。Enter かフォーカスが外れたら保存、Esc でやめる。空の名前は保存しない（元の名前に戻る）。
 * オフラインなどで受け付けられなかったら、欄を開いたまま文字を残す。
 * 送ったあとに保存できなかった名前は、次にこの欄を開いたときに入っている（projectNameDraftsOf）
 */
function RenameInput({ project, onDone }: { project: ProjectRow; onDone: () => void }) {
  const ui = useUi();
  const drafts = projectNameDraftsOf(ui.store);
  const [value, setValue] = useState(() => drafts.get(project.id) ?? project.name);
  const latest = useRef(value);
  latest.current = value;
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // 保存できないまま画面を離れたら、打った名前を残す
  useEffect(
    () => () => {
      const name = latest.current.trim();
      if (!done.current && name !== "" && name !== project.name) {
        drafts.keep(project.id, latest.current);
      }
    },
    [drafts, project],
  );

  const close = () => {
    done.current = true;
    onDone();
  };

  /** 保存して閉じる。受け付けられなかったら開いたまま（false） */
  const save = (): boolean => {
    if (done.current) return true;
    const name = value.trim();
    if (name === "" || name === project.name) {
      drafts.clear(project.id);
      close();
      return true;
    }
    const result = renameProject(ui, project, value);
    if (!result.ok && result.reason === "offline") return false;
    close();
    return true;
  };

  const cancel = () => {
    if (done.current) return;
    drafts.clear(project.id);
    close();
  };

  return (
    <input
      ref={input}
      aria-label="プロジェクト名"
      className={`-mx-1 w-full rounded-sm bg-transparent px-1 outline-none ring-1 ring-ring/70 ${headingTextClassName}`}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent)) return;
        if (event.key === "Enter") {
          event.preventDefault();
          if (save()) ui.focusList();
        } else if (event.key === "Escape") {
          event.preventDefault();
          cancel();
          ui.focusList();
        }
      }}
      onBlur={() => save()}
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
    <div className="ms-auto flex flex-none items-center gap-0.5 self-center text-muted-foreground text-xs">
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
  "rounded-md px-2 py-1 outline-none hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring";
