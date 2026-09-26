import {
  API_VERSION,
  API_VERSION_HEADER,
  type ApiErrorResponse,
  type MutateResponse,
  type SyncRequest,
  type SyncResponse,
} from "@shared/api";
import type { MutationBatch } from "@shared/mutations";

/**
 * /api/sync と /api/mutate の呼び出し。どちらも JSON の POST で、X-Api-Version を付ける
 * （Origin はブラウザが付け、Cookie は同じオリジンなので既定で送られる）
 */

/** 失敗の種類。どう扱うか（再送・ログイン・再読み込み）で分ける */
export type ApiFailure =
  /** 通信エラーかタイムアウト。同じ ID で再送してよい */
  | { kind: "network" }
  /** 5xx。同じ ID で再送してよい */
  | { kind: "server"; status: number }
  /** 401。ログインし直す */
  | { kind: "unauthorized" }
  /** 409。画面の版が古い。再読み込みする */
  | { kind: "version-mismatch" }
  /** 400 など、再送しても通らない（ほぼ不具合） */
  | { kind: "rejected"; status: number; body: ApiErrorResponse | null };

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiFailure };

/** 同じ ID のまま再送してよい失敗か */
export function isRetryable(error: ApiFailure): boolean {
  return error.kind === "network" || error.kind === "server";
}

/**
 * 1回の呼び出しを待つ時間。過ぎたら打ち切って、通信エラーと同じに扱う
 * （送信は再送を含めて最長でおよそ 10 秒 × 3 回 + 2.5 秒で「保存できませんでした」になる）
 */
export const REQUEST_TIMEOUT_MS = 10_000;

export type ApiClientOptions = {
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class ApiClient {
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;

  constructor({
    fetch: fetchImpl = globalThis.fetch.bind(globalThis),
    timeoutMs = REQUEST_TIMEOUT_MS,
  }: ApiClientOptions = {}) {
    this.#fetch = fetchImpl;
    this.#timeoutMs = timeoutMs;
  }

  sync(request: SyncRequest): Promise<ApiResult<SyncResponse>> {
    return this.#post<SyncResponse>("/api/sync", request);
  }

  mutate(batch: MutationBatch): Promise<ApiResult<MutateResponse>> {
    return this.#post<MutateResponse>("/api/mutate", batch);
  }

  async #post<T>(path: string, body: unknown): Promise<ApiResult<T>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      let response: Response;
      try {
        response = await this.#fetch(path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [API_VERSION_HEADER]: String(API_VERSION),
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch {
        return { ok: false, error: { kind: "network" } };
      }
      if (response.ok) {
        try {
          return { ok: true, data: (await response.json()) as T };
        } catch {
          // 途中で切れた・JSON でない応答。届いたかどうか分からないので、再送できる扱いにする
          return { ok: false, error: { kind: "server", status: response.status } };
        }
      }
      return { ok: false, error: await failureOf(response) };
    } finally {
      clearTimeout(timer);
    }
  }
}

async function failureOf(response: Response): Promise<ApiFailure> {
  const { status } = response;
  if (status === 401) return { kind: "unauthorized" };
  // サーバーが 409 を返すのは API の版が違うときだけ
  if (status === 409) return { kind: "version-mismatch" };
  if (status >= 500) return { kind: "server", status };
  const body = await response.json().then(
    (json: unknown) => json as ApiErrorResponse,
    () => null,
  );
  return { kind: "rejected", status, body };
}
