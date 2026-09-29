import { afterEach, describe, expect, it, vi } from "vitest";
import { writeClipboardText } from "./clipboard";

/**
 * チケット21：クリップボードに入れる（Clipboard API）。入れられたら true、API がないときや断られたときは false。
 * navigator は vi.stubGlobal で替え、テストごとに戻す
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubClipboard(clipboard: unknown) {
  vi.stubGlobal("navigator", { clipboard });
}

describe("writeClipboardText", () => {
  it("入れられたら true。渡した文字がそのまま入る", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    stubClipboard({ writeText });
    await expect(writeClipboardText("見積もりを確認\n\nメモ")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledExactlyOnceWith("見積もりを確認\n\nメモ");
  });

  it("writeText は呼んだその場で呼ぶ（キーを押した処理の中で入れる。ブラウザによっては、操作の中でないと断る）", () => {
    const writeText = vi.fn(async (_text: string) => {});
    stubClipboard({ writeText });
    const result = writeClipboardText("A");
    expect(writeText).toHaveBeenCalledExactlyOnceWith("A");
    return result;
  });

  it("Clipboard API がないとき（navigator がない・clipboard がない・writeText がない）は false", async () => {
    vi.stubGlobal("navigator", undefined);
    await expect(writeClipboardText("A")).resolves.toBe(false);
    vi.stubGlobal("navigator", {});
    await expect(writeClipboardText("A")).resolves.toBe(false);
    stubClipboard({});
    await expect(writeClipboardText("A")).resolves.toBe(false);
  });

  it("断られたとき（writeText の Promise が失敗する）は false", async () => {
    stubClipboard({
      writeText: vi.fn(async () => {
        throw new DOMException("Document is not focused.", "NotAllowedError");
      }),
    });
    await expect(writeClipboardText("A")).resolves.toBe(false);
  });

  it("writeText がその場で例外を投げたときも false", async () => {
    stubClipboard({
      writeText: vi.fn(() => {
        throw new TypeError("Illegal invocation");
      }),
    });
    await expect(writeClipboardText("A")).resolves.toBe(false);
  });
});
