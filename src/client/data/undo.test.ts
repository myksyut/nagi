import type { ChecklistItem } from "@shared/model";
import { describe, expect, it } from "vitest";
import { makeBatch, makeProject, makeTask } from "../test/fixtures";
import { buildInverse, revertChecklist, UndoStack } from "./undo";

/** 10. 元に戻す（単体：buildInverse と UndoStack） */

function item(overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return { id: "i1", title: "項目", done: false, ...overrides };
}

describe("revertChecklist", () => {
  it("チェックの操作を戻すと、操作のあとに直した名前は残る", () => {
    const before = [item({ id: "a", title: "元の名前", done: false })];
    const after = [item({ id: "a", title: "元の名前", done: true })]; // 操作：チェックを付けた
    const current = [item({ id: "a", title: "書き直した", done: true })]; // 操作のあとに名前を直した（自動保存）
    expect(revertChecklist(before, after, current)).toEqual([
      { id: "a", title: "書き直した", done: false },
    ]);
  });

  it("操作で消した項目は戻す。操作のあとに足された項目は残す", () => {
    const before = [item({ id: "a" }), item({ id: "b", title: "消される" })];
    const after = [item({ id: "a" })]; // 操作：b を消した
    const current = [item({ id: "a" }), item({ id: "c", title: "あとで足した" })];
    expect(revertChecklist(before, after, current)).toEqual([
      item({ id: "a" }),
      item({ id: "b", title: "消される" }),
      item({ id: "c", title: "あとで足した" }),
    ]);
  });

  it("並び替えを戻すと、操作前の並びに戻る", () => {
    const before = [item({ id: "a" }), item({ id: "b" })];
    const after = [item({ id: "b" }), item({ id: "a" })]; // 操作：並べ替え
    const current = [item({ id: "b" }), item({ id: "a" })];
    expect(revertChecklist(before, after, current)).toEqual([item({ id: "a" }), item({ id: "b" })]);
  });
});

describe("buildInverse", () => {
  it("作成の逆は削除（deletedAt が入る）", () => {
    const id = "0199a000-0000-7000-8000-000000000001";
    const inverse = buildInverse(
      [{ type: "task.create", task: { id, title: "A", bucket: "inbox", rank: "a0" } }],
      {
        task: () => undefined,
        project: () => undefined,
      },
    );
    const result = inverse("2026-01-05T00:00:00.000Z");
    expect(result).toEqual([
      { type: "task.update", id, changes: { deletedAt: "2026-01-05T00:00:00.000Z" } },
    ]);
  });

  it("削除の逆は deletedAt: null", () => {
    const task = makeTask({ deletedAt: null });
    const inverse = buildInverse(
      [{ type: "task.update", id: task.id, changes: { deletedAt: "2026-01-01T00:00:00.000Z" } }],
      { task: (id) => (id === task.id ? task : undefined), project: () => undefined },
    );
    const result = inverse("2026-01-05T00:00:00.000Z");
    expect(result).toEqual([{ type: "task.update", id: task.id, changes: { deletedAt: null } }]);
  });

  it("更新の逆は変える前の値（複数項目：bucket と rank）", () => {
    const task = makeTask({ bucket: "inbox", rank: "a0" });
    const inverse = buildInverse(
      [{ type: "task.update", id: task.id, changes: { bucket: "today", rank: "z0" } }],
      { task: (id) => (id === task.id ? task : undefined), project: () => undefined },
    );
    const result = inverse("2026-01-05T00:00:00.000Z");
    expect(result).toEqual([
      { type: "task.update", id: task.id, changes: { bucket: "inbox", rank: "a0" } },
    ]);
  });

  it("予定から移したのを戻すと scheduledOn も戻る", () => {
    const task = makeTask({ bucket: "scheduled", scheduledOn: "2026-02-01", rank: "a0" });
    const inverse = buildInverse(
      [
        {
          type: "task.update",
          id: task.id,
          changes: { bucket: "today", scheduledOn: null, rank: "z0" },
        },
      ],
      { task: (id) => (id === task.id ? task : undefined), project: () => undefined },
    );
    const result = inverse("2026-01-05T00:00:00.000Z");
    expect(result).toEqual([
      {
        type: "task.update",
        id: task.id,
        changes: { bucket: "scheduled", scheduledOn: "2026-02-01", rank: "a0" },
      },
    ]);
  });

  it("まとめて完了した3件を、1回でまとめて戻せる逆向きを作る（順に3つ）", () => {
    const tasks = [makeTask(), makeTask(), makeTask()];
    const mutations = tasks.map((t) => ({
      type: "task.update" as const,
      id: t.id,
      changes: { completedAt: "2026-01-05T00:00:00.000Z" },
    }));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const inverse = buildInverse(mutations, {
      task: (id) => byId.get(id),
      project: () => undefined,
    });
    const result = inverse("2026-01-05T00:00:01.000Z");
    expect(result).toHaveLength(3);
    // 逆の順に並ぶ（最後の操作から先に戻す）が、3件とも1つのまとまりに入っている
    const reversedTasks = [...tasks].reverse();
    for (const [i, task] of reversedTasks.entries()) {
      expect(result[i]).toEqual({
        type: "task.update",
        id: task.id,
        changes: { completedAt: null },
      });
    }
  });

  it("逆の順に並べる（あとの操作から先に戻す）", () => {
    const id = "0199a000-0000-7000-8000-000000000001";
    const projectId = "0199a000-0000-7000-8000-000000000002";
    // 1. プロジェクトを作る → 2. 作ったプロジェクトをタスクに付ける、という順の操作
    const mutations = [
      { type: "project.create" as const, project: { id: projectId, name: "P" } },
      { type: "task.update" as const, id, changes: { projectId } },
    ];
    const task = makeTask({ id, projectId: null });
    const inverse = buildInverse(mutations, {
      task: (i) => (i === id ? task : undefined),
      project: () => undefined,
    });
    const result = inverse("2026-01-05T00:00:00.000Z");
    // 逆順：先にタスクの projectId を戻し、そのあとプロジェクトを削除する
    expect(result).toEqual([
      { type: "task.update", id, changes: { projectId: null } },
      { type: "project.update", id: projectId, changes: { deletedAt: "2026-01-05T00:00:00.000Z" } },
    ]);
  });

  it("プロジェクトの更新の逆", () => {
    const project = makeProject({ name: "元の名前", archivedAt: null });
    const inverse = buildInverse(
      [{ type: "project.update", id: project.id, changes: { name: "新しい名前" } }],
      { task: () => undefined, project: (id) => (id === project.id ? project : undefined) },
    );
    expect(inverse("2026-01-05T00:00:00.000Z")).toEqual([
      { type: "project.update", id: project.id, changes: { name: "元の名前" } },
    ]);
  });
});

