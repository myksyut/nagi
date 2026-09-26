import { Link, useRoute } from "wouter";
import { cn } from "@/lib/utils";
import { BUCKET_LISTS, type ListEntry, LOGBOOK } from "../navigation";

export function Sidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 w-(--sidebar-width) overflow-y-auto border-sidebar-border border-r bg-sidebar px-2.5 py-4 text-sidebar-foreground text-sm">
      <nav aria-label="リスト">
        <ul className="flex flex-col gap-px">
          {BUCKET_LISTS.map((list) => (
            <li key={list.key}>
              <NavItem list={list} />
            </li>
          ))}
        </ul>
        <h2
          id="sidebar-projects"
          className="mt-5 mb-1.5 px-2.5 font-normal text-muted-foreground text-xs"
        >
          プロジェクト
        </h2>
        {/* プロジェクトの一覧は 6 で足す */}
        <ul aria-labelledby="sidebar-projects" className="flex flex-col gap-px" />
        <ul className="mt-5 flex flex-col gap-px">
          <li>
            <NavItem list={LOGBOOK} />
          </li>
        </ul>
      </nav>
    </aside>
  );
}

function NavItem({ list }: { list: ListEntry }) {
  const [active] = useRoute(list.path);
  return (
    <Link
      href={list.path}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center rounded-md px-2.5 py-1.5 outline-none",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
      )}
    >
      {list.label}
    </Link>
  );
}
