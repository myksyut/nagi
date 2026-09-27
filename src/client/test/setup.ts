import "fake-indexeddb/auto";
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { MotionGlobalConfig } from "motion/react";
import { afterEach, beforeAll, vi } from "vitest";
import { preloadDeferred } from "../lib/deferred";

// 動きはテストでは飛ばす（抜けていく行が、動きの終わりまで残らないように）
MotionGlobalConfig.skipAnimations = true;

// 後から読み込む部品（⌘K・完了ログ・カレンダー・p の候補など）は、本番では起動のあとの空いた時間に先読みする。
// テストでも各ファイルの最初に読んでおく（最初のテストの時間に、読み込みの重さが入らないように）。
// テストファイルが読み込んだモジュールに登録されたものだけを読む
beforeAll(() => preloadDeferred(), 30_000);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  // 下書きは localStorage に残るので、テストごとに空にする（前のテストの下書きが追加欄に入らないように）
  localStorage.clear();
  sessionStorage.clear();
});
