import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backupKey, MAX_STATEMENT_BYTES, PAGE_BYTES, pruneBackups, runBackup } from "./backup";

const DAY_MS = 24 * 60 * 60 * 1000;
/** 日本時間 2026-10-12 4 時 37 分（cron の時刻）。ファイル名の日付は 10-12 になる */
const NOW = new Date("2026-10-11T19:37:00.000Z");

async function listKeys(bucket: R2Bucket = env.BACKUPS) {
  const listed = await bucket.list({ prefix: "backups/" });
  return listed.objects.map((o) => o.key).sort();
}

async function readBackup(key: string): Promise<string> {
  const object = await env.BACKUPS.get(key);
  if (object === null) throw new Error(`no such backup: ${key}`);
  return await new Response(object.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

const TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name";

/** ダンプを、表を消した D1 に「;\n」で割って流し込む */
async function restore(dump: string, target: D1Database) {
  const existing = await target.prepare(TABLES_SQL).all<{ name: string }>();
  for (const { name } of existing.results) await target.exec(`DROP TABLE IF EXISTS "${name}"`);
  const statements = dump
    .split(";\n")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("--"));
  for (let i = 0; i < statements.length; i += 100) {
    await target.batch(statements.slice(i, i + 100).map((sql) => target.prepare(sql)));
  }
}

/** 表ごとに、全行の全列を「型:UTF-8 のバイトの 16 進」にして並べたもの。バイトまで同じかを比べる */
async function snapshot(db: D1Database) {
  const tables = await db.prepare(TABLES_SQL).all<{ name: string }>();
  const result: Record<string, string[]> = {};
  for (const { name } of tables.results) {
    const columns = await db.prepare(`PRAGMA table_info("${name}")`).all<{ name: string }>();
    const row = columns.results
      .map((c) => `typeof("${c.name}") || ':' || coalesce(hex("${c.name}"), '')`)
      .join(" || '|' || ");
    const rows = await db.prepare(`SELECT ${row} AS row FROM "${name}"`).all<{ row: string }>();
    result[name] = rows.results.map((r) => r.row).sort();
  }
  return result;
}

interface TaskFields {
  title?: string;
  memo?: string;
  checklist?: string;
  project_id?: string | null;
}

async function insertTasks(count: number, fields: (i: number) => TaskFields = () => ({})) {
  await env.DB.prepare("DELETE FROM tasks").run();
  const stmt = env.DB.prepare(
    `INSERT INTO tasks (user_id, id, title, bucket, rank, created_at, updated_at, seq, memo, checklist, project_id)
     VALUES ('owner', ?, ?, 'inbox', 'a0', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?, ?, ?, ?)`,
  );
  for (let start = 0; start < count; start += 50) {
    const batch = [];
    for (let i = start; i < Math.min(start + 50, count); i++) {
      const f = fields(i);
      batch.push(
        stmt.bind(
          `t${i}`,
          f.title ?? `task ${i}`,
          i + 1,
          f.memo ?? "",
          f.checklist ?? "[]",
          f.project_id ?? null,
        ),
      );
    }
    await env.DB.batch(batch);
  }
}

/** API が受け付ける最大のタスク（タイトル 500 字、メモ 20,000 字、500 字の項目 200 個）。字は UTF-16 の単位で数える */
function maximalTask(memoUnit: string): TaskFields {
  return {
    title: "題".repeat(500),
    memo: memoUnit.repeat(20_000 / memoUnit.length),
    checklist: JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({
        id: `0199a000-0000-7000-8000-${String(i).padStart(12, "0")}`,
        title: "項目".repeat(250),
        done: i % 2 === 0,
      })),
    ),
  };
}

beforeEach(async () => {
  const stale = await env.BACKUPS.list({ prefix: "backups/" });
  if (stale.objects.length > 0) await env.BACKUPS.delete(stale.objects.map((o) => o.key));
  await insertTasks(0);
  await env.DB.prepare("DELETE FROM projects").run();
});

