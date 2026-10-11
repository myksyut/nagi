import { z } from "zod";

/** IANA タイムゾーンの名前（例：Europe/Berlin）。Intl が読めない名前は通さない */
export const timeZoneSchema = z
  .string()
  .max(64)
  .refine((name) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: name });
      return true;
    } catch {
      return false;
    }
  }, "unknown time zone");

/** POST /api/time-zone の要求と応答 */
export const timeZoneRequestSchema = z.strictObject({ timeZone: timeZoneSchema });
export type TimeZoneResponse = z.output<typeof timeZoneRequestSchema>;
