import { sqliteTable, text } from "drizzle-orm/sqlite-core";

/** ログインのセッション。id はセッションのトークンの SHA-256（16進）。トークンそのものは保存しない */
export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  /** ISO 8601（UTC） */
  expiresAt: text("expires_at").notNull(),
  /** ISO 8601（UTC） */
  createdAt: text("created_at").notNull(),
});
