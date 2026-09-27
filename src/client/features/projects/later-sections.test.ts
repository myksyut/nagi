import { describe, expect, it } from "vitest";
import { AppStore } from "../../data";
import { createMemoryLocalDb } from "../../data/local-db";
import { FakeServer } from "../../test/fake-server";
import { makeProject, makeTask } from "../../test/fixtures";
import { LATER_NO_PROJECT, laterSections } from "./later-sections";

/** 6：あとでのまとまり。プロジェクトなしが先頭、そのあとプロジェクトの作成順（見出しは名前） */

async function setupStore(server: FakeServer) {
  const store = new AppStore({
    fetch: server.fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  await store.start();
  await store.sync();
  return store;
}

describe("laterSections", () => {
  it("プロジェクトなしが先頭（見出しなし）、そのあとプロジェクトの作成順（見出しは名前）", async () => {
    const server = new FakeServer();
    const p1 = makeProject({ name: "先に作った", createdAt: "2026-01-01T00:00:00.000Z" });
    const p2 = makeProject({ name: "あとで作った", createdAt: "2026-01-02T00:00:00.000Z" });
    server.putProject(p1);
    server.putProject(p2);
    server.putTask(makeTask({ title: "なし1", bucket: "later", rank: "a0" }));
    server.putTask(makeTask({ title: "p2の1", bucket: "later", rank: "a0", projectId: p2.id }));
    server.putTask(makeTask({ title: "p1の1", bucket: "later", rank: "b0", projectId: p1.id }));
    server.putTask(makeTask({ title: "p1の2", bucket: "later", rank: "a0", projectId: p1.id }));

    const store = await setupStore(server);
    try {
      const sections = laterSections(store);
      expect(sections.map((s) => s.key)).toEqual([
        LATER_NO_PROJECT,
        `project:${p1.id}`,
        `project:${p2.id}`,
      ]);
      expect(sections[0]?.heading).toBeUndefined();
      expect(sections[1]?.heading).toBe("先に作った");
      expect(sections[2]?.heading).toBe("あとで作った");

      expect(sections[0]?.rows.map((t) => t.title)).toEqual(["なし1"]);
      // まとまりの中は rank 順
      expect(sections[1]?.rows.map((t) => t.title)).toEqual(["p1の2", "p1の1"]);
      expect(sections[2]?.rows.map((t) => t.title)).toEqual(["p2の1"]);
    } finally {
      store.dispose();
    }
  });

  it("付いているプロジェクトが見つからない・削除済みなら、プロジェクトなしのまとまりに入る", async () => {
    const server = new FakeServer();
    server.putTask(makeTask({ title: "孤立", bucket: "later", projectId: "no-such-project" }));
    const store = await setupStore(server);
    try {
      const sections = laterSections(store);
      expect(sections[0]?.rows.map((t) => t.title)).toEqual(["孤立"]);
      expect(sections).toHaveLength(1);
    } finally {
      store.dispose();
    }
  });
});
