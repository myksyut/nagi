import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { LazyMotion } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useStore } from "@/data";
import "@/features";
import { LazyCommandPalette } from "@/features/command-palette/lazy";
import { shortcutsPageOf } from "@/features/shortcuts/state";
import { KeyContextProvider } from "@/keyboard/key-context";
import type { KeyContext } from "@/keyboard/keymap";
import { useKeymap } from "@/keyboard/use-keymap";
import { loadUntilLoaded, startDeferredLoading } from "@/lib/deferred";
import { motionFeatures } from "@/lib/motion";
import { followReducedMotion } from "@/lib/reduced-motion";
import { ListUi } from "@/tasks/list-ui";
import { ToastHost } from "@/tasks/toast-host";
import { UiProvider } from "@/tasks/ui-context";
import { AddButton } from "./add-button";
import { Sidebar } from "./sidebar";
import { StatusBar } from "./status-bar";

/**
 * 左にサイドバー、右にリスト、右下に「＋」。形と色は index.html の外枠の CSS とそろえる。
 * 一覧の状態（選択・開いているタスク・追加欄）、キーの割り当て、トースト、⌘K、上部の帯（オフライン・新しいバージョン）もここで持つ。
 * キー操作の状況（`{ store, ui, navigate }`）は React の context として出す（⌘K からもキーと同じ run を呼ぶ）。
 * ⌘K・ショートカットのページ・完了ログ・カレンダー・p の候補などは後から読み込む部品で、起動のあとの空いた時間に先読みする。
 * 画面を移るたびに、ショートカットのページへ今の画面を知らせる（Esc と `?` で戻る先）。
 * 右の枠の幅の上限（max-w-3xl）は、画面の一番外の要素に data-wide-view を付けると外れる（カレンダー・タイムライン）
 */
export function AppShell({ children }: { children: ReactNode }) {
  const store = useStore();
  const [ui] = useState(() => new ListUi(store));
  const [location, navigate] = useLocation();
  const keyContext = useMemo<KeyContext>(
    () => ({ store, ui, navigate: (path, options) => navigate(path, options) }),
    [store, ui, navigate],
  );

  useLoginOnUnauthorized();
  useEffect(() => ui.start(), [ui]);
  // prefers-reduced-motion のときは動きを止める（色の変化は残る）
  useEffect(() => followReducedMotion(), []);
  useEffect(() => startDeferredLoading(), []);
  useKeymap(keyContext);
  useEffect(() => shortcutsPageOf(ui).noteLocation(location), [ui, location]);
  // ページを離れるとき（閉じる・読み込み直す）に、まだ送っていないタイトルとメモを下書きへ書く
  useEffect(() => {
    const persist = () => ui.persistEditing();
    window.addEventListener("pagehide", persist);
    return () => window.removeEventListener("pagehide", persist);
  }, [ui]);

  return (
    <UiProvider ui={ui}>
      <KeyContextProvider value={keyContext}>
        {/* Motion の機能は後から読み込む（読み込み済みならそのまま渡す。読み込めなければ、読み込めるまで読み直す） */}
        <LazyMotion features={motionFeatures.current ?? (() => loadUntilLoaded(motionFeatures))}>
          <ToastHost toaster={ui.toaster}>
            <StatusBar />
            <EditingLock ui={ui}>
              <Sidebar />
              <main className="min-h-dvh pl-(--sidebar-width)">
                {/* 画面の一番外の要素に data-wide-view を付けると、幅の上限が外れる（カレンダー・タイムライン） */}
                <div className="mx-auto max-w-3xl px-12 pt-9 pb-28 has-data-wide-view:max-w-none">
                  {children}
                </div>
              </main>
              <AddButton />
            </EditingLock>
            <LazyCommandPalette />
          </ToastHost>
        </LazyMotion>
      </KeyContextProvider>
    </UiProvider>
  );
}

/**
 * 新しいバージョンへ読み込み直すまで（ListUi.editingLocked）、サイドバーとリストを inert にする
 * （クリックもフォーカスも受けない。見るだけ）。上部の帯は外に置く
 */
const EditingLock = observer(function EditingLock({
  ui,
  children,
}: {
  ui: ListUi;
  children: ReactNode;
}) {
  return (
    <div className="contents" inert={ui.editingLocked || undefined}>
      {children}
    </div>
  );
});

/**
 * ログインが切れたら（同期か送信が 401 になったら）ログイン画面へ移す。
 * 手元のデータで先に描いておき、最初の同期で 401 になったときもここで移る
 */
function useLoginOnUnauthorized() {
  const store = useStore();
  const [, navigate] = useLocation();
  useEffect(
    () =>
      reaction(
        () => store.stoppedBy,
        (reason) => {
          if (reason === "unauthorized") navigate("/login", { replace: true });
        },
        { fireImmediately: true },
      ),
    [store, navigate],
  );
}
