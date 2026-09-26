import type { ReactNode } from "react";
import { Sidebar } from "./sidebar";

/** 左にサイドバー、右にリスト。形と色は index.html の外枠の CSS とそろえる */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <>
      <Sidebar />
      <main className="min-h-dvh pl-(--sidebar-width)">
        <div className="mx-auto max-w-3xl px-10 pt-9 pb-12">{children}</div>
      </main>
    </>
  );
}
