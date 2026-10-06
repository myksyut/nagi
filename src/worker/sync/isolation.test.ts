import { env } from "cloudflare:test";
import { and, eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { API_VERSION, API_VERSION_HEADER } from "../../shared/api";
import { arrivalRanks } from "../../shared/rank";
import { createSession } from "../auth/session";
import { getDb } from "../db/client";
import { appliedMutations, meta, OWNER_USER_ID, projects, tasks } from "../db/schema";
import { createApp } from "../index";
import { interceptedDb } from "../test/intercept-d1";
import {
  asTaskRow,
  at,
  errorBody,
  insertRawProject,
  insertRawTask,
  insertRawUser,
  metaSeq,
  mutateBody,
  mutationBatch,
  parseBatch,
  projectInput,
  resetSyncTables,
  snapshot,
  syncBody,
  taskInput,
} from "../test/sync-app";
import { metaRow } from "./meta";
import { applyMutationBatch } from "./mutate";

/**
 * 利用者どうしの行が混ざらないことの確認。2 人の利用者（持ち主の A と、もう 1 人の B）が、それぞれのセッションの
 * トークンで /api/sync と /api/mutate を呼ぶ。相手の行は、ID を知っていても、読めず・書けず・検証にも入らない
 */
const db = getDb(env.DB);
const A = OWNER_USER_ID;
let B: string;

const TODAY = "2026-09-28";
/** 論理日付が TODAY になる時刻（Asia/Tokyo の正午） */
const NOW = new Date(`${TODAY}T12:00:00+09:00`);
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await resetSyncTables(db);
  B = await insertRawUser(db, 2002);
});

