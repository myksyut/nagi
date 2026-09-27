import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect } from "react";
import { LoadFailedNote } from "@/components/waiting-input";
import { keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { defer, preloadDeferred, useDeferred } from "@/lib/deferred";
import { SHORTCUTS } from "@/navigation";
import { ScreenHeading } from "@/screens/list-screen";
import { SHORTCUTS_ICON } from "@/shell/list-icons";
import { useUi } from "@/tasks/ui-context";
import { SHORTCUTS_CLOSE_BINDING_ID } from "./register";
import { shortcutsPageOf } from "./state";

/**
 * ショートカットのページ（`/shortcuts`）。ページの部品（絞り込みと一覧）は起動に要らないので後から読み込む。
 * ふだんは起動のあとの空いた時間に先読みしてあるので、`?` で開くときに待たない。
 * 先読みの前に開かれたときは、見出しだけ先に出して、届いたらページごと描く。読み込めなかったときは、読み直せる一行を出す。
 * ページが出ているあいだは Esc と `?` で前の画面に戻る（register.ts。読み込む前から効く）
 */
const screen = defer(() => import("./shortcuts-screen"));

export function LazyShortcutsScreen() {
  const ui = useUi();
  const { module, failed, retry } = useDeferred(screen);
  useLayoutEffect(() => {
    const page = shortcutsPageOf(ui);
    page.show();
    return () => page.hide();
  }, [ui]);
  useEffect(() => {
    document.title = `${SHORTCUTS.label} — nagi`;
    // 画面の中だけで効くキー（カレンダーの [ ] など）や、候補や欄の中のキーの一部は、後から読み込むモジュールが
    // 登録する。直接このページを開いたときも、空いた時間を待たずに読み込んで並べる（読み込んだものから出る）
    void preloadDeferred();
  }, []);
  return (
    // 幅の上限を外す（右の枠。shell/app-shell.tsx）。読み込む前と後で見出しの幅を変えない
    <div data-wide-view="" className="@container">
      {module ? (
        <module.ShortcutsScreen Heading={ShortcutsHeading} />
      ) : (
        <>
          <ShortcutsHeading />
          {failed && (
            <div className="mt-5">
              <LoadFailedNote what="ショートカット" onRetry={retry} />
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 見出し（キーボードのアイコンと名前、下に戻り方）。読み込む前も、読み込んだあとも同じ形 */
export function ShortcutsHeading({ actions }: { actions?: ReactNode }) {
  const { Icon, color } = SHORTCUTS_ICON;
  // 戻るキーはキーマップから（「Esc か ? で前の画面に戻る」）
  const keys = keymap.get(SHORTCUTS_CLOSE_BINDING_ID)?.keys ?? [];
  return (
    <ScreenHeading
      leading={
        <span
          aria-hidden="true"
          className="list-tile grid size-7.5 flex-none place-items-center rounded-[9px]"
          style={{ "--tile": color } as CSSProperties}
        >
          <Icon className="size-4.5" strokeWidth={1.75} />
        </span>
      }
      subtitle={
        keys.length > 0 ? `${keys.map(formatKey).join(" か ")} で前の画面に戻る` : undefined
      }
      actions={actions}
    >
      <h1 className="font-[650] text-[26px] leading-tight tracking-[-0.01em]">{SHORTCUTS.label}</h1>
    </ScreenHeading>
  );
}
