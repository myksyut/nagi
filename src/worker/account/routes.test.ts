import { env } from "cloudflare:test";
import { and, count, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { exportSchema } from "../../shared/export";
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

  it("応答は exportSchema で読め、論理削除の行を含まず、自分の行だけを id の順に返す。2 文字の字下げの JSON で、ファイル名の付いた添付になる", async () => {
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

    const res = await request(token, "GET", "/api/export");

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="nagi-export-\d{4}-\d{2}-\d{2}\.json"$/,
    );
    const text = await res.text();
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
    const document = exportSchema.parse(JSON.parse(text));
    expect(document.tasks.map((task) => task.title)).toEqual(["完了済み", "一つ目\n改行 😀"]);
    expect(document.projects.map((row) => row.name)).toEqual(["空", "仕事"]);
    expect(at(document.tasks, 1).projectId).toBe(project.id);
  });

  it("行がなくても、空の配列の JSON を返す", async () => {
    const res = await request(await tokenOf(B), "GET", "/api/export");

    const text = await res.text();
    expect(text).toBe(JSON.stringify(JSON.parse(text), null, 2));
    const document = exportSchema.parse(JSON.parse(text));
    expect(document.projects).toEqual([]);
    expect(document.tasks).toEqual([]);
  });

  it("1000 行を超えても、全部を id の順に返す", async () => {
    const rows = await insertRawTasks(db, 2300, 1);
    const token = await tokenOf(OWNER_USER_ID);

    const res = await request(token, "GET", "/api/export");

    const document = exportSchema.parse(await res.json());
    expect(document.tasks.map((task) => task.id)).toEqual(rows.map((row) => row.id).sort());
  });

  it("読んでいるあいだに読み終えた行を書き換えても、その行は 1 回だけ入る", async () => {
    const early = await insertRawTask(db, { id: idOf(0), seq: 1, title: "前" });
    const rows = await insertRawTasks(db, 1500, 2);
    const token = await tokenOf(OWNER_USER_ID);

    const res = await request(token, "GET", "/api/export");
    const reader = res.body?.getReader();
    if (reader === undefined) throw new Error("本文がありません");
    const decoder = new TextDecoder();
    // 最初のページの途中まで読んだところで、先頭の行を書き換える（seq は今までのどれよりも後になる）
    let text = "";
    const first = await reader.read();
    text += decoder.decode(first.value, { stream: true });
    expect(text).toContain(early.id);
    await db
      .update(tasks)
      .set({ title: "後", seq: 10_000 })
      .where(and(eq(tasks.userId, OWNER_USER_ID), eq(tasks.id, early.id)));
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();

    const document = exportSchema.parse(JSON.parse(text));
    const ids = document.tasks.map((task) => task.id);
    expect(ids).toHaveLength(1501);
    expect(new Set(ids).size).toBe(1501);
    expect(ids).toEqual([early.id, ...rows.map((row) => row.id).sort()]);
  });
});
