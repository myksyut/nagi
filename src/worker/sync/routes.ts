import { type Context, Hono } from "hono";
import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import {
  API_VERSION,
  API_VERSION_HEADER,
  type ApiErrorResponse,
  type ImportResponse,
  MIN_API_VERSION,
  type MutateResponse,
  RELEASES_URL,
  type SyncResponse,
  syncRequestSchema,
} from "../../shared/api";
import { mutationBatchSchema } from "../../shared/mutations";
import { type TimeZoneResponse, timeZoneRequestSchema } from "../../shared/time-zone";
import { setUserTimeZone } from "../auth/users";
import { getDb } from "../db/client";
import type { AppEnv } from "../types";
import { readChanges } from "./changes";
import { importRequestSchema, importRows } from "./import";
import { applyMutationBatch } from "./mutate";
import { rolloverIfDue } from "./rollover";

/** X-Api-Version が MIN_API_VERSION から API_VERSION までの整数でなければ 409（古い nagi は 409 だけを版のずれと読む） */
export const requireApiVersion = createMiddleware<AppEnv>(async (c, next) => {
  const header = c.req.header(API_VERSION_HEADER);
  const version = header !== undefined && /^\d+$/.test(header) ? Number(header) : undefined;
  if (version === undefined || version < MIN_API_VERSION) {
    return c.json(
      {
        error: "api_version_unsupported",
        minApiVersion: MIN_API_VERSION,
        apiVersion: API_VERSION,
        releaseUrl: RELEASES_URL,
      } satisfies ApiErrorResponse,
      409,
    );
  }
  if (version > API_VERSION) {
    return c.json(
      {
        error: "api_version_too_new",
        minApiVersion: MIN_API_VERSION,
        apiVersion: API_VERSION,
      } satisfies ApiErrorResponse,
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

/** /api/sync と /api/mutate と /api/time-zone。ログインの確認（/api/*）は index.ts でかける。どちらも、ログインしている利用者の行だけを扱う */
export function createSyncRoutes({ now }: SyncRoutesOptions) {
  return new Hono<AppEnv>()
    .post("/sync", requireApiVersion, async (c) => {
      const parsed = await parseJsonBody(c, syncRequestSchema);
      if (!parsed.ok) return c.json(parsed.error, 400);
      const db = getDb(c.env.DB);
      const userId = c.get("userId");
      // 差分を読む前に、必要なら日付の切り替えを進める（移した行も、この応答か次のページで届く）
      const timeZone = c.get("timeZone") ?? c.env.APP_TIMEZONE;
      await rolloverIfDue(db, userId, now(), timeZone);
      const changes = await readChanges(db, userId, parsed.data);
      return c.json({ ...changes, timeZone } satisfies SyncResponse);
    })
    .post("/time-zone", async (c) => {
      const parsed = await parseJsonBody(c, timeZoneRequestSchema);
      if (!parsed.ok) return c.json(parsed.error, 400);
      await setUserTimeZone(getDb(c.env.DB), c.get("userId"), parsed.data.timeZone);
      return c.json(parsed.data satisfies TimeZoneResponse);
    })
    .post("/mutate", requireApiVersion, async (c) => {
      const parsed = await parseJsonBody(c, mutationBatchSchema);
      if (!parsed.ok) return c.json(parsed.error, 400);
      const outcome = await applyMutationBatch(
        getDb(c.env.DB),
        c.get("userId"),
        parsed.data,
        now(),
      );
      if (!outcome.ok) {
        const error: ApiErrorResponse = {
          error: "invalid_request",
          reason: outcome.reason,
          mutationIndex: outcome.mutationIndex,
        };
        return c.json(error, 400);
      }
      return c.json({ rows: outcome.rows } satisfies MutateResponse);
    })
    .post("/import", requireApiVersion, async (c) => {
      const parsed = await parseJsonBody(c, importRequestSchema);
      if (!parsed.ok) return c.json(parsed.error, 400);
      const outcome = await importRows(
        getDb(c.env.DB),
        c.get("userId"),
        parsed.data,
        now(),
        c.req.query("dryRun") === "1",
      );
      if (!outcome.ok) {
        return c.json(
          { error: "invalid_request", reason: outcome.reason } satisfies ApiErrorResponse,
          400,
        );
      }
      return c.json(outcome.response satisfies ImportResponse);
    });
}
