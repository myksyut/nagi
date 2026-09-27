import { afterEach, describe, expect, it, vi } from "vitest";
import { DraftStorage } from "./draft-storage";

/**
 * 下書きの localStorage への保存（8）。追加欄の下書き・戻ってきた追加の残り・
 * 保存できなかったタイトルとメモが、キーを分けて残ることを確かめる
 */

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("追加欄の下書き（nagi:draft:add）", () => {
  it("保存して、別のインスタンスからも読める（再読み込み・作り直しの代わり）", () => {
    new DraftStorage().saveAddDraft("書いている途中");
    expect(new DraftStorage().loadAddDraft()).toBe("書いている途中");
  });

  it("空文字を保存するとキーが消え、読み込みは空文字に戻る", () => {
    const storage = new DraftStorage();
    storage.saveAddDraft("いったん");
    storage.saveAddDraft("");
    expect(localStorage.getItem("nagi:draft:add")).toBeNull();
    expect(new DraftStorage().loadAddDraft()).toBe("");
  });
});

describe("戻ってきた追加の残り（nagi:draft:add-queue）", () => {
  it("配列のまま残り、別のインスタンスからも順番どおり読める", () => {
    new DraftStorage().saveAddQueue(["一つ目", "二つ目"]);
    expect(new DraftStorage().loadAddQueue()).toEqual(["一つ目", "二つ目"]);
  });

  it("壊れた JSON や文字列以外が混じっていても、空の配列として読める（例外にしない）", () => {
    localStorage.setItem("nagi:draft:add-queue", "{ 壊れている");
    expect(new DraftStorage().loadAddQueue()).toEqual([]);

    localStorage.setItem("nagi:draft:add-queue", JSON.stringify(["ok", 1, null, "ok2"]));
    expect(new DraftStorage().loadAddQueue()).toEqual(["ok", "ok2"]);
  });

  it("空の配列を保存するとキーが消える", () => {
    const storage = new DraftStorage();
    storage.saveAddQueue(["残り"]);
    storage.saveAddQueue([]);
    expect(localStorage.getItem("nagi:draft:add-queue")).toBeNull();
  });
});

describe("保存できなかったタイトルとメモ（nagi:draft:unsaved:）", () => {
  it("タスクごと・項目ごとに別のキーで残り、別のインスタンスからも読める", () => {
    const storage = new DraftStorage();
    storage.saveUnsaved("task-1:title", "新しいタイトル");
    storage.saveUnsaved("task-1:memo", "メモの続き");
    storage.saveUnsaved("task-2:title", "別のタスクのタイトル");

    const loaded = new Map(new DraftStorage().loadUnsaved());
    expect(loaded.get("task-1:title")).toBe("新しいタイトル");
    expect(loaded.get("task-1:memo")).toBe("メモの続き");
    expect(loaded.get("task-2:title")).toBe("別のタスクのタイトル");
  });

  it("removeUnsaved で消すと、以後は読めない", () => {
    const storage = new DraftStorage();
    storage.saveUnsaved("task-1:title", "新しいタイトル");
    storage.removeUnsaved("task-1:title");
    expect(new DraftStorage().loadUnsaved()).toEqual([]);
  });

  it("ほかの用途の localStorage のキーには触らない", () => {
    localStorage.setItem("nagi:draft:add", "追加欄の下書き");
    localStorage.setItem("something-else", "無関係");
    new DraftStorage().saveUnsaved("task-1:title", "タイトル");
    expect(new DraftStorage().loadUnsaved()).toEqual([["task-1:title", "タイトル"]]);
  });
});

describe("localStorage が使えないとき（プライベートブラウズなど）", () => {
  it("例外を投げず、メモリの控えで動く。残せていないことが persisted でわかる", () => {
    const broken: Storage = {
      length: 0,
      getItem: () => {
        throw new Error("使えない");
      },
      setItem: () => {
        throw new Error("使えない");
      },
      removeItem: () => {
        throw new Error("使えない");
      },
      clear: () => {},
      key: () => null,
    };
    const storage = new DraftStorage(broken);
    expect(storage.persisted).toBe(true);
    expect(() => storage.saveAddDraft("なにか")).not.toThrow();
    expect(storage.loadAddDraft()).toBe("なにか");
    expect(storage.persisted).toBe(false);
    expect(storage.loadUnsaved()).toEqual([]);
    // 空にすれば、残すべきものはなくなる
    storage.saveAddDraft("");
    expect(storage.persisted).toBe(true);
  });

  it("storage が null（プライベートブラウズの容量切れなど）でも例外にしない", () => {
    const storage = new DraftStorage(null);
    expect(() => storage.saveAddDraft("なにか")).not.toThrow();
    expect(storage.loadAddDraft()).toBe("なにか");
    expect(storage.persisted).toBe(false);
  });
});

// --- プロジェクトの名前の控えの列（17-修正3 の R1-b） ------------------------------------------

/** 2つのタブが共有する localStorage の代わり（中身は1つ） */
class SharedStorage {
  readonly items = new Map<string, string>();
}

/**
 * 1つのタブから見た localStorage。interruptAt 回目の読み書きのあとに、interrupt（ほかのタブの操作）を1回だけ挟む。
 * 1つの操作（足す・取る）の途中のどこでほかのタブが割り込んでも、名前が消えないことを確かめるため
 */
class TabStorage implements Storage {
  #calls = 0;
  interruptAt = 0;
  interrupt: (() => void) | null = null;

  constructor(readonly shared: SharedStorage) {}

