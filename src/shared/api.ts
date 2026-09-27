import { z } from "zod";
import type { SyncRow } from "./model";

/**
 * API の版。すべての呼び出しで X-Api-Version ヘッダに付ける。サーバーの値と違えば 409。
 * API の形を変えるときは互換を保ち、保てない変更のときだけ上げる（デプロイのたびには上げない）
 */
export const API_VERSION = 1;
export const API_VERSION_HEADER = "X-Api-Version";

/**
 * POST /api/sync の要求
 * - cursor：ここより新しい行（seq > cursor）を取る。ページを進めるたびに前の応答の nextCursor にする
 * - baseCursor：手元に反映済みのカーソル（手元が空なら 0）。1回の取得の流れ（hasMore がなくなるまで）の
 *   すべてのページに、最初に読んだ値をそのまま付ける。サーバーはこれで reset を決める
 */
export const syncRequestSchema = z.strictObject({
  cursor: z.int().nonnegative(),
  baseCursor: z.int().nonnegative(),
});
export type SyncRequest = z.input<typeof syncRequestSchema>;

/**
 * POST /api/sync の応答
 * - reset：手元のデータを捨てて、cursor・baseCursor を 0 にして最初から取り直す
 * - rows：cursor より新しい行を seq の順に最大 500 行。論理削除した行（deletedAt あり）も入る
 * - nextCursor：次のページの cursor。最後のページ（hasMore: false）では、そこまでの変更をすべて
 *   受け取ったことを表す値（seq のすき間を飛ばす）なので、全部そろえて反映したあとに保存する
 */
export type SyncResponse =
  | { reset: true }
  | { reset: false; rows: SyncRow[]; nextCursor: number; hasMore: boolean };

/**
 * POST /api/mutate の応答。確定した行を seq の順に返す。
 * 同じ id のまとまりの再送なら、書き込まずに、操作の対象になった行の今の内容を返す（成功と同じに扱える）。
 * ここで返った行でカーソルは動かさない
 */
export type MutateResponse = { rows: SyncRow[] };

/** 400 の理由。schema は形の誤り（issues に詳細）、それ以外は中身の検証 */
export type InvalidRequestReason =
  | "invalid_json"
  | "schema"
  | "task_exists"
  | "task_not_found"
  | "project_exists"
  | "project_not_found"
  | "project_archived"
  | "project_deleted"
  | "schedule_mismatch"
  | "project_has_open_tasks"
  /** チェックリストの今の配列が、操作に添えられた「変える前の配列」と違う（ほかの画面が先に変えた） */
  | "checklist_conflict";

export type ApiErrorResponse =
  | {
      error: "invalid_request";
      reason: InvalidRequestReason;
      /** 中身の検証で落ちた操作の位置（0 始まり） */
      mutationIndex?: number;
      issues?: { path: (string | number)[]; message: string }[];
    }
  | { error: "api_version_mismatch"; apiVersion: number }
  | {
      error:
        | "unauthorized"
        | "forbidden_origin"
        | "unsupported_media_type"
        | "not_found"
        | "internal_error";
    };
