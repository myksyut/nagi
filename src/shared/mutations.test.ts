import { describe, expect, it } from "vitest";
import {
  MAX_CHECKLIST_ITEM_LENGTH,
  MAX_CHECKLIST_ITEMS,
  MAX_MEMO_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  MAX_TITLE_LENGTH,
  mutationBatchSchema,
  mutationSchema,
  projectCreateSchema,
  projectUpdateSchema,
  taskCreateSchema,
} from "./mutations";
import { rankAfter } from "./rank";

const validTask = () => ({
  id: crypto.randomUUID(),
  title: "task",
  bucket: "inbox" as const,
  rank: rankAfter(null),
});

describe("既定値", () => {
  it("task.create は省略した項目に既定値が入る（memoは''、checklistは[]、他はnull）", () => {
    const result = taskCreateSchema.parse({ type: "task.create", task: validTask() });
    expect(result.task.memo).toBe("");
    expect(result.task.checklist).toEqual([]);
    expect(result.task.scheduledOn).toBeNull();
    expect(result.task.deadlineOn).toBeNull();
    expect(result.task.projectId).toBeNull();
    expect(result.task.arrivedOn).toBeNull();
  });

  it("project.create は color を省略すると null", () => {
    const result = projectCreateSchema.parse({
      type: "project.create",
      project: { id: crypto.randomUUID(), name: "p" },
    });
    expect(result.project.color).toBeNull();
  });
});

describe("startedAt・color の検証", () => {
  it("task.create は startedAt を受け付けない（strictObject なので schema）", () => {
    const result = taskCreateSchema.safeParse({
      type: "task.create",
      task: { ...validTask(), startedAt: new Date().toISOString() },
    });
    expect(result.success).toBe(false);
  });

  it("task.update の startedAt は時刻の形にそろい、null も通る", () => {
    const id = crypto.randomUUID();
    const result = mutationSchema.parse({
      type: "task.update",
      id,
      changes: { startedAt: "2026-01-01T00:00:00Z" },
    });
    if (result.type !== "task.update") throw new Error("unexpected type");
    expect(result.changes.startedAt).toBe(new Date("2026-01-01T00:00:00Z").toISOString());

    const cleared = mutationSchema.parse({ type: "task.update", id, changes: { startedAt: null } });
    if (cleared.type !== "task.update") throw new Error("unexpected type");
    expect(cleared.changes.startedAt).toBeNull();
  });

  it.each(["red", "", "Violet"])(
    "project.create・project.update ともパレットにない色 %s は通らない",
    (color) => {
      const createResult = projectCreateSchema.safeParse({
        type: "project.create",
        project: { id: crypto.randomUUID(), name: "p", color },
      });
      expect(createResult.success).toBe(false);

      const updateResult = projectUpdateSchema.safeParse({
        type: "project.update",
        id: crypto.randomUUID(),
        changes: { color },
      });
      expect(updateResult.success).toBe(false);
    },
  );

  it("project.create・project.update ともパレットの名前は通る", () => {
    const createResult = projectCreateSchema.safeParse({
      type: "project.create",
      project: { id: crypto.randomUUID(), name: "p", color: "emerald" },
    });
    expect(createResult.success).toBe(true);

    const updateResult = projectUpdateSchema.safeParse({
      type: "project.update",
      id: crypto.randomUUID(),
      changes: { color: "emerald" },
    });
    expect(updateResult.success).toBe(true);
  });
});

describe("時刻の正規化", () => {
  it("changesの時刻はtoISOString()の形にそろう", () => {
    const id = crypto.randomUUID();
    const result = mutationSchema.parse({
      type: "task.update",
      id,
      changes: { completedAt: "2026-01-01T00:00:00Z" },
    });
    if (result.type !== "task.update") throw new Error("unexpected type");
    expect(result.changes.completedAt).toBe(new Date("2026-01-01T00:00:00Z").toISOString());
  });
});

