import { env } from "cloudflare:test";
import { and, count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  type ExportKind,
  type ExportPage,
  exportSchema,
  exportTaskSchema,
} from "../../shared/export";
import type { Project, Task } from "../../shared/model";
import { createSession } from "../auth/session";
import { readSignupPolicy, resolveUser } from "../auth/users";
import { getDb } from "../db/client";
import {
  appliedMutations,
  meta,
  OWNER_USER_ID,
  projects,
  sessions,
  tasks,
  users,
} from "../db/schema";
import { createApp } from "../index";
import { initialMetaRows } from "../sync/meta";
import {
  at,
  insertRawProject,
  insertRawTask,
  insertRawTasks,
  insertRawUser,
  resetSyncTables,
} from "../test/sync-app";
import { PAGE_BYTES, ROW_OVERHEAD, readExportPage } from "./export";

const db = getDb(env.DB);
const app = createApp();
const BASE = "https://nagi.example.com";
/** 2 人目の利用者（B）の GitHub ユーザーを、許可した人にしておく */
const TEST_ENV = { ...env, ALLOWED_GITHUB_USER_IDS: "2002" };

let B: string;

beforeEach(async () => {
  await resetSyncTables(db);
  B = await insertRawUser(db, 2002);
});

async function tokenOf(userId: string): Promise<string> {
  return (await createSession(db, userId, new Date())).token;
}

function request(token: string, method: "GET" | "DELETE", path: string, body?: unknown) {
  return app.request(
    `${BASE}${path}`,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    TEST_ENV,
  );
}

/** 利用者の行が 6 つの表にいくつ残っているか */
async function rowCounts(userId: string) {
  const of = async (
    table: typeof tasks | typeof projects | typeof appliedMutations | typeof meta | typeof sessions,
  ) => {
    const [row] = await db.select({ n: count() }).from(table).where(eq(table.userId, userId));
    return row?.n ?? 0;
  };
  const [user] = await db.select({ n: count() }).from(users).where(eq(users.id, userId));
  return {
    tasks: await of(tasks),
    projects: await of(projects),
    appliedMutations: await of(appliedMutations),
    meta: await of(meta),
    sessions: await of(sessions),
    users: user?.n ?? 0,
  };
}

async function fill(userId: string, seqStart: number) {
  const project = await insertRawProject(db, { userId, seq: seqStart });
  await insertRawTask(db, { userId, seq: seqStart + 1, projectId: project.id });
  await insertRawTask(db, { userId, seq: seqStart + 2 });
  await db
    .insert(appliedMutations)
    .values({ userId, id: crypto.randomUUID(), appliedAt: new Date().toISOString() });
}

describe("DELETE /api/account", () => {
  it("確かめの userId が合えば 204。その利用者の行は 6 つの表のどこにも残らず、ほかの利用者の行は変わらない。同じトークンは 401", async () => {
    await fill(OWNER_USER_ID, 1);
    await fill(B, 1);
    const token = await tokenOf(B);
    const second = await tokenOf(B);
    const before = await rowCounts(OWNER_USER_ID);
    expect(await rowCounts(B)).toEqual({
      tasks: 2,
      projects: 1,
      appliedMutations: 1,
      meta: 3,
      sessions: 2,
      users: 1,
    });

    const res = await request(token, "DELETE", "/api/account", { confirm: B });

    expect(res.status).toBe(204);
    expect(await rowCounts(B)).toEqual({
      tasks: 0,
      projects: 0,
      appliedMutations: 0,
      meta: 0,
      sessions: 0,
      users: 0,
    });
    expect(await rowCounts(OWNER_USER_ID)).toEqual(before);
    expect((await request(token, "GET", "/api/session")).status).toBe(401);
    expect((await request(second, "GET", "/api/session")).status).toBe(401);
  });

  it("確かめの userId が違う・ない・読めないなら 400 で、何も消えない", async () => {
    await fill(B, 1);
    const token = await tokenOf(B);
    const before = await rowCounts(B);

    for (const body of [{ confirm: OWNER_USER_ID }, { confirm: "" }, {}, { confirm: 1 }, "x"]) {
      const res = await request(token, "DELETE", "/api/account", body);
      expect(res.status).toBe(400);
    }
    const notJson = await app.request(
      `${BASE}/api/account`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: "{",
      },
      TEST_ENV,
    );
    expect(notJson.status).toBe(400);

    expect(await rowCounts(B)).toEqual(before);
    expect((await request(token, "GET", "/api/session")).status).toBe(200);
  });

  it("本文のない DELETE は 415（JSON を求める）で、何も消えない", async () => {
    await fill(B, 1);
    const token = await tokenOf(B);
    const before = await rowCounts(B);

    const res = await request(token, "DELETE", "/api/account");

    expect(res.status).toBe(415);
    expect(await rowCounts(B)).toEqual(before);
  });

  it("ログインしていなければ 401", async () => {
    const res = await request("nope", "DELETE", "/api/account", { confirm: B });
    expect(res.status).toBe(401);
  });

  it("持ち主の行も消える。次に持ち主の GitHub でログインすると、新しい利用者になる", async () => {
    await fill(OWNER_USER_ID, 1);
    const token = await tokenOf(OWNER_USER_ID);

    const res = await request(token, "DELETE", "/api/account", { confirm: OWNER_USER_ID });

    expect(res.status).toBe(204);
    expect(await rowCounts(OWNER_USER_ID)).toEqual({
      tasks: 0,
      projects: 0,
      appliedMutations: 0,
      meta: 0,
      sessions: 0,
      users: 0,
    });
    const policy = readSignupPolicy({ OWNER_GITHUB_USER_ID: "1001" });
    if (policy === null) throw new Error("設定が読めません");
    const next = await resolveUser(db, policy, 1001, new Date());
    expect(next).not.toBeNull();
    expect(next).not.toBe(OWNER_USER_ID);

    // 後のテストのために、持ち主の行を戻す
    if (next !== null) await db.delete(meta).where(eq(meta.userId, next));
    await db.delete(users).where(eq(users.githubUserId, 1001));
    await db.insert(users).values({ id: OWNER_USER_ID, createdAt: new Date().toISOString() });
    await db.insert(meta).values(initialMetaRows(OWNER_USER_ID));
  });
});

