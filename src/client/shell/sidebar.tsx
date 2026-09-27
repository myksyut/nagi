import { observer } from "mobx-react-lite";
import { Link, useRoute } from "wouter";
import { type AppStore, useStore } from "@/data";
import { dateEntryOf } from "@/features/dates/date-entry";
import { CreateProjectButton, ProjectCreateField } from "@/features/projects/create-field";
import { ProjectNavItems } from "@/features/projects/project-nav";
import { moveTasks } from "@/tasks/commands";
import { useTaskDropTarget } from "@/tasks/drag";
import { useUi } from "@/tasks/ui-context";
import {
  BUCKET_LISTS,
  type ListEntry,
  type ListKey,
  LOGBOOK,
  SHORTCUTS,
  VIEWS,
  type ViewEntry,
} from "../navigation";
import { LIST_ICONS, SHORTCUTS_ICON, VIEW_ICONS } from "./list-icons";
import { NavCountOf, navLinkClassName } from "./nav-parts";

/**
 * 左のサイドバー（すりガラス）。上から、名前、受信箱・今日・予定・あとで（色の付いたアイコンと未完了の件数）、
 * 「ビュー」の見出しの下にカレンダー・タイムライン（navigation.ts の VIEWS）、
 * 「プロジェクト」の見出しの下に各プロジェクト（色の点と件数）と、見出しの右の ＋ で開く名前の欄（一覧の一番下）、
 * 一番下に完了ログとショートカット
 */
export function Sidebar() {
  return (
    <aside className="glass fixed inset-y-0 left-0 z-20 w-(--sidebar-width) overflow-y-auto border-sidebar-border border-r bg-sidebar px-3 py-4.5 text-[13px] text-sidebar-foreground">
      <div className="mx-2 mb-4.5 flex items-center gap-2 font-semibold text-foreground tracking-[0.02em]">
        <span
          aria-hidden="true"
          className="size-4.5 rounded-md bg-(image:--brand) shadow-[0_0_14px_var(--brand-glow)]"
        />
        nagi
      </div>
      <nav aria-label="リスト">
        <ul className="flex flex-col gap-px">
          {BUCKET_LISTS.map((list) => (
            <li key={list.key}>
              <NavItem list={list} />
            </li>
          ))}
        </ul>
        <h2
          id="sidebar-views"
          className="mx-2.5 mt-4 mb-1.5 font-normal text-[11px] text-faint-foreground"
        >
          ビュー
        </h2>
        <ul aria-labelledby="sidebar-views" className="flex flex-col gap-px">
          {VIEWS.map((view) => (
            <li key={view.key}>
              <ViewNavItem view={view} />
            </li>
          ))}
        </ul>
        <div className="mx-2.5 mt-4 mb-1.5 flex items-center">
          <h2 id="sidebar-projects" className="font-normal text-[11px] text-faint-foreground">
            プロジェクト
          </h2>
          <CreateProjectButton />
        </div>
        <ul aria-labelledby="sidebar-projects" className="flex flex-col gap-px">
          <ProjectNavItems />
          <ProjectCreateField />
        </ul>
        <ul className="mt-5 flex flex-col gap-px">
          <li>
            <NavItem list={LOGBOOK} />
          </li>
          <li>
            <ShortcutsNavItem />
          </li>
        </ul>
      </nav>
    </aside>
  );
}

/** 未完了の件数（データ層のリストの計算を読むだけ）。完了ログには出さない（0 件のときは出さない） */
function countOf({ lists }: AppStore, key: ListKey): number {
  switch (key) {
    case "inbox":
      return lists.inboxCount;
    case "today":
      return lists.todayCount;
    case "upcoming":
      return lists.scheduled.length;
    case "later":
      return lists.later.length;
    case "logbook":
      return 0;
  }
}

/**
 * 行を落としたときの動き：今日・あとでへは移し、予定では日付の入力を開く（その行から広がる）。
 * 受信箱と完了ログには落とせない。完了済みのタスク（ボードの完了のカード）は、今日・あとで・予定にも落とせない
 */
function useListDrop(key: ListKey) {
  const ui = useUi();
  const onDrop =
    key === "today" || key === "later"
      ? (ids: readonly string[]) => {
          moveTasks(ui, ids, key);
          ui.focusList();
        }
      : key === "upcoming"
        ? (ids: readonly string[], element: HTMLElement) =>
            dateEntryOf(ui).open("schedule", ids, ui.view, element)
        : null;
  // 置き場へ移せるのは未完了のタスクだけ（プロジェクトへは、p と同じく完了済みも落とせる）
  return useTaskDropTarget(onDrop, { openOnly: true });
}

const NavItem = observer(function NavItem({ list }: { list: ListEntry }) {
  const store = useStore();
  const [active] = useRoute(list.path);
  const { over, dropProps } = useListDrop(list.key);
  const { Icon, color } = LIST_ICONS[list.key];
  return (
    <Link
      href={list.path}
      aria-current={active ? "page" : undefined}
      className={navLinkClassName(active, over)}
      {...dropProps}
    >
      <Icon aria-hidden="true" className="size-4 flex-none" style={{ color }} strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{list.label}</span>
      <NavCountOf count={() => countOf(store, list.key)} />
    </Link>
  );
});

/** 一番下の「ショートカット」（キーボードのアイコン。件数は出さない。行を落とす先にもしない） */
function ShortcutsNavItem() {
  const [active] = useRoute(SHORTCUTS.path);
  const { Icon, color } = SHORTCUTS_ICON;
  return (
    <Link
      href={SHORTCUTS.path}
      aria-current={active ? "page" : undefined}
      className={navLinkClassName(active)}
    >
      <Icon aria-hidden="true" className="size-4 flex-none" style={{ color }} strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{SHORTCUTS.label}</span>
    </Link>
  );
}

/** 「ビュー」の1行（件数は出さない。行を落とす先にもしない） */
function ViewNavItem({ view }: { view: ViewEntry }) {
  const [active] = useRoute(view.path);
  const { Icon, color } = VIEW_ICONS[view.key];
  return (
    <Link
      href={view.path}
      aria-current={active ? "page" : undefined}
      className={navLinkClassName(active)}
    >
      <Icon aria-hidden="true" className="size-4 flex-none" style={{ color }} strokeWidth={1.75} />
      <span className="min-w-0 flex-1 truncate">{view.label}</span>
    </Link>
  );
}
