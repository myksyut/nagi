import type { SyncRow } from "@shared/model";
import { type ApiClient, type ApiFailure, type ApiResult, isRetryable } from "./api-client";
import type { PendingBatch, Replica } from "./replica";

/**
 * 送信の列。送信中のまとまりを1本の列で、積んだ順に1つずつ POST /api/mutate へ送る（操作の順序が入れ替わらない）。
 * - 通信エラー・タイムアウト・5xx は、同じ ID のまま 2 回まで再送する（0.5 秒後、2 秒後）。
 *   サーバーは同じ ID の再送を見分けて、対象の行の今の内容を返すので、成功と同じに扱える
 * - それでも駄目なとき・400 などのときは、そのまとまりと後ろに並ぶまとまりをすべて捨てる
 *   （操作どうしの依存を追わないため）。表示はその操作の前に戻る
 */

/** 再送までの待ち時間（1回目、2回目） */
export const RETRY_DELAYS_MS = [500, 2000] as const;

export type SendQueueOptions = {
  replica: Replica;
  api: ApiClient;
  /** 確定した行を手元の控えに保存する */
  persist: (rows: readonly SyncRow[]) => void;
  /** まとまりが確定した（元に戻すの後始末に使う） */
  onConfirmed: (batch: PendingBatch) => void;
  /** まとまりが失敗し、送信中のまとまりをすべて捨てた */
  onFailed: (error: ApiFailure, discarded: readonly PendingBatch[]) => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class SendQueue {
  readonly #options: SendQueueOptions;
  #running: Promise<void> | null = null;
  #disposed = false;

  constructor(options: SendQueueOptions) {
    this.#options = options;
  }

  /** 列に積んだまとまりを送り始める（送っている途中なら何もしない） */
  kick(): void {
    if (this.#running || this.#disposed) return;
    this.#running = this.#run().finally(() => {
      this.#running = null;
    });
  }

  /** 列が空になるまで待つ（テスト用） */
  async idle(): Promise<void> {
    while (this.#running) await this.#running;
  }

  dispose(): void {
    this.#disposed = true;
  }

  async #run(): Promise<void> {
    const { replica, persist, onConfirmed, onFailed } = this.#options;
    for (;;) {
      const batch = replica.pending[0];
      if (!batch || this.#disposed) return;
      const result = await this.#send(batch);
      if (this.#disposed) return;
      // 送っているあいだに捨てられていたら（ほかの失敗など）、次へ
      if (replica.pending[0] !== batch) continue;
      if (result.ok) {
        replica.confirmBatch(batch.id, result.data.rows);
        persist(result.data.rows);
        onConfirmed(batch);
      } else {
        const discarded = replica.discardPending(() => true);
        onFailed(result.error, discarded);
      }
    }
  }

  async #send(batch: PendingBatch): Promise<ApiResult<{ rows: SyncRow[] }>> {
    const send = () => this.#options.api.mutate({ id: batch.id, mutations: [...batch.mutations] });
    let result = await send();
    for (const delay of RETRY_DELAYS_MS) {
      if (result.ok || !isRetryable(result.error) || this.#disposed) break;
      await sleep(delay);
      if (this.#disposed) break;
      result = await send();
    }
    return result;
  }
}
