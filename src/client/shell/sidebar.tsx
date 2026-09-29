import { PanelLeftCloseIcon, PanelLeftOpenIcon } from "lucide-react";
import { observer } from "mobx-react-lite";
import { type RefObject, useEffect, useRef, useState } from "react";
import { Link, useRoute } from "wouter";
import { Kbd } from "@/components/ui/kbd";
import { type AppStore, useStore } from "@/data";
import { dateEntryOf } from "@/features/dates/date-entry";
import { CreateProjectButton, ProjectCreateField } from "@/features/projects/create-field";
import { ProjectNavItems } from "@/features/projects/project-nav";
import { useKeyContext } from "@/keyboard/key-context";
import { keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";
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
import { NavCountOf, navIconColor, navLabelClassName, navLinkClassName } from "./nav-parts";
import { SIDEBAR_TOGGLE_BINDING_ID, sidebarOf } from "./sidebar-state";

/**
 * 左のサイドバー（すりガラス）。上から、名前、受信箱・今日・予定・あとで（色の付いたアイコンと未完了の件数）、
 * 「ビュー」の見出しの下にカレンダー・タイムライン（navigation.ts の VIEWS）、
 * 「プロジェクト」の見出しの下に各プロジェクト（色の点と件数）と、見出しの右の ＋ で開く名前の欄（一覧の一番下）、
 * 一番下に完了ログとショートカット。ここまでが縦にスクロールし、その下に畳む・広げるボタンを固定する。
 * 畳むと（⌘\。チケット20）、アイコンと色の点だけの細い帯になる：名前と件数は透明にし、見出しは細い線に替え、
 * ＋ と名前の欄は出さない。アイコンは広げたときと同じ横の位置のまま（styles.css の --sidebar-rail-width）。
 * 帯の項目の名前は、帯の右に出す札で見せる（useRailTip）
 */
export const Sidebar = observer(function Sidebar() {
  const ui = useUi();
  const rail = sidebarOf(ui).rail;
  const aside = useRef<HTMLElement>(null);
  const tip = useRailTip(aside, rail);
  return (
    <>
      <aside
        ref={aside}
        className="glass fixed inset-y-0 left-0 z-20 flex w-(--sidebar-width) flex-col overflow-hidden border-sidebar-border border-r bg-sidebar px-3 pt-4.5 pb-2.5 text-[13px] text-sidebar-foreground transition-[width] duration-(--duration-base) ease-out"
      >
        <div className="mx-2 mb-4.5 flex items-center gap-2 font-semibold text-foreground tracking-[0.02em]">
          <span
            aria-hidden="true"
            className="size-4.5 flex-none rounded-md bg-(image:--brand) shadow-[0_0_14px_var(--brand-glow)]"
          />
          <span className="transition-opacity duration-(--duration-short) rail:opacity-0">
            nagi
          </span>
        </div>
        {/* 縦にスクロールする部分。横にははみ出させない（帯では、透明にした名前と件数が行の右へはみ出す） */}
        <nav
          aria-label="リスト"
          className="-mx-3 min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3 pb-2"
        >
          <ul className="flex flex-col gap-px">
            {BUCKET_LISTS.map((list) => (
              <li key={list.key}>
                <NavItem list={list} />
              </li>
            ))}
          </ul>
          <h2 id="sidebar-views" className={sectionHeadingClassName}>
            ビュー
          </h2>
          <ul aria-labelledby="sidebar-views" className="flex flex-col gap-px">
            {VIEWS.map((view) => (
              <li key={view.key}>
                <ViewNavItem view={view} />
              </li>
            ))}
          </ul>
          <div className={cn(sectionHeadingClassName, "flex items-center")}>
            <h2 id="sidebar-projects" className="font-normal">
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
        <SidebarToggle />
      </aside>
      {tip}
    </>
  );
});

/**
 * 「ビュー」「プロジェクト」の見出し。畳んだとき（帯）は、文字を透明にして（読み上げには残る）、同じ高さに細い線を引く
 * （見出しの高さは変えないので、畳む・広げるときに行が上下に動かない。帯の狭い幅で折り返して高くならないよう、
 * 折り返さない）
 */
const sectionHeadingClassName = cn(
  "relative mx-2.5 mt-4 mb-1.5 whitespace-nowrap font-normal text-[11px] text-faint-foreground",
  "rail:text-transparent rail:before:absolute rail:before:-inset-x-1.5 rail:before:top-1/2 rail:before:h-px rail:before:bg-sidebar-border",
);

/**
 * サイドバーの一番下の、畳む・広げるボタン（⌘\ と同じ割り当て）。広げているときは「サイドバーを畳む」と出し、
 * マウスを乗せるとキーを添える。畳んでいるときはアイコンだけ（名前とキーは帯の右の札に出す）。
 * 押しても、開いている入力欄からフォーカスを奪わない（右下の ＋ と同じ）
 */
const SidebarToggle = observer(function SidebarToggle() {
  const context = useKeyContext();
  const rail = sidebarOf(context.ui).rail;
  const key = keymap.get(SIDEBAR_TOGGLE_BINDING_ID)?.keys[0];
  const keyLabel = key === undefined ? undefined : formatKey(key);
  const label = rail ? "サイドバーを広げる" : "サイドバーを畳む";
  const Icon = rail ? PanelLeftOpenIcon : PanelLeftCloseIcon;
  return (
    <button
      type="button"
      data-tip={label}
      data-tip-key={keyLabel}
      aria-keyshortcuts={key?.replace("Mod+", "Meta+")}
      className={cn(navLinkClassName(false), "group/toggle mt-2 w-full text-faint-foreground")}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => keymap.run(SIDEBAR_TOGGLE_BINDING_ID, context)}
    >
      <Icon aria-hidden="true" className="size-4 flex-none" strokeWidth={1.75} />
      <span className={cn(navLabelClassName, "text-left")}>{label}</span>
      {keyLabel !== undefined && (
        <Kbd
          aria-hidden="true"
          className="opacity-0 transition-opacity duration-(--duration-short) group-hover/toggle:opacity-100 group-focus-visible/toggle:opacity-100 rail:hidden"
        >
          {keyLabel}
        </Kbd>
      )}
    </button>
  );
});

