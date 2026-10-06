import { describe, expect, it } from "vitest";
import { OWNER_USER_ID } from "../db/schema";
import { mayUse, parseGitHubUserId, readSignupPolicy } from "./users";

describe("parseGitHubUserId", () => {
  it.each([
    ["1001", 1001],
    ["1", 1],
    ["9007199254740991", 9007199254740991], // Number.MAX_SAFE_INTEGER
  ])("%s は %i", (input, expected) => {
    expect(parseGitHubUserId(input)).toBe(expected);
  });

  it.each([
    [undefined],
    [""],
    ["0"],
    ["-5"],
    ["abc"],
    ["01"],
    ["1.5"],
    ["9007199254740993"], // MAX_SAFE_INTEGER を超える
  ])("%s は null", (input) => {
    expect(parseGitHubUserId(input)).toBeNull();
  });
});

describe("readSignupPolicy", () => {
  it("持ち主だけ（SIGNUP を書かなければ allowlist）", () => {
    expect(readSignupPolicy({ OWNER_GITHUB_USER_ID: "1001" })).toEqual({
      ownerGitHubUserId: 1001,
      open: false,
      allowed: new Set(),
    });
  });

  it("許可した人の一覧は、カンマ区切り。前後の空白・空の項目・重なりは無視する", () => {
    expect(
      readSignupPolicy({
        OWNER_GITHUB_USER_ID: "1001",
        SIGNUP: "allowlist",
        ALLOWED_GITHUB_USER_IDS: " 1002 ,1003,,1002, ",
      }),
    ).toEqual({ ownerGitHubUserId: 1001, open: false, allowed: new Set([1002, 1003]) });
  });

  it("持ち主がいなくても、許可した人がいればよい", () => {
    expect(readSignupPolicy({ ALLOWED_GITHUB_USER_IDS: "1002" })).toEqual({
      ownerGitHubUserId: null,
      open: false,
      allowed: new Set([1002]),
    });
  });

  it("open なら、持ち主も許可した人もいなくてよい", () => {
    expect(readSignupPolicy({ SIGNUP: "open" })).toEqual({
      ownerGitHubUserId: null,
      open: true,
      allowed: new Set(),
    });
  });

  it.each([
    ["SIGNUP が知らない値", { SIGNUP: "closed", OWNER_GITHUB_USER_ID: "1001" }],
    ["SIGNUP の大文字・小文字が違う", { SIGNUP: "Open" }],
    ["OWNER_GITHUB_USER_ID が数でない", { OWNER_GITHUB_USER_ID: "myksyut" }],
    ["OWNER_GITHUB_USER_ID が数でない（open でも）", { SIGNUP: "open", OWNER_GITHUB_USER_ID: "x" }],
    [
      "ALLOWED_GITHUB_USER_IDS に数でないものがある",
      { OWNER_GITHUB_USER_ID: "1001", ALLOWED_GITHUB_USER_IDS: "1002,abc" },
    ],
    [
      "ALLOWED_GITHUB_USER_IDS に 0 がある",
      { OWNER_GITHUB_USER_ID: "1001", ALLOWED_GITHUB_USER_IDS: "0" },
    ],
    ["allowlist で、だれもログインできない", {}],
    ["allowlist で、一覧が空白だけ", { ALLOWED_GITHUB_USER_IDS: " , " }],
  ])("%s なら null（設定の不備）", (_label, env) => {
    expect(readSignupPolicy(env)).toBeNull();
  });
});

describe("mayUse", () => {
  const allowlist = { ownerGitHubUserId: 1001, open: false, allowed: new Set([1002]) };
  const open = { ownerGitHubUserId: null, open: true, allowed: new Set<number>() };

  it.each([
    ["設定の持ち主", allowlist, { userId: OWNER_USER_ID, githubUserId: 1001 }, true],
    ["許可した人", allowlist, { userId: "u2", githubUserId: 1002 }, true],
    ["許可していない人", allowlist, { userId: "u3", githubUserId: 1003 }, false],
    ["open なら、だれでも", open, { userId: "u3", githubUserId: 1003 }, true],
    [
      "持ち主の行に、設定の持ち主でも許可した人でもない GitHub ユーザーが入っている",
      allowlist,
      { userId: OWNER_USER_ID, githubUserId: 2002 },
      false,
    ],
    [
      "持ち主の行に、まだ GitHub ユーザーが入っていない",
      allowlist,
      { userId: OWNER_USER_ID, githubUserId: null },
      true,
    ],
    [
      "持ち主でないのに GitHub ユーザーが入っていない（ありえない行）",
      open,
      { userId: "u9", githubUserId: null },
      false,
    ],
  ])("%s", (_label, policy, user, expected) => {
    expect(mayUse(policy, user)).toBe(expected);
  });
});
