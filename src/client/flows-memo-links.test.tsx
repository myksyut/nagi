import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PropertySymbol } from "happy-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppStore } from "./data";
import { FakeServer } from "./test/fake-server";
import { makeTask } from "./test/fixtures";
import { setupApp } from "./test/render-app";

/**
 * チケット18：メモの中のリンクを押せるようにする（押すと書き直す欄に切り替わって、リンクが消えていた）。
 * - Safari の系統（デスクトップ版の中身も）は、リンクを押してもリンクにフォーカスを移さず、フォーカスできる一番近い祖先
 *   （メモの枠）にフォーカスを入れる。happy-dom はこれをまねないので、mousedown の既定の動きとして、
 *   止められていなければ枠に focus() を手で起こす（safariMouseDown）
 * - リンクを開く既定の動きは、happy-dom では window.open になる。本当には開かないよう差し替えて、呼ばれたかを見る
 */

const LINK_URL = "https://example.com/a";
const MEMO = `見て ${LINK_URL} を読む`;

const stores: AppStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.dispose();
  vi.restoreAllMocks();
});

/** 今日のタスクを開いて、メモの枠（表示のとき）とその中のリンクを返す */
async function openMemo() {
  const server = new FakeServer();
  server.putTask(makeTask({ title: "A", bucket: "today", memo: MEMO }));
  const { store } = await setupApp("/today", server);
  stores.push(store);
  await act(async () => {
    await store.sync();
  });
  await screen.findByRole("listbox", { name: "今日" });
  const user = userEvent.setup();
  await user.keyboard("j{Enter}");
  const link = screen.getByRole("link", { name: "example.com/a" });
  // リンクを開くのは、happy-dom の本来の window の open（テストの window や document.defaultView は、
  // vitest がそれの関数を写したもので、差し替えても届かない）。本当に開きに行かないよう、何もしないものにする
  const view = (link as unknown as Record<symbol, Window>)[PropertySymbol.window];
  if (!view) throw new Error("リンクの window が見つかりません");
  const open = vi.spyOn(view, "open").mockReturnValue(null);
  return { user, open, frame: screen.getByRole("button", { name: "メモを直す" }), link };
}

/** 書き直す欄（textarea）。出ていなければ null */
const memoField = () => screen.queryByRole("textbox", { name: "メモ" });

/**
 * Safari の系統の mousedown。既定の動きが止められていなければ、押した先がリンクでも文字でも、フォーカスは枠に入る。
 * 既定の動きが止められていないかを返す
 */
function safariMouseDown(target: Element, frame: HTMLElement): boolean {
  const notPrevented = fireEvent.mouseDown(target);
  if (notPrevented) act(() => frame.focus());
  return notPrevented;
}

describe("マウスで押す（Safari の系統）", () => {
  it("リンクを押しても書き直す欄にならず、クリックがリンクに届いて新しいタブで開く", async () => {
    const { frame, link, open } = await openMemo();
    const clicks = vi.fn();
    link.addEventListener("click", clicks);

    const mouseDownNotPrevented = safariMouseDown(link, frame);
    // リンクは消えず、フォーカスも枠へ動かない
    expect(memoField()).toBeNull();
    expect(link).toBeInTheDocument();
    expect(frame).not.toHaveFocus();
    expect(mouseDownNotPrevented).toBe(false);

    fireEvent.mouseUp(link);
    const clickNotPrevented = fireEvent.click(link);
    expect(clicks).toHaveBeenCalledTimes(1);
    // リンクを開く既定の動きは止めない
    expect(clickNotPrevented).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(LINK_URL, "_blank", expect.any(String));
    // クリックは枠まで上がらない（書き直す欄にならない）
    expect(memoField()).toBeNull();
    expect(frame).toBeInTheDocument();
  });

  it("メモの文字の部分を押すと、今までどおり書き直す欄になる（mousedown は止めない）", async () => {
    const { frame, open } = await openMemo();

    // 文字は枠の直下のテキストなので、押した先は枠そのもの
    expect(safariMouseDown(frame, frame)).toBe(true);
    const field = await screen.findByRole("textbox", { name: "メモ" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(field).toHaveValue(MEMO);
    expect(open).not.toHaveBeenCalled();
  });
});

describe("マウスで押す（user-event：Chrome の系統）", () => {
  it("リンクを押すと、書き直す欄にならずに新しいタブで開く", async () => {
    const { user, link, open } = await openMemo();

    await user.click(link);
    expect(open).toHaveBeenCalledWith(LINK_URL, "_blank", expect.any(String));
    expect(memoField()).toBeNull();
    expect(link).toBeInTheDocument();
  });

  it("メモの文字の部分を押すと、書き直す欄になる", async () => {
    const { user, frame, open } = await openMemo();

    await user.click(frame);
    const field = await screen.findByRole("textbox", { name: "メモ" });
    await waitFor(() => expect(field).toHaveFocus());
    expect(open).not.toHaveBeenCalled();
  });
});

describe("キー", () => {
  it("Shift+Tab でリンクに入って Enter を押すと、書き直す欄にならずにリンクが開く", async () => {
    const { user, link, open } = await openMemo();

    // リンクの次はチェックリストの「項目を追加」。そこから戻ってリンクに入る
    act(() => screen.getByRole("textbox", { name: "項目を追加" }).focus());
    await user.tab({ shift: true });
    expect(link).toHaveFocus();
    expect(memoField()).toBeNull();

    // Enter の既定の動き（リンクを開く）は止めない。user-event は止められていなければ click を送る
    await user.keyboard("{Enter}");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(LINK_URL, "_blank", expect.any(String));
    expect(memoField()).toBeNull();
    expect(link).toBeInTheDocument();

    expect(fireEvent.keyDown(link, { key: "Enter" })).toBe(true);
    expect(memoField()).toBeNull();
  });

  it("枠そのもので Enter を押すと、今までどおり書き直す欄になる。変換中の Enter ではならない", async () => {
    const { frame } = await openMemo();

    // 枠はフォーカスが入るだけで書き直す欄になるので、キーは枠に直に送る
    expect(fireEvent.keyDown(frame, { key: "Enter", isComposing: true })).toBe(true);
    expect(fireEvent.keyDown(frame, { key: "Enter", keyCode: 229 })).toBe(true);
    expect(memoField()).toBeNull();

    expect(fireEvent.keyDown(frame, { key: "Enter" })).toBe(false);
    const field = await screen.findByRole("textbox", { name: "メモ" });
    await waitFor(() => expect(field).toHaveFocus());
  });
});