/** 帯の右に出す札の中身と位置（画面の座標） */
type RailTip = {
  label: string;
  /** 未完了の件数（リストとプロジェクト。0 件なら出さない） */
  count: string | null;
  /** キー（畳む・広げるボタン） */
  keyLabel: string | null;
  top: number;
  left: number;
};

/**
 * 畳んだサイドバー（帯）の項目（data-tip の付いたもの）の名前を、帯の右に札で出す。リストとプロジェクトは
 * 未完了の件数（行の data-nav-count）、畳む・広げるボタンはキー（data-tip-key）も添える。
 * 出すのは、マウスを乗せたとき・キーでフォーカスしたとき・タスクを運んで落とせる項目に重ねたとき
 * （どこに落とすかが分かるように）。
 * 押したとき・項目から外れたとき・スクロールしたときに消す。
 * 札はサイドバーの外に1つだけ置く（サイドバーはすりガラスで、はみ出しを切るため）。読み上げには出さない
 * （項目の名前は、項目の中に透明にして残っている）
 */
function useRailTip(aside: RefObject<HTMLElement | null>, rail: boolean) {
  const [tip, setTip] = useState<RailTip | null>(null);
  useEffect(() => {
    const element = aside.current;
    if (!rail || !element) return;
    let current: HTMLElement | null = null;
    const show = (item: HTMLElement | null) => {
      if (item === current) return;
      current = item;
      if (!item) {
        setTip(null);
        return;
      }
      const rect = item.getBoundingClientRect();
      setTip({
        label: item.dataset.tip ?? "",
        count: item.querySelector("[data-nav-count]")?.getAttribute("data-nav-count") ?? null,
        keyLabel: item.dataset.tipKey ?? null,
        top: rect.top + rect.height / 2,
        left: element.getBoundingClientRect().right + 8,
      });
    };
    const itemOf = (target: EventTarget | null) =>
      target instanceof Element && element.contains(target)
        ? target.closest<HTMLElement>("[data-tip]")
        : null;
    const hide = () => show(null);
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType !== "touch") show(itemOf(event.target));
    };
    const onFocusIn = (event: FocusEvent) => {
      if (isFocusVisible(event.target)) show(itemOf(event.target));
    };
    // 運んでいるあいだは pointerover が来ないので、dragover で見る。出すのは落とせる項目の上だけ
    // （受け口が dragover を preventDefault したとき。useTaskDropTarget）。帯の外や落とせない項目では消す
    const onDragOver = (event: DragEvent) =>
      show(event.defaultPrevented ? itemOf(event.target) : null);
    element.addEventListener("pointerover", onPointerOver);
    element.addEventListener("pointerleave", hide);
    element.addEventListener("pointerdown", hide);
    element.addEventListener("focusin", onFocusIn);
    element.addEventListener("focusout", hide);
    element.addEventListener("scroll", hide, true);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", hide);
    window.addEventListener("dragend", hide);
    return () => {
      element.removeEventListener("pointerover", onPointerOver);
      element.removeEventListener("pointerleave", hide);
      element.removeEventListener("pointerdown", hide);
      element.removeEventListener("focusin", onFocusIn);
      element.removeEventListener("focusout", hide);
      element.removeEventListener("scroll", hide, true);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", hide);
      window.removeEventListener("dragend", hide);
      setTip(null);
    };
  }, [aside, rail]);
  if (!tip) return null;
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed z-30 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-md border border-glass-edge bg-surface px-2 py-1 text-foreground text-xs shadow-lg"
      style={{ top: tip.top, left: tip.left }}
      data-rail-tip=""
    >
      {tip.label}
      {tip.count !== null && tip.count !== "0" && (
        <span className="text-faint-foreground tabular-nums">{tip.count}</span>
      )}
      {tip.keyLabel !== null && <Kbd>{tip.keyLabel}</Kbd>}
    </div>
  );
}

