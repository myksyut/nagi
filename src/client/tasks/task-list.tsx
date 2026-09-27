import { ChevronRightIcon } from "lucide-react";
import { autorun } from "mobx";
import { observer } from "mobx-react-lite";
import { AnimatePresence, m } from "motion/react";
import { memo, type ReactNode, useCallback, useLayoutEffect, useRef } from "react";
import type { TaskRow } from "@/data";
import { DURATION, EASE_OUT, LAYOUT_TRANSITION } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { AddRow } from "./add-row";
import { taskDragOf } from "./drag";
import type { ListView, TaskSection } from "./list-ui";
import { TaskItem, taskRowId } from "./task-item";
import { useUi } from "./ui-context";

/**
 * 一覧（listbox）。まとまりの見出し、行、追加欄、閉じられるまとまり（「完了 N件」）を、
 * 1つの並びとして描く。行が別のまとまりへ移る・抜けるときは、Motion の layout アニメーションで
 * 下の行が詰まる（中身は transform）。最初の描画では動かさない
 */

type Item =
  /** first：一覧の最初の項目（上の余白を付けない） */
  | { type: "heading"; key: string; section: TaskSection; first: boolean }
  | { type: "row"; key: string; task: TaskRow }
  | { type: "add"; key: string }
  | { type: "empty"; key: string }
  | { type: "fold"; key: string; section: TaskSection; open: boolean };

export const TaskList = observer(function TaskList({
  view,
  label,
  empty,
}: {
  view: ListView;
  /** 一覧の読み上げ名（画面の名前） */
  label: string;
  /** 未完了の行が1つもないときに出すもの（閉じられるまとまりの上に出す） */
  empty?: ReactNode;
}) {
  const ui = useUi();
  /** 前に描いた項目の並び（行の出入りで、どこから下が動くかを見る） */
  const committedKeys = useRef<readonly string[]>([]);
  const adding = ui.adding && ui.view === view;
  const sections = view.sections();
  const listRef = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return;
      ui.registerListElement(element);
      // 選択中の行を指す（選択が動くたびに一覧を描き直さないよう、属性だけを書き換える）
      const dispose = autorun(() => {
        const id = ui.selected?.id;
        if (id === undefined) element.removeAttribute("aria-activedescendant");
        else element.setAttribute("aria-activedescendant", taskRowId(id));
      });
      return () => {
        dispose();
        ui.registerListElement(null);
      };
    },
    [ui],
  );

  const items: Item[] = [];
  if (adding && view.addInSection === undefined) items.push({ type: "add", key: "add" });
  let emptyPlaced = false;
  const placeEmpty = () => {
    if (emptyPlaced) return;
    emptyPlaced = true;
    const hasRows = sections.some((section) => !section.fold && section.rows.length > 0);
    if (!hasRows && !adding && empty) items.push({ type: "empty", key: "empty" });
  };
  for (const section of sections) {
    if (section.fold) {
      placeEmpty();
      if (section.rows.length === 0) continue;
      const open = ui.isFoldOpen(section.key, view.key);
      items.push({ type: "fold", key: `fold:${section.key}`, section, open });
      if (!open) continue;
    } else if (section.heading && section.rows.length > 0) {
      items.push({
        type: "heading",
        key: `heading:${section.key}`,
        section,
        first: items.length === 0,
      });
    }
    for (const task of section.rows) items.push({ type: "row", key: task.id, task });
    if (adding && view.addInSection === section.key) items.push({ type: "add", key: "add" });
  }
  placeEmpty();

  // 前に描いた並びと比べて、最初に変わった項目。そこから下の LAYOUT_WINDOW 項目だけ、位置の変化を動かす
  const keys = items.map((item) => item.key);
  const committed = committedKeys.current;
  let firstChange = keys.findIndex((key, i) => committed[i] !== key);
  if (firstChange < 0) firstChange = keys.length;
  useLayoutEffect(() => {
    committedKeys.current = keys;
  });

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label={label}
      // ⇧↑↓・⌘クリックで複数選べる
      aria-multiselectable="true"
      tabIndex={0}
      // 運んでいる行が一覧の外へ出たら、並べ替えの落とし先の線を消す
      onDragLeave={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node && event.currentTarget.contains(next))) {
          taskDragOf(ui).clearTarget();
        }
      }}
      className={cn(
        "group/list relative mt-5 rounded-lg outline-none",
        // 選ぶ前に Tab で入ったときは一覧そのものに輪郭を出す（選んでいれば、選択中の行に出す）
        "[&:focus-visible:not([aria-activedescendant])]:ring-2 [&:focus-visible:not([aria-activedescendant])]:ring-ring/60 [&:focus-visible:not([aria-activedescendant])]:ring-offset-4 [&:focus-visible:not([aria-activedescendant])]:ring-offset-background",
      )}
    >
      {/* 描く範囲が飛んだら（完了ログの窓）作り直して、行の動きを出さない */}
      {/* presenceAffectsLayout を外す：既定では描き直すたびに全行へ新しい文脈を配り、memo した行まで描き直して測ってしまう
          （行の出入りで位置の変わる行は、position が変わるので描き直して動く） */}
      <AnimatePresence
        key={view.layoutKey?.() ?? "list"}
        initial={false}
        mode="popLayout"
        presenceAffectsLayout={false}
      >
        {positioned(items).map(({ item, position }, index) => (
          <ListItem
            key={item.key}
            item={item}
            position={position}
            animate={index >= firstChange && index < firstChange + LAYOUT_WINDOW}
            view={view}
            empty={empty}
          />
        ))}
      </AnimatePresence>
    </div>
  );
});

