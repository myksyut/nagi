import { describe, expect, it } from "vitest";
import { ProjectRow } from "../../data/rows";
import { makeProject } from "../../test/fixtures";
import { pickerItems } from "./picker";

/** 6：p の候補（純粋な関数）。アーカイブ済みは候補に出さない。名前の絞り込みと「作成」の出方 */

function project(overrides: Parameters<typeof makeProject>[0] = {}): ProjectRow {
  return new ProjectRow(makeProject(overrides));
}

describe("pickerItems", () => {
  it("名前の一部で絞り込む（全角半角・大小文字を区別しない）", () => {
    const projects = [
      project({ id: "p1", name: "AIPR" }),
      project({ id: "p2", name: "dev-metrics" }),
    ];
    expect(pickerItems(projects, "aipr", null)).toEqual([
      { kind: "project", id: "p1", label: "AIPR" },
    ]);
    expect(pickerItems(projects, "ＡＩＰＲ", null)).toEqual([
      { kind: "project", id: "p1", label: "AIPR" },
    ]);
    expect(pickerItems(projects, "metrics", null)).toEqual([
      { kind: "project", id: "p2", label: "dev-metrics" },
      { kind: "create", name: "metrics", label: "「metrics」を作成" },
    ]);
  });

  it("ちょうど同じ名前がなければ、最後に「作成」を足す", () => {
    const projects = [project({ id: "p1", name: "AIPR" })];
    expect(pickerItems(projects, "AIPR新", null)).toEqual([
      { kind: "create", name: "AIPR新", label: "「AIPR新」を作成" },
    ]);
  });

  it("ちょうど同じ名前があれば「作成」を出さない", () => {
    const projects = [project({ id: "p1", name: "AIPR" })];
    expect(pickerItems(projects, "aipr", null)).toEqual([
      { kind: "project", id: "p1", label: "AIPR" },
    ]);
  });

  it("何も打っていないとき、付いていれば「プロジェクトを外す」を最後に足す", () => {
    const projects = [project({ id: "p1", name: "AIPR" })];
    expect(pickerItems(projects, "", "p1")).toEqual([
      { kind: "project", id: "p1", label: "AIPR" },
      { kind: "clear", label: "プロジェクトを外す" },
    ]);
    expect(pickerItems(projects, "", null)).toEqual([{ kind: "project", id: "p1", label: "AIPR" }]);
  });
});
