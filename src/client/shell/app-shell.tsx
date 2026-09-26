import { reaction } from "mobx";
import { type ReactNode, useEffect } from "react";
import { useLocation } from "wouter";
import { useStore } from "@/data";
import { Sidebar } from "./sidebar";

/** 左にサイドバー、右にリスト。形と色は index.html の外枠の CSS とそろえる */
export function AppShell({ children }: { children: ReactNode }) {
  useLoginOnUnauthorized();
  return (
    <>
      <Sidebar />
      <main className="min-h-dvh pl-(--sidebar-width)">
        <div className="mx-auto max-w-3xl px-10 pt-9 pb-12">{children}</div>
      </main>
    </>
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
