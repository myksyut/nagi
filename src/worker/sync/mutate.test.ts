import { env } from "cloudflare:test";
import { API_VERSION, API_VERSION_HEADER } from "@shared/api";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../db/client";
import { appliedMutations, meta, projects, tasks } from "../db/schema";
import { createApp } from "../index";
import {
  apiApp,
  asProjectRow,
  asTaskRow,
  at,
  errorBody,
  mutateBody,
  mutationBatch,
  projectInput,
  resetSyncTables,
  syncBody,
  taskInput,
} from "../test/sync-app";

const db = getDb(env.DB);

beforeEach(async () => {
  await resetSyncTables(db);
});

async function metaSeq(): Promise<number> {
  const row = await db.select().from(meta).where(eq(meta.key, "seq")).get();
  return Number(row?.value);
}

/** 書き込みが起きていないことを確かめるための、meta.seq・各表・applied_mutations のまとめ */
async function snapshot() {
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const [seq, taskRows, projectRows, appliedRows] = await Promise.all([
    metaSeq(),
    db.select().from(tasks),
    db.select().from(projects),
    db.select().from(appliedMutations),
  ]);
  return { seq, tasks: byId(taskRows), projects: byId(projectRows), applied: byId(appliedRows) };
}

describe("seq と書き込み", () => {
  it("1つのまとまりでN行書くと、操作の順に連続したseqになる。meta.seqは最大のseqと同じ", async () => {
    const { post } = apiApp();
    const inputs = [taskInput(), taskInput(), taskInput()];
    const res = await post(
      "/api/mutate",
      mutationBatch(inputs.map((task) => ({ type: "task.create", task }))),
    );
    expect(res.status).toBe(200);
    const body = await mutateBody(res);
    expect(body.rows.map((r) => r.row.seq)).toEqual([1, 2, 3]);
    expect(await metaSeq()).toBe(3);
  });

  it("★ 2つ以上のmutateをPromise.allで同時に投げても、すべて200で、tasksとprojectsを合わせたseqが重ならない。meta.seqは書いた行数と同じ", async () => {
    const { post } = apiApp();
    const batches = Array.from({ length: 6 }, () =>
      mutationBatch([{ type: "task.create", task: taskInput() }]),
    );
    const responses = await Promise.all(batches.map((batch) => post("/api/mutate", batch)));
    for (const res of responses) expect(res.status).toBe(200);
    const bodies = await Promise.all(responses.map((res) => mutateBody(res)));
    const seqs = bodies.flatMap((body) => body.rows.map((r) => r.row.seq));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(await metaSeq()).toBe(batches.length);
  });

  it("同じまとまりで作成のあとに更新すると、1行・1つのseqにまとまり、最後の内容になる", async () => {
    const { post } = apiApp();
    const id = crypto.randomUUID();
    const res = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.create", task: taskInput({ id, title: "first" }) },
        { type: "task.update", id, changes: { title: "second" } },
      ]),
    );
    expect(res.status).toBe(200);
    const body = await mutateBody(res);
    expect(body.rows).toHaveLength(1);
    const row = asTaskRow(at(body.rows, 0));
    expect(row.title).toBe("second");
    expect(row.seq).toBe(1);
    expect(await metaSeq()).toBe(1);
  });

  it("別々のまとまりでタイトルと置き場を変えても、両方が残る（変える列だけを書くため）", async () => {
    const { post } = apiApp();
    const id = crypto.randomUUID();
    await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.create", task: taskInput({ id, title: "orig", bucket: "inbox" }) },
      ]),
    );
    await post(
      "/api/mutate",
      mutationBatch([{ type: "task.update", id, changes: { title: "new title" } }]),
    );
    const res = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.update", id, changes: { bucket: "later" } }]),
    );
    const body = await mutateBody(res);
    const row = asTaskRow(at(body.rows, 0));
    expect(row.title).toBe("new title");
    expect(row.bucket).toBe("later");
  });

  it("応答の形：kindがあり、seqの順に並ぶ。checklistは配列。createdAt/updatedAtは差し替えた時刻になる", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const { post } = apiApp(() => now);
    const projectId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const res = await post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project: projectInput({ id: projectId }) },
        { type: "task.create", task: taskInput({ id: taskId }) },
      ]),
    );
    expect(res.status).toBe(200);
    const body = await mutateBody(res);
    expect(body.rows.map((r) => r.kind)).toEqual(["project", "task"]);
    const projectRow = asProjectRow(at(body.rows, 0));
    const taskRow = asTaskRow(at(body.rows, 1));
    expect(projectRow.seq).toBeLessThan(taskRow.seq);
    expect(Array.isArray(taskRow.checklist)).toBe(true);
    expect(taskRow.checklist).toEqual([]);
    expect(taskRow.createdAt).toBe(now.toISOString());
    expect(taskRow.updatedAt).toBe(now.toISOString());
    expect(projectRow.createdAt).toBe(now.toISOString());
  });

  it("completedAtとdeletedAtは送った値をtoISOString()の形にそろえたものになる", async () => {
    const now = new Date("2026-01-02T03:04:05.000Z");
    const { post } = apiApp(() => now);
    const taskId = crypto.randomUUID();
    await post(
      "/api/mutate",
      mutationBatch([{ type: "task.create", task: taskInput({ id: taskId }) }]),
    );
    const completedAt = "2026-01-01T00:00:00Z";
    const deletedAt = "2026-01-01T05:00:00Z";
    const res = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.update", id: taskId, changes: { completedAt, deletedAt } }]),
    );
    expect(res.status).toBe(200);
    const body = await mutateBody(res);
    const row = asTaskRow(at(body.rows, 0));
    expect(row.completedAt).toBe(new Date(completedAt).toISOString());
    expect(row.deletedAt).toBe(new Date(deletedAt).toISOString());
    expect(row.updatedAt).toBe(now.toISOString());
  });
});

