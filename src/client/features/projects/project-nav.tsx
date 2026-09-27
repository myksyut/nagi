import { observer } from "mobx-react-lite";
import { Link, useRoute } from "wouter";
import { type ProjectRow, useStore } from "@/data";
import { projectColorOf } from "@/lib/project-color";
import { projectPath } from "@/navigation";
import { NavCount, navLinkClassName } from "@/shell/nav-parts";
import { useTaskDropTarget } from "@/tasks/drag";
import { useUi } from "@/tasks/ui-context";
import { setTaskProject } from "./commands";
import { openCountOfProject } from "./open-counts";
import { ProjectDot } from "./project-dot";

/**
 * サイドバーのプロジェクトの一覧（作成順。アーカイブ済みは出さない）。見た目はサイドバーのほかの行と同じで、
 * アイコンの代わりに色の点、右に未完了の件数。
 * 行をドラッグして落とすと、そのプロジェクトを付ける（置き場は変わらない）
 */
export const ProjectNavItems = observer(function ProjectNavItems() {
  const { lists } = useStore();
  return lists.projects.map((project) => (
    <li key={project.id}>
      <ProjectNavItem project={project} />
    </li>
  ));
});

const ProjectNavItem = observer(function ProjectNavItem({ project }: { project: ProjectRow }) {
  const ui = useUi();
  const store = useStore();
  const path = projectPath(project.id);
  const [active] = useRoute(path);
  const count = openCountOfProject(store, project.id);
  const { over, dropProps } = useTaskDropTarget((ids) => {
    setTaskProject(ui, ids, project.id);
    ui.focusList();
  });
  return (
    <Link
      href={path}
      aria-current={active ? "page" : undefined}
      className={navLinkClassName(active, over)}
      {...dropProps}
    >
      <ProjectDot color={projectColorOf(store, project.id)} className="mx-[3.5px] size-[9px]" />
      <span className="min-w-0 flex-1 truncate">{project.name}</span>
      {count > 0 && <NavCount count={count} />}
    </Link>
  );
});
