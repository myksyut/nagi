import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMPLETE_RING_MS,
  completeButtonId,
  MAX_RINGS,
  playCompletionRings,
} from "./completion-ring";

/**
 * チケット9：完了の光の輪（丸が埋まるのに合わせて広がって消える。300ms、reduced motion では出さない）。
 * 9-修正1：丸はタスクの id から直接引き（画面の中の丸を全部は探さない）、見えている丸を最大 20 個だけ読む。
 * 輪が出ているあいだに reduced motion に変わったら、すぐ外す
 */

type Listener = () => void;

/** matchMedia の偽物。matches を後から変えて、change を送れる */
function stubReducedMotion(initial: boolean) {
  const state = { matches: initial };
  const listeners = new Set<Listener>();
  vi.spyOn(window, "matchMedia").mockImplementation(
    (media: string) =>
      ({
        get matches() {
          return state.matches;
        },
        media,
        addEventListener: (_type: string, listener: Listener) => listeners.add(listener),
        removeEventListener: (_type: string, listener: Listener) => listeners.delete(listener),
      }) as unknown as MediaQueryList,
  );
  return {
    change(matches: boolean) {
      state.matches = matches;
      for (const listener of [...listeners]) listener();
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

/** そのタスクの丸（id 付き）を置く。位置は getBoundingClientRect で決める */
function buttonFor(taskId: string, rect: Partial<DOMRect> = {}): HTMLElement {
  const element = document.createElement("button");
  element.id = completeButtonId(taskId);
  const full = { left: 10, top: 20, width: 17, height: 17, bottom: 37, right: 27, ...rect };
  element.getBoundingClientRect = vi.fn(() => full as DOMRect);
  document.body.append(element);
  return element;
}

function rings(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-complete-ring]")];
}

afterEach(() => {
  // 出ている輪を外し、reduced motion の見張りも止める（animationend で外れる）
  for (const ring of rings()) ring.dispatchEvent(new Event("animationend"));
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("playCompletionRings", () => {
  it("丸の位置に、aria-hidden の輪を body 直下へ置く", () => {
    stubReducedMotion(false);
    buttonFor("task-1", { left: 10, top: 20, width: 17, height: 17 });
    playCompletionRings(["task-1"]);

    const [ring] = rings();
    expect(ring).toBeDefined();
    expect(ring?.parentElement).toBe(document.body);
    expect(ring).toHaveAttribute("aria-hidden", "true");
    expect(ring).toHaveClass("complete-ring");
    expect(ring?.style.left).toBe("10px");
    expect(ring?.style.top).toBe("20px");
    expect(ring?.style.width).toBe("17px");
    expect(ring?.style.height).toBe("17px");
  });

  it("reduced motion のときは、丸の位置も読まずに何も置かない", () => {
    stubReducedMotion(true);
    const button = buttonFor("task-1");
    playCompletionRings(["task-1"]);
    expect(rings()).toHaveLength(0);
    expect(button.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("ids が空のときは何もしない", () => {
    stubReducedMotion(false);
    buttonFor("task-1");
    playCompletionRings([]);
    expect(rings()).toHaveLength(0);
  });

  it("丸はタスクの id から引き、画面の中の丸を全部は探さない（対象でない丸は読まない）", () => {
    stubReducedMotion(false);
    const others = Array.from({ length: 50 }, (_, i) => buttonFor(`other-${i}`));
    buttonFor("task-1");
    const querySelectorAll = vi.spyOn(document, "querySelectorAll");

    playCompletionRings(["task-1"]);

    // 先に見る（rings() 自身が querySelectorAll を使うため）
    expect(querySelectorAll).not.toHaveBeenCalled();
    for (const other of others) expect(other.getBoundingClientRect).not.toHaveBeenCalled();
    expect(rings()).toHaveLength(1);
  });

  it(`まとめて完了しても、見えている丸を最大 ${MAX_RINGS} 個だけ読み、輪も ${MAX_RINGS} 個まで`, () => {
    stubReducedMotion(false);
    const ids = Array.from({ length: 30 }, (_, i) => `task-${i}`);
    const buttons = ids.map((id, i) => buttonFor(id, { top: i * 20, bottom: i * 20 + 17 }));

    playCompletionRings(ids);

    expect(rings()).toHaveLength(MAX_RINGS);
    const read = buttons.filter(
      (button) => vi.mocked(button.getBoundingClientRect).mock.calls.length,
    );
    expect(read).toHaveLength(MAX_RINGS);
  });

  it("画面より上の丸は飛ばし、画面より下の丸が出てきたら、それより後ろは読まない", () => {
    stubReducedMotion(false);
    const above = buttonFor("above", { top: -100, bottom: -83 });
    buttonFor("visible", { top: 100, bottom: 117 });
    buttonFor("below", { top: window.innerHeight + 50, bottom: window.innerHeight + 67 });
    const after = buttonFor("after", { top: 200, bottom: 217 });

    playCompletionRings(["above", "visible", "below", "after"]);

    expect(rings()).toHaveLength(1);
    expect(rings()[0]?.style.top).toBe("100px");
    expect(above.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(after.getBoundingClientRect).not.toHaveBeenCalled();
  });

  it("animationend で輪が外れる", () => {
    stubReducedMotion(false);
    buttonFor("task-1");
    playCompletionRings(["task-1"]);
    rings()[0]?.dispatchEvent(new Event("animationend"));
    expect(rings()).toHaveLength(0);
  });

  it("animationend が来なくても、COMPLETE_RING_MS + 100 後に外れる", () => {
    vi.useFakeTimers();
    stubReducedMotion(false);
    buttonFor("task-1");
    playCompletionRings(["task-1"]);
    expect(rings()).toHaveLength(1);

    vi.advanceTimersByTime(COMPLETE_RING_MS + 99);
    expect(rings()).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(rings()).toHaveLength(0);
  });

  it("輪が出ているあいだに reduced motion に変わったら、止まった輪を残さずにすぐ外す", () => {
    const media = stubReducedMotion(false);
    buttonFor("task-1");
    buttonFor("task-2", { top: 40, bottom: 57 });
    playCompletionRings(["task-1", "task-2"]);
    expect(rings()).toHaveLength(2);

    media.change(true);

    expect(rings()).toHaveLength(0);
    // 輪がなくなったら、設定の見張りもやめる
    expect(media.listenerCount).toBe(0);
  });

  it("reduced motion から戻ったとき（動きを減らさない側への変更）は、出ている輪を外さない", () => {
    const media = stubReducedMotion(false);
    buttonFor("task-1");
    playCompletionRings(["task-1"]);

    media.change(false);

    expect(rings()).toHaveLength(1);
  });
});
