import { logicalDate } from "../../shared/logical-date";

export const BACKUP_PREFIX = "backups/";
export const BACKUP_RETENTION_DAYS = 35;

const BACKUP_KEY = /^backups\/(\d{4}-\d{2}-\d{2})\.sqlgz$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 1 ページの行数の上限 */
const PAGE_ROWS = 1000;
/**
 * 1 ページの大きさの上限（src/worker/account/export.ts の書き出しと同じ考え方）。行の大きさは、全部の列の
 * octet_length（UTF-8 のバイト数。数は文字にした長さ）の和に ROW_OVERHEAD を足したもの。最低 1 行は読む。
 * - 1 行の最大は 680 KB 未満（export.ts の見積もり）なので、どの 1 行も上限に収まる
 * - Worker のメモリ（128 MB）：数えたバイトを B とすると、D1 の結果を読むときに、届いた JSON ≤ 6B（制御文字の
 *   \u00XX）、その文字列 ≤ 12B、行 ≤ 2B。SQL は 1 行ずつ作って FLUSH_CHARS ごとに圧縮へ渡し、ページ全体の SQL は
 *   持たない。B = 2 MiB なら 40 MiB 以下で、ほかは 1 行ぶんの SQL（数 MB）と、マルチパートの部品（10 MiB まで）
 */
export const PAGE_BYTES = 2 * 1024 * 1024;
const ROW_OVERHEAD = 1024;
/** D1 の 1 文の上限（100,000 バイト）より下。収まらない行は、INSERT のあとの UPDATE で、大きい列に少しずつ足す */
export const MAX_STATEMENT_BYTES = 90_000;
/** 圧縮へ渡すまとまりの大きさ（文字数）のめやす */
const FLUSH_CHARS = 64 * 1024;
/** D1 は 1 回の呼び出しで 1000 クエリまで。残りを、失敗を見て気づける形で打ち切るための上限 */
const MAX_QUERIES = 900;
/** R2 のマルチパートは、最後以外の部品がどれも同じ大きさで、5 MiB 以上でなければならない */
const PART_SIZE = 5 * 1024 * 1024;

const utf8 = new TextEncoder();
/**
 * 16 進で書く文字列。SQLite は SQL の文を NUL で打ち切る。改行は、文の途中に入れない（「;\n」で文を割れるように）。
 * 改行を char(10) の連結で書くと、改行の多いメモで式の深さが D1 の上限（100）を超える
 */
const NEEDS_HEX = /[\0\r\n]/;
const HEX_TEXT_WRAP = "CAST(X'' AS TEXT)".length;
const HEX_DIGITS = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, "0"));

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
  const chunks = dumpChunks(env.DB, now, counts);
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await chunks.next();
      if (next.done) controller.close();
      else controller.enqueue(utf8.encode(next.value));
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
 * 文はどれも「;」と改行で終わり、MAX_STATEMENT_BYTES 以下で、文の途中に改行は入らない（NUL・改行を含む
 * 文字列は CAST(X'..' AS TEXT) で書く）。そのため、`wrangler d1 execute --file` でも、「;\n」で割っての実行でも、
 * そのまま戻せる
 */
