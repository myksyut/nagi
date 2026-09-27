import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BeamLine } from "./beam-line";

/**
 * チケット8：⌘K の入力欄と追加欄の下の辺だけに流す border-beam は、
 * prefers-reduced-motion のときは出さない
 */

function stubMatchMedia(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockReturnValue({
    matches,
    media: "(prefers-reduced-motion: reduce)",
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as MediaQueryList);
}

/** border-beam は描いた次のフレームで付くので、1フレーム待つ */
async function nextFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BeamLine", () => {
  it("prefers-reduced-motion のときは、active でも border-beam を描かない", async () => {
    stubMatchMedia(true);
    render(
      <BeamLine active radius={8}>
        <div>中身</div>
      </BeamLine>,
    );
    await nextFrame();
    expect(screen.getByText("中身")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="beam-line"][data-active]')).toBeNull();
  });

  it("prefers-reduced-motion でなければ、active のときに border-beam を流す", async () => {
    stubMatchMedia(false);
    render(
      <BeamLine active radius={8}>
        <div>中身</div>
      </BeamLine>,
    );
    await nextFrame();
    expect(document.querySelector('[data-slot="beam-line"][data-active]')).not.toBeNull();
  });

  it("active でなければ、prefers-reduced-motion でなくても流さない", async () => {
    stubMatchMedia(false);
    render(
      <BeamLine active={false} radius={8}>
        <div>中身</div>
      </BeamLine>,
    );
    await nextFrame();
    expect(document.querySelector('[data-slot="beam-line"][data-active]')).toBeNull();
  });
});