describe("再送", () => {
  it("★ 同じIDのまとまりを再送すると、200で行の今の内容を返し、二重には書かない", async () => {
    const { post } = apiApp();
    const batchId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    const batch = mutationBatch(
      [{ type: "task.create", task: taskInput({ id: taskId, title: "first" }) }],
      batchId,
    );

    const first = await post("/api/mutate", batch);
    expect(first.status).toBe(200);
    const seqAfterFirst = await metaSeq();

    // 最初の書き込みのあとに別のまとまりで行を変える
    await post(
      "/api/mutate",
      mutationBatch([{ type: "task.update", id: taskId, changes: { title: "second" } }]),
    );
    const seqAfterSecond = await metaSeq();
    expect(seqAfterSecond).toBe(seqAfterFirst + 1);

    // 最初のまとまりを再送
    const resend = await post("/api/mutate", batch);
    expect(resend.status).toBe(200);
    const body = await mutateBody(resend);
    expect(asTaskRow(at(body.rows, 0)).title).toBe("second");
    expect(await metaSeq()).toBe(seqAfterSecond);

    const appliedRows = await db
      .select()
      .from(appliedMutations)
      .where(eq(appliedMutations.id, batchId));
    expect(appliedRows).toHaveLength(1);
    const taskRows = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(taskRows).toHaveLength(1);
  });

  it("同じまとまりをPromise.allで2つ同時に送っても、どちらも200で、書き込みは1回だけ", async () => {
    const { post } = apiApp();
    const batch = mutationBatch([{ type: "task.create", task: taskInput() }]);
    const [r1, r2] = await Promise.all([post("/api/mutate", batch), post("/api/mutate", batch)]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await metaSeq()).toBe(1);
    const appliedRows = await db
      .select()
      .from(appliedMutations)
      .where(eq(appliedMutations.id, batch.id));
    expect(appliedRows).toHaveLength(1);
  });
});

