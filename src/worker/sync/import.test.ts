import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { ImportResponse } from "../../shared/api";
import type { ExportDocument } from "../../shared/export";
import { rankAfter } from "../../shared/rank";
import { getDb } from "../db/client";
import { OWNER_USER_ID } from "../db/schema";
import {
  apiApp,
  errorBody,
  insertRawProject,
  insertRawProjects,
  insertRawTask,
  insertRawUser,
  metaSeq,
  resetSyncTables,
  setMeta,
  snapshot,
} from "../test/sync-app";
import { type ImportOutcome, importRequestSchema, importRows, MAX_IMPORT_ROWS } from "./import";
import { MAX_PROJECTS_PER_USER } from "./mutate";

const db = getDb(env.DB);
const WRITTEN_AT = "2026-10-12T00:00:00.000Z";
const LOCAL_AT = "2026-10-11T14:24:07.692Z";

beforeEach(async () => {
  await resetSyncTables(db);
});

/** `nagi export` が書き出す行（ローカルの `json` の列のまま） */
function exportedTask(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    title: "task",
    memo: "",
    bucket: "inbox",
    scheduledOn: null,
    deadlineOn: null,
    projectId: null,
    rank: rankAfter(null),
    arrivedOn: null,
    checklist: [],
    completedAt: null,
    startedAt: null,
    priority: null,
    points: null,
    createdAt: LOCAL_AT,
    updatedAt: LOCAL_AT,
    deletedAt: null,
    seq: 1,
    ...overrides,
  };
}

function exportedProject(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    name: "project",
    color: null,
    archivedAt: null,
    createdAt: LOCAL_AT,
    updatedAt: LOCAL_AT,
    deletedAt: null,
    seq: 1,
    ...overrides,
  };
}

function exportDocument(
  exported: { projects?: unknown[]; tasks?: unknown[] } = {},
  overrides: Record<string, unknown> = {},
) {
  return {
    format: "nagi-export",
    formatVersion: 1,
    exportedAt: LOCAL_AT,
    app: "nagi 0.1.0",
    projects: [],
    tasks: [],
    ...exported,
    ...overrides,
  };
}

const now = () => new Date(WRITTEN_AT);

function sendImport(body: unknown, query = "") {
  return apiApp(now).post(`/api/import${query}`, body);
}

async function importOk(body: unknown, query = ""): Promise<ImportResponse> {
  const res = await sendImport(body, query);
  expect(res.status).toBe(200);
  return (await res.json()) as ImportResponse;
}

