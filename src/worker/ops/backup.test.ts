import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { backupKey, pruneBackups, runBackup } from "./backup";

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

/** ダンプを、空の D1 に「;\n」で割って流し込み、戻した表ごとの行数を返す */
async function restore(dump: string, target: D1Database) {
  const statements = dump
    .split(";\n")
    .map((s) => s.trim())
    .filter((s) => s !== "" && !s.startsWith("--"));
  for (let i = 0; i < statements.length; i += 100) {
    await target.batch(statements.slice(i, i + 100).map((sql) => target.prepare(sql)));
  }
  return await tableCounts(target);
}

async function tableCounts(target: D1Database) {
  const tables = await target
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
    )
    .all<{ name: string }>();
  const counts: Record<string, number> = {};
  for (const { name } of tables.results) {
    const row = await target.prepare(`SELECT count(*) AS n FROM "${name}"`).first<{ n: number }>();
    counts[name] = row?.n ?? 0;
  }
  return counts;
}

async function insertTasks(count: number, memo: (i: number) => string) {
  await env.DB.prepare("DELETE FROM tasks").run();
  const stmt = env.DB.prepare(
    `INSERT INTO tasks (user_id, id, title, bucket, rank, created_at, updated_at, seq, memo)
     VALUES ('owner', ?, ?, 'inbox', 'a0', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', ?, ?)`,
  );
  for (let start = 0; start < count; start += 50) {
    const batch = [];
    for (let i = start; i < Math.min(start + 50, count); i++) {
      batch.push(stmt.bind(`t${i}`, `task ${i}`, i + 1, memo(i)));
    }
    await env.DB.batch(batch);
  }
}

beforeEach(async () => {
  const stale = await env.BACKUPS.list({ prefix: "backups/" });
  if (stale.objects.length > 0) await env.BACKUPS.delete(stale.objects.map((o) => o.key));
  await insertTasks(0, () => "");
});

describe("runBackup", () => {
  it("アプリの時間帯の日付で、backups/YYYY-MM-DD.sqlgz の 1 ファイルを書く", async () => {
    await runBackup(env, NOW);

    expect(await listKeys()).toEqual(["backups/2026-10-12.sqlgz"]);
    expect(backupKey("2026-10-12")).toBe("backups/2026-10-12.sqlgz");
  });

  it("同じ日に 2 回走っても、その日のファイルは 1 つで、最後の中身になる", async () => {
    await insertTasks(1, () => "");
    await runBackup(env, NOW);
    await insertTasks(3, () => "");
    await runBackup(env, new Date(NOW.getTime() + 60_000));

    expect(await listKeys()).toEqual(["backups/2026-10-12.sqlgz"]);
    expect(await readBackup("backups/2026-10-12.sqlgz")).toContain("-- rows tasks 3\n");
  });

  it("全テーブルの行を、戻せる形で書く（引用符・改行・NULL・ページをまたぐ件数）", async () => {
    await insertTasks(1203, (i) => (i === 7 ? "it's\r\nmulti\nline; -- not a comment\n" : ""));
    const before = await tableCounts(env.DB);
    await runBackup(env, NOW);

    const target = env.MIGRATION_TEST_DB;
    const names = await target
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'",
      )
      .all<{ name: string }>();
    for (const { name } of names.results) await target.exec(`DROP TABLE IF EXISTS "${name}"`);

    const restored = await restore(await readBackup("backups/2026-10-12.sqlgz"), target);

    expect(restored).toEqual(before);
    expect(restored.tasks).toBe(1203);
    const memo = await target
      .prepare("SELECT memo FROM tasks WHERE id = 't7'")
      .first<{ memo: string }>();
    expect(memo?.memo).toBe("it's\r\nmulti\nline; -- not a comment\n");
  }, 60_000);

  it("5 MiB を超えるダンプも、複数の部品に分けて欠けなく書く", async () => {
    const noise = (i: number) => {
      const bytes = crypto.getRandomValues(new Uint8Array(65_536));
      return `${i}:${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
    };
    await insertTasks(100, noise);
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
