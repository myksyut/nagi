import { describe, expect, it } from "vitest";
import { AppStore } from "@/data";
import { createMemoryLocalDb } from "@/data/local-db";
import { FakeServer } from "@/test/fake-server";
import { makeProject, makeTask } from "@/test/fixtures";
import {
  ALL_PROJECTS,
  computeTimelineGroups,
  doOnOf,
  isInRange,
  shapeOf,
  timelineRange,
  WEEKS_AFTER,
  WEEKS_BEFORE,
} from "./timeline-model";

/**
 * チケット14：タイムラインの並びの計算（timeline-model.ts）。完了の条件1「予定・今日・締切の組み合わせごとに、
 * 棒と◆が決まりどおりに出る」のうち、モデルの単体（shapeOf・doOnOf・isInRange）と、
 * computeTimelineGroups の並び・絞り込み・範囲・観測（項目ごとの取りこぼしがないか）を確かめる
 */

const TODAY = "2026-09-27";

describe("shapeOf：やる日と締切から、棒か◆の形を決める", () => {
  it("予定だけ（締切なし）→ 予定の日の1日の棒（◆なし）", () => {
    expect(shapeOf("2026-10-01", null)).toEqual({
      kind: "bar",
      from: "2026-10-01",
      to: "2026-10-01",
      endDiamond: false,
      looseDeadline: null,
    });
  });

  it("予定＋締切（締切 ≥ 予定）→ 予定から締切までの棒＋右端◆", () => {
    expect(shapeOf("2026-10-01", "2026-10-05")).toEqual({
      kind: "bar",
      from: "2026-10-01",
      to: "2026-10-05",
      endDiamond: true,
      looseDeadline: null,
    });
  });

  it("予定＋予定と同じ日の締切 → 締切は付いた1日の棒", () => {
    expect(shapeOf("2026-10-01", "2026-10-01")).toEqual({
      kind: "bar",
      from: "2026-10-01",
      to: "2026-10-01",
      endDiamond: true,
      looseDeadline: null,
    });
  });

  it("予定＋予定より前の締切 → 予定の1日の棒と離れた◆", () => {
    expect(shapeOf("2026-10-05", "2026-10-01")).toEqual({
      kind: "bar",
      from: "2026-10-05",
      to: "2026-10-05",
      endDiamond: false,
      looseDeadline: "2026-10-01",
    });
  });

  it("やる日がなく締切だけ → ◆だけ", () => {
    expect(shapeOf(null, "2026-10-01")).toEqual({ kind: "diamond", on: "2026-10-01" });
  });

  it("やる日も締切もない → null", () => {
    expect(shapeOf(null, null)).toBeNull();
  });
});

describe("doOnOf：置き場と予定の日付から、やる日を決める", () => {
  it("予定は予定の日付", () => {
    expect(doOnOf("scheduled", "2026-10-01", TODAY)).toBe("2026-10-01");
  });

  it("今日のタスクは今日", () => {
    expect(doOnOf("today", null, TODAY)).toBe(TODAY);
  });

  it("受信箱・あとでは null", () => {
    expect(doOnOf("inbox", null, TODAY)).toBeNull();
    expect(doOnOf("later", null, TODAY)).toBeNull();
  });
});

describe("timelineRange：1週前から8週先まで", () => {
  it("範囲の両端が今日から±7日単位で決まる", () => {
    const range = timelineRange(TODAY);
    expect(range.start).toBe("2026-09-20");
    expect(range.end).toBe("2026-11-22");
    expect(WEEKS_BEFORE).toBe(1);
    expect(WEEKS_AFTER).toBe(8);
    expect(range.days).toBe(64);
  });
});