describe("POST /api/import", () => {
  it("同じ本文を2回送ると、2回目は全部existingで、行とmeta.seqが変わらない", async () => {
    const project = exportedProject();
    const tasks = [
      exportedTask({ projectId: project.id }),
      exportedTask(),
      exportedTask({ completedAt: LOCAL_AT }),
    ];
    const body = exportDocument({ projects: [project], tasks });

    const first = await importOk(body);
    expect(first).toEqual({
      tasks: { new: 3, existing: 0 },
      projects: { new: 1, existing: 0 },
      detachedTasks: 0,
    });
    const afterFirst = await snapshot(db);
    expect(afterFirst.seq).toBe(4);

    const second = await importOk(body);
    expect(second).toEqual({
      tasks: { new: 0, existing: 3 },
      projects: { new: 0, existing: 1 },
      detachedTasks: 0,
    });
    expect(await snapshot(db)).toEqual(afterFirst);
  });

  it("途中まで入った本文の続きを送ると、残りだけが入る", async () => {
    const tasks = [exportedTask(), exportedTask(), exportedTask()];
    await importOk(exportDocument({ tasks: tasks.slice(0, 2) }));
    expect(await metaSeq(db)).toBe(2);

    const resumed = await importOk(exportDocument({ tasks }));
    expect(resumed.tasks).toEqual({ new: 1, existing: 2 });
    const rows = (await snapshot(db)).tasks;
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => row.seq)).size).toBe(3);
    expect(await metaSeq(db)).toBe(3);
  });

  it("同じ本文を同時に送っても、行は重ならず、どちらも200になる", async () => {
    const project = exportedProject();
    const body = exportDocument({
      projects: [project],
      tasks: Array.from({ length: 20 }, () => exportedTask({ projectId: project.id })),
    });
    const responses = await Promise.all([sendImport(body), sendImport(body), sendImport(body)]);
    for (const res of responses) expect(res.status).toBe(200);
    const rows = await snapshot(db);
    expect(rows.tasks).toHaveLength(20);
    expect(rows.projects).toHaveLength(1);
    expect(new Set(rows.tasks.map((row) => row.seq)).size).toBe(20);
  });

  it("項目をそのまま写す。updatedAtは取り込んだ時刻で、プロジェクトが先にseqを持つ", async () => {
    const project = exportedProject({
      color: "sky",
      archivedAt: "2026-10-10T01:00:00.000Z",
    });
    const checklist = [{ id: crypto.randomUUID(), title: "下調べ", done: true }];
    const task = exportedTask({
      title: "議事録\n全角　空白 😀",
      memo: "メモ",
      bucket: "scheduled",
      scheduledOn: "2026-10-20",
      deadlineOn: "2026-10-25",
      projectId: project.id,
      arrivedOn: "2026-10-12",
      checklist,
      completedAt: "2026-10-11T10:00:00.000Z",
      priority: "high",
      points: 5,
      createdAt: "2026-09-01T00:00:00.000Z",
    });
    await importOk(exportDocument({ projects: [project], tasks: [task] }));

    const rows = await snapshot(db);
    expect(rows.projects).toEqual([
      {
        id: project.id,
        name: "project",
        color: "sky",
        archivedAt: "2026-10-10T01:00:00.000Z",
        createdAt: LOCAL_AT,
        updatedAt: WRITTEN_AT,
        deletedAt: null,
        seq: 1,
      },
    ]);
    expect(rows.tasks).toEqual([
      {
        ...task,
        updatedAt: WRITTEN_AT,
        seq: 2,
      },
    ]);
  });

  it("ほかの利用者に同じidの行があっても、自分の行として入る", async () => {
    const other = await insertRawUser(db, 4242);
    const sharedTaskId = crypto.randomUUID();
    const sharedProjectId = crypto.randomUUID();
    await insertRawTask(db, { userId: other, id: sharedTaskId, seq: 1, title: "他人" });
    await insertRawProject(db, { userId: other, id: sharedProjectId, seq: 2, name: "他人" });
    const otherBefore = await snapshot(db, other);

    const result = await importOk(
      exportDocument({
        projects: [exportedProject({ id: sharedProjectId })],
        tasks: [exportedTask({ id: sharedTaskId, title: "自分" })],
      }),
    );
    expect(result.tasks.new).toBe(1);
    expect(result.projects.new).toBe(1);
    const mine = await snapshot(db, OWNER_USER_ID);
    expect(mine.tasks.map((row) => row.title)).toEqual(["自分"]);
    expect(await snapshot(db, other)).toEqual(otherBefore);
  });

  it("dry-runは何も書かず、入れたとしたときの数を返す", async () => {
    const project = exportedProject();
    const stored = exportedTask();
    await importOk(exportDocument({ tasks: [stored] }));
    const before = await snapshot(db);

    const body = exportDocument({
      projects: [project],
      tasks: [stored, exportedTask({ projectId: project.id }), exportedTask()],
    });
    const result = await importOk(body, "?dryRun=1");
    expect(result).toEqual({
      tasks: { new: 2, existing: 1 },
      projects: { new: 1, existing: 0 },
      detachedTasks: 0,
    });
    expect(await snapshot(db)).toEqual(before);
  });

  it("指す先のないタスクはprojectIdがnullになり、その数が応答に入る。dry-runも同じ数を返す", async () => {
    const liveProject = await insertRawProject(db, { seq: 1 });
    const deletedProject = await insertRawProject(db, {
      seq: 2,
      deletedAt: "2026-10-01T00:00:00.000Z",
    });
    await setMeta(db, "seq", "2");
    const inBody = exportedProject();
    const orphan = exportedTask({ projectId: crypto.randomUUID() });
    const toDeleted = exportedTask({ projectId: deletedProject.id });
    const toLive = exportedTask({ projectId: liveProject.id });
    const toBody = exportedTask({ projectId: inBody.id });
    const body = exportDocument({ projects: [inBody], tasks: [orphan, toDeleted, toLive, toBody] });

    const dry = await importOk(body, "?dryRun=1");
    expect(dry.detachedTasks).toBe(2);
    expect((await snapshot(db)).tasks).toEqual([]);

    const result = await importOk(body);
    expect(result.detachedTasks).toBe(2);
    const projectIdOf = Object.fromEntries(
      (await snapshot(db)).tasks.map((row) => [row.id, row.projectId]),
    );
    expect(projectIdOf).toEqual({
      [orphan.id]: null,
      [toDeleted.id]: null,
      [toLive.id]: liveProject.id,
      [toBody.id]: inBody.id,
    });
  });

  it.each([
    ["タイトルが空白", { tasks: [exportedTask(), exportedTask({ title: "  " })] }, "tasks", 1],
    [
      "予定の置き場なのに日付がない",
      { tasks: [exportedTask({ bucket: "scheduled" })] },
      "tasks",
      0,
    ],
    ["idがUUIDでない", { projects: [exportedProject({ id: "x" })] }, "projects", 0],
    ["削除済みの行", { tasks: [exportedTask({ deletedAt: LOCAL_AT })] }, "tasks", 0],
    [
      "同じidが二つ",
      (() => {
        const task = exportedTask();
        return { tasks: [task, task] };
      })(),
      "tasks",
      1,
    ],
  ])("形の誤り（%s）は400で位置を返し、何も書かない", async (_name, rows, key, index) => {
    const before = await snapshot(db);
    const res = await sendImport(exportDocument(rows));
    expect(res.status).toBe(400);
    const body = await errorBody(res);
    expect(body.reason).toBe("schema");
    expect(body.issues?.some((issue) => issue.path[0] === key && issue.path[1] === index)).toBe(
      true,
    );
    expect(await snapshot(db)).toEqual(before);
  });

  it("書き出しの形でない本文は400で、何も書かない", async () => {
    const before = await snapshot(db);
    const res = await sendImport({ tasks: [exportedTask()] });
    expect(res.status).toBe(400);
    expect(await snapshot(db)).toEqual(before);
  });

  it("1回の行数の上限を超える本文は400で、何も書かない", async () => {
    const tasks = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => exportedTask());
    const res = await sendImport(exportDocument({ tasks }));
    expect(res.status).toBe(400);
    expect((await snapshot(db)).tasks).toEqual([]);

    const atLimit = await sendImport(exportDocument({ tasks: tasks.slice(1) }));
    expect(atLimit.status).toBe(200);
    expect((await snapshot(db)).tasks).toHaveLength(MAX_IMPORT_ROWS);
  });

  it("利用者ごとの行の上限を超える取り込みは、quota_exceededの400で何も書かない", async () => {
    await insertRawProjects(db, 500, 1);
    const before = await snapshot(db);
    const res = await sendImport(
      exportDocument({ projects: [exportedProject()], tasks: [exportedTask()] }),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).reason).toBe("quota_exceeded");
    expect(await snapshot(db)).toEqual(before);
  });

  it("X-Api-Versionがなければ409", async () => {
    const res = await apiApp(now).post("/api/import", exportDocument(), {
      "X-Api-Version": undefined,
    });
    expect(res.status).toBe(409);
  });
});

