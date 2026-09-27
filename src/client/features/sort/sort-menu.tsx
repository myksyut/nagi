import { observer } from "mobx-react-lite";
import {
  Combobox,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxPrimitive,
} from "@/components/ui/combobox";
import { TASK_SORT_LABELS, TASK_SORTS, type TaskSort } from "@/data";
import { isComposingKey } from "@/keyboard/keys";
import { useUi } from "@/tasks/ui-context";
import { setSort, sortOf } from "./state";

/**
 * 並び方の一覧（見出しの「並び：◯◯」を押すと開く）。⇧P の優先度の候補と同じ作り（coss ui の Combobox。文字は打たない）で、
 * 今の並び方に印が付く。↑↓ と Enter か、1〜4 のキーでその場で決まる。Esc で閉じてボタンへ戻る。
 * 決めたら一覧へフォーカスを移す（そのまま ↑↓ やキーの操作を続けられるように）。
 * Base UI の Combobox を含むので、このモジュールは後から読み込む（ボタンと開閉の状態は sort-button.tsx）。
 * 出るときは 100ms でボタンから広がり、消えるときだけ 150ms でフェードする
 */
export const SortMenu = observer(function SortMenu({
  screen,
  anchor,
  open,
  onClose,
  onClosed,
}: {
  screen: string;
  /** 押したボタン（ここから広がり、Esc で閉じたらここへフォーカスを戻す） */
  anchor: HTMLElement;
  /** false なら閉じる途中（消えるときのフェードのあいだ） */
  open: boolean;
  onClose: () => void;
  /** 消えるときのフェードが終わった */
  onClosed: () => void;
}) {
  const ui = useUi();
  const current = sortOf(ui, screen);

  const choose = (sort: TaskSort) => {
    setSort(ui, screen, sort);
    onClose();
    ui.focusList();
  };

  return (
    <Combobox<TaskSort>
      open={open}
      onOpenChange={(next) => {
        if (next || !open) return;
        onClose();
        if (anchor.isConnected) anchor.focus();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
      items={TASK_SORTS}
      filter={null}
      value={current}
      onValueChange={(sort) => {
        if (sort) choose(sort);
      }}
      itemToStringLabel={(sort) => TASK_SORT_LABELS[sort]}
      autoHighlight
    >
      <ComboboxPopup
        anchor={anchor}
        align="end"
        // 一覧の中ではアプリのキー（↑↓ や Enter）を止める
        data-keymap="off"
        className="w-48 min-w-0 duration-(--duration-short) data-ending-style:pointer-events-none data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 data-ending-style:duration-(--duration-exit)"
      >
        <div className="border-b p-1">
          <ComboboxPrimitive.Input
            aria-label="並び方"
            placeholder="並び方"
            autoFocus
            // 文字は受けない（1〜4 はその場で決まる）
            readOnly
            className="h-8 w-full rounded-md bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/60"
            onKeyDown={(event) => {
              if (isComposingKey(event.nativeEvent)) {
                event.preventBaseUIHandler();
                return;
              }
              if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
              const sort = TASK_SORTS[Number(event.key.normalize("NFKC")) - 1];
              if (sort) {
                event.preventDefault();
                event.preventBaseUIHandler();
                choose(sort);
              }
            }}
          />
        </div>
        <ComboboxList>
          {(sort: TaskSort) => (
            <ComboboxItem key={sort} value={sort}>
              <span className="flex items-center justify-between gap-3">
                <span>{TASK_SORT_LABELS[sort]}</span>
                <kbd className="font-sans text-faint-foreground text-xs">
                  {TASK_SORTS.indexOf(sort) + 1}
                </kbd>
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
});
