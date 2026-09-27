import { describe, expect, it } from "vitest";
import {
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
