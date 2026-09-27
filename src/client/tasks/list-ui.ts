import {
  compareShallow,
  computed,
  makeObservable,
  observable,
  observableRef,
  reaction,
  runInAction,
} from "mobx";
import type { AppStore, Notice, TaskRow } from "@/data";
import { Toaster } from "./toaster";

/**
 * 画面側の一覧の状態。画面（リスト）ごとの中身は ListView で受け取り、状態は1つだけ持つ。
 * - 選択中：ふだんは1つ（↑↓ で動かす）。⇧↑↓ で範囲を広げ、⌘クリックで1行ずつ足し引きできる。
 *   選択の中の1行は「カーソル」（selectedId。↑↓ の起点で、ポップオーバーはこの行から広がる）。
 *   キーの操作は、選んでいるすべての行に働く
 * - 開いているタスク：1つ（その場で下に広がる）
 * - 追加欄：開いているか、下書き
 * - 閉じられるまとまり（今日の「完了 N件」）の開閉
 * データ（タスクの中身や並び）はストアが持ち、ここでは id で指すだけ
 */

export type ListKind = "inbox" | "today" | "upcoming" | "later" | "logbook" | "project";

/** 開いたタスクで直せる文字の項目 */
export type TextField = "title" | "memo";

const TEXT_FIELDS: readonly TextField[] = ["title", "memo"];

function textKey(taskId: string, field: TextField): string {
  return `${taskId}:${field}`;
}

/** n で追加する行き先 */
export type AddTarget = {
  bucket: "inbox" | "today" | "later";
  projectId?: string | null;
  /** 追加欄に小さく出す行き先（例：「今日に追加」） */
  label: string;
};

/** 一覧の中のまとまり（今日の未完了と「完了 N件」、完了ログの日ごと、6 のプロジェクトごと、など） */
export type TaskSection = {
  key: string;
  /** まとまりの見出し（完了ログの日付など）。行が1つもないまとまりは見出しも出さない */
  heading?: string;
  rows: readonly TaskRow[];
  /** 閉じられるまとまり（今日の「完了 N件」）。最初は閉じていて、閉じているあいだは行を描かず、↑↓ でも選ばない */
  fold?: { label: string };
  /**
   * 自分で決めた順（rank）で並ぶまとまり。⌥↑↓ とドラッグで、このまとまりの中で並べ替えられる
   * （今日、あとでのプロジェクトごとのまとまり、プロジェクトの画面の「今日」と「あとで」）
   */
  reorderable?: boolean;
};

/** 画面ごとの一覧の中身。画面が useListView で渡す */
export type ListView = {
  /** 画面ごとの名前（例：`today`、6 のプロジェクトなら `project:<id>`）。選択や開閉をこの名前で覚える */
  key: string;
  kind: ListKind;
  /** 上から順のまとまり。MobX の値を読んでよい（読んだ値が変わると描き直す） */
  sections: () => readonly TaskSection[];
  addTo: AddTarget;
  /** 追加欄を開くまとまり（そのまとまりの一番下に開く）。省略すると一覧の一番上 */
  addInSection?: string;
  /** ↓ で一番下の行より先へ進もうとしたとき（完了ログの続きを読み込むなど） */
  onReachEnd?: () => void;
  /** ↑ で一番上の行より先へ進もうとしたとき（完了ログの窓より新しい側を読み込む） */
  onReachStart?: () => void;
  /**
   * 描く範囲が飛んだとき（完了ログの窓の始まりが変わったとき）に変わる値。変わると、行の動きなしで一覧を描き直す
   */
  layoutKey?: () => string;
  /** そのタスクの行を一覧に出す（⌘K の検索で選んだとき。完了ログの続きを読み込むなど） */
  reveal?: (taskId: string) => void;
};

function sameSections(a: readonly TaskSection[], b: readonly TaskSection[]): boolean {
  return (
    a.length === b.length &&
    a.every((section, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        section.key === other.key &&
        section.heading === other.heading &&
        section.fold?.label === other.fold?.label &&
        compareShallow(section.rows, other.rows)
      );
    })
  );
}

