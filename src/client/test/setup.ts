import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, vi } from "vitest";

// 動きはテストでは飛ばす（抜けていく行が、動きの終わりまで残らないように）
MotionGlobalConfig.skipAnimations = true;

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
