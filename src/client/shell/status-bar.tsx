import { observer } from "mobx-react-lite";
import { type ComponentProps, useEffect, useRef, useState } from "react";
import { useStore } from "@/data";
import { cn } from "@/lib/utils";
import { useUi } from "@/tasks/ui-context";

/**
 * 画面上部の細い帯（右のリストの上の余白に重ねる。リストはそのまま見られる）。
 * - オフラインのあいだ：「オフライン — つながるまで保存できません」。オフラインで操作を止めたとき
 *   （データ層の offline-blocked の知らせ）は、帯を軽く強調する（色だけを変える）。つながったら消す
 * - 画面の版が古い（409）：「新しいバージョンがあります」と出し、下書きを残してから読み込み直す（NewVersionBar）
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
        "fixed top-0 right-0 left-(--sidebar-width) z-40 flex h-6 items-center justify-center gap-3 border-b bg-surface text-muted-foreground text-xs",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

/**
 * オフラインで操作（x・t・追加の Enter など）を止めたと知らされたら、しばらく true（続けて止めたら延ばす）。
 * 入力の自動保存を止めたときは強調しない（帯はもう出ていて、打つたびに光るとうるさいため）
 */
function useOfflineEmphasis(): boolean {
  const store = useStore();
  const [emphasized, setEmphasized] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const off = store.subscribe((notice) => {
      if (notice.type !== "offline-blocked" || notice.autosave) return;
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

type ReloadMode =
  /** 少し待って自動で読み込み直す（そのあいだは編集を止める） */
  | "automatic"
  /** 続けて 409 になった・sessionStorage を使えない：ボタンで読み込み直す */
  | "manual"
  /** 下書きを localStorage に残せない：自動では読み込み直さない（入力は画面の中に残る） */
  | "unsaved";

/**
 * 新しいバージョン（409）。自動で読み込み直すときは、まず編集を止めて開いているタスクと追加欄を閉じ
 * （打った文字は下書きへ）、読み込み直す直前に、まだ送っていない文字を同期で下書きへ書く。
 * 下書きを残せなかったとき・繰り返しを防げないときは、自動では読み込み直さず「再読み込み」のボタンにする
 */
const NewVersionBar = observer(function NewVersionBar() {
  const ui = useUi();
  const [mode, setMode] = useState<ReloadMode>(() =>
    canReloadAutomatically() ? "automatic" : "manual",
  );
  useEffect(() => {
    if (mode !== "automatic") return;
    ui.lockEditing();
    const timer = setTimeout(() => {
      if (!ui.persistEditing()) {
        setMode("unsaved");
        return;
      }
      if (!markReload()) {
        setMode("manual");
        return;
      }
      window.location.reload();
    }, RELOAD_DELAY_MS);
    return () => clearTimeout(timer);
  }, [ui, mode]);
  // 自動で読み込み直さないときは、編集を戻す（開き直して、残っている文字を確かめられるように）
  useEffect(() => {
    if (mode !== "automatic") ui.unlockEditing();
  }, [ui, mode]);
  return (
    <Bar className="bg-primary/15 text-foreground">
      {mode === "automatic" ? (
        "新しいバージョンがあります — 読み込み直しています"
      ) : (
        <>
          {mode === "unsaved"
            ? "新しいバージョンがあります — 下書きを残せないため、自動では読み込み直しません"
            : "新しいバージョンがあります"}
          <button
            type="button"
            className="rounded-sm text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              ui.persistEditing();
              markReload();
              window.location.reload();
            }}
          >
            再読み込み
          </button>
        </>
      )}
    </Bar>
  );
});

/** 自動で読み込み直してよいか（直前に読み込み直していない。sessionStorage を読めないときは、繰り返しを防げないので false） */
function canReloadAutomatically(): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY) ?? 0);
    return Date.now() - last > RELOAD_GUARD_MS;
  } catch {
    return false;
  }
}

/** 読み込み直した時刻を残す。残せなければ false（自動で繰り返すのを防げない） */
function markReload(): boolean {
  try {
    const now = String(Date.now());
    sessionStorage.setItem(RELOAD_GUARD_KEY, now);
    return sessionStorage.getItem(RELOAD_GUARD_KEY) === now;
  } catch {
    return false;
  }
}