export class ListUi {
  readonly store: AppStore;
  readonly toaster = new Toaster();

  view: ListView | null = null;
  /** 選択の中のカーソル（↑↓ の起点）。何も選んでいなければ null */
  selectedId: string | null = null;
  /** 選んでいる行（カーソルを含む。並びは決めない） */
  selection: ReadonlySet<string> = new Set();
  openId: string | null = null;
  adding = false;
  /** 追加欄の下書き（閉じても残る） */
  addDraft = "";
  /** 追加欄を開いてから最後に追加したタスク（Esc で閉じるとこれを選ぶ） */
  lastAddedId: string | null = null;

  /** 保存できずに戻ってきた追加の文字の残り（追加欄が空になったら、次を下書きに入れる） */
  readonly #draftQueue = observable.array<string>([], { deep: false });
  /**
   * まだ保存できていないタイトルとメモ（`<タスクの id>:<項目>` → 打った文字）。編集欄より長く持ち、
   * 保存できなかったとき（閉じたあとの失敗も）やオフラインで閉じたときに入れ、次にそのタスクを開いたら欄へ戻す
   */
  readonly #unsavedText = observable.map<string, string>();
  /** 開いているまとまり（`<画面>:<まとまり>`） */
  readonly #openFolds = observable.set<string>();
  /** 行ごとの「選択中か」「開いているか」。行は自分の id だけを観測するので、選択が動いても描き直すのは2行だけ */
  readonly #selectedFlags = observable.map<string, boolean>();
  readonly #cursorFlags = observable.map<string, boolean>();
  readonly #openFlags = observable.map<string, boolean>();
  /** 画面ごとに最後に選んでいたタスク（リストを切り替えて戻ったときに戻す） */
  readonly #selectionByView = new Map<string, string>();
  /** 選択中の行が一覧の何番目だったか（行が消えたときに、同じ位置の行を選ぶ） */
  #lastIndex = -1;
  /** ⇧↑↓ で広げる範囲の起点 */
  #anchorId: string | null = null;
  /** ⌘クリックで足した行（⇧↑↓ の範囲とは別に、選んだままにする） */
  #base: ReadonlySet<string> = new Set();
  /** ⌘K の検索で選んだタスク。そのリストが開いたら（開いていれば今すぐ）選ぶ */
  #reveal: { taskId: string; viewKey: string } | null = null;
  #listElement: HTMLElement | null = null;

  constructor(store: AppStore) {
    this.store = store;
    makeObservable<ListUi, "applySelection" | "applyOpen">(this, {
      view: observableRef,
      selectedId: observable,
      selection: observableRef,
      openId: observable,
      adding: observable,
      addDraft: observable,
      lastAddedId: observable,
      sections: computed({ equals: sameSections }),
      rows: computed({ equals: compareShallow }),
      selected: computed,
      selectedIds: computed({ equals: compareShallow }),
      selectedRows: computed({ equals: compareShallow }),
      draftCount: computed,
      setView: true,
      clearView: true,
      select: true,
      moveSelection: true,
      extendSelection: true,
      toggleInSelection: true,
      reveal: true,
      open: true,
      close: true,
      toggleOpen: true,
      startAdding: true,
      stopAdding: true,
      setAddDraft: true,
      noteAdded: true,
      restoreDrafts: true,
      keepUnsavedText: true,
      clearUnsavedText: true,
      toggleFold: true,
      applySelection: true,
      applyOpen: true,
    });
  }

  // --- 読む -------------------------------------------------------------------------------

  /** 今の画面のまとまり */
  get sections(): readonly TaskSection[] {
    return this.view?.sections() ?? [];
  }

  /** ↑↓ で選べる行（上から見えている順。閉じているまとまりの行は入らない） */
  get rows(): readonly TaskRow[] {
    const rows: TaskRow[] = [];
    for (const section of this.sections) {
      if (section.fold && !this.isFoldOpen(section.key)) continue;
      rows.push(...section.rows);
    }
    return rows;
  }

