import { describe, expect, it, vi } from "vitest";
import { CORE_KEY_BINDINGS } from "@/features/core/register";
import type { KeyContext } from "./keymap";
import { Keymap } from "./keymap";

/** dispatch が読む最低限のプロパティだけを持つ、偽のキーボードイベント */
function makeEvent(overrides: Partial<KeyboardEvent> & { target?: EventTarget | null } = {}) {
  return {
    key: "x",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    defaultPrevented: false,
    target: null,
    preventDefault: vi.fn(),
    ...overrides,
  } as unknown as KeyboardEvent;
}

function makeContext(overrides: Partial<KeyContext> = {}): KeyContext {
  return {
    store: { loaded: true } as KeyContext["store"],
    ui: {} as KeyContext["ui"],
    navigate: vi.fn(),
    ...overrides,
  };
}

describe("Keymap.dispatch", () => {
  it("当たったら run を呼び、既定の動きを止め、true を返す", () => {
    const keymap = new Keymap();
    const run = vi.fn();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["x"], run });
    const event = makeEvent();
    const handled = keymap.dispatch(event, makeContext());
    expect(handled).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  it("当たらなければ false", () => {
    const keymap = new Keymap();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["y"], run: vi.fn() });
    expect(keymap.dispatch(makeEvent({ key: "x" }), makeContext())).toBe(false);
  });

  it("入力欄では allowInInput の割り当てだけ効く", () => {
    const keymap = new Keymap();
    const plain = vi.fn();
    const allowed = vi.fn();
    keymap.register({ id: "plain", label: "普通", group: "タスク", keys: ["Mod+z"], run: plain });
    keymap.register({
      id: "allowed",
      label: "許可",
      group: "タスク",
      keys: ["Mod+z"],
      allowInInput: true,
      // 同じキーを別の割り当てにするので、場面を分ける（同じ場面だと登録で例外になる）
      scope: "入力欄",
      run: allowed,
    });
    const input = document.createElement("input");
    const event = makeEvent({ key: "z", metaKey: true, target: input });
    keymap.dispatch(event, makeContext());
    expect(plain).not.toHaveBeenCalled();
    expect(allowed).toHaveBeenCalledTimes(1);
  });

  it("ボタン・リンクの上の Enter・Space は部品に任せる（奪わない）", () => {
    const keymap = new Keymap();
    const run = vi.fn();
    keymap.register({ id: "open", label: "開く", group: "タスク", keys: ["Enter"], run });
    const button = document.createElement("button");
    expect(keymap.dispatch(makeEvent({ key: "Enter", target: button }), makeContext())).toBe(false);
    expect(run).not.toHaveBeenCalled();
    const link = document.createElement("a");
    link.href = "#";
    expect(keymap.dispatch(makeEvent({ key: " ", target: link }), makeContext())).toBe(false);
  });

  it("押しっぱなしの繰り返しは repeat: true の割り当てだけ動く", () => {
    const keymap = new Keymap();
    const run = vi.fn();
    keymap.register({ id: "down", label: "下へ", group: "移動", keys: ["j"], run });
    expect(keymap.dispatch(makeEvent({ key: "j", repeat: true }), makeContext())).toBe(false);
    expect(run).not.toHaveBeenCalled();

    const repeatable = new Keymap();
    const repeatRun = vi.fn();
    repeatable.register({
      id: "down",
      label: "下へ",
      group: "移動",
      keys: ["j"],
      repeat: true,
      run: repeatRun,
    });
    expect(repeatable.dispatch(makeEvent({ key: "j", repeat: true }), makeContext())).toBe(true);
    expect(repeatRun).toHaveBeenCalledTimes(1);
  });

  it("store.loaded が false のあいだは allowBeforeLoad の割り当てだけ動く", () => {
    const keymap = new Keymap();
    const run = vi.fn();
    keymap.register({ id: "go", label: "移動", group: "リスト", keys: ["1"], run });
    const notLoaded = makeContext({ store: { loaded: false } as KeyContext["store"] });
    expect(keymap.dispatch(makeEvent({ key: "1" }), notLoaded)).toBe(false);
    expect(run).not.toHaveBeenCalled();

    const allowed = new Keymap();
    const allowedRun = vi.fn();
    allowed.register({
      id: "go",
      label: "移動",
      group: "リスト",
      keys: ["1"],
      allowBeforeLoad: true,
      run: allowedRun,
    });
    expect(allowed.dispatch(makeEvent({ key: "1" }), notLoaded)).toBe(true);
    expect(allowedRun).toHaveBeenCalledTimes(1);
  });

  it("when が false なら奪わない", () => {
    const keymap = new Keymap();
    const run = vi.fn();
    keymap.register({
      id: "complete",
      label: "完了",
      group: "タスク",
      keys: ["x"],
      when: () => false,
      run,
    });
    expect(keymap.dispatch(makeEvent({ key: "x" }), makeContext())).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("data-keymap=off の中では何もしない", () => {
    const keymap = new Keymap();
    const run = vi.fn();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["x"], run });
    const container = document.createElement("div");
    container.setAttribute("data-keymap", "off");
    const child = document.createElement("span");
    container.appendChild(child);
    expect(keymap.dispatch(makeEvent({ key: "x", target: child }), makeContext())).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("変換中（isComposing・keyCode 229）は何もしない", () => {
    const keymap = new Keymap();
    const run = vi.fn();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["x"], run });
    expect(keymap.dispatch(makeEvent({ key: "x", isComposing: true }), makeContext())).toBe(false);
    expect(keymap.dispatch(makeEvent({ key: "x", keyCode: 229 }), makeContext())).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("すでに defaultPrevented のイベントは触らない", () => {
    const keymap = new Keymap();
    const run = vi.fn();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["x"], run });
    expect(keymap.dispatch(makeEvent({ key: "x", defaultPrevented: true }), makeContext())).toBe(
      false,
    );
    expect(run).not.toHaveBeenCalled();
  });
});

