import { cleanup, render, screen } from "@testing-library/react";
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

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("BeamLine", () => {
  it("prefers-reduced-motion のときは、active でも border-beam を描かない", () => {
    stubMatchMedia(true);
    render(
      <BeamLine active radius={8}>
        <div>中身</div>
      </BeamLine>,
    );
    expect(screen.getByText("中身")).toBeInTheDocument();
    expect(document.querySelector('[data-slot="beam-line"][data-active]')).toBeNull();
  });

  it("prefers-reduced-motion でなければ、active のときに border-beam を流す", () => {
    stubMatchMedia(false);
    render(
      <BeamLine active radius={8}>
        <div>中身</div>
      </BeamLine>,
    );
    expect(document.querySelector('[data-slot="beam-line"][data-active]')).not.toBeNull();
  });

  it("active でなければ、prefers-reduced-motion でなくても流さない", () => {
    stubMatchMedia(false);
    render(
      <BeamLine active={false} radius={8}>
        <div>中身</div>
      </BeamLine>,
    );
    expect(document.querySelector('[data-slot="beam-line"][data-active]')).toBeNull();
  });
});