/**
 * db を読む・書く直前ごとに数を振った db。`at` 番目（0 始まり）の直前で `other` を最後まで動かす。
 * 取り込みのあいだのどこで、同時の取り込みが先に終わっても、を確かめる
 */
function interleaved(at: number, other: () => Promise<unknown>) {
  let step = 0;
  let ran = false;
  const pause = async () => {
    if (step++ === at) {
      ran = true;
      await other();
    }
  };
  type Fn = (...args: unknown[]) => unknown;
  const wrap = <T extends object>(target: T): T =>
    new Proxy(target, {
      get(builder, prop) {
        const value = Reflect.get(builder, prop, builder) as unknown;
        if (typeof value !== "function") return value;
        const method = value as Fn;
        if (prop === "then" || prop === "get" || prop === "all") {
          return (...args: unknown[]) => pause().then(() => method.apply(builder, args));
        }
        return (...args: unknown[]) => {
          const result = method.apply(builder, args);
          return typeof result === "object" && result !== null ? wrap(result) : result;
        };
      },
    });
  const paused = new Proxy(db, {
    get(target, prop) {
      if (prop === "select") {
        return (...args: Parameters<typeof db.select>) => wrap(target.select(...args));
      }
      if (prop === "batch") {
        return (statements: Parameters<typeof db.batch>[0]) =>
          pause().then(() => target.batch(statements));
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as Fn).bind(target) : value;
    },
  });
  return { db: paused, ran: () => ran };
}

