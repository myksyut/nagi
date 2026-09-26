import { Toast } from "@base-ui/react/toast";
import { reaction } from "mobx";
import type { AppStore } from "@/data";

/**
 * 画面下のトースト。「元に戻す」付きのもの（完了・振り分け・削除）と、「保存できませんでした」。
 * 「元に戻す」付きのトーストは1つだけ出し、元に戻す対象（undoStack の一番上）がその操作でなくなったら消す
 * （⌘Z で戻したとき、ほかの操作をしたとき）。トーストのボタンが別の操作を戻してしまわないように
 */

export type ToastData = {
  /** ⌘Z のキー表示を添える */
  undo?: boolean;
};

/** 「元に戻す」付きのトーストを出しておく時間 */
export const UNDO_TOAST_MS = 5000;
const ERROR_TOAST_MS = 6000;

export class Toaster {
  readonly manager = Toast.createToastManager();
  #undoToast: { toastId: string; operationId: string } | null = null;

  /** 「元に戻す」付きのトーストを出す（前のものは消す） */
  undoable(message: string, operationId: string, onUndo: () => void): void {
    this.dismissUndo();
    const toastId = this.manager.add<ToastData>({
      title: message,
      type: "undo",
      timeout: UNDO_TOAST_MS,
      data: { undo: true },
      actionProps: {
        children: "元に戻す",
        onClick: () => {
          this.dismissUndo();
          onUndo();
        },
      },
      onClose: () => {
        if (this.#undoToast?.toastId === toastId) this.#undoToast = null;
      },
    });
    this.#undoToast = { toastId, operationId };
  }

  error(title: string, description?: string): void {
    this.manager.add<ToastData>({
      title,
      description,
      type: "error",
      priority: "high",
      timeout: ERROR_TOAST_MS,
    });
  }

  dismissUndo(): void {
    const current = this.#undoToast;
    if (!current) return;
    this.#undoToast = null;
    this.manager.close(current.toastId);
  }

  /** 元に戻す対象が変わったら「元に戻す」のトーストを消す。戻り値を呼ぶと止める */
  start(store: AppStore): () => void {
    return reaction(
      () => store.undoStack.last?.operationId,
      (operationId) => {
        if (this.#undoToast && this.#undoToast.operationId !== operationId) this.dismissUndo();
      },
    );
  }
}
