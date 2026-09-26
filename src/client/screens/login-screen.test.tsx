import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { LoginScreen } from "./login-screen";

function renderAt(path: string) {
  const location = memoryLocation({ path, record: true });
  render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <LoginScreen />
    </Router>,
  );
}

describe("LoginScreen", () => {
  it("「GitHub でログイン」は /auth/login へのリンク", () => {
    renderAt("/login");
    expect(screen.getByRole("link", { name: "GitHub でログイン" })).toHaveAttribute(
      "href",
      "/auth/login",
    );
  });

  it("error がなければ何も出ない", () => {
    renderAt("/login");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("error=forbidden は専用の文言", () => {
    renderAt("/login?error=forbidden");
    expect(screen.getByRole("alert")).toHaveTextContent("このアカウントではログインできません");
  });

  it("error=config は専用の文言", () => {
    renderAt("/login?error=config");
    expect(screen.getByRole("alert")).toHaveTextContent("ログインの設定が済んでいません");
  });

  it.each(["state", "github", "something-else"])("error=%s はそれ以外の文言", (error) => {
    renderAt(`/login?error=${error}`);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "ログインできませんでした。もう一度お試しください",
    );
  });

  it("サイドバーは出ない", () => {
    renderAt("/login");
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "今日" })).not.toBeInTheDocument();
  });
});
