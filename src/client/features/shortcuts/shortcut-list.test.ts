import { describe, expect, it } from "vitest";
import type { FieldKeyScene } from "@/keyboard/field-keys";
import type { KeyBinding } from "@/keyboard/keymap";
import { bindingSections, fieldKeySections, keyMatches } from "./shortcut-list";

/**
 * ショートカットのページの並べ方と絞り込み（純粋な関数）。画面での確かめは shortcuts-screen.test.tsx
 */

function binding(fields: Partial<KeyBinding> & Pick<KeyBinding, "id" | "label">): KeyBinding {
  return { group: "タスク", keys: [], run: () => {}, ...fields };
}

describe("keyMatches：キーの一部で絞り込む", () => {
  it("1文字は、修飾キーを除いたキーそのものに当たる（d で d と ⇧D。Esc や ↓ の名前には当たらない）", () => {
    expect(keyMatches("d", "d")).toBe(true);
    expect(keyMatches("Shift+d", "d")).toBe(true);
    expect(keyMatches("Escape", "e")).toBe(false);
    expect(keyMatches("ArrowDown", "d")).toBe(false);
    expect(keyMatches("Mod+Backspace", "d")).toBe(false);
    expect(keyMatches(" ", "a")).toBe(false);
    expect(keyMatches("?", "?")).toBe(true);
    expect(keyMatches("Alt+ArrowUp", "↑")).toBe(true);
  });

  it("修飾キーの記号1文字は、その修飾キー付きのキーに当たる", () => {
    expect(keyMatches("Mod+z", "⌘")).toBe(true);
    expect(keyMatches("z", "⌘")).toBe(false);
    expect(keyMatches("Shift+d", "⇧")).toBe(true);
  });

  it("2文字以上は、表記（⇧d・⌘z・esc）か名前（enter・cmd+z・shift+d）の一部に当たる", () => {
    expect(keyMatches("Shift+d", "⇧d")).toBe(true);
    expect(keyMatches("Mod+z", "⌘z")).toBe(true);
    expect(keyMatches("Mod+z", "cmd+z")).toBe(true);
    expect(keyMatches("Shift+d", "shift+d")).toBe(true);
    expect(keyMatches("Escape", "esc")).toBe(true);
    expect(keyMatches("Enter", "enter")).toBe(true);
    expect(keyMatches(" ", "space")).toBe(true);
    expect(keyMatches("d", "shift")).toBe(false);
  });
});

describe("bindingSections", () => {
  const bindings = [
    binding({ id: "a", label: "締切", group: "いつやる", keys: ["Shift+d"] }),
    binding({ id: "b", label: "日付を決めて予定へ", group: "いつやる", keys: ["d"] }),
    binding({ id: "c", label: "完了", group: "タスク", keys: ["x"] }),
    binding({ id: "d", label: "左の列へ", group: "移動", keys: ["ArrowLeft"], where: "ボード" }),
    binding({ id: "e", label: "キーのない操作", group: "リスト", keys: [] }),
  ];

  it("まとまりの順（タスク・いつやる・移動・リスト・全体）に、登録した順で並ぶ。キーのない操作も並ぶ", () => {
    expect(
      bindingSections(bindings, "").map((section) => [
        section.title,
        section.rows.map((row) => row.label),
      ]),
    ).toEqual([
      ["タスク", ["完了"]],
      ["いつやる", ["締切", "日付を決めて予定へ"]],
      ["移動", ["左の列へ"]],
      ["リスト", ["キーのない操作"]],
    ]);
  });

  it("決まった画面だけで効くキーは、どこでも効くキーの後ろに、効く画面ごとに並ぶ", () => {
    const rows = bindingSections(
      [
        binding({ id: "t", label: "次の週へ", group: "移動", keys: ["]"], where: "タイムライン" }),
        binding({ id: "c", label: "次の月へ", group: "移動", keys: ["]"], where: "カレンダー" }),
        binding({ id: "down", label: "下へ", group: "移動", keys: ["ArrowDown"] }),
        binding({ id: "t2", label: "前の週へ", group: "移動", keys: ["["], where: "タイムライン" }),
      ],
      "",
    ).flatMap((section) => section.rows.map((row) => row.key));
    expect(rows).toEqual(["down", "c", "t", "t2"]);
  });

  it("操作の名前・効く画面・キーで絞り込む（全角と大文字も同じに扱う）", () => {
    const labels = (filter: string) =>
      bindingSections(bindings, filter).flatMap((section) => section.rows.map((row) => row.key));
    expect(labels("締切")).toEqual(["a"]);
    expect(labels("d")).toEqual(["a", "b"]);
    expect(labels("Ｄ")).toEqual(["a", "b"]);
    expect(labels("ボード")).toEqual(["d"]);
    expect(labels("見つからない")).toEqual([]);
  });
});

describe("fieldKeySections", () => {
  const scenes: FieldKeyScene[] = [
    {
      id: "checklist",
      label: "チェックリスト",
      order: 1,
      keys: [
        { label: "次の項目へ", keys: ["Enter"] },
        { label: "空の項目を消す", keys: ["Backspace"] },
      ],
    },
    { id: "palette", label: "⌘K", order: 2, keys: [{ label: "閉じる", keys: ["Escape"] }] },
  ];

  it("場面ごとに並び、場面の名前が当たれば、その場面の操作をすべて出す", () => {
    expect(fieldKeySections(scenes, "").map((section) => section.title)).toEqual([
      "チェックリスト",
      "⌘K",
    ]);
    expect(
      fieldKeySections(scenes, "チェック").flatMap((section) => section.rows.map((r) => r.label)),
    ).toEqual(["次の項目へ", "空の項目を消す"]);
    expect(
      fieldKeySections(scenes, "esc").map((section) => [
        section.title,
        section.rows.map((row) => row.label),
      ]),
    ).toEqual([["⌘K", ["閉じる"]]]);
  });
});
