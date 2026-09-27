import { observer } from "mobx-react-lite";
import { useState } from "react";
import { useAnchoredStyle, WaitingInput } from "@/components/waiting-input";
import { TASK_SORT_LABELS } from "@/data";
import { defer, useDeferred } from "@/lib/deferred";
import { cn } from "@/lib/utils";
import { useUi } from "@/tasks/ui-context";
import { sortOf } from "./state";

/**
 * 見出しの右の並び方の切り替え（今日・あとで・プロジェクト。今日とプロジェクトはボードでも同じ）。
 * ボタンに今の並び方（「並び：手動」）を出し、押すとほかの候補（p・⇧P・e）と同じ小さな一覧が、このボタンから広がる。
 * 一覧（Base UI の Combobox）は sort-menu.tsx にあり、起動に要らないので後から読み込む。届く前に押したときは、待ちの欄を出す。
 * 手動以外にしているあいだは、文字をアクセントの色にして、並べ替えて見せていることが分かるようにする。
 * ⌘K の「並び方：◯◯」でも切り替わる（register.ts）
 */

const menu = defer(() => import("./sort-menu"));

let nextMenuId = 1;

/** 開いているか、閉じる途中か（消えるときのフェードのあいだも描き続ける） */
type MenuState = { id: number; anchor: HTMLElement; open: boolean } | null;

export const SortButton = observer(function SortButton({ screen }: { screen: string }) {
  const ui = useUi();
  const sort = sortOf(ui, screen);
  const [state, setState] = useState<MenuState>(null);
  const { module, failed, retry } = useDeferred(menu, state !== null, state?.id);

  return (
    <>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={state?.open ?? false}
        className={cn(
          "h-7.5 flex-none self-center rounded-[9px] border bg-muted px-3 font-medium text-xs outline-none hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring",
          sort === "manual" ? "text-muted-foreground" : "text-primary-text",
        )}
        onClick={(event) => {
          const anchor = event.currentTarget;
          // 開いているときに押したら閉じる。一覧が届く前（待ちの欄）なら、フェードなしで閉じる
          setState((current) => {
            if (!current) return { id: nextMenuId++, anchor, open: true };
            return menu.current ? { ...current, open: false } : null;
          });
        }}
      >
        並び：{TASK_SORT_LABELS[sort]}
      </button>
      {state &&
        (module ? (
          <module.SortMenu
            key={state.id}
            screen={screen}
            anchor={state.anchor}
            open={state.open}
            onClose={() => setState((current) => current && { ...current, open: false })}
            onClosed={() =>
              setState((current) => (current?.id === state.id && !current.open ? null : current))
            }
          />
        ) : (
          state.open && (
            <SortWaiting
              anchor={state.anchor}
              failed={failed}
              onRetry={retry}
              onCancel={() => {
                setState(null);
                state.anchor.focus();
              }}
            />
          )
        ))}
    </>
  );
});

/** 一覧が届くまでの待ちの欄（ボタンの下に、右の端をそろえて出す） */
function SortWaiting({
  anchor,
  failed,
  onRetry,
  onCancel,
}: {
  anchor: HTMLElement;
  failed: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const style = useAnchoredStyle(anchor, "end");
  return (
    <WaitingInput
      label="並び方"
      onCancel={onCancel}
      failed={failed}
      onRetry={onRetry}
      className="w-48"
      style={style}
    />
  );
}
