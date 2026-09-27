import { createContext, type ReactNode, useContext } from "react";
import type { KeyContext } from "./keymap";

/**
 * キー操作の状況（`{ store, ui, navigate }`）を部品へ渡す。⌘K のように、キーを押さずに
 * キーマップの割り当て（run）を呼ぶ部品が使う。作るのはアプリの外枠（AppShell）で1つだけ
 */
const KeyContextContext = createContext<KeyContext | null>(null);

export function KeyContextProvider({
  value,
  children,
}: {
  value: KeyContext;
  children: ReactNode;
}) {
  return <KeyContextContext value={value}>{children}</KeyContextContext>;
}

export function useKeyContext(): KeyContext {
  const context = useContext(KeyContextContext);
  if (!context) throw new Error("KeyContextProvider の内側で使ってください");
  return context;
}