/** 利用者のセッションを作り、そのトークンで POST する */
async function clientOf(userId: string, now: () => Date = () => NOW) {
  const { token } = await createSession(db, userId, new Date());
  const app = createApp({ now });
  const post = (path: string, body: unknown) =>
    app.request(
      `https://nagi.example.com${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [API_VERSION_HEADER]: String(API_VERSION),
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      },
      // B（GitHub ユーザー 2002）を、許可した人にしておく
      { ...env, ALLOWED_GITHUB_USER_IDS: "2002" },
    );
  const sync = async () => syncBody(await post("/api/sync", { cursor: 0, baseCursor: 0 }));
  return { post, sync };
}

describe("読む：相手の行は届かない", () => {
  it("同期で届くのは自分の行だけ。通し番号（seq）は利用者ごとに 1 から振る。行に user_id は入らない", async () => {
    const a = await clientOf(A);
    const b = await clientOf(B);
    const project = projectInput({ name: "A のプロジェクト" });
    await a.post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project },
        { type: "task.create", task: taskInput({ title: "A-1", projectId: project.id }) },
        { type: "task.create", task: taskInput({ title: "A-2" }) },
      ]),
    );
    const created = await mutateBody(
      await b.post(
        "/api/mutate",
        mutationBatch([{ type: "task.create", task: taskInput({ title: "B-1" }) }]),
      ),
    );
    // B の最初の行の seq は 1（A が 3 行書いたあとでも）
    expect(created.rows.map((row) => row.row.seq)).toEqual([1]);

    const fromA = await a.sync();
    const fromB = await b.sync();

    expect(fromA.rows.map((row) => row.row.seq)).toEqual([1, 2, 3]);
    expect(fromA.nextCursor).toBe(3);
    expect(
      fromA.rows.filter((row) => row.kind === "task").map((row) => asTaskRow(row).title),
    ).toEqual(["A-1", "A-2"]);
    expect(fromB.rows.map((row) => asTaskRow(row).title)).toEqual(["B-1"]);
    expect(fromB.nextCursor).toBe(1);
    for (const row of [...fromA.rows, ...fromB.rows, ...created.rows]) {
      expect(Object.keys(row.row)).not.toContain("userId");
      expect(Object.keys(row.row)).not.toContain("user_id");
    }
    expect(await metaSeq(db, A)).toBe(3);
    expect(await metaSeq(db, B)).toBe(1);
  });

  it("相手が物理削除を進めていても、自分の同期は reset にならない（purged_through_seq は利用者ごと）", async () => {
    await db.update(meta).set({ value: "50" }).where(metaRow(A, "seq"));
    await db.update(meta).set({ value: "40" }).where(metaRow(A, "purged_through_seq"));
    const b = await clientOf(B);
    await b.post("/api/mutate", mutationBatch([{ type: "task.create", task: taskInput() }]));

    const res = await b.post("/api/sync", { cursor: 0, baseCursor: 1 });

    const body = await syncBody(res);
    expect(body.rows).toHaveLength(1);
    expect(body.nextCursor).toBe(1);
  });
});

describe("書く：相手の行は変えられない", () => {
  it("相手のタスクは更新できない（task_not_found）。相手の行も自分の行も変わらない", async () => {
    const a = await clientOf(A);
    const b = await clientOf(B);
    const task = taskInput({ title: "A のタスク" });
    await a.post("/api/mutate", mutationBatch([{ type: "task.create", task }]));
    const before = { a: await snapshot(db, A), b: await snapshot(db, B) };

    const res = await b.post(
      "/api/mutate",
      mutationBatch([{ type: "task.update", id: task.id, changes: { title: "書き換え" } }]),
    );

    expect(res.status).toBe(400);
    expect((await errorBody(res)).reason).toBe("task_not_found");
    expect(await snapshot(db, A)).toEqual(before.a);
    expect(await snapshot(db, B)).toEqual(before.b);
  });

  it("相手のプロジェクトは、タスクに付けられず、更新もできない（project_not_found）", async () => {
    const a = await clientOf(A);
    const b = await clientOf(B);
    const project = projectInput({ name: "A のプロジェクト" });
    await a.post("/api/mutate", mutationBatch([{ type: "project.create", project }]));
    const own = taskInput({ title: "B のタスク" });
    await b.post("/api/mutate", mutationBatch([{ type: "task.create", task: own }]));
    const before = { a: await snapshot(db, A), b: await snapshot(db, B) };

    const attempts = [
      [{ type: "task.create", task: taskInput({ projectId: project.id }) }],
      [{ type: "task.update", id: own.id, changes: { projectId: project.id } }],
      [{ type: "project.update", id: project.id, changes: { name: "書き換え" } }],
    ];
    for (const mutations of attempts) {
      const res = await b.post("/api/mutate", mutationBatch(mutations));
      expect(res.status).toBe(400);
      expect((await errorBody(res)).reason).toBe("project_not_found");
    }

    expect(await snapshot(db, A)).toEqual(before.a);
    expect(await snapshot(db, B)).toEqual(before.b);
  });

  it("同じ ID のタスク・プロジェクトを、2 人がそれぞれ作れる。互いに見えず、片方を変えても、もう片方は変わらない", async () => {
    const a = await clientOf(A);
    const b = await clientOf(B);
    const taskId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    await a.post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project: projectInput({ id: projectId, name: "A の" }) },
        { type: "task.create", task: taskInput({ id: taskId, title: "A の", projectId }) },
      ]),
    );
    const beforeA = await snapshot(db, A);

    const created = await b.post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project: projectInput({ id: projectId, name: "B の" }) },
        { type: "task.create", task: taskInput({ id: taskId, title: "B の", projectId }) },
      ]),
    );
    expect(created.status).toBe(200);
    const updated = await b.post(
      "/api/mutate",
      mutationBatch([
        { type: "task.update", id: taskId, changes: { title: "B の（変更）" } },
        { type: "project.update", id: projectId, changes: { name: "B の（変更）" } },
      ]),
    );
    expect(updated.status).toBe(200);
    // 返る行は、自分のものだけ
    expect((await mutateBody(updated)).rows.map((row) => row.row.seq)).toEqual([3, 4]);

    expect(await snapshot(db, A)).toEqual(beforeA);
    const names = (rows: Awaited<ReturnType<typeof a.sync>>["rows"]) =>
      rows.map((row) => (row.kind === "task" ? row.row.title : row.row.name));
    expect(names((await a.sync()).rows)).toEqual(["A の", "A の"]);
    expect(names((await b.sync()).rows)).toEqual(["B の（変更）", "B の（変更）"]);
  });

  it("まとまりの ID が同じでも、利用者ごとに 1 回ずつ反映される。再送で返るのは自分の行だけ", async () => {
    const a = await clientOf(A);
    const b = await clientOf(B);
    const batchId = crypto.randomUUID();
    // タスクもプロジェクトも、2 人が同じ ID で作る（再送で ID から読み直すときに、相手の行を拾わないこと）
    const ids = { task: crypto.randomUUID(), project: crypto.randomUUID() };
    const batchOf = (owner: string) => [
      { type: "project.create", project: projectInput({ id: ids.project, name: `${owner} の` }) },
      { type: "task.create", task: taskInput({ id: ids.task, title: `${owner} の` }) },
    ];
    const names = (rows: Awaited<ReturnType<typeof a.sync>>["rows"]) =>
      rows.map((row) => (row.kind === "task" ? row.row.title : row.row.name));

    const first = await a.post("/api/mutate", mutationBatch(batchOf("A"), batchId));
    const second = await b.post("/api/mutate", mutationBatch(batchOf("B"), batchId));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(names((await b.sync()).rows)).toEqual(["B の", "B の"]);

    // A が同じまとまりを送り直す：書き込まず、A の行だけを返す
    const resent = await mutateBody(
      await a.post("/api/mutate", mutationBatch(batchOf("A"), batchId)),
    );
    expect(names(resent.rows)).toEqual(["A の", "A の"]);
    expect(await metaSeq(db, A)).toBe(2);
    expect(await metaSeq(db, B)).toBe(2);
  });
});

describe("検証と守り：相手の行は数えない", () => {
  it("プロジェクトのアーカイブは、自分の未完了のタスクだけで決まる（同じ ID の相手のプロジェクトに未完了があっても通る）", async () => {
    const projectId = crypto.randomUUID();
    await insertRawProject(db, { userId: A, id: projectId, seq: 1 });
    await insertRawTask(db, { userId: A, projectId, seq: 2 });
    await db.update(meta).set({ value: "2" }).where(metaRow(A, "seq"));
    await insertRawProject(db, { userId: B, id: projectId, seq: 1 });
    await db.update(meta).set({ value: "1" }).where(metaRow(B, "seq"));
    const archive = [
      { type: "project.update", id: projectId, changes: { archivedAt: NOW.toISOString() } },
    ];

    const byB = await (await clientOf(B)).post("/api/mutate", mutationBatch(archive));
    const byA = await (await clientOf(A)).post("/api/mutate", mutationBatch(archive));

    expect(byB.status).toBe(200);
    expect(byA.status).toBe(400);
    expect((await errorBody(byA)).reason).toBe("project_has_open_tasks");
  });

  it("チェックリストの守りは、自分の行と比べる（同じ ID の相手のタスクのチェックリストが違っていても通る）", async () => {
    const id = crypto.randomUUID();
    const itemId = crypto.randomUUID();
    const mine = [{ id: itemId, title: "自分の項目", done: false }];
    await insertRawTask(db, {
      userId: A,
      id,
      checklist: [{ id: crypto.randomUUID(), title: "相手の項目", done: true }],
      seq: 1,
    });
    await db.update(meta).set({ value: "1" }).where(metaRow(A, "seq"));
    await insertRawTask(db, { userId: B, id, checklist: mine, seq: 1 });
    await db.update(meta).set({ value: "1" }).where(metaRow(B, "seq"));
    const beforeA = await snapshot(db, A);

    const res = await (await clientOf(B)).post(
      "/api/mutate",
      mutationBatch([
        {
          type: "task.update",
          id,
          baseChecklist: mine,
          changes: { checklist: [{ id: itemId, title: "自分の項目", done: true }] },
        },
      ]),
    );

    expect(res.status).toBe(200);
    expect(at(asTaskRow(at((await mutateBody(res)).rows, 0)).checklist, 0).done).toBe(true);
    expect(await snapshot(db, A)).toEqual(beforeA);
  });

  it("★ 更新する行が検証のあとで物理削除されたら、同じ ID の相手の行が残っていても task_not_found（相手の行を数えない・変えない）", async () => {
    const id = crypto.randomUUID();
    await insertRawTask(db, { userId: A, id, title: "A の", seq: 1 });
    await db.update(meta).set({ value: "1" }).where(metaRow(A, "seq"));
    await insertRawTask(db, { userId: B, id, title: "B の", seq: 1 });
    await db.update(meta).set({ value: "1" }).where(metaRow(B, "seq"));
    const beforeA = await snapshot(db, A);

    // B の更新の、書き込みのバッチの直前に、B の行だけを消す
    const idb = interceptedDb(env.DB, {
      beforeBatch: async () => {
        await db.delete(tasks).where(and(eq(tasks.userId, B), eq(tasks.id, id)));
      },
    });
    const outcome = await applyMutationBatch(
      idb,
      B,
      parseBatch([{ type: "task.update", id, changes: { title: "書き換え" } }]),
      NOW,
    );

    expect(outcome).toEqual({ ok: false, reason: "task_not_found", mutationIndex: 0 });
    expect(await snapshot(db, A)).toEqual(beforeA);
    expect(await metaSeq(db, B)).toBe(1);
    expect(
      await db.select().from(appliedMutations).where(eq(appliedMutations.userId, B)),
    ).toHaveLength(0);
  });
});

describe("日付の切り替え：同期した利用者の行だけ", () => {
  it("A の同期では、A の期限の来たタスクだけが今日へ移り、A の古い行だけが消える。B のぶんは、B が同期したときに進む", async () => {
    const old = new Date(NOW.getTime() - 31 * DAY_MS).toISOString();
    const oldApplied = new Date(NOW.getTime() - 8 * DAY_MS).toISOString();
    // B の seq は A より大きくしておく（A の切り替えが B の行を数えたら、A の purged_through_seq に出る）
    const seed = async (userId: string, seq: number) => {
      const due = await insertRawTask(db, {
        userId,
        bucket: "scheduled",
        scheduledOn: TODAY,
        seq: seq + 1,
      });
      const deleted = await insertRawTask(db, { userId, deletedAt: old, seq: seq + 2 });
      const project = await insertRawProject(db, { userId, deletedAt: old, seq: seq + 3 });
      await db
        .update(meta)
        .set({ value: String(seq + 3) })
        .where(metaRow(userId, "seq"));
      await db
        .insert(appliedMutations)
        .values({ userId, id: crypto.randomUUID(), appliedAt: oldApplied });
      return { due, deleted, project };
    };
    const ofA = await seed(A, 0);
    const ofB = await seed(B, 10);
    // B には、今日来たタスクがもうある（A の移る行の並び順キーは、これを見ずに決まること）
    const arrived = await insertRawTask(db, {
      userId: B,
      bucket: "today",
      arrivedOn: TODAY,
      rank: "a5",
      seq: 14,
    });
    await db.update(meta).set({ value: "14" }).where(metaRow(B, "seq"));
    const beforeB = await snapshot(db, B);

    const fromA = await (await clientOf(A)).sync();

    // A：移った行だけが届く（消した行は届かない）。古い行と applied_mutations は消えた
    expect(fromA.rows.map((row) => [row.row.id, asTaskRow(row).bucket])).toEqual([
      [ofA.due.id, "today"],
    ]);
    // A の今日には何もなかったので、並び順キーは「今日のタスクがないとき」のもの
    expect(asTaskRow(at(fromA.rows, 0)).rank).toBe(at(arrivalRanks([], TODAY, 1), 0));
    const afterA = await snapshot(db, A);
    expect(afterA.tasks.map((row) => row.id)).toEqual([ofA.due.id]);
    expect(afterA.projects).toEqual([]);
    expect(afterA.applied).toEqual([]);
    const metaOf = async (userId: string) =>
      Object.fromEntries(
        (await db.select().from(meta).where(eq(meta.userId, userId))).map((row) => [
          row.key,
          row.value,
        ]),
      );
    expect(await metaOf(A)).toEqual({
      seq: "4",
      last_rollover_on: TODAY,
      purged_through_seq: "3",
    });
    // B：何も変わっていない
    expect(await snapshot(db, B)).toEqual(beforeB);
    expect(await metaOf(B)).toEqual({ seq: "14", last_rollover_on: "", purged_through_seq: "0" });
    expect(
      await db.select({ id: projects.id }).from(projects).where(eq(projects.userId, B)),
    ).toEqual([{ id: ofB.project.id }]);

    // B が同期すると、B のぶんが進む
    const fromB = await (await clientOf(B)).sync();
    expect(fromB.rows.map((row) => [row.row.id, asTaskRow(row).bucket])).toEqual([
      [arrived.id, "today"],
      [ofB.due.id, "today"],
    ]);
    expect(await metaOf(B)).toEqual({
      seq: "15",
      last_rollover_on: TODAY,
      purged_through_seq: "13",
    });
  });
});