async function* dumpChunks(
  db: D1Database,
  now: Date,
  counts: Record<string, number>,
): AsyncGenerator<string> {
  let queries = 0;
  const prepare = (sql: string) => {
    if (++queries > MAX_QUERIES) {
      throw new Error(
        `backup needs more than ${MAX_QUERIES} D1 queries; the database outgrew one invocation`,
      );
    }
    return db.prepare(sql);
  };

  const tables = (
    await prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
        ORDER BY rowid`,
    ).all<{ name: string; sql: string }>()
  ).results;
  const others = (
    await prepare(
      `SELECT sql FROM sqlite_master
        WHERE type IN ('index', 'view', 'trigger') AND sql IS NOT NULL
        ORDER BY rowid`,
    ).all<{ sql: string }>()
  ).results;

  yield `-- nagi backup ${now.toISOString()}\nPRAGMA defer_foreign_keys = on;\n`;
  for (const { sql } of tables) yield `${sql};\n`;

  let out = "";
  for (const { name } of tables) {
    const columns = (await prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all<Column>())
      .results;
    const sql = pageQuery(name, columns);
    counts[name] = 0;
    let after = 0;
    for (;;) {
      const rows = await prepare(sql).bind(after, PAGE_BYTES).raw<unknown[]>();
      for (const [, , ...values] of rows) {
        for (const statement of rowStatements(name, columns, values)) {
          out += statement;
          if (out.length >= FLUSH_CHARS) {
            yield out;
            out = "";
          }
        }
      }
      counts[name] += rows.length;
      const last = rows.at(-1);
      if (last === undefined) break;
      after = Number(last[0]);
      const available = Number(last[1]);
      if (rows.length === available && available < PAGE_ROWS) break;
    }
  }
  if (out !== "") yield out;

  for (const { sql } of others) yield `${sql};\n`;
  // 戻したあとの行数と突き合わせる控え（scripts/restore-rehearsal.sh が読む）
  yield Object.entries(counts)
    .map(([name, count]) => `-- rows ${name} ${count}\n`)
    .join("");
}

interface Column {
  name: string;
  /** 主キーの何番目の列か（1 から）。主キーでなければ 0 */
  pk: number;
}

/**
 * rowid が 1 つめの ? より後の行を、rowid の順に、大きさの累計が 2 つめの ? に収まるところまで
 * （最低 1 行、最大 PAGE_ROWS 行）読む。大きさを測るのと行を読むのは一つの文なので、同じ時点の行で区切る。
 * 各行の先頭は rowid と、測った行の数（読んだ行の数がそれと同じで、PAGE_ROWS より少なければ、表の終わり）
 */
function pageQuery(table: string, columns: Column[]): string {
  const t = quoteIdentifier(table);
  const size = columns
    .map((c) => `coalesce(octet_length(${quoteIdentifier(c.name)}), 0)`)
    .join(" + ");
  const selected = columns.map((c) => `${t}.${quoteIdentifier(c.name)}`).join(", ");
  return `WITH sized AS (
      SELECT rowid AS r, ${size} + ${ROW_OVERHEAD} AS size FROM ${t}
        WHERE rowid > ? ORDER BY rowid LIMIT ${PAGE_ROWS}
    ), page AS (
      SELECT r, sum(size) OVER (ORDER BY r) AS total, row_number() OVER (ORDER BY r) AS n,
        count(*) OVER () AS available
      FROM sized
    )
    SELECT page.r, page.available, ${selected}
      FROM page JOIN ${t} ON ${t}.rowid = page.r
      WHERE page.n = 1 OR page.total <= ?
      ORDER BY page.r`;
}

/**
 * 1 行を戻す文。1 文に収まらない行は、大きい文字列の列から順に空（''）にして INSERT を収め、
 * その列に、主キーで行を指す UPDATE で、文字の切れ目で分けた断片を順に足す
 */
function* rowStatements(table: string, columns: Column[], values: unknown[]): Generator<string> {
  const t = quoteIdentifier(table);
  const names = columns.map((c) => quoteIdentifier(c.name));
  const literals = values.map(sqlLiteral);
  const insert = (exprs: string[]) =>
    `INSERT INTO ${t} (${names.join(", ")}) VALUES (${exprs.join(", ")});\n`;
  const whole = insert(literals);
  // UTF-16 の 1 単位は、UTF-8 で 3 バイトまで
  if (whole.length * 3 <= MAX_STATEMENT_BYTES || utf8.encode(whole).length <= MAX_STATEMENT_BYTES) {
    yield whole;
    return;
  }

  const keys = columns
    .map((c, i) => ({ pk: c.pk, i }))
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.i);
  if (keys.length === 0) {
    throw new Error(`a row of ${table} exceeds one statement and the table has no primary key`);
  }
  const candidates = literals
    .flatMap((literal, i) => {
      const value = values[i];
      return typeof value === "string" && !keys.includes(i)
        ? [{ i, value, bytes: utf8.encode(literal).length }]
        : [];
    })
    .sort((a, b) => b.bytes - a.bytes);
  const deferred: typeof candidates = [];
  let total = utf8.encode(whole).length;
  for (const candidate of candidates) {
    if (total <= MAX_STATEMENT_BYTES) break;
    deferred.push(candidate);
    total -= candidate.bytes - "''".length;
  }
  if (total > MAX_STATEMENT_BYTES) {
    throw new Error(`a row of ${table} does not fit in ${MAX_STATEMENT_BYTES} bytes`);
  }

  yield insert(literals.map((literal, i) => (deferred.some((d) => d.i === i) ? "''" : literal)));
  const where = keys.map((i) => `${names[i]} IS ${literals[i]}`).join(" AND ");
  for (const { i, value } of deferred) {
    const head = `UPDATE ${t} SET ${names[i]} = ${names[i]} || `;
    const tail = ` WHERE ${where};\n`;
    const budget = MAX_STATEMENT_BYTES - utf8.encode(head + tail).length;
    for (const piece of textPieces(value, budget)) yield head + piece + tail;
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "string") return textLiteral(value, NEEDS_HEX.test(value));
  if (value instanceof ArrayBuffer || Array.isArray(value)) {
    return `X'${hexBytes(new Uint8Array(value as ArrayBuffer | number[]))}'`;
  }
  throw new Error(`unsupported D1 value type: ${typeof value}`);
}

/** 文字列の式。hex なら UTF-8 のバイトを 16 進で書いて TEXT に戻し、そうでなければ引用符で囲む */
function textLiteral(value: string, hex: boolean): string {
  return hex
    ? `CAST(X'${hexBytes(utf8.encode(value))}' AS TEXT)`
    : `'${value.replaceAll("'", "''")}'`;
}

function hexBytes(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += HEX_DIGITS[byte];
  return text;
}

/**
 * 文字列を、式（textLiteral）にしたときの UTF-8 のバイト数が budget 以下の断片に分け、断片ごとの式を返す。
 * 分けるのは文字の切れ目だけ（サロゲートペアも、16 進の 1 バイトの 2 桁も割らない）。
 * 16 進で書く文字列は、全部の断片を 16 進で書く
 */
function textPieces(value: string, budget: number): string[] {
  const hex = NEEDS_HEX.test(value);
  const room = budget - (hex ? HEX_TEXT_WRAP : "''".length);
  const pieces: string[] = [];
  let start = 0;
  let used = 0;
  for (let i = 0; i < value.length; ) {
    const code = value.codePointAt(i) ?? 0;
    const bytes = code < 0x80 ? 1 : code < 0x800 ? 2 : code <= 0xffff ? 3 : 4;
    const cost = hex ? bytes * 2 : code === 0x27 ? 2 : bytes;
    if (used + cost > room && i > start) {
      pieces.push(textLiteral(value.slice(start, i), hex));
      start = i;
      used = 0;
    }
    used += cost;
    i += code > 0xffff ? 2 : 1;
  }
  pieces.push(textLiteral(value.slice(start), hex));
  return pieces;
}