describe("UndoStack", () => {
  it("push した順に pop できる（後入れ先出し）", () => {
    const stack = new UndoStack();
    const entryA = { operationId: "a", kind: "task.update" as const, inverse: () => [] };
    const entryB = { operationId: "b", kind: "task.update" as const, inverse: () => [] };
    stack.push(entryA);
    stack.push(entryB);
    expect(stack.canUndo).toBe(true);
    expect(stack.pop()).toBe(entryB);
    expect(stack.pop()).toBe(entryA);
    expect(stack.canUndo).toBe(false);
  });

  it("discarded：捨てられた操作は元に戻す対象から外れる", () => {
    const stack = new UndoStack();
    const entryA = { operationId: "a", kind: "task.update" as const, inverse: () => [] };
    const entryB = { operationId: "b", kind: "task.update" as const, inverse: () => [] };
    stack.push(entryA);
    stack.push(entryB);

    stack.discarded([
      makeBatch({
        operationId: "a",
        mutations: [
          { type: "task.create", task: { id: "x", title: "t", bucket: "inbox", rank: "a0" } },
        ],
      }),
    ]);

    expect(stack.pop()).toBe(entryB);
    expect(stack.canUndo).toBe(false);
  });

  it("失敗して捨てられた「元に戻す」操作は、戻そうとした元の操作を積み直す", () => {
    const stack = new UndoStack();
    const original = { operationId: "orig", kind: "task.update" as const, inverse: () => [] };
    // undo() が original を pop して送信中（operationId: "undo-op"）にした状況を再現
    stack.undoing("undo-op", original);

    stack.discarded([
      makeBatch({
        id: "batch-1",
        operationId: "undo-op",
        kind: "undo",
        mutations: [{ type: "task.update", id: "x", changes: { title: "戻す" } }],
      }),
    ]);

    // もう一度 ⌘Z で戻せるように、元の操作が積み直されている
    expect(stack.canUndo).toBe(true);
    expect(stack.pop()).toBe(original);
  });

  it("discarded(..., { restoreUndone: false })：400 などで捨てられた「元に戻す」は積み直さない", () => {
    const stack = new UndoStack();
    const original = { operationId: "orig", kind: "task.update" as const, inverse: () => [] };
    stack.undoing("undo-op", original);

    stack.discarded(
      [
        makeBatch({
          id: "batch-1",
          operationId: "undo-op",
          kind: "undo",
          mutations: [{ type: "task.update", id: "x", changes: { title: "戻す" } }],
        }),
      ],
      { restoreUndone: false },
    );

    // 同じ操作がまた失敗するだけなので、積み直さない
    expect(stack.canUndo).toBe(false);
  });

  it("confirmed：成功したら undoing の記録から外れる（積み直されない）", () => {
    const stack = new UndoStack();
    const original = { operationId: "orig", kind: "task.update" as const, inverse: () => [] };
    stack.undoing("undo-op", original);
    stack.confirmed(
      makeBatch({
        id: "b1",
        operationId: "undo-op",
        mutations: [{ type: "task.update", id: "x", changes: {} }],
      }),
    );
    // 別の何かが失敗しても、成功済みの undo-op は積み直されない
    stack.discarded([
      makeBatch({
        id: "b2",
        operationId: "other",
        mutations: [{ type: "task.update", id: "y", changes: {} }],
      }),
    ]);
    expect(stack.canUndo).toBe(false);
  });

  it("clear：すべて消える", () => {
    const stack = new UndoStack();
    stack.push({ operationId: "a", kind: "task.update", inverse: () => [] });
    stack.clear();
    expect(stack.canUndo).toBe(false);
  });
});
