import { useEffect } from "react";
import { type KeyContext, keymap } from "./keymap";

/** ページ全体のキーを、キーマップの割り当てに渡す（アプリの外枠で1回だけ使う） */
export function useKeymap(context: KeyContext): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      keymap.dispatch(event, context);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [context]);
}
