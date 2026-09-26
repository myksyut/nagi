import { createContext, type ReactNode, useContext } from "react";
import type { AppStore } from "./store";

/**
 * ストアを部品に渡す。読む部品は mobx-react-lite の observer で包む
 * （包んだ部品は、読んだ行やリストが変わったときだけ再描画される）
 */

const StoreContext = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreContext value={store}>{children}</StoreContext>;
}

export function useStore(): AppStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("StoreProvider の内側で使ってください");
  return store;
}