describe("strictObject", () => {
  it("知らない項目があると通らない", () => {
    const result = taskCreateSchema.safeParse({
      type: "task.create",
      task: { ...validTask(), unknownField: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("project.createも知らない項目があると通らない", () => {
    const result = projectCreateSchema.safeParse({
      type: "project.create",
      project: { id: crypto.randomUUID(), name: "p", unknownField: "x" },
    });
    expect(result.success).toBe(false);
  });

  it("まとまり自体も知らない項目があると通らない", () => {
    const result = mutationBatchSchema.safeParse({
      id: crypto.randomUUID(),
      mutations: [{ type: "task.create", task: validTask() }],
      unknownField: "x",
    });
    expect(result.success).toBe(false);
  });
});

describe("文字数と項目数の上限", () => {
  const item = (title = "a") => ({ id: crypto.randomUUID(), title, done: false });
  const createTask = (overrides: Record<string, unknown>) =>
    taskCreateSchema.safeParse({ type: "task.create", task: { ...validTask(), ...overrides } });
  const updateTask = (changes: Record<string, unknown>) =>
    mutationSchema.safeParse({ type: "task.update", id: crypto.randomUUID(), changes });
  const createProject = (name: string) =>
    projectCreateSchema.safeParse({
      type: "project.create",
      project: { id: crypto.randomUUID(), name },
    });

  it("タイトルは上限ちょうどまで。1つ超えると落ちる（作成も更新も）", () => {
    expect(createTask({ title: "a".repeat(MAX_TITLE_LENGTH) }).success).toBe(true);
    expect(createTask({ title: "a".repeat(MAX_TITLE_LENGTH + 1) }).success).toBe(false);
    expect(updateTask({ title: "a".repeat(MAX_TITLE_LENGTH) }).success).toBe(true);
    expect(updateTask({ title: "a".repeat(MAX_TITLE_LENGTH + 1) }).success).toBe(false);
  });

  it("長さは UTF-16 の単位で数える（BMP の外の文字は 2）", () => {
    expect(createTask({ title: "𠮷".repeat(MAX_TITLE_LENGTH / 2) }).success).toBe(true);
    expect(createTask({ title: "𠮷".repeat(MAX_TITLE_LENGTH / 2 + 1) }).success).toBe(false);
  });

  it("メモは上限ちょうどまで", () => {
    expect(createTask({ memo: "a".repeat(MAX_MEMO_LENGTH) }).success).toBe(true);
    expect(createTask({ memo: "a".repeat(MAX_MEMO_LENGTH + 1) }).success).toBe(false);
    expect(updateTask({ memo: "a".repeat(MAX_MEMO_LENGTH + 1) }).success).toBe(false);
  });

  it("チェックリストは項目数と項目の長さに上限がある", () => {
    const items = (count: number) => Array.from({ length: count }, () => item());
    expect(createTask({ checklist: items(MAX_CHECKLIST_ITEMS) }).success).toBe(true);
    expect(createTask({ checklist: items(MAX_CHECKLIST_ITEMS + 1) }).success).toBe(false);
    expect(updateTask({ checklist: items(MAX_CHECKLIST_ITEMS + 1) }).success).toBe(false);
    expect(createTask({ checklist: [item("a".repeat(MAX_CHECKLIST_ITEM_LENGTH))] }).success).toBe(
      true,
    );
    expect(
      createTask({ checklist: [item("a".repeat(MAX_CHECKLIST_ITEM_LENGTH + 1))] }).success,
    ).toBe(false);
  });

  it("プロジェクト名は上限ちょうどまで", () => {
    expect(createProject("a".repeat(MAX_PROJECT_NAME_LENGTH)).success).toBe(true);
    expect(createProject("a".repeat(MAX_PROJECT_NAME_LENGTH + 1)).success).toBe(false);
    expect(
      projectUpdateSchema.safeParse({
        type: "project.update",
        id: crypto.randomUUID(),
        changes: { name: "a".repeat(MAX_PROJECT_NAME_LENGTH + 1) },
      }).success,
    ).toBe(false);
  });
});
