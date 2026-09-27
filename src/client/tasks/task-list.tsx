import { ChevronRightIcon } from "lucide-react";
import { autorun } from "mobx";
import { observer } from "mobx-react-lite";
import { AnimatePresence, motion } from "motion/react";
import { type ReactNode, useCallback } from "react";
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
      <AnimatePresence key={view.layoutKey?.() ?? "list"} initial={false} mode="popLayout">
        {items.map((item) => (
          <motion.div
            key={item.key}
            layout="position"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={
              item.type === "row"
                ? { opacity: 0, x: 12, transition: { duration: DURATION.exit, ease: EASE_OUT } }
                : { opacity: 0, transition: { duration: DURATION.exit } }
            }
            transition={{ ...LAYOUT_TRANSITION, opacity: { duration: DURATION.short } }}
          >
            <ItemView item={item} view={view} empty={empty} />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
});

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
        className="flex items-center gap-1 rounded-md px-2.5 py-1 text-muted-foreground text-sm hover:text-foreground"
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