describe("検証（何も書かれないことまで確かめる）", () => {
  const invalidCases: Record<string, () => unknown> = {
    schema_blank_title: () =>
      mutationBatch([{ type: "task.create", task: taskInput({ title: "   " }) }]),
    schema_unknown_field: () =>
      mutationBatch([{ type: "task.create", task: { ...taskInput(), extra: "x" } }]),
    schema_bad_date_shape: () =>
      mutationBatch([
        {
          type: "task.create",
          task: taskInput({ bucket: "scheduled", scheduledOn: "2026/01/01" }),
        },
      ]),
    schema_bad_rank: () =>
      mutationBatch([{ type: "task.create", task: taskInput({ rank: "!!" }) }]),
    schema_uppercase_id: () =>
      mutationBatch([
        { type: "task.create", task: taskInput({ id: crypto.randomUUID().toUpperCase() }) },
      ]),
    schema_empty_changes: () =>
      mutationBatch([{ type: "task.update", id: crypto.randomUUID(), changes: {} }]),
    schema_too_many_mutations: () =>
      mutationBatch(
        Array.from({ length: 501 }, () => ({ type: "task.create", task: taskInput() })),
      ),
  };

  it.each(Object.entries(invalidCases))(
    "★ %s は 400（reason: schema）で何も書かれない",
    async (_name, build) => {
      const { post } = apiApp();
      const before = await snapshot();
      const res = await post("/api/mutate", build());
      expect(res.status).toBe(400);
      const body = await errorBody(res);
      expect(body.error).toBe("invalid_request");
      expect(body.reason).toBe("schema");
      expect(await snapshot()).toEqual(before);
    },
  );

  it("★ invalid_json は 400 で何も書かれない", async () => {
    const { app } = apiApp();
    const before = await snapshot();
    const res = await app.request(
      "http://localhost/api/mutate",
      {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "application/json",
          [API_VERSION_HEADER]: String(API_VERSION),
        },
        body: "not json",
      },
      { ...env, AUTH_DISABLED: "true" },
    );
    expect(res.status).toBe(400);
    const body = await errorBody(res);
    expect(body.reason).toBe("invalid_json");
    expect(await snapshot()).toEqual(before);
  });

  it("★ task_exists は 400 で何も書かれない", async () => {
    const { post } = apiApp();
    const id = crypto.randomUUID();
    await post("/api/mutate", mutationBatch([{ type: "task.create", task: taskInput({ id }) }]));
    const before = await snapshot();
    const res = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.create", task: taskInput({ id }) }]),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).reason).toBe("task_exists");
    expect(await snapshot()).toEqual(before);
  });

  it("task_not_found は 400 で何も書かれない", async () => {
    const { post } = apiApp();
    const before = await snapshot();
    const res = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.update", id: crypto.randomUUID(), changes: { title: "x" } }]),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).reason).toBe("task_not_found");
    expect(await snapshot()).toEqual(before);
  });

  it("project_exists は 400 で何も書かれない", async () => {
    const { post } = apiApp();
    const id = crypto.randomUUID();
    await post(
      "/api/mutate",
      mutationBatch([{ type: "project.create", project: projectInput({ id }) }]),
    );
    const before = await snapshot();
    const res = await post(
      "/api/mutate",
      mutationBatch([{ type: "project.create", project: projectInput({ id }) }]),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).reason).toBe("project_exists");
    expect(await snapshot()).toEqual(before);
  });

  it("project_not_found は 400 で何も書かれない", async () => {
    const { post } = apiApp();
    const before = await snapshot();
    const res = await post(
      "/api/mutate",
      mutationBatch([{ type: "project.update", id: crypto.randomUUID(), changes: { name: "x" } }]),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).reason).toBe("project_not_found");
    expect(await snapshot()).toEqual(before);
  });

  it("★ アーカイブ済みのプロジェクトは、作成でも更新でも付けられない（project_archived）。削除済みならproject_deleted。同じまとまりで作ったプロジェクトなら付けられる", async () => {
    const { post } = apiApp();
    const archivedProjectId = crypto.randomUUID();
    const deletedProjectId = crypto.randomUUID();
    await post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project: projectInput({ id: archivedProjectId }) },
        { type: "project.create", project: projectInput({ id: deletedProjectId }) },
      ]),
    );
    await post(
      "/api/mutate",
      mutationBatch([
        {
          type: "project.update",
          id: archivedProjectId,
          changes: { archivedAt: new Date().toISOString() },
        },
      ]),
    );
    await post(
      "/api/mutate",
      mutationBatch([
        {
          type: "project.update",
          id: deletedProjectId,
          changes: { deletedAt: new Date().toISOString() },
        },
      ]),
    );

    // 作成でアーカイブ済みプロジェクトを付ける
    const before1 = await snapshot();
    const createRes = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.create", task: taskInput({ projectId: archivedProjectId }) }]),
    );
    expect(createRes.status).toBe(400);
    expect((await errorBody(createRes)).reason).toBe("project_archived");
    expect(await snapshot()).toEqual(before1);

    // 更新でアーカイブ済みプロジェクトを付ける
    const existingTaskId = crypto.randomUUID();
    await post(
      "/api/mutate",
      mutationBatch([{ type: "task.create", task: taskInput({ id: existingTaskId }) }]),
    );
    const before2 = await snapshot();
    const updateRes = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.update", id: existingTaskId, changes: { projectId: archivedProjectId } },
      ]),
    );
    expect(updateRes.status).toBe(400);
    expect((await errorBody(updateRes)).reason).toBe("project_archived");
    expect(await snapshot()).toEqual(before2);

    // 削除済みプロジェクト
    const before3 = await snapshot();
    const deletedRes = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.create", task: taskInput({ projectId: deletedProjectId }) }]),
    );
    expect(deletedRes.status).toBe(400);
    expect((await errorBody(deletedRes)).reason).toBe("project_deleted");
    expect(await snapshot()).toEqual(before3);

    // 同じまとまりで作ったプロジェクトなら付けられる
    const newProjectId = crypto.randomUUID();
    const okRes = await post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project: projectInput({ id: newProjectId }) },
        { type: "task.create", task: taskInput({ projectId: newProjectId }) },
      ]),
    );
    expect(okRes.status).toBe(200);
  });

  it("未完了のタスクがあるとアーカイブできない。同じまとまりで最後のタスクを完了にしてからアーカイブするのは通る。同じまとまりで作ったタスクも数に入る", async () => {
    const { post } = apiApp();
    const projectId = crypto.randomUUID();
    const taskId = crypto.randomUUID();
    await post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project: projectInput({ id: projectId }) },
        { type: "task.create", task: taskInput({ id: taskId, projectId }) },
      ]),
    );

    const before = await snapshot();
    const failRes = await post(
      "/api/mutate",
      mutationBatch([
        {
          type: "project.update",
          id: projectId,
          changes: { archivedAt: new Date().toISOString() },
        },
      ]),
    );
    expect(failRes.status).toBe(400);
    expect((await errorBody(failRes)).reason).toBe("project_has_open_tasks");
    expect(await snapshot()).toEqual(before);

    const okRes = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.update", id: taskId, changes: { completedAt: new Date().toISOString() } },
        {
          type: "project.update",
          id: projectId,
          changes: { archivedAt: new Date().toISOString() },
        },
      ]),
    );
    expect(okRes.status).toBe(200);

    // 同じまとまりで作ったタスクも数に入る
    const projectId2 = crypto.randomUUID();
    const before2 = await snapshot();
    const failRes2 = await post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project: projectInput({ id: projectId2 }) },
        { type: "task.create", task: taskInput({ projectId: projectId2 }) },
        {
          type: "project.update",
          id: projectId2,
          changes: { archivedAt: new Date().toISOString() },
        },
      ]),
    );
    expect(failRes2.status).toBe(400);
    expect((await errorBody(failRes2)).reason).toBe("project_has_open_tasks");
    expect(await snapshot()).toEqual(before2);
  });

  it("bucketとscheduledOnが合わない（作成でも更新でも）→ schedule_mismatch", async () => {
    const { post } = apiApp();
    const before = await snapshot();
    const createRes = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.create", task: taskInput({ bucket: "scheduled", scheduledOn: null }) },
      ]),
    );
    expect(createRes.status).toBe(400);
    expect((await errorBody(createRes)).reason).toBe("schedule_mismatch");
    expect(await snapshot()).toEqual(before);

    const taskId = crypto.randomUUID();
    await post(
      "/api/mutate",
      mutationBatch([{ type: "task.create", task: taskInput({ id: taskId, bucket: "inbox" }) }]),
    );
    const before2 = await snapshot();
    const updateRes = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.update", id: taskId, changes: { scheduledOn: "2026-01-01" } }]),
    );
    expect(updateRes.status).toBe(400);
    expect((await errorBody(updateRes)).reason).toBe("schedule_mismatch");
    expect(await snapshot()).toEqual(before2);
  });

  it("★ まとまりの前半が正しく、後半が誤っているときも、何も書かれない（構造の誤り）", async () => {
    const { post } = apiApp();
    const before = await snapshot();
    const res = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.create", task: taskInput() },
        { type: "task.create", task: taskInput({ title: "" }) },
      ]),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).reason).toBe("schema");
    expect(await snapshot()).toEqual(before);
  });

  it("★ まとまりの前半が正しく、後半が誤っているときも、何も書かれない（中身の検証）", async () => {
    const { post } = apiApp();
    const before = await snapshot();
    const res = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.create", task: taskInput() },
        { type: "task.update", id: crypto.randomUUID(), changes: { title: "x" } },
      ]),
    );
    expect(res.status).toBe(400);
    const body = await errorBody(res);
    expect(body.reason).toBe("task_not_found");
    expect(body.mutationIndex).toBe(1);
    expect(await snapshot()).toEqual(before);
  });
});