describe("isInRange：範囲の端の日は入り、外れると入らない", () => {
  const range = timelineRange(TODAY);

  it("棒が範囲の右端ぴったりに始まる／終わるのは入る", () => {
    expect(
      isInRange(
        { kind: "bar", from: range.end, to: range.end, endDiamond: false, looseDeadline: null },
        range,
      ),
    ).toBe(true);
    expect(
      isInRange(
        { kind: "bar", from: range.start, to: range.start, endDiamond: false, looseDeadline: null },
        range,
      ),
    ).toBe(true);
  });

  it("範囲の1日外は入らない", () => {
    const beforeStart = "2026-09-19";
    const afterEnd = "2026-11-23";
    expect(
      isInRange(
        { kind: "bar", from: beforeStart, to: beforeStart, endDiamond: false, looseDeadline: null },
        range,
      ),
    ).toBe(false);
    expect(
      isInRange(
        { kind: "bar", from: afterEnd, to: afterEnd, endDiamond: false, looseDeadline: null },
        range,
      ),
    ).toBe(false);
  });

  it("◆だけの形も範囲の端で入る・外れる", () => {
    expect(isInRange({ kind: "diamond", on: range.end }, range)).toBe(true);
    expect(isInRange({ kind: "diamond", on: "2026-11-23" }, range)).toBe(false);
  });

  it("離れた◆（looseDeadline）が範囲に入っていれば、棒の本体が範囲外でも入る", () => {
    const farBefore = "2026-01-01";
    expect(
      isInRange(
        {
          kind: "bar",
          from: farBefore,
          to: farBefore,
          endDiamond: false,
          looseDeadline: range.start,
        },
        range,
      ),
    ).toBe(true);
  });
});

async function makeTimelineStore(server: FakeServer) {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
    now: () => new Date(`${TODAY}T05:00:00+09:00`),
  });
  await store.start();
  return store;
}

