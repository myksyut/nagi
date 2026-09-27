import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeamLine } from "./beam-line";
import { Popover, PopoverPopup } from "./ui/popover";

/**
 * 8-修正1 の 6・7：
 * - 7：border-beam の出入りは 100ms・150ms（ライブラリの既定の 600ms・500ms を上書きする）。
 *   reduced motion のあいだは border-beam そのものを外し、設定を戻したら付け直す
 * - 6：ポップオーバーは幅と高さを動かさない（動かすのは scale と opacity だけ）
 */

/** prefers-reduced-motion を切り替えられる matchMedia */
function stubReducedMotion(initial: boolean) {
  let matches = initial;
  type Listener = (event: { matches: boolean }) => void;
  const listeners = new Set<Listener>();
  vi.spyOn(window, "matchMedia").mockImplementation((media: string) => {
    const reduced = media.includes("reduced-motion");
    return {
      get matches() {
        return reduced ? matches : false;
      },
      media,
      addEventListener: (_: string, listener: Listener) => {
        if (reduced) listeners.add(listener);
      },
      removeEventListener: (_: string, listener: Listener) => listeners.delete(listener),
    } as unknown as MediaQueryList;
  });
  return (next: boolean) => {
    matches = next;
    for (const listener of listeners) listener({ matches });
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("7：border-beam の出入り", () => {
  it("出るときは 100ms、消えるときは 150ms のフェードに上書きする", () => {
    stubReducedMotion(false);
    render(
      <BeamLine active radius={8}>
        <input aria-label="追加" />
      </BeamLine>,
    );
    const css = [...document.querySelectorAll("style")]
      .map((style) => style.textContent)
      .join("\n");
    expect(css).toMatch(/\[data-active\] \{ animation:[^}]*beam-fade-in-[^ ]+ 100ms/);
    expect(css).toMatch(/\[data-fading\] \{ animation:[^}]*beam-fade-out-[^ ]+ 150ms/);
  });

  it("reduced motion のあいだは border-beam を外し、戻したら付け直す", () => {
    const setReduced = stubReducedMotion(true);
    render(
      <BeamLine active radius={8}>
        <input aria-label="追加" />
      </BeamLine>,
    );
    expect(document.querySelector('[data-slot="beam-line"]')).toBeNull();

    act(() => setReduced(false));
    expect(document.querySelector('[data-slot="beam-line"][data-active]')).not.toBeNull();

    act(() => setReduced(true));
    expect(document.querySelector('[data-slot="beam-line"]')).toBeNull();
  });
});

describe("6：ポップオーバーの動き", () => {
  it("幅と高さを transition の対象にしない（scale と opacity だけ）", () => {
    render(
      <Popover open>
        <PopoverPopup aria-label="試し">中身</PopoverPopup>
      </Popover>,
    );
    const popup = document.querySelector('[data-slot="popover-popup"]');
    expect(popup?.className).toContain("transition-[scale,opacity]");
    expect(popup?.className).not.toMatch(/transition-\[[^\]]*(width|height)/);
  });
});