describe("チェックリストのぶつかり（baseChecklist）", () => {
  const item = (title: string, done = false, id: string = crypto.randomUUID()) => ({
    id,
    title,
    done,
  });

  async function createWithChecklist(checklist: ReturnType<typeof item>[]) {
    const { post } = apiApp();
    const id = crypto.randomUUID();
    const res = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.create", task: taskInput({ id, checklist }) }]),
    );
    expect(res.status).toBe(200);
    return { post, id };
  }

  it("★ 今の配列が添えた配列と同じなら通る。違えば 400 checklist_conflict で何も書かれない", async () => {
    const a = item("A");
    const b = item("B");
    const { post, id } = await createWithChecklist([a, b]);

    // 別の画面が先に A をチェックした
    const first = await post(
      "/api/mutate",
      mutationBatch([
        {
          type: "task.update",
          id,
          changes: { checklist: [{ ...a, done: true }, b] },
          baseChecklist: [a, b],
        },
      ]),
    );
    expect(first.status).toBe(200);

    // こちらの画面は古い配列のまま B をチェックしようとする → 断る
    const before = await snapshot();
    const second = await post(
      "/api/mutate",
      mutationBatch([
        {
          type: "task.update",
          id,
          changes: { checklist: [a, { ...b, done: true }] },
          baseChecklist: [a, b],
        },
      ]),
    );
    expect(second.status).toBe(400);
    const body = await errorBody(second);
    expect(body.reason).toBe("checklist_conflict");
    expect(body.mutationIndex).toBe(0);
    expect(await snapshot()).toEqual(before);
    const row = await db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(row?.checklist).toEqual([{ ...a, done: true }, b]);
  });

  it("同じまとまりの中の前の操作で変わった配列を添えれば通る（続けて操作したとき）", async () => {
    const a = item("A");
    const { post, id } = await createWithChecklist([a]);
    const res = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.update", id, changes: { checklist: [a, item("B")] }, baseChecklist: [a] },
        { type: "task.update", id, changes: { title: "改名" } },
      ]),
    );
    expect(res.status).toBe(200);
  });

  it("baseChecklist を添えない更新は、これまでどおり配列をそのまま置き換える", async () => {
    const a = item("A");
    const { post, id } = await createWithChecklist([a]);
    const res = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.update", id, changes: { checklist: [] } }]),
    );
    expect(res.status).toBe(200);
    const row = await db.select().from(tasks).where(eq(tasks.id, id)).get();
    expect(row?.checklist).toEqual([]);
  });
});