describe("computeTimelineGroups：まとまり・並び・絞り込み・範囲", () => {
  it("受信箱・あとでで締切なしは出ない。完了・削除も出ない", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "受信箱", bucket: "inbox" }));
    server.putTask(makeTask({ title: "あとで", bucket: "later" }));
    server.putTask(
      makeTask({
        title: "完了",
        bucket: "scheduled",
        scheduledOn: "2026-10-01",
        completedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    server.putTask(
      makeTask({
        title: "削除",
        bucket: "scheduled",
        scheduledOn: "2026-10-01",
        deletedAt: "2026-09-01T00:00:00.000Z",
      }),
    );
    const store = await makeTimelineStore(server);

    const groups = computeTimelineGroups(store, ALL_PROJECTS);
    expect(groups).toEqual([]);
  });

  it("受信箱・あとでで締切があるものは出る（◆だけ）", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "受信箱＋締切", bucket: "inbox", deadlineOn: "2026-10-01" }));
    server.putTask(makeTask({ title: "あとで＋締切", bucket: "later", deadlineOn: "2026-10-02" }));
    const store = await makeTimelineStore(server);

    const groups = computeTimelineGroups(store, ALL_PROJECTS);
    const items = groups[0]?.items ?? [];
    expect(items.map((item) => item.task.title)).toEqual(["受信箱＋締切", "あとで＋締切"]);
    expect(items.every((item) => item.shape.kind === "diamond")).toBe(true);
  });

  it("範囲（今日の7日前〜56日後）に入らないタスクは出ない。端の日は入る", async () => {
    const server = new FakeServer();
    const range = timelineRange(TODAY);
    server.putTask(
      makeTask({ title: "範囲の外（前）", bucket: "scheduled", scheduledOn: "2026-09-19" }),
    );
    server.putTask(
      makeTask({ title: "範囲の外（後）", bucket: "scheduled", scheduledOn: "2026-11-23" }),
    );
    server.putTask(
      makeTask({ title: "範囲の端（前）", bucket: "scheduled", scheduledOn: range.start }),
    );
    server.putTask(
      makeTask({ title: "範囲の端（後）", bucket: "scheduled", scheduledOn: range.end }),
    );
    const store = await makeTimelineStore(server);

    const groups = computeTimelineGroups(store, ALL_PROJECTS);
    const titles = (groups[0]?.items ?? []).map((item) => item.task.title);
    expect(titles).toEqual(["範囲の端（前）", "範囲の端（後）"]);
  });

  it("プロジェクトの作成順にまとまり、プロジェクトなしは最後。行が0のまとまりは出ない", async () => {
    const server = new FakeServer();
    const p1 = server.putProject(
      makeProject({ name: "P1", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    const p2 = server.putProject(
      makeProject({ name: "P2", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    // P3 は未完了のタスクがないので、まとまりごと出ない
    server.putProject(makeProject({ name: "P3", createdAt: "2026-01-03T00:00:00.000Z" }));
    server.putTask(makeTask({ title: "P2のタスク", bucket: "today", projectId: p2.id }));
    server.putTask(makeTask({ title: "P1のタスク", bucket: "today", projectId: p1.id }));
    server.putTask(makeTask({ title: "プロジェクトなしのタスク", bucket: "today" }));
    const store = await makeTimelineStore(server);

    const groups = computeTimelineGroups(store, ALL_PROJECTS);
    expect(groups.map((g) => g.projectId)).toEqual([p1.id, p2.id, null]);
  });

  it("まとまりの中はやる日の順。やる日のない◆だけの行は後ろ（同じなら締切の順）", async () => {
    const server = new FakeServer();
    server.putTask(
      makeTask({ title: "10/5の予定", bucket: "scheduled", scheduledOn: "2026-10-05" }),
    );
    server.putTask(
      makeTask({ title: "10/1の予定", bucket: "scheduled", scheduledOn: "2026-10-01" }),
    );
    server.putTask(makeTask({ title: "早い締切のみ", bucket: "later", deadlineOn: "2026-10-10" }));
    server.putTask(makeTask({ title: "遅い締切のみ", bucket: "later", deadlineOn: "2026-10-20" }));
    const store = await makeTimelineStore(server);

    const groups = computeTimelineGroups(store, ALL_PROJECTS);
    const titles = (groups[0]?.items ?? []).map((item) => item.task.title);
    expect(titles).toEqual(["10/1の予定", "10/5の予定", "早い締切のみ", "遅い締切のみ"]);
  });

  it("絞り込み：すべて・1つのプロジェクト・プロジェクトなし", async () => {
    const server = new FakeServer();
    const project = server.putProject(makeProject({ name: "P1" }));
    server.putTask(makeTask({ title: "Pのタスク", bucket: "today", projectId: project.id }));
    server.putTask(makeTask({ title: "なしのタスク", bucket: "today" }));
    const store = await makeTimelineStore(server);

    expect(
      computeTimelineGroups(store, ALL_PROJECTS).flatMap((g) => g.items.map((i) => i.task.title)),
    ).toEqual(["Pのタスク", "なしのタスク"]);
    expect(
      computeTimelineGroups(store, { kind: "project", id: project.id }).flatMap((g) =>
        g.items.map((i) => i.task.title),
      ),
    ).toEqual(["Pのタスク"]);
    expect(
      computeTimelineGroups(store, { kind: "none" }).flatMap((g) =>
        g.items.map((i) => i.task.title),
      ),
    ).toEqual(["なしのタスク"]);
  });

  it("予定の日付・締切・プロジェクトを store の操作で変えたら並びが追いかける（取りこぼしがない）", async () => {
    const server = new FakeServer();
    const p1 = server.putProject(
      makeProject({ name: "P1", createdAt: "2026-01-01T00:00:00.000Z" }),
    );
    const p2 = server.putProject(
      makeProject({ name: "P2", createdAt: "2026-01-02T00:00:00.000Z" }),
    );
    const task = server.putTask(
      makeTask({
        title: "動くタスク",
        bucket: "scheduled",
        scheduledOn: "2026-10-01",
        projectId: p1.id,
      }),
    );
    const store = await makeTimelineStore(server);

    expect(computeTimelineGroups(store, ALL_PROJECTS).map((g) => g.projectId)).toEqual([p1.id]);

    store.actions.moveTasks([task.id], { bucket: "scheduled", on: "2026-10-10" });
    expect(computeTimelineGroups(store, ALL_PROJECTS)[0]?.items[0]?.doOn).toBe("2026-10-10");

    store.actions.setDeadline([task.id], "2026-10-20");
    expect(computeTimelineGroups(store, ALL_PROJECTS)[0]?.items[0]?.deadlineOn).toBe("2026-10-20");

    store.actions.setProject([task.id], p2.id);
    expect(computeTimelineGroups(store, ALL_PROJECTS).map((g) => g.projectId)).toEqual([p2.id]);
  });
});
