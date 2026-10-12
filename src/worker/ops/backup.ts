import { logicalDate } from "../../shared/logical-date";

export const BACKUP_PREFIX = "backups/";
export const BACKUP_RETENTION_DAYS = 35;

const BACKUP_KEY = /^backups\/(\d{4}-\d{2}-\d{2})\.sqlgz$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const ROWS_PER_PAGE = 500;
/** D1 は 1 回の呼び出しで 1000 クエリまで。残りを、失敗を見て気づける形で打ち切るための上限 */
const MAX_QUERIES = 900;
/** R2 のマルチパートは、最後以外の部品がどれも同じ大きさで、5 MiB 以上でなければならない */
const PART_SIZE = 5 * 1024 * 1024;

export interface BackupEnv {
  DB: D1Database;
  BACKUPS: R2Bucket;
  APP_TIMEZONE: string;
}

export function backupKey(date: string): string {
  return `${BACKUP_PREFIX}${date}.sqlgz`;
}

/** 毎日 1 つ、その日の日付（アプリの時間帯）の名前で書く。同じ日にもう 1 回走ると、同じ名前に置き換わる */
export async function runBackup(env: BackupEnv, now: Date): Promise<void> {
  const today = logicalDate(now, env.APP_TIMEZONE);
  const key = backupKey(today);
  const rows = await writeBackup(env, key, now);
  // 掃除は書き込みが成功したあとだけ。失敗した日は、古いファイルを減らさない
  const removed = await pruneBackups(env.BACKUPS, today);
  console.log(JSON.stringify({ event: "backup", key, rows, pruned: removed }));
}

/** 35 日より古い日付のファイルを消す（今日からちょうど 35 日前のものは残す）。消した数を返す */
export async function pruneBackups(bucket: R2Bucket, today: string): Promise<number> {
  const cutoff = new Date(Date.parse(today) - BACKUP_RETENTION_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  const expired: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: BACKUP_PREFIX, cursor });
    for (const { key } of page.objects) {
      const date = BACKUP_KEY.exec(key)?.[1];
      if (date !== undefined && date < cutoff) expired.push(key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);
  for (let i = 0; i < expired.length; i += 1000) {
    await bucket.delete(expired.slice(i, i + 1000));
  }
  return expired.length;
}

/**
 * ダンプ（SQL を gzip したもの）を、R2 のマルチパートで書く。complete するまで、最終の名前のオブジェクトは
 * 現れないので、途中で失敗しても、書きかけのファイルも、同じ日の前のファイルの消失も起きない
 * 行数の表ごとの合計を返す
 */
async function writeBackup(
  env: BackupEnv,
  key: string,
  now: Date,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  const encoder = new TextEncoder();
  const chunks = dumpChunks(env.DB, now, counts);
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(encoder.encode(next.value));
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
  const reader = source.pipeThrough(new CompressionStream("gzip")).getReader();

  const upload = await env.BACKUPS.createMultipartUpload(key, {
    httpMetadata: { contentType: "application/gzip" },
  });
  try {
    const parts: R2UploadedPart[] = [];
    let pending: Uint8Array[] = [];
    let pendingSize = 0;
    const flush = async (size: number) => {
      const joined = new Uint8Array(pendingSize);
      let offset = 0;
      for (const chunk of pending) {
        joined.set(chunk, offset);
        offset += chunk.length;
      }
      parts.push(await upload.uploadPart(parts.length + 1, joined.subarray(0, size)));
      pending = pendingSize > size ? [joined.slice(size)] : [];
      pendingSize -= size;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      pending.push(value);
      pendingSize += value.length;
      while (pendingSize >= PART_SIZE) await flush(PART_SIZE);
    }
    if (pendingSize > 0) await flush(pendingSize);
    await upload.complete(parts);
  } catch (error) {
    await reader.cancel().catch(() => {});
    await upload.abort().catch(() => {});
    throw error;
  }
  return counts;
}

/**
 * ダンプの SQL を、まとまりごとに順に返す。順序は、表の定義 → 行 → 索引・トリガー・ビュー → 行数の控え。
 * 文はどれも「;」と改行で終わり、文の途中に改行は入らない（値の改行は char(10) で書く）。そのため、
 * `wrangler d1 execute --file` でも、「;\n」で割っての実行でも、そのまま戻せる
 */
async function* dumpChunks(
  db: D1Database,
  now: Date,
  counts: Record<string, number>,
): AsyncGenerator<string> {
  let queries = 0;
  const query = async <T>(sql: string, ...binds: unknown[]) => {
    if (++queries > MAX_QUERIES) {
      throw new Error(
        `backup needs more than ${MAX_QUERIES} D1 queries; the database outgrew one invocation`,
      );
    }
    return (
      await db
        .prepare(sql)
        .bind(...binds)
        .all<T>()
    ).results;
  };

  const tables = await query<{ name: string; sql: string }>(
    `SELECT name, sql FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
      ORDER BY rowid`,
  );
  const others = await query<{ sql: string }>(
    `SELECT sql FROM sqlite_master
      WHERE type IN ('index', 'view', 'trigger') AND sql IS NOT NULL
      ORDER BY rowid`,
  );

  yield `-- nagi backup ${now.toISOString()}\nPRAGMA defer_foreign_keys = on;\n`;
  for (const { sql } of tables) yield `${sql};\n`;

  for (const { name } of tables) {
    counts[name] = 0;
    let after = 0;
    for (;;) {
      const rows = await query<Record<string, unknown>>(
        `SELECT rowid AS "__rowid", * FROM ${quoteIdentifier(name)} WHERE rowid > ? ORDER BY rowid LIMIT ${ROWS_PER_PAGE}`,
        after,
      );
      if (rows.length === 0) break;
      let text = "";
      for (const { __rowid, ...row } of rows) {
        const columns = Object.keys(row).map(quoteIdentifier).join(", ");
        const values = Object.values(row).map(sqlLiteral).join(", ");
        text += `INSERT INTO ${quoteIdentifier(name)} (${columns}) VALUES (${values});\n`;
        after = Number(__rowid);
      }
      counts[name] += rows.length;
      yield text;
    }
  }

  for (const { sql } of others) yield `${sql};\n`;
  // 戻したあとの行数と突き合わせる控え（scripts/restore-rehearsal.sh が読む）
  yield Object.entries(counts)
    .map(([name, count]) => `-- rows ${name} ${count}\n`)
    .join("");
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "string") {
    return `'${value.replaceAll("'", "''").replaceAll("\r", "' || char(13) || '").replaceAll("\n", "' || char(10) || '")}'`;
  }
  if (value instanceof ArrayBuffer || Array.isArray(value)) {
    const bytes = new Uint8Array(value as ArrayBuffer | number[]);
    return `X'${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  throw new Error(`unsupported D1 value type: ${typeof value}`);
}