describe("進行中（startedAt）の検証", () => {
  it("★ task.create は startedAt を受け付けない（schema）", async () => {
    const { post } = apiApp();
    const before = await snapshot();
    const res = await post(
      "/api/mutate",
      mutationBatch([
        {
          type: "task.create",
          task: { ...taskInput(), startedAt: new Date().toISOString() },
        },
      ]),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).reason).toBe("schema");
    expect(await snapshot()).toEqual(before);
  });

  it("★ 今日以外の bucket に startedAt を入れる更新は started_outside_today で何も書かれない。今日に移すのと同時に入れるのは通る", async () => {
    const { post } = apiApp();
    const inboxId = crypto.randomUUID();
    await post(
      "/api/mutate",
      mutationBatch([{ type: "task.create", task: taskInput({ id: inboxId, bucket: "inbox" }) }]),
    );

    const before = await snapshot();
    const failRes = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.update", id: inboxId, changes: { startedAt: new Date().toISOString() } },
      ]),
    );
    expect(failRes.status).toBe(400);
    expect((await errorBody(failRes)).reason).toBe("started_outside_today");
    expect(await snapshot()).toEqual(before);

    const startedAt = new Date().toISOString();
    const okRes = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.update", id: inboxId, changes: { bucket: "today", startedAt } },
      ]),
    );
    expect(okRes.status).toBe(200);
    const row = asTaskRow(at((await mutateBody(okRes)).rows, 0));
    expect(row.bucket).toBe("today");
    expect(row.startedAt).toBe(startedAt);
  });

  it("★ 進行中のまま bucket を今日の外へ変える更新は started_outside_today で何も書かれない。startedAt: null を同じ changes に入れれば通る", async () => {
    const { post } = apiApp();
    const taskId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.create", task: taskInput({ id: taskId, bucket: "today" }) },
        { type: "task.update", id: taskId, changes: { startedAt } },
      ]),
    );

    const before = await snapshot();
    const failRes = await post(
      "/api/mutate",
      mutationBatch([{ type: "task.update", id: taskId, changes: { bucket: "later" } }]),
    );
    expect(failRes.status).toBe(400);
    expect((await errorBody(failRes)).reason).toBe("started_outside_today");
    expect(await snapshot()).toEqual(before);

    const okRes = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.update", id: taskId, changes: { bucket: "later", startedAt: null } },
      ]),
    );
    expect(okRes.status).toBe(200);
    const row = asTaskRow(at((await mutateBody(okRes)).rows, 0));
    expect(row.bucket).toBe("later");
    expect(row.startedAt).toBeNull();
  });

  it("同じまとまりで今日以外に作ってから進行中にすると started_outside_today で何も書かれない", async () => {
    const { post } = apiApp();
    const before = await snapshot();
    const taskId = crypto.randomUUID();
    const res = await post(
      "/api/mutate",
      mutationBatch([
        { type: "task.create", task: taskInput({ id: taskId, bucket: "later" }) },
        {
          type: "task.update",
          id: taskId,
          changes: { startedAt: new Date().toISOString() },
        },
      ]),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).reason).toBe("started_outside_today");
    expect(await snapshot()).toEqual(before);
  });
});