/** キーで入ったフォーカスか（マウスで押したときは札を出さない）。:focus-visible を知らない環境では、出す */
function isFocusVisible(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  try {
    return target.matches(":focus-visible");
  } catch {
    return true;
  }
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
  const Icon = LIST_ICONS[list.key];
  return (
    <Link
      href={list.path}
      aria-current={active ? "page" : undefined}
      className={navLinkClassName(active, over)}
      data-tip={list.label}
      {...dropProps}
    >
      <Icon
        aria-hidden="true"
        className="size-4 flex-none"
        style={{ color: navIconColor(active) }}
        strokeWidth={1.75}
      />
      <span className={navLabelClassName}>{list.label}</span>
      <NavCountOf count={() => countOf(store, list.key)} />
    </Link>
  );
});

/** 一番下の「ショートカット」（キーボードのアイコン。件数は出さない。行を落とす先にもしない） */
function ShortcutsNavItem() {
  const [active] = useRoute(SHORTCUTS.path);
  const Icon = SHORTCUTS_ICON;
  return (
    <Link
      href={SHORTCUTS.path}
      aria-current={active ? "page" : undefined}
      className={navLinkClassName(active)}
      data-tip={SHORTCUTS.label}
    >
      <Icon
        aria-hidden="true"
        className="size-4 flex-none"
        style={{ color: navIconColor(active) }}
        strokeWidth={1.75}
      />
      <span className={navLabelClassName}>{SHORTCUTS.label}</span>
    </Link>
  );
}

/** 「ビュー」の1行（件数は出さない。行を落とす先にもしない） */
function ViewNavItem({ view }: { view: ViewEntry }) {
  const [active] = useRoute(view.path);
  const Icon = VIEW_ICONS[view.key];
  return (
    <Link
      href={view.path}
      aria-current={active ? "page" : undefined}
      className={navLinkClassName(active)}
      data-tip={view.label}
    >
      <Icon
        aria-hidden="true"
        className="size-4 flex-none"
        style={{ color: navIconColor(active) }}
        strokeWidth={1.75}
      />
      <span className={navLabelClassName}>{view.label}</span>
    </Link>
  );
}
