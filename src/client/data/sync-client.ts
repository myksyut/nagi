import type { SyncRow } from "@shared/model";
import type { ApiClient, ApiFailure } from "./api-client";
import type { LocalDb } from "./local-db";
import type { Replica } from "./replica";

/**
 * 差分の取得（POST /api/sync）。
 * - 要求は { cursor, baseCursor }。baseCursor は、その取得の流れの最初の、手元に反映済みのカーソル
 *   （手元が空なら 0）で、hasMore がなくなるまでのすべてのページにそのまま付ける
 * - 全部そろってから、まとめて確定データに反映し（途中の半端な状態を見せない）、最後に手元の控えに保存する
 * - reset が来たら、それまでのページを捨てて { cursor: 0, baseCursor: 0 } から取り直し、そろったら手元を置き換える
 * - カーソルを進めるのは差分の取得だけ（操作の応答で返った行では動かさない）
 * - 取得は同時に1つだけ。取得中にきっかけが来たら、終わったあとにもう1回取る
 */

export type SyncClientOptions = {
  replica: Replica;
  api: ApiClient;
  localDb: () => LocalDb;
  /** 今、取りに行ってよいか（読み込み済み・オンライン・止まっていない） */
  canSync: () => boolean;
  /** 取得の途中で、結果を反映してよいか（止まっていない。オフラインになっても届いた結果は使う） */
  isActive: () => boolean;
  /** 1回の取得の流れが反映まで終わった */
  onSynced: () => void;
  onFailed: (error: ApiFailure) => void;
};

export class SyncClient {
  /** 手元（メモリ）に反映済みのカーソル */
  cursor = 0;

  readonly #options: SyncClientOptions;
  #running: Promise<void> | null = null;
  #again = false;

  constructor(options: SyncClientOptions) {
    this.#options = options;
  }

  /** 差分を取る。取得中なら、終わったあとにもう1回取る（その取得の終わりまでを待つ） */
  sync(): Promise<void> {
    if (!this.#options.canSync()) return Promise.resolve();
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = this.#loop().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #loop(): Promise<void> {
    do {
      this.#again = false;
      await this.#flow();
    } while (this.#again && this.#options.canSync());
  }

  /** 1回の取得の流れ（hasMore がなくなるまで） */
  async #flow(): Promise<void> {
    const { api, replica, isActive, onFailed, onSynced } = this.#options;
    let baseCursor = this.cursor;
    let cursor = baseCursor;
    let reset = false;
    const rows: SyncRow[] = [];

    for (;;) {
      const result = await api.sync({ cursor, baseCursor });
      if (!isActive()) return;
      if (!result.ok) {
        onFailed(result.error);
        return;
      }
      const page = result.data;
      if (page.reset) {
        // baseCursor が 0 なら reset は来ない。続いたらサーバーの不具合なので、あきらめて次のきっかけを待つ
        if (reset) {
          console.error("差分の取得で reset が続きました");
          return;
        }
        reset = true;
        baseCursor = 0;
        cursor = 0;
        rows.length = 0;
        continue;
      }
      rows.push(...page.rows);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }

    if (reset) {
      replica.replaceConfirmed(rows);
      this.cursor = cursor;
      await this.#persist(() => this.#options.localDb().replaceAll(rows, cursor));
      // 取り直しのあいだに確定した操作の応答は、置き換えで消えることがあるので、もう1回取る
      this.#again = true;
    } else {
      replica.mergeConfirmed(rows);
      this.cursor = cursor;
      await this.#persist(() => this.#options.localDb().putRows(rows, cursor));
    }
    onSynced();
  }

  async #persist(write: () => Promise<void>): Promise<void> {
    try {
      await write();
    } catch (error) {
      console.error("手元の控えに保存できませんでした", error);
    }
  }
}
