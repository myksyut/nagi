import { observer } from "mobx-react-lite";
import { useEffect, useState } from "react";
import { WaitingInput } from "@/components/waiting-input";
import { defer, useDeferred } from "@/lib/deferred";
import type { ListUi } from "@/tasks/list-ui";
import { useUi } from "@/tasks/ui-context";
import { type Overlays, overlaysOf } from "./overlays";

/**
 * ⌘K は、起動に要らないので後から読み込む（Base UI の Autocomplete を含む）。
 * ふだんは起動のあとの空いた時間に先読みしてあるので、開くときに待たない。
 * 先読みの前に開かれたら、届くまでは待ちの欄（WaitingInput）がキーを受け止める（打った文字は届いたら ⌘K の検索欄へ移す）。
 * 読み込めなかったときは、待ちの欄に「読み込めませんでした・もう一度」を出す（開き直したときも読み直す）。
 * 一度読み込んだら描き続ける（閉じる動きのため）
 */

const palette = defer(() => import("./command-palette"));

/** 待ちの欄を Esc で閉じたとき、開く前の場所へフォーカスを戻す（なければ一覧へ） */
function returnFocus(overlays: Overlays, ui: ListUi): void {
  const back = overlays.returnFocus;
  overlays.returnFocus = null;
  if (back instanceof HTMLElement && back.isConnected) back.focus();
  else ui.focusList();
}

export const LazyCommandPalette = observer(function LazyCommandPalette() {
  const ui = useUi();
  const overlays = overlaysOf(ui);
  const open = overlays.palette;
  // 届く前に打った文字（届いたら検索欄に入れる。閉じたら空にする）
  const [typed, setTyped] = useState("");
  const { module, failed, retry } = useDeferred(palette, open);
  useEffect(() => {
    if (!open) setTyped("");
  }, [open]);
  if (module) return <module.CommandPalette initialQuery={typed} />;
  if (!open) return null;
  return (
    <WaitingInput
      label="検索とコマンド"
      placeholder="タスクを検索、コマンドを実行…"
      value={typed}
      onChange={setTyped}
      onCancel={() => {
        overlays.closePalette();
        returnFocus(overlays, ui);
      }}
      failed={failed}
      onRetry={retry}
      className="fixed inset-x-0 top-[10vh] mx-auto w-[calc(100%-2rem)] max-w-xl rounded-2xl px-3 py-2"
    />
  );
});
