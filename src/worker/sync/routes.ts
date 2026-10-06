import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import {
  API_VERSION,
  API_VERSION_HEADER,
  type ApiErrorResponse,
  type MutateResponse,
  type SyncResponse,
  syncRequestSchema,
} from "../../shared/api";
import { mutationBatchSchema } from "../../shared/mutations";
import { getDb } from "../db/client";
import type { AppEnv } from "../types";
import { readChanges } from "./changes";
import { applyMutationBatch } from "./mutate";
import { rolloverIfDue } from "./rollover";

/** X-Api-Version が API_VERSION と違えば 409（画面の版が古い。画面は再読み込みする） */
export const requireApiVersion = createMiddleware<AppEnv>(async (c, next) => {
  if (c.req.header(API_VERSION_HEADER) !== String(API_VERSION)) {
    return c.json(
      { error: "api_version_mismatch", apiVersion: API_VERSION } satisfies ApiErrorResponse,
      409,
    );
  }
  return next();
});

type Parsed<T> = { ok: true; data: T } | { ok: false; error: ApiErrorResponse };

async function parseJsonBody<T extends z.ZodType>(
  c: Context<AppEnv>,
  schema: T,
): Promise<Parsed<z.output<T>>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return { ok: false, error: { error: "invalid_request", reason: "invalid_json" } };
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.map((key) => (typeof key === "number" ? key : String(key))),
      message: issue.message,
    }));
    return { ok: false, error: { error: "invalid_request", reason: "schema", issues } };
  }
  return { ok: true, data: result.data };
}

export type SyncRoutesOptions = {
  /** 現在時刻。テストで差し替える（日付の切り替え、updatedAt など） */
  now: () => Date;
};

/** /api/sync と /api/mutate。ログインの確認（/api/*）は index.ts でかける */
export function createSyncRoutes({ now }: SyncRoutesOptions) {
  return new Hono<AppEnv>()
    .post("/sync", requireApiVersion, async (c) => {
      const parsed = await parseJsonBody(c, syncRequestSchema);
      if (!parsed.ok) return c.json(parsed.error, 400);
      const db = getDb(c.env.DB);
      // 差分を読む前に、必要なら日付の切り替えを進める（移した行も、この応答か次のページで届く）
      await rolloverIfDue(db, now(), c.env.APP_TIMEZONE);
      return c.json((await readChanges(db, parsed.data)) satisfies SyncResponse);
    })
    .post("/mutate", requireApiVersion, async (c) => {
      const parsed = await parseJsonBody(c, mutationBatchSchema);
      if (!parsed.ok) return c.json(parsed.error, 400);
      const outcome = await applyMutationBatch(getDb(c.env.DB), parsed.data, now());
      if (!outcome.ok) {
        const error: ApiErrorResponse = {
          error: "invalid_request",
          reason: outcome.reason,
          mutationIndex: outcome.mutationIndex,
        };
        return c.json(error, 400);
      }
      return c.json({ rows: outcome.rows } satisfies MutateResponse);
    });
}
