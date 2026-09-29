import { afterEach, describe, expect, it } from "vitest";
import { AppStore } from "@/data";
import { createMemoryLocalDb } from "@/data/local-db";
import { ListUi } from "@/tasks/list-ui";
import { breakLocalStorage } from "@/test/broken-storage";
import { FakeServer } from "@/test/fake-server";
import { SIDEBAR_STORAGE_KEY, SidebarState, sidebarOf } from "./sidebar-state";

/**
 * チケット20：サイドバーを畳んでいるかの状態（SidebarState）。
 * localStorage からの読み込みと書き込み、<html> の data-sidebar への写し（mirrorTo）、ListUi ごとに1つ（sidebarOf）
 */

const stores: AppStore[] = [];
/** 例外を投げるように替えた localStorage を戻す */
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const store of stores.splice(0)) store.dispose();
  delete document.documentElement.dataset.sidebar;
});

function makeUi(): ListUi {
  const store = new AppStore({
    fetch: new FakeServer().fetch,
    openLocalDb: async () => createMemoryLocalDb(),
  });
  stores.push(store);
  return new ListUi(store);
}

describe("SidebarState：覚える", () => {
  it("localStorage に rail があれば畳んだ状態で始まり、なければ・ほかの値なら広げた状態で始まる", () => {
    expect(new SidebarState().rail).toBe(false);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "full");
    expect(new SidebarState().rail).toBe(false);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "rail");
    expect(new SidebarState().rail).toBe(true);
  });

  it("setRail で畳むと localStorage に rail を書き、広げると消す", () => {
    const state = new SidebarState();
    state.setRail(true);
    expect(state.rail).toBe(true);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe("rail");
    state.setRail(false);
    expect(state.rail).toBe(false);
    expect(localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBeNull();
  });

  it("localStorage が例外を投げても作れて、setRail はそのタブの中で効く", () => {
    const storage = breakLocalStorage();
    restores.push(storage.restore);
    const state = new SidebarState();
    expect(state.rail).toBe(false);
    state.setRail(true);
    expect(state.rail).toBe(true);
    state.setRail(false);
    expect(state.rail).toBe(false);
    expect(storage.calls.map(({ method }) => method)).toEqual(["getItem", "setItem", "removeItem"]);
  });
});

describe("SidebarState.mirrorTo", () => {
  it("渡した要素の data-sidebar を、最初から畳んでいるかに合わせ、変わるたびに付け外しする", () => {
    const root = document.createElement("div");
    localStorage.setItem(SIDEBAR_STORAGE_KEY, "rail");
    const state = new SidebarState();
    const stop = state.mirrorTo(root);
    expect(root.dataset.sidebar).toBe("rail");
    state.setRail(false);
    expect(root.dataset.sidebar).toBeUndefined();
    expect(root.hasAttribute("data-sidebar")).toBe(false);
    state.setRail(true);
    expect(root.dataset.sidebar).toBe("rail");
    stop();
  });

  it("戻り値を呼ぶと data-sidebar を外し、そのあとは畳んでも付けない", () => {
    const root = document.createElement("div");
    const state = new SidebarState();
    const stop = state.mirrorTo(root);
    state.setRail(true);
    expect(root.dataset.sidebar).toBe("rail");
    stop();
    expect(root.hasAttribute("data-sidebar")).toBe(false);
    state.setRail(false);
    state.setRail(true);
    expect(root.hasAttribute("data-sidebar")).toBe(false);
  });

  it("要素を渡さなければ <html> に写す", () => {
    const state = new SidebarState();
    const stop = state.mirrorTo();
    expect(document.documentElement.hasAttribute("data-sidebar")).toBe(false);
    state.setRail(true);
    expect(document.documentElement.dataset.sidebar).toBe("rail");
    stop();
    expect(document.documentElement.hasAttribute("data-sidebar")).toBe(false);
  });
});

describe("sidebarOf", () => {
  it("ListUi ごとに別の状態を返し、同じ ListUi には同じものを返す", () => {
    const a = makeUi();
    const b = makeUi();
    expect(sidebarOf(a)).toBe(sidebarOf(a));
    expect(sidebarOf(a)).not.toBe(sidebarOf(b));
    // 片方で畳んでも、もう片方の状態（いま描いているもの）は変わらない（localStorage には書く）
    sidebarOf(a).setRail(true);
    expect(sidebarOf(a).rail).toBe(true);
    expect(sidebarOf(b).rail).toBe(false);
  });
});
