import { describe, expect, it } from "vitest";
import { readBearerToken } from "./bearer";

describe("readBearerToken", () => {
  it.each([
    ["Bearer abc123", "abc123"],
    ["bearer abc123", "abc123"],
    ["BEARER abc123", "abc123"],
    ["Bearer   abc123", "abc123"],
    // セッションのトークン（base64url）に出る文字
    ["Bearer Ab-_09", "Ab-_09"],
    ["Bearer abc.def~ghi+jkl/mno==", "abc.def~ghi+jkl/mno=="],
  ])("%s は %s", (header, expected) => {
    expect(readBearerToken(header)).toBe(expected);
  });

  it.each([
    [undefined],
    [""],
    ["Bearer"],
    ["Bearer "],
    ["abc123"],
    ["Basic abc123"],
    ["Token abc123"],
    ["Bearer abc 123"],
    ["Bearer abc123 "],
    [" Bearer abc123"],
    ["Bearer abc,123"],
  ])("%s は null", (header) => {
    expect(readBearerToken(header)).toBeNull();
  });
});
