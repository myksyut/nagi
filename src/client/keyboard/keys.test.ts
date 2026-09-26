import { describe, expect, it } from "vitest";
import { formatKey, isComposingKey, isEditableTarget, matchesKey, parseKey } from "./keys";

function event(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "a",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("parseKey", () => {
  it("1文字・名前つき・修飾キーを読む", () => {
    expect(parseKey("x")).toEqual({ key: "x", mod: false, shift: false, alt: false });
    expect(parseKey("Mod+z")).toEqual({ key: "z", mod: true, shift: false, alt: false });
    expect(parseKey("Shift+d")).toEqual({ key: "d", mod: false, shift: true, alt: false });
    expect(parseKey("Mod+Backspace")).toEqual({
      key: "Backspace",
      mod: true,
      shift: false,
      alt: false,
    });
    expect(parseKey("Alt+ArrowUp")).toEqual({
      key: "ArrowUp",
      mod: false,
      shift: false,
      alt: true,
    });
  });

  it("知らない修飾キーは例外", () => {
    expect(() => parseKey("Ctrl+z")).toThrow();
  });

  it("キーがなければ例外", () => {
    expect(() => parseKey("")).toThrow();
  });

  it("+ そのものは、最後の空の要素として読む", () => {
    expect(parseKey("Mod++")).toEqual({ key: "+", mod: true, shift: false, alt: false });
  });
});

describe("matchesKey", () => {
  it("1文字のキーは修飾キーなしのときだけ当たる", () => {
    const combo = parseKey("x");
    expect(matchesKey(combo, event({ key: "x" }))).toBe(true);
    expect(matchesKey(combo, event({ key: "x", metaKey: true }))).toBe(false);
    expect(matchesKey(combo, event({ key: "x", altKey: true }))).toBe(false);
  });

  it("Ctrl を押したキーはどれにも当てない", () => {
    const combo = parseKey("x");
    expect(matchesKey(combo, event({ key: "x", ctrlKey: true }))).toBe(false);
    const modCombo = parseKey("Mod+z");
    expect(matchesKey(modCombo, event({ key: "z", metaKey: true, ctrlKey: true }))).toBe(false);
  });

  it("⌘ を押した英字は小文字で届き、Shift は書き方どおりに見る", () => {
    const combo = parseKey("Mod+z");
    expect(matchesKey(combo, event({ key: "z", metaKey: true }))).toBe(true);
    expect(matchesKey(combo, event({ key: "Z", metaKey: true }))).toBe(true);
    expect(matchesKey(combo, event({ key: "z", metaKey: true, shiftKey: true }))).toBe(false);
  });

  it("Shift+d は ⇧D にだけ当たり、d には当たらない", () => {
    const shiftD = parseKey("Shift+d");
    expect(matchesKey(shiftD, event({ key: "D", shiftKey: true }))).toBe(true);
    expect(matchesKey(shiftD, event({ key: "d", shiftKey: false }))).toBe(false);
    const plainD = parseKey("d");
    expect(matchesKey(plainD, event({ key: "d", shiftKey: false }))).toBe(true);
    expect(matchesKey(plainD, event({ key: "D", shiftKey: true }))).toBe(false);
  });

  it("記号など、1文字だが英字でないキーは大文字小文字を区別する", () => {
    const combo = parseKey("?");
    expect(matchesKey(combo, event({ key: "?" }))).toBe(true);
    expect(matchesKey(combo, event({ key: "/" }))).toBe(false);
  });

  it("名前つきのキーは shift も見る", () => {
    const combo = parseKey("ArrowUp");
    expect(matchesKey(combo, event({ key: "ArrowUp" }))).toBe(true);
    expect(matchesKey(combo, event({ key: "ArrowUp", shiftKey: true }))).toBe(false);
  });
});

describe("formatKey", () => {
  it("修飾キーと名前つきキーの表記", () => {
    expect(formatKey("Mod+z")).toBe("⌘Z");
    expect(formatKey("Shift+d")).toBe("⇧D");
    expect(formatKey("Mod+Backspace")).toBe("⌘⌫");
    expect(formatKey("Enter")).toBe("↩");
    expect(formatKey("Escape")).toBe("Esc");
    expect(formatKey("x")).toBe("X");
    expect(formatKey("?")).toBe("?");
  });
});

describe("isComposingKey", () => {
  it("isComposing か keyCode 229 のどちらかで変換中と見なす", () => {
    expect(isComposingKey({ isComposing: true, keyCode: 13 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 229 })).toBe(true);
    expect(isComposingKey({ isComposing: false, keyCode: 13 })).toBe(false);
  });
});

describe("isEditableTarget", () => {
  it("input・textarea・select・contenteditable を文字を打てる場所とする", () => {
    expect(isEditableTarget(document.createElement("textarea"))).toBe(true);
    expect(isEditableTarget(document.createElement("select"))).toBe(true);
    const input = document.createElement("input");
    expect(isEditableTarget(input)).toBe(true);
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    expect(isEditableTarget(checkbox)).toBe(false);
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(document.createElement("div"))).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
  });
});
