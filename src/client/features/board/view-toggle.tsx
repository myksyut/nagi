import { observer } from "mobx-react-lite";
import { useEffect, useLayoutEffect, useRef } from "react";
import { keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";
import { useUi } from "@/tasks/ui-context";
import { type ScreenLayout, screenLayoutsOf } from "./layout";

/**
 * 今日とプロジェクトの画面の見出しの右の「リスト｜ボード」と、画面の側で使う切り替えの状態。
 * v でも切り替わる（register.tsx）。どちらで見ていたかは画面ごとに覚える（layout.ts）
 */

const LABELS: Record<ScreenLayout, string> = { list: "リスト", board: "ボード" };

const OPTIONS: readonly ScreenLayout[] = ["list", "board"];

/**
 * 切り替えられる画面（今日・プロジェクト）で使う。開いているあいだ v が効き、今の見え方を返す。
 * 切り替えたら（最初の描画ではなく）、新しく出た一覧へフォーカスを移す（そのままキーの操作を続けられるように）
 */
export function useScreenLayout(screen: string): ScreenLayout {
  const ui = useUi();
  const layouts = screenLayoutsOf(ui);
  useLayoutEffect(() => layouts.open(screen), [layouts, screen]);
  const layout = layouts.layoutOf(screen);
  const shown = useRef(layout);
  useEffect(() => {
    if (shown.current === layout) return;
    shown.current = layout;
    ui.focusList();
  }, [ui, layout]);
  return layout;
}

/** 見出しの右の「リスト｜ボード」。押した方で見る（v と同じく、画面ごとに覚える） */
export const ViewToggle = observer(function ViewToggle({ screen }: { screen: string }) {
  const layouts = screenLayoutsOf(useUi());
  const current = layouts.layoutOf(screen);
  const key = keymap.get("view.toggleBoard")?.keys[0];
  const hint = key === undefined ? "" : `（${formatKey(key)}）`;
  return (
    // biome-ignore lint/a11y/useSemanticElements: 見出しの右の、2つのボタンの切り替え（フォームではない）
    <div
      role="group"
      aria-label="表示の切り替え"
      className="flex flex-none self-center rounded-[9px] border bg-muted p-[3px] text-xs"
    >
      {OPTIONS.map((layout) => (
        <button
          key={layout}
          type="button"
          aria-pressed={current === layout}
          title={`${LABELS[layout]}で見る${hint}`}
          className={cn(
            "rounded-[7px] px-3 py-1 font-medium outline-none focus-visible:outline-2 focus-visible:outline-ring",
            current === layout
              ? "bg-foreground/10 text-foreground"
              : "text-muted-foreground hover:text-foreground",
          )}
          onClick={() => layouts.set(screen, layout)}
        >
          {LABELS[layout]}
        </button>
      ))}
    </div>
  );
});
