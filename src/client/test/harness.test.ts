import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * テストの土台そのものの確認。fake-indexeddb と偽のタイマーは、
 * 手元での同期（チケット3）のテストがこの土台に乗るので、先に効くことを確かめておく
 */
describe("テストの土台", () => {
  it("fake-indexeddb で IndexedDB を開ける", async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("harness-test-db", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("things", { keyPath: "id" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    expect(db.objectStoreNames.contains("things")).toBe(true);
    db.close();
    indexedDB.deleteDatabase("harness-test-db");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("vi.useFakeTimers() と vi.setSystemTime() が効く", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    expect(new Date().toISOString()).toBe("2026-01-01T00:00:00.000Z");

    vi.setSystemTime(new Date("2026-01-02T00:00:00.000Z"));
    expect(Date.now()).toBe(new Date("2026-01-02T00:00:00.000Z").getTime());
  });
});
