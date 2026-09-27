import { observer } from "mobx-react-lite";
import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { Link, useRoute } from "wouter";
import { useStore } from "@/data";
import { dateEntryOf } from "@/features/dates/date-entry";
import { ProjectNavItems } from "@/features/projects/project-nav";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { moveTasks } from "@/tasks/commands";
import { useTaskDropTarget } from "@/tasks/drag";
import { useUi } from "@/tasks/ui-context";
import { BUCKET_LISTS, type ListEntry, type ListKey, LOGBOOK } from "../navigation";

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
        <ul aria-labelledby="sidebar-projects" className="flex flex-col gap-px">
          <ProjectNavItems linkClassName={navLinkClassName} />
        </ul>
        <ul className="mt-5 flex flex-col gap-px">
          <li>
            <NavItem list={LOGBOOK} />
          </li>
        </ul>
      </nav>
    </aside>
  );
}

/** 件数を出すリスト（受信箱と今日）。0 件のときは出さない */
function useCount(key: ListKey): number {
  const { lists } = useStore();
  if (key === "inbox") return lists.inboxCount;
  if (key === "today") return lists.todayCount;
  return 0;
}

/**
 * サイドバーの1行の見た目（プロジェクトの一覧も同じ）。
 * dropping は、運んでいる行を重ねているあいだ（落とすと移せる）
 */
function navLinkClassName(active: boolean, dropping = false): string {
  return cn(
    "flex items-center justify-between rounded-md px-2.5 py-1.5 outline-none",
    "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    "focus-visible:ring-2 focus-visible:ring-sidebar-ring",
    active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
    dropping && "bg-primary/15 text-sidebar-accent-foreground ring-1 ring-primary/50",
  );
}

/**
 * 行を落としたときの動き：今日・あとでへは移し、予定では日付の入力を開く（その行から広がる）。
 * 受信箱と完了ログには落とせない
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
  return useTaskDropTarget(onDrop);
}

const NavItem = observer(function NavItem({ list }: { list: ListEntry }) {
  const [active] = useRoute(list.path);
  const count = useCount(list.key);
  const { over, dropProps } = useListDrop(list.key);
  return (
    <Link
      href={list.path}
      aria-current={active ? "page" : undefined}
      className={navLinkClassName(active, over)}
      {...dropProps}
    >
      {list.label}
      {count > 0 && <Count count={count} />}
    </Link>
  );
});

/** 件数の数字が入れ替わるときの動き（増えたら下から、減ったら上から。数字だけが小さく入れ替わる） */
const COUNT_VARIANTS = {
  enter: (direction: number) => ({ y: direction * 6, opacity: 0 }),
  shown: { y: 0, opacity: 1, transition: { duration: DURATION.short, ease: EASE_OUT } },
  leave: (direction: number) => ({
    y: direction * -6,
    opacity: 0,
    transition: { duration: DURATION.exit, ease: EASE_OUT },
  }),
};

/**
 * サイドバーの件数（受信箱 3 → 2 など）。数字だけが小さく入れ替わる（transitions.dev の数字の入れ替えを写したもの）。
 * 最初の描画とリストの切り替えでは動かさない。読み上げには「（3件）」を出す
 */
function Count({ count }: { count: number }) {
  // 前の件数との比べ（描き直しのたびではなく、件数が変わったときだけ向きを決める）
  const [last, setLast] = useState({ count, direction: 1 });
  if (last.count !== count) setLast({ count, direction: count > last.count ? 1 : -1 });
  const { direction } = last;
  return (
    <span className="relative inline-flex font-normal text-muted-foreground text-xs tabular-nums">
      <span className="sr-only">（{count}件）</span>
      {/* 抜けていく数字は、新しい数字の位置に重ねる（popLayout） */}
      <AnimatePresence initial={false} mode="popLayout" custom={direction}>
        <m.span
          key={count}
          aria-hidden="true"
          custom={direction}
          variants={COUNT_VARIANTS}
          initial="enter"
          animate="shown"
          exit="leave"
        >
          {count}
        </m.span>
      </AnimatePresence>
    </span>
  );
}