/**
 * 行の出入りで位置の変わる項目のうち、動かすのは変わったところから下のこの数まで（画面にはおよそ 25 行が入る）。
 * それより下の項目は画面の外なので、描き直さずにそのまま詰める（100 行の一覧で、完了のたびに全行を測って動かさないように）
 */
const LAYOUT_WINDOW = 40;

/**
 * 項目ごとの「上から何番目か」。追加欄は数えない（追加欄を開いても、下の行を動かさない。
 * 動かすのは、行が別のまとまりへ移る・抜けるときだけ）
 */
function positioned(items: readonly Item[]): { item: Item; position: number }[] {
  let position = 0;
  return items.map((item) => ({ item, position: item.type === "add" ? -1 : position++ }));
}

const ITEM_INITIAL = { opacity: 0 };
const ITEM_ANIMATE = { opacity: 1 };
const ROW_EXIT = { opacity: 0, x: 12, transition: { duration: DURATION.exit, ease: EASE_OUT } };
const ITEM_EXIT = { opacity: 0, transition: { duration: DURATION.exit } };
const ITEM_TRANSITION = { ...LAYOUT_TRANSITION, opacity: { duration: DURATION.short } };

/** 同じ項目か（まとまりのオブジェクトは計算のたびに作り直されるので、中身で比べる） */
function sameItem(a: Item, b: Item): boolean {
  if (a.type !== b.type || a.key !== b.key) return false;
  switch (a.type) {
    case "row":
      return b.type === "row" && a.task === b.task;
    case "heading":
      return b.type === "heading" && a.first === b.first && a.section.heading === b.section.heading;
    case "fold":
      return (
        b.type === "fold" && a.open === b.open && a.section.fold?.label === b.section.fold?.label
      );
    case "add":
    case "empty":
      return true;
  }
}

/**
 * 一覧の1項目（Motion の layout アニメーションの単位）。上から何番目か（position）が変わったときだけ描き直し、
 * そのときだけ Motion が位置を測って動かす。位置の変わらない行と、動かす範囲の外（animate が false）の行は、
 * ほかの行の出入りで描き直さない
 */
const ListItem = memo(
  function ListItem({
    item,
    position,
    view,
    empty,
  }: {
    item: Item;
    position: number;
    /** 位置の変化を動かす範囲にあるか（false なら、位置が変わっても描き直さない） */
    animate: boolean;
    view: ListView;
    empty?: ReactNode;
  }) {
    return (
      <m.div
        layout="position"
        layoutDependency={position}
        initial={ITEM_INITIAL}
        animate={ITEM_ANIMATE}
        exit={item.type === "row" ? ROW_EXIT : ITEM_EXIT}
        transition={ITEM_TRANSITION}
      >
        <ItemView item={item} view={view} empty={empty} />
      </m.div>
    );
  },
  (a, b) =>
    (!b.animate || a.position === b.position) &&
    a.view === b.view &&
    a.empty === b.empty &&
    sameItem(a.item, b.item),
);

function ItemView({ item, view, empty }: { item: Item; view: ListView; empty?: ReactNode }) {
  switch (item.type) {
    case "row":
      return <TaskItem task={item.task} view={view} />;
    case "add":
      return <AddRow view={view} />;
    case "empty":
      return <div className="py-14 text-center text-muted-foreground text-sm">{empty}</div>;
    case "heading":
      // 見出しはそれぞれ別の動きの要素に包まれるので、first: ではなく一覧の中の位置で上の余白を決める
      return (
        <h2
          className={cn(
            "mb-1 px-2.5 font-medium text-muted-foreground text-xs",
            !item.first && "mt-6",
          )}
        >
          {item.section.heading}
        </h2>
      );
    case "fold":
      return <FoldHeader section={item.section} open={item.open} />;
  }
}

/** 閉じられるまとまりの見出し（「▸ 完了 N件」）。クリックで開閉する */
const FoldHeader = observer(function FoldHeader({
  section,
  open,
}: {
  section: TaskSection;
  open: boolean;
}) {
  const ui = useUi();
  return (
    <div className="mt-4 border-t pt-2">
      <button
        type="button"
        aria-expanded={open}
        className="flex items-center gap-1 rounded-md px-2.5 py-1 text-muted-foreground text-sm outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/70"
        onClick={() => ui.toggleFold(section.key)}
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn("size-3.5 transition-transform", open && "rotate-90")}
        />
        {section.fold?.label}
      </button>
    </div>
  );
});
