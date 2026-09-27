import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { defer, loadUntilLoaded, useDeferred } from "./deferred";

/**
 * チケット8：後から読み込む部品（defer・useDeferred）。
 * 読み込み前は undefined、needed になったら読み込みを始め、届いたら描き直す。
 * 先読み（preloadDeferred）で先に届いたときも、使っている部品を描き直す
 */

function deferredModule<T>(value: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  const deferred = defer(() => promise);
  return { deferred, resolve: () => resolve(value) };
}

describe("useDeferred", () => {
  it("needed のあいだ、読み込み前は undefined。届くと描き直されて値になる", async () => {
    const { deferred, resolve } = deferredModule({ hello: "world" });
    const { result, rerender } = renderHook(() => useDeferred(deferred));
    expect(result.current.module).toBeUndefined();

    resolve();
    await vi.waitFor(() => expect(deferred.current).toEqual({ hello: "world" }));
    rerender();
    expect(result.current.module).toEqual({ hello: "world" });
  });

  it("needed が false のあいだは読み込みを始めない", async () => {
    const { deferred } = deferredModule({ ok: true });
    const load = vi.spyOn(deferred, "load");
    renderHook(() => useDeferred(deferred, false));
    await Promise.resolve();
    expect(load).not.toHaveBeenCalled();
  });

  it("先読み（load を直接呼ぶ）で先に届いていれば、使うときに待たずに値が入る", async () => {
    const { deferred, resolve } = deferredModule({ preloaded: true });
    resolve();
    await deferred.load();

    const { result } = renderHook(() => useDeferred(deferred));
    expect(result.current.module).toEqual({ preloaded: true });
  });

  it("先読みが、すでに使っている部品の描き直しにも届く（subscribe 経由）", async () => {
    const { deferred, resolve } = deferredModule({ later: true });
    const { result } = renderHook(() => useDeferred(deferred, false));
    expect(result.current.module).toBeUndefined();

    // ほかの場所からの先読み（needed=false のこの部品は自分では load を呼ばないが、subscribe しているので描き直る）
    resolve();
    await act(async () => {
      await deferred.load();
    });
    expect(result.current.module).toEqual({ later: true });
  });
});

describe("defer", () => {
  it("load は何度呼んでも importer を1回だけ呼ぶ", async () => {
    const importer = vi.fn(() => Promise.resolve({ once: true }));
    const deferred = defer(importer);
    await Promise.all([deferred.load(), deferred.load(), deferred.load()]);
    expect(importer).toHaveBeenCalledTimes(1);
    expect(deferred.current).toEqual({ once: true });
  });

  it("失敗したら、次に load を呼んだときにもう一度読み込む", async () => {
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error("失敗"))
      .mockResolvedValueOnce({ retried: true });
    const deferred = defer(importer);
    await expect(deferred.load()).rejects.toThrow("失敗");
    await expect(deferred.load()).resolves.toEqual({ retried: true });
    expect(importer).toHaveBeenCalledTimes(2);
  });
});

describe("loadUntilLoaded（Motion の機能）", () => {
  it("読み込めなかったら、つながり直したときに読み直し、届いたら resolve する", async () => {
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error("失敗"))
      .mockResolvedValueOnce({ features: true });
    const deferred = defer(importer);
    let loaded: unknown;
    void loadUntilLoaded(deferred).then((module) => {
      loaded = module;
    });
    await vi.waitFor(() => expect(deferred.state.failed).toBe(true));
    expect(loaded).toBeUndefined();

    window.dispatchEvent(new Event("online"));
    await vi.waitFor(() => expect(loaded).toEqual({ features: true }));
    expect(importer).toHaveBeenCalledTimes(2);
  });
});