describe("GET /api/export", () => {
  /** 並びを決めるための ID（文字列の大小が、末尾の数の大小と同じ） */
  const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const utf8 = (text: string) => new TextEncoder().encode(text).length;
  /** readExportPage が数える 1 行の大きさ */
  const sizeOf = (task: Task) =>
    utf8(task.title) +
    utf8(task.memo) +
    utf8(JSON.stringify(task.checklist)) +
    utf8(task.rank) +
    ROW_OVERHEAD;

  async function page(token: string, query: string) {
    const res = await request(token, "GET", `/api/export?${query}`);
    expect(res.status).toBe(200);
    return (await res.json()) as ExportPage<Project> & ExportPage<Task>;
  }

  /** kind のページを、next が null になるまで順に読む */
  async function pages(token: string, kind: ExportKind) {
    const read = [];
    let after: string | null = null;
    do {
      const next = await page(token, `kind=${kind}${after === null ? "" : `&after=${after}`}`);
      read.push(next);
      after = next.next;
    } while (after !== null);
    return read;
  }

  it("最初のページにだけファイルの頭が付き、論理削除の行と他人の行を除いて、id の順に返す。つなげると exportSchema で読める", async () => {
    const project = await insertRawProject(db, { userId: B, id: idOf(2), seq: 3, name: "仕事" });
    await insertRawProject(db, { userId: B, id: idOf(1), name: "空", seq: 6 });
    await insertRawProject(db, { userId: B, seq: 4, deletedAt: "2026-09-01T00:00:00.000Z" });
    await insertRawTask(db, {
      userId: B,
      id: idOf(2),
      seq: 1,
      title: "一つ目\n改行 😀",
      projectId: project.id,
    });
    await insertRawTask(db, {
      userId: B,
      id: idOf(1),
      seq: 2,
      title: "完了済み",
      completedAt: "2026-09-02T00:00:00.000Z",
    });
    await insertRawTask(db, { userId: B, seq: 5, deletedAt: "2026-09-01T00:00:00.000Z" });
    await insertRawTask(db, { userId: OWNER_USER_ID, seq: 1, title: "他人" });
    const token = await tokenOf(B);

    const projectPages = await pages(token, "projects");
    const taskPages = await pages(token, "tasks");

    expect(projectPages).toHaveLength(1);
    expect(taskPages).toHaveLength(1);
    expect(taskPages[0]).not.toHaveProperty("format");
    const { rows, next: _, ...header } = at(projectPages, 0);
    const document = exportSchema.parse({
      ...header,
      projects: rows,
      tasks: at(taskPages, 0).rows,
    });
    expect(document.format).toBe("nagi-export");
    expect(document.app).toBe("nagi-worker");
    expect(document.tasks.map((task) => task.title)).toEqual(["完了済み", "一つ目\n改行 😀"]);
    expect(document.projects.map((row) => row.name)).toEqual(["空", "仕事"]);
    expect(at(document.tasks, 1).projectId).toBe(project.id);
  });

  it("kind がない・知らない、after が id の形でないときは 400", async () => {
    const token = await tokenOf(B);
    for (const query of ["", "kind=users", "kind=tasks&after=x", "kind=tasks&cursor=1"]) {
      const res = await request(token, "GET", `/api/export?${query}`);
      expect(res.status, query).toBe(400);
    }
  });

  it("行がなければ、空の 1 ページで終わる", async () => {
    const token = await tokenOf(B);

    expect(await pages(token, "projects")).toEqual([
      expect.objectContaining({ rows: [], next: null, format: "nagi-export" }),
    ]);
    expect(await pages(token, "tasks")).toEqual([{ rows: [], next: null }]);
  });

  it("1000 行を超えると 1000 行ずつ id の順に返し、最後のページで next が null になる", async () => {
    const rows = await insertRawTasks(db, 2300, 1);

    const read = await pages(await tokenOf(OWNER_USER_ID), "tasks");

    expect(read.map((each) => each.rows.length)).toEqual([1000, 1000, 300]);
    expect(read.flatMap((each) => each.rows.map((task) => task.id))).toEqual(
      rows.map((row) => row.id).sort(),
    );
  });

  it("ページのあいだに読み終えた行を書き換えても、その行は 1 回だけ入る", async () => {
    const early = await insertRawTask(db, { id: idOf(0), seq: 1, title: "前" });
    const rows = await insertRawTasks(db, 1500, 2);
    const token = await tokenOf(OWNER_USER_ID);

    const first = await page(token, "kind=tasks");
    expect(at(first.rows, 0).id).toBe(early.id);
    // seq は今までのどれよりも後になる
    await db
      .update(tasks)
      .set({ title: "後", seq: 10_000 })
      .where(and(eq(tasks.userId, OWNER_USER_ID), eq(tasks.id, early.id)));
    const second = await page(token, `kind=tasks&after=${first.next}`);

    expect(second.next).toBeNull();
    const ids = [...first.rows, ...second.rows].map((task) => task.id);
    expect(ids).toEqual([early.id, ...rows.map((row) => row.id).sort()]);
  });

  it("1 ページは、UTF-8 のバイト数の累計が上限に収まるところまで、id の順。D1 への問い合わせはページごとに 1 回", async () => {
    const rows = [];
    for (let i = 0; i < 30; i += 1) {
      rows.push(await insertRawTask(db, { id: idOf(i), seq: i + 1, memo: "あ".repeat(3_000) }));
    }
    let queries = 0;
    const counting = getDb(
      new Proxy(env.DB, {
        get(target, key) {
          if (key !== "prepare") return Reflect.get(target, key).bind(target);
          return (query: string) => {
            queries += 1;
            return target.prepare(query);
          };
        },
      }),
    );
    // メモは 1 行 9000 バイト（3000 文字）なので、35000 バイトなら 1 ページは 3 行
    const budget = 35_000;
    const read = [];
    let after: string | undefined;
    for (;;) {
      const next = await readExportPage(counting, OWNER_USER_ID, "tasks", after, budget);
      read.push(next.rows as Task[]);
      if (next.next === null) break;
      after = next.next;
    }

    expect(read.map((each) => each.length)).toEqual(Array(10).fill(3));
    for (const [i, each] of read.entries()) {
      const sizes = each.map(sizeOf);
      expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(budget);
      const following = read[i + 1]?.[0];
      if (following !== undefined) {
        expect(sizes.reduce((a, b) => a + b, sizeOf(following))).toBeGreaterThan(budget);
      }
    }
    expect(read.flat()).toEqual(rows);
    expect(queries).toBe(read.length);
  });

  it("上限より大きい 1 行は、その 1 行だけで 1 ページになる。最大のタスク（メモ 20000 文字、200 項目 × 500 文字）も、既定の上限なら前後の行と同じページに入る", async () => {
    const small = await insertRawTask(db, { id: idOf(0), seq: 1 });
    const checklist = Array.from({ length: 200 }, (_, i) => ({
      id: crypto.randomUUID(),
      title: "あ".repeat(500),
      done: i % 2 === 0,
    }));
    const big = await insertRawTask(db, {
      id: idOf(1),
      seq: 2,
      memo: "い".repeat(20_000),
      checklist,
    });
    const last = await insertRawTask(db, { id: idOf(2), seq: 3 });
    expect(sizeOf(big)).toBeGreaterThan(100_000);
    expect(sizeOf(big)).toBeLessThan(PAGE_BYTES / 5);

    const read = async (budget: number) => {
      const all = [];
      let after: string | undefined;
      for (;;) {
        const next = await readExportPage(db, OWNER_USER_ID, "tasks", after, budget);
        all.push(next.rows);
        if (next.next === null) return all;
        after = next.next;
      }
    };

    expect(await read(100_000)).toEqual([[small], [big], [last]]);
    expect(await read(PAGE_BYTES)).toEqual([[small, big, last]]);
    const [only] = await pages(await tokenOf(OWNER_USER_ID), "tasks");
    expect(exportTaskSchema.array().parse(only?.rows)).toEqual([small, big, last]);
  });
});
