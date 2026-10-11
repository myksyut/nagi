import { z } from "zod";
import type { SyncRow } from "./model";

/**
 * API の版。TUI はすべての呼び出しで X-Api-Version ヘッダに付ける。
 * Worker は MIN_API_VERSION から API_VERSION までを受け、範囲の外なら 409 を返す（426 にしない。
 * 出回っている nagi は 409 だけを「更新が要る」と読み、それ以外の 4xx では止まらずに変更を捨て続けるため）
 * - API_VERSION：形を足すときに上げる。範囲の中の古い版の形も受け続ける（古い版が知らない項目は、送られなければ変えない）
 * - MIN_API_VERSION：新しい版の TUI を出し、Homebrew の tap が更新されてから 90 日たつまで上げない。
 *   上げると、それより古い nagi は送っていない変更を残したまま止まり、更新を求められる
 *
 * これまでの版
 * - 2：進行中（tasks の startedAt）とプロジェクトの色（color）を足した
 * - 3：タスクの優先度（priority）と工数（points）を足した
 */
export const API_VERSION = 3;
export const MIN_API_VERSION = 3;
export const API_VERSION_HEADER = "X-Api-Version";
/** 版が古すぎる nagi に、409 の本文で示す入手先 */
export const RELEASES_URL = "https://github.com/myksyut/nagi/releases/latest";

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
 * - timeZone：Worker が日付の切り替えに使ったタイムゾーン（利用者の設定。なければ APP_TIMEZONE）。
 *   画面は、この名前で「今日」を出す（Worker と画面の日付をそろえる）。どのページにも付く
 */
export type SyncResponse = { timeZone: string } & SyncChanges;
/** SyncResponse から timeZone を除いたもの（行の差分の部分） */
export type SyncChanges =
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
  /** 変えたあとの行で、startedAt があるのに bucket が today でない（進行中のタスクは必ず今日にある） */
  | "started_outside_today"
  | "project_has_open_tasks"
  /** チェックリストの今の配列が、操作に添えられた「変える前の配列」と違う（ほかの画面が先に変えた） */
  | "checklist_conflict"
  /** 利用者ごとの行数の上限（MAX_TASKS_PER_USER、MAX_PROJECTS_PER_USER）を超える作成 */
  | "quota_exceeded";

export type ApiErrorResponse =
  | {
      error: "invalid_request";
      reason: InvalidRequestReason;
      /** 中身の検証で落ちた操作の位置（0 始まり） */
      mutationIndex?: number;
      issues?: { path: (string | number)[]; message: string }[];
    }
  /** X-Api-Version がない、読めない、MIN_API_VERSION より小さい（nagi の更新が要る） */
  | {
      error: "api_version_unsupported";
      minApiVersion: number;
      apiVersion: number;
      releaseUrl: string;
    }
  /** X-Api-Version が API_VERSION より大きい（nagi が先に出て、Worker の deploy がまだ） */
  | { error: "api_version_too_new"; minApiVersion: number; apiVersion: number }
  | {
      error:
        | "unauthorized"
        | "forbidden_origin"
        | "unsupported_media_type"
        /** 回数制限。Retry-After（秒）のあとにやり直す */
        | "rate_limited"
        /** 本文が大きすぎる（/api/* は 1 MiB、/auth/* は 4 KiB まで） */
        | "payload_too_large"
        | "not_found"
        | "internal_error";
    };
