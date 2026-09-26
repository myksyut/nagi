import { describe, expect, it } from "vitest";
import { shortUrl, splitUrls } from "./linkified-text";

describe("splitUrls", () => {
  it("URL を含まない文字はそのまま1つの text", () => {
    expect(splitUrls("ふつうの文字")).toEqual([{ type: "text", text: "ふつうの文字" }]);
  });

  it("URL の前後を text、URL 自体を url として分ける", () => {
    expect(splitUrls("見て https://example.com/a です")).toEqual([
      { type: "text", text: "見て " },
      { type: "url", url: "https://example.com/a" },
      { type: "text", text: " です" },
    ]);
  });

  it("URL の直後の句読点や閉じかっこは URL に含めない", () => {
    expect(splitUrls("参考。https://example.com/a。")).toEqual([
      { type: "text", text: "参考。" },
      { type: "url", url: "https://example.com/a" },
      { type: "text", text: "。" },
    ]);
    expect(splitUrls("（https://example.com/a）")).toEqual([
      { type: "text", text: "（" },
      { type: "url", url: "https://example.com/a" },
      { type: "text", text: "）" },
    ]);
  });

  it("複数の URL を分ける", () => {
    expect(splitUrls("https://a.example と https://b.example")).toEqual([
      { type: "url", url: "https://a.example" },
      { type: "text", text: " と " },
      { type: "url", url: "https://b.example" },
    ]);
  });
});

describe("shortUrl", () => {
  it("https:// と www. を落とす", () => {
    expect(shortUrl("https://www.example.com/")).toBe("example.com/");
  });

  it("短い URL はそのまま", () => {
    expect(shortUrl("https://example.com/a")).toBe("example.com/a");
  });

  it("長くセグメントが多い URL は host/…/末尾2つ に短くする", () => {
    const url = "https://github.com/myksyut/nagi/pull/412/files/very/long/path/here";
    expect(shortUrl(url)).toBe("github.com/…/path/here");
  });

  it("長いがセグメントが少ない URL は末尾を … で切る", () => {
    const url = `https://example.com/${"a".repeat(60)}`;
    const result = shortUrl(url);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBe(48);
  });
});