describe("Keymap.register", () => {
  it("1文字のキーに allowInInput を付けると例外", () => {
    const keymap = new Keymap();
    expect(() =>
      keymap.register({
        id: "bad",
        label: "だめ",
        group: "タスク",
        keys: ["x"],
        allowInInput: true,
        run: vi.fn(),
      }),
    ).toThrow();
  });

  it("Mod+z のような修飾キーつきの1文字は allowInInput にできる", () => {
    const keymap = new Keymap();
    expect(() =>
      keymap.register({
        id: "ok",
        label: "だいじょうぶ",
        group: "タスク",
        keys: ["Mod+z"],
        allowInInput: true,
        run: vi.fn(),
      }),
    ).not.toThrow();
  });

  it("同じ id で登録し直すと置き換わる。戻り値を呼ぶと外れる", () => {
    const keymap = new Keymap();
    const first = vi.fn();
    const second = vi.fn();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["x"], run: first });
    const unregister = keymap.register({
      id: "a",
      label: "A2",
      group: "タスク",
      keys: ["x"],
      run: second,
    });
    keymap.dispatch(makeEvent({ key: "x" }), makeContext());
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);

    unregister();
    expect(keymap.get("a")).toBeUndefined();
  });
});

describe("Keymap：キーの重複の検出（4-修正1の5）", () => {
  it("同じ場面で同じキーを別の id に登録すると例外。何も登録されない", () => {
    const keymap = new Keymap();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["x"], run: vi.fn() });
    expect(() =>
      keymap.register({ id: "b", label: "B", group: "タスク", keys: ["x"], run: vi.fn() }),
    ).toThrow();
    expect(keymap.get("b")).toBeUndefined();
  });

  it("英字は大文字小文字を区別しない：D と d は重なる", () => {
    const keymap = new Keymap();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["d"], run: vi.fn() });
    expect(() =>
      keymap.register({ id: "b", label: "B", group: "タスク", keys: ["D"], run: vi.fn() }),
    ).toThrow();
  });

  it("Shift+d と d は重ならない", () => {
    const keymap = new Keymap();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["d"], run: vi.fn() });
    expect(() =>
      keymap.register({ id: "b", label: "B", group: "タスク", keys: ["Shift+d"], run: vi.fn() }),
    ).not.toThrow();
  });

  it("Mod+z と z は重ならない", () => {
    const keymap = new Keymap();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["z"], run: vi.fn() });
    expect(() =>
      keymap.register({ id: "b", label: "B", group: "タスク", keys: ["Mod+z"], run: vi.fn() }),
    ).not.toThrow();
  });

  it("scope が違えば重ならない", () => {
    const keymap = new Keymap();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["x"], run: vi.fn() });
    expect(() =>
      keymap.register({
        id: "b",
        label: "B",
        group: "タスク",
        keys: ["x"],
        scope: "別の場面",
        run: vi.fn(),
      }),
    ).not.toThrow();
  });

  it("同じ id の登録し直しは置き換えで、例外にならない", () => {
    const keymap = new Keymap();
    keymap.register({ id: "a", label: "A", group: "タスク", keys: ["x"], run: vi.fn() });
    expect(() =>
      keymap.register({ id: "a", label: "A2", group: "タスク", keys: ["x"], run: vi.fn() }),
    ).not.toThrow();
  });

  it("1回の register に渡した配列の中どうしの重なりも例外", () => {
    const keymap = new Keymap();
    expect(() =>
      keymap.register([
        { id: "a", label: "A", group: "タスク", keys: ["x"], run: vi.fn() },
        { id: "b", label: "B", group: "タスク", keys: ["x"], run: vi.fn() },
      ]),
    ).toThrow();
  });

  it("4 の割り当て（CORE_KEY_BINDINGS）どうしに重なりがない", () => {
    const keymap = new Keymap();
    expect(() => keymap.register(CORE_KEY_BINDINGS)).not.toThrow();
  });
});