describe("runBackup", () => {
  it("アプリの時間帯の日付で、backups/YYYY-MM-DD.sqlgz の 1 ファイルを書く", async () => {
    await runBackup(env, NOW);

    expect(await listKeys()).toEqual(["backups/2026-10-12.sqlgz"]);
    expect(backupKey("2026-10-12")).toBe("backups/2026-10-12.sqlgz");
  });

  it("同じ日に 2 回走っても、その日のファイルは 1 つで、最後の中身になる", async () => {
    await insertTasks(1);
    await runBackup(env, NOW);
    await insertTasks(3);
    await runBackup(env, new Date(NOW.getTime() + 60_000));

    expect(await listKeys()).toEqual(["backups/2026-10-12.sqlgz"]);
    expect(await readBackup("backups/2026-10-12.sqlgz")).toContain("-- rows tasks 3\n");
  });

  it("全テーブルの行を、バイトまで同じに戻せる形で書く（NUL・引用符・改行・絵文字・NULL と空・ページをまたぐ件数）", async () => {
    const tricky = "it's\r\nmulti\nline; -- not a comment\n\0end😀";
    await insertTasks(1203, (i) =>
      i === 7
        ? { title: "a\0b 😀", memo: tricky, project_id: "" }
        : i === 8
          ? { memo: "\0", project_id: null }
          : {},
    );
    await env.DB.prepare(
      `INSERT INTO projects (user_id, id, name, created_at, updated_at, seq)
       VALUES ('owner', 'p1', ?, '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', 1)`,
    )
      .bind("名前\0'😀\r\n")
      .run();
    const before = await snapshot(env.DB);
    await runBackup(env, NOW);

    await restore(await readBackup("backups/2026-10-12.sqlgz"), env.MIGRATION_TEST_DB);

    expect(await snapshot(env.MIGRATION_TEST_DB)).toEqual(before);
    expect(before.tasks).toHaveLength(1203);
    const row = await env.MIGRATION_TEST_DB.prepare(
      "SELECT title, memo, project_id FROM tasks WHERE id = 't7'",
    ).first();
    expect(row).toEqual({ title: "a\0b 😀", memo: tricky, project_id: "" });
  }, 60_000);

  it("API が受け付ける最大の行も、1 文が上限を超えずに、バイトまで同じに戻る。1 ページの大きさは上限に収まる", async () => {
    await insertTasks(10, (i) =>
      i === 9 ? maximalTask("日本語\0") : i % 3 === 0 ? {} : maximalTask("日本語の😀メモ'\n"),
    );
    const before = await snapshot(env.DB);
    const pages: number[] = [];
    const spied = {
      prepare(sql: string) {
        const stmt = env.DB.prepare(sql);
        return {
          all: () => stmt.all(),
          bind: (...args: unknown[]) => ({
            raw: async () => {
              const rows = await stmt.bind(...args).raw<unknown[]>();
              const values = rows.flat().filter((v) => typeof v === "string");
              if (rows.length > 1) pages.push(new TextEncoder().encode(values.join("")).length);
              return rows;
            },
          }),
        };
      },
    } as unknown as D1Database;
    await runBackup({ ...env, DB: spied }, NOW);

    const dump = await readBackup("backups/2026-10-12.sqlgz");
    const sizes = dump.split(";\n").map((s) => new TextEncoder().encode(`${s};\n`).length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_STATEMENT_BYTES);
    expect(dump).toMatch(/^UPDATE "tasks" SET "checklist" = "checklist" \|\| /m);
    expect(Math.max(...pages)).toBeLessThanOrEqual(PAGE_BYTES);
    await restore(dump, env.MIGRATION_TEST_DB);
    expect(await snapshot(env.MIGRATION_TEST_DB)).toEqual(before);
  }, 120_000);

  it("5 MiB を超えるダンプも、複数の部品に分けて欠けなく書く", async () => {
    const noise = (i: number) => {
      const bytes = crypto.getRandomValues(new Uint8Array(65_536));
      return `${i}:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    };
    await insertTasks(100, (i) => ({ memo: noise(i) }));
    await runBackup(env, NOW);

    const object = await env.BACKUPS.head("backups/2026-10-12.sqlgz");
    expect(object?.size).toBeGreaterThan(5 * 1024 * 1024);
    expect(await readBackup("backups/2026-10-12.sqlgz")).toContain("-- rows tasks 100\n");
  }, 60_000);

  it("35 日より古い日付のファイルを消し、ちょうど 35 日前と関係ない名前は残す", async () => {
    const day = (ago: number) =>
      new Date(Date.parse("2026-10-12") - ago * DAY_MS).toISOString().slice(0, 10);
    for (const ago of [36, 40, 35, 10]) await env.BACKUPS.put(backupKey(day(ago)), "old");
    await env.BACKUPS.put("backups/notes.txt", "keep");
    await env.BACKUPS.put("other/2020-01-01.sqlgz", "keep");

    await runBackup(env, NOW);

    expect(await env.BACKUPS.list().then((l) => l.objects.map((o) => o.key).sort())).toEqual(
      [
        "backups/2026-10-12.sqlgz",
        backupKey(day(10)),
        backupKey(day(35)),
        "backups/notes.txt",
        "other/2020-01-01.sqlgz",
      ].sort(),
    );
  });

  it("pruneBackups は、1000 件を超えるファイルも、ページをまたいで全部見る", async () => {
    for (let i = 0; i < 1005; i++) {
      const date = new Date(Date.UTC(2020, 0, 1) + i * DAY_MS).toISOString().slice(0, 10);
      await env.BACKUPS.put(backupKey(date), "x");
    }
    const removed = await pruneBackups(env.BACKUPS, "2023-10-12");

    const remaining = await listKeys();
    expect(removed + remaining.length).toBe(1005);
    expect(remaining.every((key) => key >= backupKey("2023-09-07"))).toBe(true);
  }, 60_000);

  it("R2 への書き込みが失敗したら、拒否し、書きかけのファイルも作らず、古いファイルを消さない", async () => {
    await env.BACKUPS.put(backupKey("2026-08-01"), "old");
    await env.BACKUPS.put(backupKey("2026-10-12"), "same-day-old");
    let aborted = false;
    const failing = {
      list: env.BACKUPS.list.bind(env.BACKUPS),
      delete: env.BACKUPS.delete.bind(env.BACKUPS),
      createMultipartUpload: async () => ({
        uploadPart: async () => {
          throw new Error("r2 down");
        },
        complete: async () => {
          throw new Error("unreachable");
        },
        abort: async () => {
          aborted = true;
        },
      }),
    } as unknown as R2Bucket;

    await expect(runBackup({ ...env, BACKUPS: failing }, NOW)).rejects.toThrow("r2 down");

    expect(aborted).toBe(true);
    expect(await listKeys()).toEqual([backupKey("2026-08-01"), backupKey("2026-10-12")]);
    expect(await (await env.BACKUPS.get(backupKey("2026-10-12")))?.text()).toBe("same-day-old");
  });

  it("D1 の読み出しが途中で失敗したら、拒否し、ファイルを作らず、古いファイルを消さない", async () => {
    await env.BACKUPS.put(backupKey("2026-01-01"), "old");
    const base = env.DB;
    let calls = 0;
    const flaky = {
      prepare(sql: string) {
        if (++calls > 3) throw new Error("d1 down");
        return base.prepare(sql);
      },
    } as unknown as D1Database;

    await expect(runBackup({ ...env, DB: flaky }, NOW)).rejects.toThrow("d1 down");

    expect(await listKeys()).toEqual([backupKey("2026-01-01")]);
  });
});
