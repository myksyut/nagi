import { observer } from "mobx-react-lite";
import { Link, useRoute } from "wouter";
import { type ProjectRow, useStore } from "@/data";
import { projectPath } from "@/navigation";
import { useTaskDropTarget } from "@/tasks/drag";
import { useUi } from "@/tasks/ui-context";
import { setTaskProject } from "./commands";

type LinkClassName = (active: boolean, dropping?: boolean) => string;

/**
 * サイドバーのプロジェクトの一覧（作成順。アーカイブ済みは出さない）。見た目はサイドバーのほかの行と同じ。
 * 行をドラッグして落とすと、そのプロジェクトを付ける（置き場は変わらない）
 */
export const ProjectNavItems = observer(function ProjectNavItems({
  linkClassName,
}: {
  linkClassName: LinkClassName;
}) {
  const { lists } = useStore();
  return lists.projects.map((project) => (
    <li key={project.id}>
      <ProjectNavItem project={project} linkClassName={linkClassName} />
    </li>
  ));
});

const ProjectNavItem = observer(function ProjectNavItem({
  project,
  linkClassName,
}: {
  project: ProjectRow;
  linkClassName: LinkClassName;
}) {
  const ui = useUi();
  const path = projectPath(project.id);
  const [active] = useRoute(path);
  const { over, dropProps } = useTaskDropTarget((ids) => {
    setTaskProject(ui, ids, project.id);
    ui.focusList();
  });
  return (
    <Link
      href={path}
      aria-current={active ? "page" : undefined}
      className={linkClassName(active, over)}
      {...dropProps}
    >
      <span className="truncate">{project.name}</span>
    </Link>
  );
});