/** 取り込み first のあいだの、db を読む・書く直前のそれぞれで、取り込み second を先に終わらせて、check で確かめる */
async function eachInterleaving(
  setup: () => Promise<void>,
  first: ExportDocument,
  second: ExportDocument,
  check: (first: ImportOutcome, second: ImportOutcome) => Promise<void>,
) {
  for (let at = 0; ; at++) {
    await resetSyncTables(db);
    await setup();
    let secondOutcome: ImportOutcome | undefined;
    const run = interleaved(at, async () => {
      secondOutcome = await importRows(db, OWNER_USER_ID, second, now(), false);
    });
    const firstOutcome = await importRows(run.db, OWNER_USER_ID, first, now(), false);
    if (!run.ran() || secondOutcome === undefined) {
      expect(at).toBeGreaterThan(2);
      return;
    }
    await check(firstOutcome, secondOutcome);
  }
}

function parsedDocument(exported: { projects?: unknown[]; tasks?: unknown[] }): ExportDocument {
  return importRequestSchema.parse(exportDocument(exported));
}

describe("importRows を同時に動かす", () => {
  it("同じ行を同時に取り込むと、一方だけが入れ、どちらも成功し、数とmeta.seqは入った行のとおり", async () => {
    const project = exportedProject();
    const document = parsedDocument({
      projects: [project],
      tasks: [exportedTask({ projectId: project.id }), exportedTask(), exportedTask()],
    });
    await eachInterleaving(
      async () => {},
      document,
      document,
      async (first, second) => {
        if (!first.ok || !second.ok) throw new Error("取り込みが断られました");
        expect(first.response.tasks.new + second.response.tasks.new).toBe(3);
        expect(first.response.projects.new + second.response.projects.new).toBe(1);
        for (const { response } of [first, second]) {
          expect(response.tasks.new + response.tasks.existing).toBe(3);
          expect(response.projects.new + response.projects.existing).toBe(1);
        }
        const rows = await snapshot(db);
        expect(rows.seq).toBe(4);
        expect([...rows.projects, ...rows.tasks].map((row) => row.seq).sort()).toEqual([
          1, 2, 3, 4,
        ]);
      },
    );
  });

  it("上限まで1件のとき、同じ新しいプロジェクトを同時に取り込んでも、どちらも断られない", async () => {
    const document = parsedDocument({ projects: [exportedProject()] });
    await eachInterleaving(
      async () => {
        await insertRawProjects(db, MAX_PROJECTS_PER_USER - 1, 1);
        await setMeta(db, "seq", String(MAX_PROJECTS_PER_USER - 1));
      },
      document,
      document,
      async (first, second) => {
        if (!first.ok || !second.ok) throw new Error("取り込みが断られました");
        expect(first.response.projects.new + second.response.projects.new).toBe(1);
        const rows = await snapshot(db);
        expect(rows.projects).toHaveLength(MAX_PROJECTS_PER_USER);
        expect(rows.seq).toBe(MAX_PROJECTS_PER_USER);
      },
    );
  });

  it("上限まで1件のとき、別のプロジェクトを同時に取り込むと、あとの方はquota_exceededになる", async () => {
    await eachInterleaving(
      async () => {
        await insertRawProjects(db, MAX_PROJECTS_PER_USER - 1, 1);
        await setMeta(db, "seq", String(MAX_PROJECTS_PER_USER - 1));
      },
      parsedDocument({ projects: [exportedProject()] }),
      parsedDocument({ projects: [exportedProject()] }),
      async (first, second) => {
        expect(second.ok).toBe(true);
        expect(first).toEqual({ ok: false, reason: "quota_exceeded" });
        const rows = await snapshot(db);
        expect(rows.projects).toHaveLength(MAX_PROJECTS_PER_USER);
        expect(rows.seq).toBe(MAX_PROJECTS_PER_USER);
      },
    );
  });
});
