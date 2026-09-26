import { reaction } from "mobx";
import { MotionConfig } from "motion/react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useLocation } from "wouter";
import { useStore } from "@/data";
import "@/features";
import { useKeymap } from "@/keyboard/use-keymap";
import { ListUi } from "@/tasks/list-ui";
import { ToastHost } from "@/tasks/toast-host";
import { UiProvider } from "@/tasks/ui-context";
import { Sidebar } from "./sidebar";

/**
 * 左にサイドバー、右にリスト。形と色は index.html の外枠の CSS とそろえる。
 * 一覧の状態（選択・開いているタスク・追加欄）、キーの割り当て、トーストもここで持つ
 */
export function AppShell({ children }: { children: ReactNode }) {
  const store = useStore();
  const [ui] = useState(() => new ListUi(store));
  const [, navigate] = useLocation();
  const keyContext = useMemo(() => ({ store, ui, navigate }), [store, ui, navigate]);

  useLoginOnUnauthorized();
  useEffect(() => ui.start(), [ui]);
  useKeymap(keyContext);

  return (
    <UiProvider ui={ui}>
      {/* prefers-reduced-motion のときは動きを止める（色の変化は残る） */}
      <MotionConfig reducedMotion="user">
        <ToastHost toaster={ui.toaster}>
          <Sidebar />
          <main className="min-h-dvh pl-(--sidebar-width)">
            <div className="mx-auto max-w-3xl px-10 pt-9 pb-24">{children}</div>
          </main>
        </ToastHost>
      </MotionConfig>
    </UiProvider>
  );
}

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
