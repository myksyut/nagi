import { observer } from "mobx-react-lite";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { useStore } from "@/data";
import { cn } from "@/lib/utils";
import type { ListUi } from "@/tasks/list-ui";
import { useUi } from "@/tasks/ui-context";

/**
 * 画面上部の細い帯（右のリストの上の余白に重ねる。リストはそのまま見られる）。
 * - オフラインのあいだ：「オフライン — つながるまで保存できません」。オフラインで操作を止めたとき
 *   （データ層の offline-blocked の知らせ）は、帯を軽く強調する（色だけを変える）。つながったら消す
 * - 画面の版が古い（409）：「新しいバージョンがあります」と出し、下書きを残してから再読み込みする
 */

/** 強調しておく時間 */
export const EMPHASIS_MS = 700;
/** 「新しいバージョンがあります」を見せてから再読み込みするまで */
export const RELOAD_DELAY_MS = 1200;
/** 版が古くて再読み込みした時刻（sessionStorage）。続けて 409 になったら、繰り返さずにボタンを出す */
const RELOAD_GUARD_KEY = "nagi:version-reload-at";
const RELOAD_GUARD_MS = 60_000;

export const StatusBar = observer(function StatusBar() {
  const store = useStore();
  const newVersion = store.stoppedBy === "version-mismatch";
  const offline = !store.isOnline;
  const emphasized = useOfflineEmphasis();
  if (newVersion) return <NewVersionBar />;
  if (!offline) return null;
  return (
    <Bar
      className={cn(
        "transition-colors duration-(--duration-base)",
        emphasized && "bg-primary/25 text-foreground",
      )}
      data-emphasized={emphasized || undefined}
    >
      オフライン — つながるまで保存できません
    </Bar>
  );
});

function Bar({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      role="status"
      className={cn(
        "fixed top-0 right-0 left-(--sidebar-width) z-40 flex h-6 items-center justify-center gap-3 border-b bg-muted text-muted-foreground text-xs",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/** オフラインで操作を止めたと知らされたら、しばらく true（続けて止めたら延ばす） */
function useOfflineEmphasis(): boolean {
  const store = useStore();
  const [emphasized, setEmphasized] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const off = store.subscribe((notice) => {
      if (notice.type !== "offline-blocked") return;
      setEmphasized(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setEmphasized(false), EMPHASIS_MS);
    });
    return () => {
      off();
      clearTimeout(timer.current);
    };
  }, [store]);
  return emphasized;
}

function NewVersionBar() {
  const ui = useUi();
  const [automatic] = useState(() => canReloadAutomatically());
  useEffect(() => {
    // 開いているタスクと追加欄を閉じて、打った文字を下書き（localStorage）に残す
    prepareReload(ui);
    if (!automatic) return;
    const timer = setTimeout(() => reloadForNewVersion(), RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ui, automatic]);
  return (
    <Bar className="bg-primary/15 text-foreground">
      {automatic ? (
        "新しいバージョンがあります — 読み込み直しています"
      ) : (
        <>
          新しいバージョンがあります
          <button
            type="button"
            className="rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => reloadForNewVersion()}
          >
            再読み込み
          </button>
        </>
      )}
    </Bar>
  );
}

function prepareReload(ui: ListUi): void {
  ui.close();
  ui.stopAdding();
}

function canReloadAutomatically(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
    return Date.now() - last > RELOAD_GUARD_MS;
  } catch {
    return true;
  }
}

function reloadForNewVersion(): void {
  try {
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
  } catch {
    // 残せなくても再読み込みはする
  }
  window.location.reload();
}
