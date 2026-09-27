import { observer } from "mobx-react-lite";
import { defer, useDeferred } from "@/lib/deferred";
import { useUi } from "@/tasks/ui-context";
import { overlaysOf } from "./overlays";

/**
 * ⌘K と `?` の一覧は、起動に要らないので後から読み込む（Base UI の Autocomplete と Dialog を含む）。
 * ふだんは起動のあとの空いた時間に先読みしてあるので、開くときに待たない。
 * 先読みの前に開かれたら、その場で読み込み、届いたら開いた状態で描く。一度読み込んだら描き続ける（閉じる動きのため）
 */

const palette = defer(() => import("./command-palette"));
const shortcuts = defer(() => import("./shortcuts-dialog"));

export const LazyCommandPalette = observer(function LazyCommandPalette() {
  const open = overlaysOf(useUi()).palette;
  const module = useDeferred(palette, open);
  return module ? <module.CommandPalette /> : null;
});

export const LazyShortcutsDialog = observer(function LazyShortcutsDialog() {
  const open = overlaysOf(useUi()).shortcuts;
  const module = useDeferred(shortcuts, open);
  return module ? <module.ShortcutsDialog /> : null;
});
