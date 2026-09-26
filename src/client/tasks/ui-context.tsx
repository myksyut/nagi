import { createContext, type ReactNode, useContext, useLayoutEffect, useState } from "react";
import type { ListUi, ListView } from "./list-ui";

const UiContext = createContext<ListUi | null>(null);

export function UiProvider({ ui, children }: { ui: ListUi; children: ReactNode }) {
  return <UiContext value={ui}>{children}</UiContext>;
}

export function useUi(): ListUi {
  const ui = useContext(UiContext);
  if (!ui) throw new Error("UiProvider の内側で使ってください");
  return ui;
}

/**
 * 画面の一覧の中身を渡す。画面が開いているあいだ、キーの操作はこの一覧に働く。
 * view は最初の描画で1回だけ作る（中身は view.sections() が MobX の値から読む）
 */
export function useListView(createView: () => ListView): ListView {
  const ui = useUi();
  const [view] = useState(createView);
  // 描いた直後（画面に出る前）に渡す。最初の1枚から選択やキーが効くように
  useLayoutEffect(() => {
    ui.setView(view);
    return () => ui.clearView(view);
  }, [ui, view]);
  return view;
}
