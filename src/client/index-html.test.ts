import { describe, expect, it } from "vitest";
import indexHtml from "../../index.html?raw";
import { SIDEBAR_STORAGE_KEY } from "./shell/sidebar-state";

/**
 * チケット20：index.html の小さなスクリプト。サイドバーを畳んでいたら（localStorage の nagi:sidebar が "rail"）、
 * <html> に data-sidebar="rail" を付けて、JavaScript の本体が届く前の最初の描画から帯の幅で描く。
 * localStorage が読めなくても、止まらずに広げた幅で描く
 */

function scriptOf(html: string): string {
  // 属性のない <script>（本体の <script type="module" src=...> は含まない）
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error("script が見つかりません");
  return match[1];
}

/** script の中身を、localStorage と document を偽物にして実行し、<html> の dataset を返す */
function runScript(localStorage: unknown): Record<string, string> {
  const documentElement = { dataset: {} as Record<string, string> };
  new Function("localStorage", "document", scriptOf(indexHtml))(localStorage, { documentElement });
  return documentElement.dataset;
}

/** 決まった値を返す偽の localStorage（読んだキーを控える） */
function storageWith(value: string | null) {
  const keys: string[] = [];
  return {
    keys,
    getItem: (key: string) => {
      keys.push(key);
      return value;
    },
  };
}

it("<head> の中の、属性のない <script> にある（本体を待たずに、最初の描画の前に動く）", () => {
  const head = indexHtml.slice(0, indexHtml.indexOf("</head>"));
  expect(head).toContain("<script>");
  expect(head).not.toContain("<script type");
});

describe("畳んでいたら data-sidebar を付ける", () => {
  it('nagi:sidebar が rail なら、<html> に data-sidebar="rail" を付ける', () => {
    expect(runScript(storageWith("rail"))).toEqual({ sidebar: "rail" });
  });

  it.each([
    ["ないとき", null],
    ["空のとき", ""],
    ["ほかの値のとき", "full"],
    ["大文字の RAIL のとき", "RAIL"],
  ])("nagi:sidebar が%s、何も付けない", (_label, value) => {
    expect(runScript(storageWith(value))).toEqual({});
  });

  it("読むキーは sidebar-state.ts と同じ（SIDEBAR_STORAGE_KEY）", () => {
    const storage = storageWith("rail");
    runScript(storage);
    expect(storage.keys).toEqual([SIDEBAR_STORAGE_KEY]);
  });
});

describe("localStorage が読めないとき", () => {
  it("getItem が例外を投げても止まらず、何も付けない（広げた幅で描く）", () => {
    const storage = {
      getItem: () => {
        throw new DOMException("storage is disabled", "SecurityError");
      },
    };
    expect(() => runScript(storage)).not.toThrow();
    expect(runScript(storage)).toEqual({});
  });

  it("localStorage に触れるだけで例外を投げても止まらない", () => {
    const storage = new Proxy(
      {},
      {
        get: () => {
          throw new DOMException("storage is disabled", "SecurityError");
        },
      },
    );
    expect(() => runScript(storage)).not.toThrow();
    expect(runScript(storage)).toEqual({});
  });
});