  #touch(): void {
    this.#calls += 1;
    const run = this.interrupt;
    if (run && this.#calls === this.interruptAt) {
      this.interrupt = null;
      run();
    }
  }

  /** 割り込みを仕掛ける（数え直す） */
  arm(at: number, run: () => void): void {
    this.#calls = 0;
    this.interruptAt = at;
    this.interrupt = run;
  }

  /** A の操作が、割り込みの回数より前に終わったときは、終わったあとに B の操作をする */
  flush(): void {
    const run = this.interrupt;
    this.interrupt = null;
    run?.();
  }

  get length(): number {
    const { size } = this.shared.items;
    this.#touch();
    return size;
  }

  key(index: number): string | null {
    const key = [...this.shared.items.keys()][index] ?? null;
    this.#touch();
    return key;
  }

  getItem(key: string): string | null {
    const value = this.shared.items.get(key) ?? null;
    this.#touch();
    return value;
  }

  setItem(key: string, value: string): void {
    this.shared.items.set(key, value);
    this.#touch();
  }

  removeItem(key: string): void {
    this.shared.items.delete(key);
    this.#touch();
  }

  clear(): void {
    this.shared.items.clear();
  }
}

function twoTabs() {
  // 足すたびに時刻が進むようにする（同じミリ秒に2つのタブが足したときの順は決まらないため。
  // そのときも名前は消えないが、「古いほうを取る」を確かめるには順が決まっている必要がある）
  let clock = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => ++clock);
  const shared = new SharedStorage();
  const storageA = new TabStorage(shared);
  const storageB = new TabStorage(shared);
  return {
    storageA,
    a: new DraftStorage(storageA),
    b: new DraftStorage(storageB),
    names: () => new DraftStorage(new TabStorage(shared)).loadProjectNames(),
  };
}

/** A の操作の途中の、読み書きの n 回目ごとに B の操作を挟んで、すべての割り込み方を試す */
const SPLIT_POINTS = Array.from({ length: 12 }, (_, i) => i + 1);

describe("プロジェクトの名前の控えの列：ほかのタブが途中で割り込んでも、足した名前は消えない", () => {
  it("名前を1件ずつ別のキーに置き、古い順に読める。取ると一番古いものが出る", () => {
    const { a, names } = twoTabs();
    a.appendProjectNames(["一つ目", "二つ目"]);
    a.appendProjectNames(["三つ目"]);
    expect(names()).toEqual(["一つ目", "二つ目", "三つ目"]);
    expect(a.takeProjectName()).toEqual({ taken: "一つ目", remaining: 2 });
    expect(names()).toEqual(["二つ目", "三つ目"]);
  });

  it.each(SPLIT_POINTS)(
    "A と B が同時に足す（A の %i 回目の読み書きのあとに B）：両方残る",
    (at) => {
      const { storageA, a, b, names } = twoTabs();
      storageA.arm(at, () => b.appendProjectNames(["B の名前"]));
      a.appendProjectNames(["A の名前"]);
      storageA.flush();
      expect(names().sort()).toEqual(["A の名前", "B の名前"]);
    },
  );

  it.each(SPLIT_POINTS)(
    "A が取るあいだに B が足す（A の %i 回目のあと）：A は古い名前を取り、B の名前は残る",
    (at) => {
      const { storageA, a, b, names } = twoTabs();
      a.appendProjectNames(["saved A"]);
      storageA.arm(at, () => b.appendProjectNames(["saved B"]));
      const { taken } = a.takeProjectName();
      storageA.flush();
      expect(taken).toBe("saved A");
      expect(names()).toEqual(["saved B"]);
    },
  );

  it.each(SPLIT_POINTS)(
    "A と B が同時に取る（A の %i 回目のあとに B）：同じ名前が2つのタブに出ることはあるが、名前は消えない",
    (at) => {
      const { storageA, a, b, names } = twoTabs();
      a.appendProjectNames(["saved A", "saved B"]);
      let takenByB: string | undefined;
      storageA.arm(at, () => {
        takenByB = b.takeProjectName().taken;
      });
      const takenByA = a.takeProjectName().taken;
      storageA.flush();
      const seen = new Set([takenByA, takenByB, ...names()]);
      expect(seen.has("saved A")).toBe(true);
      expect(seen.has("saved B")).toBe(true);
    },
  );

  it("交互に足す・取るをくり返しても（毎回、途中で割り込む）、足した名前はどれも、どちらかのタブに出たか列に残る", () => {
    const { storageA, a, b, names } = twoTabs();
    const added = new Set<string>();
    const taken = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const at = (i % 6) + 1;
      if (i % 3 === 0) {
        storageA.arm(at, () => {
          const name = `B${i}`;
          added.add(name);
          b.appendProjectNames([name]);
        });
        const name = `A${i}`;
        added.add(name);
        a.appendProjectNames([name]);
        storageA.flush();
      } else if (i % 3 === 1) {
        storageA.arm(at, () => {
          const name = b.takeProjectName().taken;
          if (name !== undefined) taken.add(name);
        });
        const name = a.takeProjectName().taken;
        if (name !== undefined) taken.add(name);
        storageA.flush();
      } else {
        storageA.arm(at, () => {
          const name = `B${i}`;
          added.add(name);
          b.appendProjectNames([name]);
        });
        const name = a.takeProjectName().taken;
        if (name !== undefined) taken.add(name);
        storageA.flush();
      }
    }
    const remaining = new Set(names());
    for (const name of added) {
      expect(taken.has(name) || remaining.has(name), name).toBe(true);
    }
  });
});