describe("プロジェクトの色（color）の検証", () => {
  it("★ project.create で省略すると null、パレットの名前なら入る", async () => {
    const { post } = apiApp();
    const withoutColor = crypto.randomUUID();
    const withColor = crypto.randomUUID();
    const res = await post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project: projectInput({ id: withoutColor }) },
        { type: "project.create", project: projectInput({ id: withColor, color: "sky" }) },
      ]),
    );
    expect(res.status).toBe(200);
    const body = await mutateBody(res);
    expect(asProjectRow(at(body.rows, 0)).color).toBeNull();
    expect(asProjectRow(at(body.rows, 1)).color).toBe("sky");
  });

  it("★ project.update で色を変えられる。null にすると戻る", async () => {
    const { post } = apiApp();
    const id = crypto.randomUUID();
    await post(
      "/api/mutate",
      mutationBatch([{ type: "project.create", project: projectInput({ id, color: "violet" }) }]),
    );

    const changeRes = await post(
      "/api/mutate",
      mutationBatch([{ type: "project.update", id, changes: { color: "amber" } }]),
    );
    expect(changeRes.status).toBe(200);
    expect(asProjectRow(at((await mutateBody(changeRes)).rows, 0)).color).toBe("amber");

    const clearRes = await post(
      "/api/mutate",
      mutationBatch([{ type: "project.update", id, changes: { color: null } }]),
    );
    expect(clearRes.status).toBe(200);
    expect(asProjectRow(at((await mutateBody(clearRes)).rows, 0)).color).toBeNull();
  });

  it.each(["red", "", "Violet"])(
    "★ パレットにない色 %s は 400（schema）で何も書かれない（作成でも更新でも）",
    async (color) => {
      const { post } = apiApp();
      const before = await snapshot();
      const createRes = await post(
        "/api/mutate",
        mutationBatch([{ type: "project.create", project: projectInput({ color }) }]),
      );
      expect(createRes.status).toBe(400);
      expect((await errorBody(createRes)).reason).toBe("schema");
      expect(await snapshot()).toEqual(before);

      const id = crypto.randomUUID();
      await post(
        "/api/mutate",
        mutationBatch([{ type: "project.create", project: projectInput({ id }) }]),
      );
      const before2 = await snapshot();
      const updateRes = await post(
        "/api/mutate",
        mutationBatch([{ type: "project.update", id, changes: { color } }]),
      );
      expect(updateRes.status).toBe(400);
      expect((await errorBody(updateRes)).reason).toBe("schema");
      expect(await snapshot()).toEqual(before2);
    },
  );
});

