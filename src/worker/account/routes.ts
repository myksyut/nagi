import { Hono } from "hono";
import { z } from "zod";
import type { ApiErrorResponse } from "../../shared/api";
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION, exportPageQuerySchema } from "../../shared/export";
import { getDb } from "../db/client";
import type { AppEnv } from "../types";
import { deleteAccount } from "./delete";
import { readExportPage } from "./export";

const deleteRequestSchema = z.strictObject({ confirm: z.string() });

/**
 * DELETE /api/account と GET /api/export。ログインの確認（/api/*）は index.ts でかける。
 * 消すのは、本文の confirm に今の利用者の ID を書いたときだけ（別のセッションや、手違いの呼び出しで消さない）
 */
export const accountRoutes = new Hono<AppEnv>()
  .delete("/account", async (c) => {
    const body = deleteRequestSchema.safeParse(await c.req.json().catch(() => undefined));
    if (!body.success) {
      return c.json({ error: "invalid_request", reason: "schema" }, 400);
    }
    if (body.data.confirm !== c.get("userId")) {
      return c.json({ error: "invalid_request", reason: "confirm_mismatch" }, 400);
    }
    await deleteAccount(getDb(c.env.DB), c.get("userId"));
    return c.body(null, 204);
  })
  .get("/export", async (c) => {
    const query = exportPageQuerySchema.safeParse(c.req.query());
    if (!query.success) {
      return c.json({ error: "invalid_request", reason: "schema" } satisfies ApiErrorResponse, 400);
    }
    const { kind, after } = query.data;
    const page = await readExportPage(getDb(c.env.DB), c.get("userId"), kind, after);
    if (kind === "projects" && after === undefined) {
      return c.json({
        format: EXPORT_FORMAT,
        formatVersion: EXPORT_FORMAT_VERSION,
        exportedAt: new Date().toISOString(),
        app: "nagi-worker",
        ...page,
      });
    }
    return c.json(page);
  });
