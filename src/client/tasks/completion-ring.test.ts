import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPLETE_FOR_ATTRIBUTE,
  COMPLETE_RING_MS,
  prepareCompletionRings,
} from "./completion-ring";

/**
 * チケット9：完了の光の輪（丸が埋まるのに合わせて広がって消える。300ms、reduced motion では出さない）。
 * prepareCompletionRings は「丸の位置を読む（完了する前）」「play() で輪を置く（受け付けられたときだけ呼ぶ）」に分かれているので、
 * それぞれを別に確かめる
 */

function stubReducedMotion(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        matches,
        media,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

function markerAt(id: string, rect: Partial<DOMRect> = {}): HTMLElement {
  const element = document.createElement("span");
  element.setAttribute(COMPLETE_FOR_ATTRIBUTE, id);
  element.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 16, height: 16, bottom: 36, right: 26, ...rect }) as DOMRect;
  document.body.append(element);
  return element;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("prepareCompletionRings", () => {
  it("play() すると、丸の位置に aria-hidden の輪を body 直下へ置く", () => {
    stubReducedMotion(false);
    markerAt("task-1", { left: 10, top: 20, width: 16, height: 16 });
    const rings = prepareCompletionRings(["task-1"]);
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);

    rings.play();
    const ring = document.querySelector("[data-complete-ring]");
    expect(ring).not.toBeNull();
    expect(ring?.parentElement).toBe(document.body);
    expect(ring).toHaveAttribute("aria-hidden", "true");
    expect(ring).toHaveClass("complete-ring");
    expect((ring as HTMLElement).style.left).toBe("10px");
    expect((ring as HTMLElement).style.top).toBe("20px");
    expect((ring as HTMLElement).style.width).toBe("16px");
    expect((ring as HTMLElement).style.height).toBe("16px");
  });

  it("reduced motion のときは play() しても何も置かない", () => {
    stubReducedMotion(true);
    markerAt("task-1");
    const rings = prepareCompletionRings(["task-1"]);
    rings.play();
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);
  });

  it("ids が空のときは何もしない", () => {
    stubReducedMotion(false);
    markerAt("task-1");
    const rings = prepareCompletionRings([]);
    rings.play();
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);
  });

  it("対象でない丸や、画面の外の丸は無視する", () => {
    stubReducedMotion(false);
    markerAt("task-1");
    markerAt("task-2", { top: -100, bottom: -84 });
    const rings = prepareCompletionRings(["task-2"]);
    rings.play();
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);
  });

  it("animationend で輪が外れる", () => {
    stubReducedMotion(false);
    markerAt("task-1");
    const rings = prepareCompletionRings(["task-1"]);
    rings.play();
    const ring = document.querySelector("[data-complete-ring]");
    expect(ring).not.toBeNull();
    ring?.dispatchEvent(new Event("animationend"));
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);
  });

  it("animationend が来なくても、COMPLETE_RING_MS + 100 後に外れる", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    markerAt("task-1");
    const rings = prepareCompletionRings(["task-1"]);
    rings.play();
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(1);

    vi.advanceTimersByTime(COMPLETE_RING_MS + 99);
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(document.querySelectorAll("[data-complete-ring]")).toHaveLength(0);
  });
});
