import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { App } from "./app";

it("/ は今日へ移る", async () => {
  const location = memoryLocation({ path: "/", record: true });
  render(
    <Router hook={location.hook} searchHook={location.searchHook}>
      <App />
    </Router>,
  );
  expect(await screen.findByRole("heading", { name: "今日" })).toBeInTheDocument();
  expect(location.history.at(-1)).toBe("/today");
});
