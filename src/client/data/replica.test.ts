import { autorun } from "mobx";
import { describe, expect, it } from "vitest";
import { makeBatch, makeProject, makeTask, nextId } from "../test/fixtures";
import { isNewer, Replica } from "./replica";

/**
 * 1. 重ねて見せる仕組み（Replica 単体）
 * 2. seq による上書きの判定
 */

describe("重ねて見せる仕組み", () => {
  it("送信中の操作はすぐ表示に出る", () => {
    const replica = new Replica();
    const task = makeTask({ title: "元" });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    replica.addPending([
      makeBatch({ mutations: [{ type: "task.update", id: task.id, changes: { title: "新" } }] }),
    ]);

    expect(replica.task(task.id)?.title).toBe("新");
    // 確定データはまだ変わっていない
    expect(replica.confirmedTask(task.id)?.title).toBe("元");
  });

  it("失敗（discardPending）で送信中の操作が捨てられ、表示が元に戻る", () => {
    const replica = new Replica();
    const task = makeTask({ title: "元" });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    const batch = makeBatch({
      mutations: [{ type: "task.update", id: task.id, changes: { title: "新" } }],
    });
    replica.addPending([batch]);
    expect(replica.task(task.id)?.title).toBe("新");

    const discarded = replica.discardPending((b) => b.id === batch.id);
    expect(discarded).toEqual([batch]);
    expect(replica.task(task.id)?.title).toBe("元");
  });

  it("送信中のあいだにサーバー側でほかの項目が変わっても、送信中の操作は重なったまま", () => {
    const replica = new Replica();
    const task = makeTask({ title: "元", memo: "元メモ", seq: 1 });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    replica.addPending([
      makeBatch({
        mutations: [
          {
            type: "task.update",
            id: task.id,
            changes: { completedAt: "2026-01-02T00:00:00.000Z" },
          },
        ],
      }),
    ]);
    expect(replica.task(task.id)?.completedAt).not.toBeNull();

    // 別のタブが memo を変えて、より新しい seq で届いた
    const updated = { ...task, memo: "サーバー側の変更", seq: 2 };
    const accepted = replica.mergeConfirmed([{ kind: "task", row: updated }]);
    expect(accepted).toHaveLength(1);

    // 完了（送信中）は消えず、memo（確定データ由来）は更新されている
    expect(replica.task(task.id)?.completedAt).not.toBeNull();
    expect(replica.task(task.id)?.memo).toBe("サーバー側の変更");
  });

  it("release 後（confirmBatch）に確定して pendingCount が 0 になる", () => {
    const replica = new Replica();
    const task = makeTask({ title: "元", seq: 1 });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    const batch = makeBatch({
      mutations: [{ type: "task.update", id: task.id, changes: { title: "新" } }],
    });
    replica.addPending([batch]);
    expect(replica.pending).toHaveLength(1);

    const confirmedRow = { ...task, title: "新", seq: 2 };
    const accepted = replica.confirmBatch(batch.id, [{ kind: "task", row: confirmedRow }]);
    expect(accepted).toEqual([{ kind: "task", row: confirmedRow }]);
    expect(replica.pending).toHaveLength(0);
    expect(replica.task(task.id)?.title).toBe("新");
    expect(replica.confirmedTask(task.id)?.title).toBe("新");
    // 表示用の行も、確定した seq まで進む（#rematerialize が呼ばれている証拠）
    expect(replica.task(task.id)?.seq).toBe(2);
  });

  it("確定の瞬間に表示がちらつかない（同じ行オブジェクト・表示上の値も同じ）", () => {
    const replica = new Replica();
    const task = makeTask({ title: "新", seq: 1 });
    // すでに送信中の操作として「新」を表示している状態を作る
    replica.replaceConfirmed([{ kind: "task", row: { ...task, title: "元" } }]);
    const batch = makeBatch({
      mutations: [{ type: "task.update", id: task.id, changes: { title: "新" } }],
    });
    replica.addPending([batch]);

    const before = replica.task(task.id);
    expect(before?.title).toBe("新");

    // 確定・除去は1回の更新の中で行われるので、途中で「元」に戻る瞬間はない
    const observedTitles: string[] = [];
    const dispose = autorun(() => {
      const row = replica.task(task.id);
      if (row) observedTitles.push(row.value.title);
    });

    const confirmedRow = { ...task, title: "新", seq: 2 };
    replica.confirmBatch(batch.id, [{ kind: "task", row: confirmedRow }]);

    // 同じ行オブジェクトのまま
    expect(replica.task(task.id)).toBe(before);
    // 一度も "元" に戻っていない（すべて "新" のまま）
    expect(observedTitles.every((title) => title === "新")).toBe(true);
    expect(observedTitles.length).toBeGreaterThan(0);

    dispose();
  });
});