  /** 選択のカーソルの行 */
  get selected(): TaskRow | undefined {
    const id = this.selectedId;
    return id === null ? undefined : this.rows.find((row) => row.id === id);
  }

  /** 選んでいる行の id（上から見えている順） */
  get selectedIds(): readonly string[] {
    return this.selectedRows.map((row) => row.id);
  }

  /** 選んでいる行（上から見えている順） */
  get selectedRows(): readonly TaskRow[] {
    const selection = this.selection;
    if (selection.size === 0) return [];
    return this.rows.filter((row) => selection.has(row.id));
  }

  /** そのタスクの行があるまとまり（閉じているまとまりも含む） */
  sectionOf(taskId: string): TaskSection | undefined {
    return this.sections.find((section) => section.rows.some((row) => row.id === taskId));
  }

  /** ids の行がすべて入っている、並べ替えられるまとまり（なければ undefined） */
  reorderableSectionOf(ids: readonly string[]): TaskSection | undefined {
    const first = ids[0];
    const section = first === undefined ? undefined : this.sectionOf(first);
    if (!section?.reorderable) return undefined;
    const inSection = new Set(section.rows.map((row) => row.id));
    return ids.every((id) => inSection.has(id)) ? section : undefined;
  }

  /** 行ごとに「選択中か」を読む（その行の分だけ観測する） */
  isSelected(id: string): boolean {
    return this.#selectedFlags.has(id);
  }

  /** 行ごとに「選択のカーソルか」を読む（その行の分だけ観測する） */
  isCursor(id: string): boolean {
    return this.#cursorFlags.has(id);
  }

  /** 行ごとに「開いているか」を読む（その行の分だけ観測する） */
  isOpen(id: string): boolean {
    return this.#openFlags.has(id);
  }

  isFoldOpen(sectionKey: string, viewKey = this.view?.key): boolean {
    return viewKey !== undefined && this.#openFolds.has(`${viewKey}:${sectionKey}`);
  }

  /** 追加欄に戻す下書きの残りの数 */
  get draftCount(): number {
    return this.#draftQueue.length;
  }

  /** ids を一覧から抜いたときに次に選ぶ行（下の行、なければ上の行）。閉じられるまとまりの中と外はまたがない */
  neighborAfter(ids: readonly string[]): string | null {
    const rows = this.rows;
    const removing = new Set(ids);
    const index = rows.findIndex((row) => removing.has(row.id));
    if (index < 0) return null;
    const inFold = this.#foldRowIds();
    const anchorInFold = inFold.has(rows[index]?.id ?? "");
    const candidate = (row: TaskRow) =>
      !removing.has(row.id) && inFold.has(row.id) === anchorInFold;
    const below = rows.slice(index + 1).find(candidate);
    if (below) return below.id;
    const above = rows.slice(0, index).reverse().find(candidate);
    return above?.id ?? null;
  }

  // --- 画面 -------------------------------------------------------------------------------

  /** 画面が開いたとき。前の画面の選択を覚え、この画面で前に選んでいたタスクに戻す */
  setView(view: ListView): void {
    if (this.view === view) return;
    this.#rememberSelection();
    this.view = view;
    this.applyOpen(null);
    this.adding = false;
    this.lastAddedId = null;
    const remembered = this.#selectionByView.get(view.key) ?? null;
    this.applySelection(
      remembered !== null && this.rows.some((row) => row.id === remembered) ? remembered : null,
    );
    this.#applyReveal();
  }

  /** 画面が閉じたとき */
  clearView(view: ListView): void {
    if (this.view !== view) return;
    this.#rememberSelection();
    this.view = null;
    this.applyOpen(null);
    this.adding = false;
    this.applySelection(null);
  }

  // --- 選択 -------------------------------------------------------------------------------

  select(id: string | null): void {
    this.applySelection(id);
  }

