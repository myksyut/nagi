import { MotionGlobalConfig } from "motion/react";
import { afterEach, describe, expect, it } from "vitest";
import { followReducedMotion } from "./reduced-motion";

/**
 * チケット8：prefers-reduced-motion のときに Motion の動きを止める（skipAnimations）。
 * setup.ts はテスト全体で skipAnimations を true にしているので、ここでは一時的に false に戻して確かめる
 */

function fakeWindow(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: { matches: boolean }) => void>();
  const query = {
    get matches() {
      return matches;
    },
    addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
      listeners.delete(listener);
    },
  };
  return {
    win: { matchMedia: () => query } as unknown as Window,
    change: (next: boolean) => {
      matches = next;
      for (const listener of listeners) listener({ matches });
    },
  };
}

afterEach(() => {
  MotionGlobalConfig.skipAnimations = true;
});

describe("followReducedMotion", () => {
  it("prefers-reduced-motion が最初から有効なら、すぐ skipAnimations を true にする", () => {
    MotionGlobalConfig.skipAnimations = false;
    const { win } = fakeWindow(true);
    const stop = followReducedMotion(win);
    expect(MotionGlobalConfig.skipAnimations).toBe(true);
    stop();
  });

  it("あとから有効になっても追いかけて true にし、戻り値を呼ぶと元の値に戻す", () => {
    MotionGlobalConfig.skipAnimations = false;
    const { win, change } = fakeWindow(false);
    const stop = followReducedMotion(win);
    expect(MotionGlobalConfig.skipAnimations).toBe(false);

    change(true);
    expect(MotionGlobalConfig.skipAnimations).toBe(true);

    change(false);
    expect(MotionGlobalConfig.skipAnimations).toBe(false);

    change(true);
    stop();
    // やめたら、始めたときの値（false）に戻す
    expect(MotionGlobalConfig.skipAnimations).toBe(false);
  });

  it("もともと true（テストなど）なら、reduced-motion が false でも true のまま", () => {
    MotionGlobalConfig.skipAnimations = true;
    const { win, change } = fakeWindow(false);
    const stop = followReducedMotion(win);
    expect(MotionGlobalConfig.skipAnimations).toBe(true);
    change(true);
    expect(MotionGlobalConfig.skipAnimations).toBe(true);
    stop();
  });

  it("matchMedia がない環境では何もしない（例外にしない）", () => {
    const win = {} as Window;
    expect(() => followReducedMotion(win)()).not.toThrow();
  });
});