describe("seq による上書きの判定", () => {
  it("isNewer：手元にない、または手元より seq が新しいときだけ true", () => {
    expect(isNewer(undefined, { seq: 1 })).toBe(true);
    expect(isNewer({ seq: 1 }, { seq: 2 })).toBe(true);
    expect(isNewer({ seq: 2 }, { seq: 2 })).toBe(false);
    expect(isNewer({ seq: 3 }, { seq: 2 })).toBe(false);
  });

  it("古い seq の行では確定データが巻き戻らない（タスク）", () => {
    const replica = new Replica();
    const task = makeTask({ title: "新しい版", seq: 5 });
    replica.replaceConfirmed([{ kind: "task", row: task }]);

    const stale = { ...task, title: "遅れて届いた古い版", seq: 3 };
    const accepted = replica.mergeConfirmed([{ kind: "task", row: stale }]);

    expect(accepted).toHaveLength(0);
    expect(replica.confirmedTask(task.id)?.title).toBe("新しい版");
    expect(replica.task(task.id)?.title).toBe("新しい版");
  });

  it("古い seq の行では確定データが巻き戻らない（プロジェクト）", () => {
    const replica = new Replica();
    const project = makeProject({ name: "新しい版", seq: 5 });
    replica.replaceConfirmed([{ kind: "project", row: project }]);

    const stale = { ...project, name: "古い版", seq: 3 };
    const accepted = replica.mergeConfirmed([{ kind: "project", row: stale }]);

    expect(accepted).toHaveLength(0);
    expect(replica.confirmedProject(project.id)?.name).toBe("新しい版");
  });

  it("削除済みの行はリストから外れるが、確定データには残る", () => {
    const replica = new Replica();
    const task = makeTask({ bucket: "today", seq: 1 });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    expect(replica.taskIndex.rows("today").size).toBe(1);

    const deleted = { ...task, deletedAt: "2026-01-05T00:00:00.000Z", seq: 2 };
    replica.mergeConfirmed([{ kind: "task", row: deleted }]);

    expect(replica.taskIndex.rows("today").size).toBe(0);
    expect(replica.taskIndex.rows("deleted").size).toBe(1);
    // task() と confirmedTask() には残る
    expect(replica.task(task.id)).toBeDefined();
    expect(replica.confirmedTask(task.id)?.deletedAt).not.toBeNull();
  });

  it("削除後に届いた古い版（削除前の seq）では生き返らない", () => {
    const replica = new Replica();
    const task = makeTask({ bucket: "today", seq: 1 });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    const deleted = { ...task, deletedAt: "2026-01-05T00:00:00.000Z", seq: 3 };
    replica.mergeConfirmed([{ kind: "task", row: deleted }]);

    // seq 2 は削除（seq 3）より古いので取り込まれない
    const revived = { ...task, deletedAt: null, seq: 2 };
    const accepted = replica.mergeConfirmed([{ kind: "task", row: revived }]);

    expect(accepted).toHaveLength(0);
    expect(replica.confirmedTask(task.id)?.deletedAt).not.toBeNull();
    expect(replica.taskIndex.rows("today").size).toBe(0);
    expect(replica.taskIndex.rows("deleted").size).toBe(1);
  });

  it("dropConfirmed で確定データから捨てられる", () => {
    const replica = new Replica();
    const task = makeTask({ deletedAt: "2020-01-01T00:00:00.000Z", seq: 1 });
    replica.replaceConfirmed([{ kind: "task", row: task }]);
    expect(replica.confirmedTask(task.id)).toBeDefined();

    replica.dropConfirmed([task.id], []);

    expect(replica.confirmedTask(task.id)).toBeUndefined();
    expect(replica.task(task.id)).toBeUndefined();
  });

  it("expiredDeleted：cutoff より前に削除された行だけを返す", () => {
    const replica = new Replica();
    const old = makeTask({ deletedAt: "2020-01-01T00:00:00.000Z" });
    const recent = makeTask({ deletedAt: "2026-01-01T00:00:00.000Z" });
    const alive = makeTask({ deletedAt: null });
    replica.replaceConfirmed([
      { kind: "task", row: old },
      { kind: "task", row: recent },
      { kind: "task", row: alive },
    ]);

    const { taskIds } = replica.expiredDeleted("2025-01-01T00:00:00.000Z");
    expect(taskIds).toEqual([old.id]);
  });

  it("uuid は一意である（フィクスチャの健全性の確認）", () => {
    expect(nextId()).not.toBe(nextId());
  });
});
