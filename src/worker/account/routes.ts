import { Hono } from "hono";
import { z } from "zod";
import { getDb } from "../db/client";
import type { AppEnv } from "../types";
import { deleteAccount } from "./delete";
import { exportAccount } from "./export";

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
    const now = new Date();
    const body = await exportAccount(getDb(c.env.DB), c.get("userId"), now);
    return c.body(body, 200, {
      "Content-Type": "application/json; charset=UTF-8",
      "Content-Disposition": `attachment; filename="nagi-export-${now.toISOString().slice(0, 10)}.json"`,
    });
  });
