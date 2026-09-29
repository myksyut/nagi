import { describe, expect, it } from "vitest";
import { copiedMessage, taskClipboardText } from "./task-text";

/** チケット21：⇧⌘C でクリップボードに入れる形 */

describe("taskClipboardText", () => {
  it("1件：1行目にタイトル、空の行をはさんでメモ", () => {
    expect(
      taskClipboardText([{ title: "見積もりを確認", memo: "先方の金額\nhttps://example.com" }]),
    ).toBe("見積もりを確認\n\n先方の金額\nhttps://example.com");
  });

  it("メモが空（空白だけも）ならタイトルだけ", () => {
    expect(taskClipboardText([{ title: "資料を送る", memo: "" }])).toBe("資料を送る");
    expect(taskClipboardText([{ title: "資料を送る", memo: " \n\t\n" }])).toBe("資料を送る");
  });

  it("タイトルの前後の空白と、メモの先頭の空の行・末尾の空白を落とす。メモの最初の行の字下げとメモの中の空の行は残す", () => {
    expect(
      taskClipboardText([{ title: "  議事録  ", memo: "\n\n  - 決めたこと\n\n  - 宿題\n\n" }]),
    ).toBe("議事録\n\n  - 決めたこと\n\n  - 宿題");
  });

  it("何件か：渡した順に並べ、あいだに --- の行をはさむ", () => {
    expect(
      taskClipboardText([
        { title: "A", memo: "a のメモ" },
        { title: "B", memo: "" },
        { title: "C", memo: "c1\n\nc2" },
      ]),
    ).toBe("A\n\na のメモ\n\n---\n\nB\n\n---\n\nC\n\nc1\n\nc2");
  });
});

describe("copiedMessage", () => {
  it("1件でメモがあれば「タイトルとメモ」、メモが空なら「タイトル」、何件かなら件数", () => {
    expect(copiedMessage([{ memo: "あり" }])).toBe("タイトルとメモをコピーしました");
    expect(copiedMessage([{ memo: "  " }])).toBe("タイトルをコピーしました");
    expect(copiedMessage([{ memo: "" }, { memo: "" }, { memo: "x" }])).toBe(
      "3件のタイトルとメモをコピーしました",
    );
  });
});