  /**
   * 選択を上下に動かす。何も選んでいなければ、↓ で一番上、↑ で一番下を選ぶ。
   * 開いているタスクは閉じる
   */
  moveSelection(delta: number): void {
    let rows = this.rows;
    if (rows.length === 0) return;
    const indexOfSelected = () =>
      this.selectedId === null ? -1 : rows.findIndex((r) => r.id === this.selectedId);
    let index = indexOfSelected();
    if (delta > 0 && index === rows.length - 1 && this.view?.onReachEnd) {
      this.view.onReachEnd();
      rows = this.rows;
    } else if (delta < 0 && index === 0 && this.view?.onReachStart) {
      // 上に行が足されると、選んでいる行の位置も変わる
      this.view.onReachStart();
      rows = this.rows;
      index = indexOfSelected();
    }
    let next: number;
    if (index < 0) next = delta > 0 ? 0 : rows.length - 1;
    else next = Math.min(Math.max(index + delta, 0), rows.length - 1);
    const id = rows[next]?.id ?? null;
    if (this.openId !== null && this.openId !== id) this.applyOpen(null);
    this.applySelection(id);
  }

  /**
   * ⇧↑↓：選択の範囲を広げる・縮める。起点（最初に選んだ行）からカーソルまでを選ぶ。
   * 何も選んでいなければ ↑↓ と同じ。開いているタスクは閉じる
   */
  extendSelection(delta: number): void {
    const rows = this.rows;
    const cursor =
      this.selectedId === null ? -1 : rows.findIndex((row) => row.id === this.selectedId);
    if (cursor < 0) {
      this.moveSelection(delta);
      return;
    }
    const anchorIndex = rows.findIndex((row) => row.id === this.#anchorId);
    const anchor = anchorIndex < 0 ? cursor : anchorIndex;
    const next = Math.min(Math.max(cursor + delta, 0), rows.length - 1);
    if (this.openId !== null) this.applyOpen(null);
    const range = rows.slice(Math.min(anchor, next), Math.max(anchor, next) + 1);
    this.#setSelection(
      [...this.#base, ...range.map((row) => row.id)],
      rows[next]?.id ?? null,
      rows[anchor]?.id ?? null,
      this.#base,
    );
  }

  /**
   * ⌘クリック：その行を選択に足す・選択から外す。足した行がカーソルになる。
   * 外したときは、いちばん近い選んでいる行（同じ距離なら上）がカーソルになる
   */
  toggleInSelection(id: string): void {
    const rows = this.rows;
    const index = rows.findIndex((row) => row.id === id);
    if (index < 0) return;
    if (this.openId !== null) this.applyOpen(null);
    if (!this.selection.has(id)) {
      const next = new Set([...this.selectedIds, id]);
      this.#setSelection(next, id, id, next);
      return;
    }
    const remaining = new Set(this.selectedIds.filter((other) => other !== id));
    let cursor: string | null = null;
    let distance = Number.POSITIVE_INFINITY;
    rows.forEach((row, i) => {
      if (remaining.has(row.id) && Math.abs(i - index) < distance) {
        cursor = row.id;
        distance = Math.abs(i - index);
      }
    });
    this.#setSelection(remaining, cursor, cursor, remaining);
  }

  /**
   * ⌘K の検索で選んだタスクを、そのリスト（viewKey）で選ぶ。リストがまだ開いていなければ、開いたときに選ぶ。
   * 閉じているまとまり（今日の「完了 N件」）にあれば開き、完了ログなら続きを読み込む
   */
  reveal(taskId: string, viewKey: string): void {
    this.#reveal = { taskId, viewKey };
    this.#applyReveal();
  }

  // --- 開く -------------------------------------------------------------------------------

  open(id: string): void {
    this.adding = false;
    this.applyOpen(id);
    this.applySelection(id);
  }

  close(): void {
    this.applyOpen(null);
  }

  toggleOpen(id: string): void {
    if (this.openId === id) this.close();
    else this.open(id);
  }

  // --- 追加欄 -----------------------------------------------------------------------------

  startAdding(): void {
    if (!this.view) return;
    this.applyOpen(null);
    this.adding = true;
    this.lastAddedId = null;
    this.#fillDraftFromQueue();
  }

  /** 追加欄を閉じる。追加したタスクがあれば、最後に追加したものを選ぶ */
  stopAdding(): void {
    if (!this.adding) return;
    this.adding = false;
    const last = this.lastAddedId;
    if (last !== null && this.rows.some((row) => row.id === last)) this.applySelection(last);
  }

  setAddDraft(text: string): void {
    this.addDraft = text;
  }

  /** 追加できた。下書きを空にし、戻ってきた下書きの残りがあれば次を入れる */
  noteAdded(id: string): void {
    this.lastAddedId = id;
    this.addDraft = "";
    this.#fillDraftFromQueue();
  }

  /** 保存できなかった追加の文字を、追加欄の下書きに戻す（空なら1つ目を入れ、残りは順に） */
  restoreDrafts(titles: readonly string[]): void {
    this.#draftQueue.push(...titles.filter((title) => title.trim() !== ""));
    this.#fillDraftFromQueue();
  }

  // --- 保存できていないタイトルとメモ -----------------------------------------------------

  unsavedText(taskId: string, field: TextField): string | undefined {
    return this.#unsavedText.get(textKey(taskId, field));
  }

  keepUnsavedText(taskId: string, field: TextField, value: string): void {
    this.#unsavedText.set(textKey(taskId, field), value);
  }

  clearUnsavedText(taskId: string, field: TextField): void {
    this.#unsavedText.delete(textKey(taskId, field));
  }

  // --- まとまりの開閉 ---------------------------------------------------------------------

  toggleFold(sectionKey: string): void {
    const viewKey = this.view?.key;
    if (viewKey === undefined) return;
    const key = `${viewKey}:${sectionKey}`;
    if (this.#openFolds.has(key)) this.#openFolds.delete(key);
    else this.#openFolds.add(key);
  }

  // --- フォーカス -------------------------------------------------------------------------

  /** 一覧の要素（listbox）。キーの操作のあと、フォーカスをここへ戻す */
  registerListElement(element: HTMLElement | null): void {
    this.#listElement = element;
  }

  focusList(): void {
    this.#listElement?.focus({ preventScroll: true });
  }

  // --- 動かす -----------------------------------------------------------------------------

  /** 行が消えたときの選択の追いかけと、知らせの受け取り。戻り値を呼ぶと止める */
  start(): () => void {
    const disposers = [
      reaction(
        () => this.rows,
        (rows) => this.#followRows(rows),
      ),
      this.store.subscribe((notice) => this.#onNotice(notice)),
      this.toaster.start(this.store),
    ];
    return () => {
      for (const dispose of disposers) dispose();
    };
  }

  // --- 内部 -------------------------------------------------------------------------------

  protected applyOpen(id: string | null): void {
    if (this.openId !== null) this.#openFlags.delete(this.openId);
    this.openId = id;
    if (id !== null) this.#openFlags.set(id, true);
  }

  /** 1行だけを選ぶ（null なら何も選ばない） */
  protected applySelection(id: string | null): void {
    this.#setSelection(id === null ? [] : [id], id, id, new Set());
  }

  /** 選択を入れ替える。行ごとの「選択中か」は、変わった行の分だけ書き換える */
  #setSelection(
    ids: Iterable<string>,
    cursor: string | null,
    anchor: string | null,
    base: ReadonlySet<string>,
  ): void {
    const next = new Set(ids);
    for (const id of this.selection) if (!next.has(id)) this.#selectedFlags.delete(id);
    for (const id of next) if (!this.selection.has(id)) this.#selectedFlags.set(id, true);
    this.selection = next;
    if (this.selectedId !== cursor) {
      if (this.selectedId !== null) this.#cursorFlags.delete(this.selectedId);
      if (cursor !== null) this.#cursorFlags.set(cursor, true);
    }
    this.selectedId = cursor;
    this.#anchorId = anchor;
    this.#base = base;
    this.#lastIndex = cursor === null ? -1 : this.rows.findIndex((row) => row.id === cursor);
  }

  #applyReveal(): void {
    const request = this.#reveal;
    const view = this.view;
    if (!request || !view || view.key !== request.viewKey) return;
    this.#reveal = null;
    view.reveal?.(request.taskId);
    const section = this.sectionOf(request.taskId);
    if (!section) return;
    if (section.fold && !this.isFoldOpen(section.key)) {
      this.#openFolds.add(`${view.key}:${section.key}`);
    }
    this.adding = false;
    this.applyOpen(null);
    this.applySelection(request.taskId);
    // 開いたリストの一覧へフォーカスを移す（そのまま ↑↓ やキーの操作を続けられるように）
    this.focusList();
  }

  #rememberSelection(): void {
    if (!this.view) return;
    if (this.selectedId === null) this.#selectionByView.delete(this.view.key);
    else this.#selectionByView.set(this.view.key, this.selectedId);
  }

