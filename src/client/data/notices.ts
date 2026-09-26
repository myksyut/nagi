import type { Bucket } from "@shared/model";
import type { Mutation } from "@shared/mutations";
import type { OperationKind, PendingBatch } from "./replica";

/**
 * データ層から画面への知らせ。見た目（トースト・帯・再読み込み）は画面が決める（4 と 8）。
 * 続けて起きる状態（オフライン、ログインが切れた、版が古い）は、ストアの値としても読める
 */

/** 保存できずに捨てた追加。画面はこれで、文字を追加欄の下書きに戻せる */
export type FailedCreate = {
  id: string;
  title: string;
  memo: string;
  bucket: Bucket;
  projectId: string | null;
};

/** 捨てた操作（1回のユーザー操作ごと、送る順） */
export type DiscardedOperation = {
  operationId: string;
  kind: OperationKind;
  mutations: readonly Mutation[];
};

/** 捨てた送信中の操作の中身 */
export type Discarded = {
  discarded: readonly DiscardedOperation[];
  failedCreates: readonly FailedCreate[];
};

export type Notice =
  /** オフラインなので、操作を受け付けずに止めた（画面は帯を軽く強調する：8） */
  | { type: "offline-blocked"; operation: OperationKind }
  /**
   * 保存できなかった。送信中の操作はすべて捨てて、表示は元に戻っている。
   * network：再送しても通信できなかった・5xx。rejected：400 など（ほぼ不具合。記録はコンソールに残す）
   */
  | ({ type: "save-failed"; reason: "network" | "rejected" } & Discarded)
  /** ログインが切れた（401）。画面はログイン画面へ移る。同期と送信は止まる */
  | ({ type: "unauthorized" } & Discarded)
  /** 画面の版が古い（409）。画面は「新しいバージョン」を出して再読み込みする（8）。同期と送信は止まる */
  | ({ type: "version-mismatch" } & Discarded);

export type NoticeListener = (notice: Notice) => void;

export class Notices {
  readonly #listeners = new Set<NoticeListener>();

  /** 知らせを受け取る。戻り値を呼ぶとやめる */
  subscribe(listener: NoticeListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  emit(notice: Notice): void {
    for (const listener of this.#listeners) {
      try {
        listener(notice);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

/** 捨てたまとまりを、操作ごとにまとめ、追加の中身を取り出す */
export function describeDiscarded(batches: readonly PendingBatch[]): Discarded {
  const operations = new Map<string, DiscardedOperation & { mutations: Mutation[] }>();
  const failedCreates: FailedCreate[] = [];
  for (const batch of batches) {
    let operation = operations.get(batch.operationId);
    if (!operation) {
      operation = { operationId: batch.operationId, kind: batch.kind, mutations: [] };
      operations.set(batch.operationId, operation);
    }
    operation.mutations.push(...batch.mutations);
    for (const mutation of batch.mutations) {
      if (mutation.type !== "task.create") continue;
      const { task } = mutation;
      failedCreates.push({
        id: task.id,
        title: task.title,
        memo: task.memo ?? "",
        bucket: task.bucket,
        projectId: task.projectId ?? null,
      });
    }
  }
  return { discarded: Array.from(operations.values()), failedCreates };
}
