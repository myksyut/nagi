import { Toast } from "@base-ui/react/toast";
import type { ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { ToastData, Toaster } from "./toaster";

/**
 * 画面下の中央に出るトースト（coss ui と同じ Base UI の Toast を、Core Flows の見た目に合わせて組んだもの）。
 * 下からすっと出て、消えるときはフェードする。一度に出すのは1つ。
 * 面は不透明（すりガラスはサイドバーとポップオーバー・ダイアログだけ）
 */
export function ToastHost({ toaster, children }: { toaster: Toaster; children: ReactNode }) {
  return (
    <Toast.Provider toastManager={toaster.manager} limit={1}>
      {children}
      <Toast.Portal>
        {/* 右のリストの中央に出す。入れ替わるときに重ねて描けるよう、トーストは同じ升目に置く */}
        <Toast.Viewport className="fixed bottom-6 left-[calc(50%+var(--sidebar-width)/2)] z-50 grid max-w-[calc(100vw-var(--sidebar-width)-2rem)] -translate-x-1/2 justify-items-center outline-none">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager<ToastData>();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      swipeDirection="down"
      className={cn(
        "col-start-1 row-start-1 flex items-center gap-3.5 whitespace-nowrap rounded-[10px] border border-glass-edge bg-surface px-3.5 py-2 text-popover-foreground text-sm shadow-xl/35",
        "transition-[transform,opacity] duration-(--duration-base) ease-out",
        "data-starting-style:translate-y-3 data-starting-style:opacity-0",
        "data-ending-style:opacity-0 data-ending-style:duration-(--duration-exit)",
        "data-limited:opacity-0",
      )}
    >
      {/* 赤は締切を過ぎたときにだけ使うので、「保存できませんでした」も色は変えない */}
      <div className="flex flex-col">
        <Toast.Title className="font-normal" />
        {/* 2行になることがある（操作の側の知らせに「下書きに戻しました」を添えたとき） */}
        <Toast.Description className="whitespace-pre-line text-muted-foreground text-xs" />
      </div>
      {toast.actionProps && (
        <Toast.Action className="rounded-sm text-primary-text outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring" />
      )}
      {toast.data?.undo && <Kbd>⌘Z</Kbd>}
    </Toast.Root>
  ));
}