  /**
   * 選択中や開いている行が一覧から消えたら（同期・元に戻す・ほかのタブ）、同じ位置の行を選ぶ。
   * 複数選んでいるときは、消えた行だけを選択から外す（カーソルの行が消えたら、同じ位置の1行を選ぶ）
   */
  #followRows(rows: readonly TaskRow[]): void {
    runInAction(() => {
      if (this.openId !== null && !rows.some((row) => row.id === this.openId)) this.applyOpen(null);
      if (this.selectedId === null) return;
      const index = rows.findIndex((row) => row.id === this.selectedId);
      if (index >= 0) {
        this.#lastIndex = index;
        if (this.selection.size <= 1) return;
        const visible = new Set(rows.map((row) => row.id));
        if ([...this.selection].some((id) => !visible.has(id))) {
          const anchor = this.#anchorId;
          this.#setSelection(
            [...this.selection].filter((id) => visible.has(id)),
            this.selectedId,
            anchor !== null && visible.has(anchor) ? anchor : this.selectedId,
            new Set([...this.#base].filter((id) => visible.has(id))),
          );
        }
        return;
      }
      const fallback = rows[Math.min(this.#lastIndex, rows.length - 1)];
      this.applySelection(this.#lastIndex >= 0 && fallback ? fallback.id : null);
    });
  }

  #foldRowIds(): Set<string> {
    const ids = new Set<string>();
    for (const section of this.sections) {
      if (section.fold) for (const row of section.rows) ids.add(row.id);
    }
    return ids;
  }

  #fillDraftFromQueue(): void {
    if (this.addDraft.trim() !== "") return;
    const next = this.#draftQueue.shift();
    if (next !== undefined) this.addDraft = next;
  }

  #onNotice(notice: Notice): void {
    if (notice.type !== "save-failed") return;
    const titles = notice.failedCreates.map((create) => create.title);
    // 捨てられたタイトルとメモの変更（同じ項目が何度もあれば、最後に打ったもの）
    const lost = new Map<string, { taskId: string; field: TextField; value: string }>();
    for (const operation of notice.discarded) {
      for (const mutation of operation.mutations) {
        if (mutation.type !== "task.update") continue;
        for (const field of TEXT_FIELDS) {
          const value = mutation.changes[field];
          if (typeof value === "string") {
            lost.set(textKey(mutation.id, field), { taskId: mutation.id, field, value });
          }
        }
      }
    }
    runInAction(() => {
      this.restoreDrafts(titles);
      for (const { taskId, field, value } of lost.values()) {
        this.keepUnsavedText(taskId, field, value);
      }
    });
    this.toaster.error(
      notice.reason === "conflict"
        ? "ほかの画面で先に変更されていたため、保存できませんでした"
        : "保存できませんでした",
      titles.length > 0
        ? "追加した文字は、追加欄の下書きに戻しました"
        : lost.size > 0
          ? "直した文字は、そのタスクを開くと欄に戻ります"
          : undefined,
    );
  }
}
