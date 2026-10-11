import { z } from "zod";

/**
 * IANA タイムゾーンの名前（例：Europe/Berlin）。Intl が読めない名前は通さない。
 * Intl は大文字と小文字を区別せずに読むので、Intl の正しい綴りに直して通す
 * （TUI の chrono_tz は綴りどおりにしか読まない。pacific/pago_pago のまま保存して返すと、TUI が読めない）
 */
export const timeZoneSchema = z
  .string()
  .max(64)
  .transform((name, ctx) => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
    } catch {
      ctx.addIssue({ code: "custom", message: "unknown time zone" });
      return z.NEVER;
    }
  });

/** POST /api/time-zone の要求と応答 */
export const timeZoneRequestSchema = z.strictObject({ timeZone: timeZoneSchema });
export type TimeZoneResponse = z.output<typeof timeZoneRequestSchema>;
