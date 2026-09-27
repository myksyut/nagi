import { describe, expect, it, vi } from "vitest";
import offlineHtml from "../../public/offline.html?raw";

/**
 * チケット8：public/offline.html。Service Worker がオフラインで開いたときに出すページ。
 * 「オフラインです」とだけ出し、online イベントか、間を空けた HEAD の成功で自動的に読み込み直す
 */

it("「オフラインです」を role=status で出す", () => {
  expect(offlineHtml).toMatch(/role="status"[^>]*>\s*オフラインです/);
});

function scriptOf(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("script が見つかりません");
  return match[1];
}

/** script の中身を、fetch・setTimeout・window を偽物にして実行する */
function runScript(html: string, fetchImpl: () => Promise<{ ok: boolean }>) {
  const listeners = new Map<string, () => void>();
  const timers: { delay: number; fn: () => void }[] = [];
  const fakeWindow = {
    addEventListener: (type: string, listener: () => void) => {
      listeners.set(type, listener);
    },
    location: { reload: vi.fn() },
  };
  const fakeSetTimeout = (fn: () => void, delay: number) => {
    timers.push({ delay, fn });
    return timers.length;
  };
  new Function("window", "fetch", "setTimeout", scriptOf(html))(
    fakeWindow,
    fetchImpl,
    fakeSetTimeout,
  );
  return {
    fireOnline: () => listeners.get("online")?.(),
    runNextTimer: async () => {
      const timer = timers.shift();
      await timer?.fn();
    },
    timers,
    reload: fakeWindow.location.reload,
  };
}

describe("つながったら読み込み直す", () => {
  it("online イベントで、待たずに reload する", () => {
    const { fireOnline, reload } = runScript(offlineHtml, () =>
      Promise.reject(new Error("未使用")),
    );
    fireOnline();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("間を空けて HEAD で確かめ、成功したら reload する", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true }));
    const { timers, runNextTimer, reload } = runScript(offlineHtml, fetchImpl);
    expect(timers).toHaveLength(1);
    await runNextTimer();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("失敗しているあいだは reload せず、間を延ばしながら確かめ続ける", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("まだつながらない");
    });
    const { timers, runNextTimer, reload } = runScript(offlineHtml, fetchImpl);
    const firstDelay = timers[0]?.delay;
    await runNextTimer();
    expect(reload).not.toHaveBeenCalled();
    expect(timers).toHaveLength(1);
    expect(timers[0]?.delay).toBeGreaterThan(firstDelay ?? 0);
  });
});
