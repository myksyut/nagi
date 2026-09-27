import { observer } from "mobx-react-lite";
import { Link, useRoute } from "wouter";
import { type ProjectRow, useStore } from "@/data";
import { projectPath } from "@/navigation";

type LinkClassName = (active: boolean) => string;

/** サイドバーのプロジェクトの一覧（作成順。アーカイブ済みは出さない）。見た目はサイドバーのほかの行と同じ */
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
  const path = projectPath(project.id);
  const [active] = useRoute(path);
  return (
    <Link href={path} aria-current={active ? "page" : undefined} className={linkClassName(active)}>
      <span className="truncate">{project.name}</span>
    </Link>
  );
});