describe("/api/sync と /api/mutate の応答に startedAt・color が届く", () => {
  it("★ 進行中のタスクと色のあるプロジェクトを作ると、/api/mutate と /api/sync のどちらの応答にも startedAt・color が入る", async () => {
    const { post } = apiApp();
    const taskId = crypto.randomUUID();
    const projectId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const mutateRes = await post(
      "/api/mutate",
      mutationBatch([
        { type: "project.create", project: projectInput({ id: projectId, color: "teal" }) },
        { type: "task.create", task: taskInput({ id: taskId, bucket: "today" }) },
        { type: "task.update", id: taskId, changes: { startedAt } },
      ]),
    );
    expect(mutateRes.status).toBe(200);
    const mutateRows = (await mutateBody(mutateRes)).rows;
    expect(asProjectRow(at(mutateRows, 0)).color).toBe("teal");
    expect(asTaskRow(at(mutateRows, 1)).startedAt).toBe(startedAt);

    const syncRes = await post("/api/sync", { cursor: 0, baseCursor: 0 });
    const syncRows = (await syncBody(syncRes)).rows;
    const projectRow = syncRows.find((r) => r.kind === "project" && r.row.id === projectId);
    const taskRow = syncRows.find((r) => r.kind === "task" && r.row.id === taskId);
    expect(projectRow?.kind === "project" && projectRow.row.color).toBe("teal");
    expect(taskRow?.kind === "task" && taskRow.row.startedAt).toBe(startedAt);
  });
});

describe("版とログイン", () => {
  it("★ X-Api-Versionがない、または違うと、どちらのAPIも409になる。/api/session には要らない", async () => {
    const { post, app } = apiApp();

    const resMissing = await post(
      "/api/sync",
      { cursor: 0, baseCursor: 0 },
      { [API_VERSION_HEADER]: undefined },
    );
    expect(resMissing.status).toBe(409);
    expect(await resMissing.json()).toEqual({
      error: "api_version_mismatch",
      apiVersion: API_VERSION,
    });

    const resWrong = await post(
      "/api/sync",
      { cursor: 0, baseCursor: 0 },
      { [API_VERSION_HEADER]: "999" },
    );
    expect(resWrong.status).toBe(409);

    // 1 つ前の版（進行中と色を知らない画面）も 409
    const resOld = await post(
      "/api/sync",
      { cursor: 0, baseCursor: 0 },
      { [API_VERSION_HEADER]: String(API_VERSION - 1) },
    );
    expect(resOld.status).toBe(409);
    const resMutateOld = await post("/api/mutate", mutationBatch([]), {
      [API_VERSION_HEADER]: String(API_VERSION - 1),
    });
    expect(resMutateOld.status).toBe(409);

    const resMutateMissing = await post("/api/mutate", mutationBatch([]), {
      [API_VERSION_HEADER]: undefined,
    });
    expect(resMutateMissing.status).toBe(409);

    const sessionRes = await app.request(
      "http://localhost/api/session",
      { headers: { Origin: "http://localhost" } },
      { ...env, AUTH_DISABLED: "true" },
    );
    expect(sessionRes.status).toBe(200);
  });

  it.each(["/api/sync", "/api/mutate"] as const)(
    "セッションがないと401（%s、localhost以外のURL）",
    async (path) => {
      const app = createApp();
      const res = await app.request(
        `https://nagi.example.com${path}`,
        {
          method: "POST",
          headers: {
            Origin: "https://nagi.example.com",
            "Content-Type": "application/json",
            [API_VERSION_HEADER]: String(API_VERSION),
          },
          body: JSON.stringify(
            path === "/api/sync" ? { cursor: 0, baseCursor: 0 } : mutationBatch([]),
          ),
        },
        env,
      );
      expect(res.status).toBe(401);
    },
  );

  it("Originが違うと403", async () => {
    const { app } = apiApp();
    const res = await app.request(
      "http://localhost/api/sync",
      {
        method: "POST",
        headers: {
          Origin: "http://evil.example.com",
          "Content-Type": "application/json",
          [API_VERSION_HEADER]: String(API_VERSION),
        },
        body: JSON.stringify({ cursor: 0, baseCursor: 0 }),
      },
      { ...env, AUTH_DISABLED: "true" },
    );
    expect(res.status).toBe(403);
  });

  it("Content-Typeが違うと415", async () => {
    const { app } = apiApp();
    const res = await app.request(
      "http://localhost/api/sync",
      {
        method: "POST",
        headers: {
          Origin: "http://localhost",
          "Content-Type": "text/plain",
          [API_VERSION_HEADER]: String(API_VERSION),
        },
        body: JSON.stringify({ cursor: 0, baseCursor: 0 }),
      },
      { ...env, AUTH_DISABLED: "true" },
    );
    expect(res.status).toBe(415);
  });
});
