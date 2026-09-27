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
import { DURATION } from "@/lib/motion";
import { type DraftChange, DraftStorage } from "./draft-storage";
import { Toaster } from "./toaster";

/**
 * 画面側の一覧の状態。画面（リスト）ごとの中身は ListView で受け取り、状態は1つだけ持つ。
 * - 選択中：ふだんは1つ（↑↓ で動かす）。⇧↑↓ で範囲を広げ、⌘クリックで1行ずつ足し引きできる。
 *   選択の中の1行は「カーソル」（selectedId。↑↓ の起点で、ポップオーバーはこの行から広がる）。
 *   キーの操作は、選んでいるすべての行に働く
 * - ボード（まとまりに列 column のある一覧）では、↑↓・⇧↑↓ は同じ列の中だけを動き、←→ で隣の列へ移る
 * - 開いているタスク：1つ（その場で下に広がる）
 * - 追加欄：開いているか、下書き
 * - 閉じられるまとまり（今日の「完了 N件」）の開閉
 * - 下書き（追加欄・戻ってきた追加・保存できなかったタイトルとメモ）。localStorage にも残す（draft-storage.ts）
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
  /**
   * 並び方（features/sort。手動以外）で並べ替えて見せている、並べ替えられるまとまり。選択は表示の並びのとおりに動くが、
   * ⌥↑↓ とドラッグの並べ替えは止め、「手動の並びのときに使えます」と知らせる（rank は表示の並びと違うため）
   */
  sorted?: boolean;
  /**
   * ボードの列の名前（例：`notStarted`）。列のある一覧では、↑↓・⇧↑↓ は同じ列の中だけを動き、
   * ←→（moveColumn）で隣の列へ移る。1つの列に、見出しの付いたまとまりをいくつ並べてもよい
   */
  column?: string;
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

/** 保存できなかったときに出す知らせの文言 */
export type FailureMessage = { title: string; description?: string };

/**
 * その操作が保存できなかったときの知らせを、操作の側で決める（汎用の「保存できませんでした」の代わりに1つだけ出す）。
 * null を返すと汎用の知らせになる
 */
export type FailureHandler = (
  reason: Extract<Notice, { type: "save-failed" }>["reason"],
) => FailureMessage | null | Promise<FailureMessage | null>;

export type ListUiOptions = {
  /** 下書きの置き場（既定は localStorage） */
  drafts?: DraftStorage;
};

/**
 * ⌘Z（元に戻す）が、ほかの画面の変更とぶつかって戻せなかった知らせか。データ層は送らずに止め、
 * 種類が "undo" で中身が空の操作だけを discarded に入れて知らせる（data/notices.ts）
 */
function isUndoConflict(notice: Extract<Notice, { type: "save-failed" }>): boolean {
  return (
    notice.reason === "conflict" &&
    notice.discarded.length > 0 &&
    notice.discarded.every((operation) => operation.kind === "undo")
  );
}

function sameSections(a: readonly TaskSection[], b: readonly TaskSection[]): boolean {
  return (
    a.length === b.length &&
    a.every((section, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        section.key === other.key &&
        section.heading === other.heading &&
        section.column === other.column &&
        section.sorted === other.sorted &&
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
  /**
   * 編集を受け付けない（新しいバージョンへ読み込み直すまで）。タスクを開けず、追加欄も開けない。
   * 打った文字を、読み込み直す前に下書きへ残しきるため
   */
  editingLocked = false;

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
  /**
   * 選択中の行が一覧の何番目だったか（行が消えたときに、同じ位置の行を選ぶ）。
   * 列のある一覧では、列の中の何番目か
   */
  #lastIndex = -1;
  /** 列のある一覧で、最後にいた列（何も選んでいないときの ↑↓ と、行が消えたときの選び直しに使う） */
  #column: string | null = null;
  /** ⇧↑↓ で広げる範囲の起点 */
  #anchorId: string | null = null;
  /** ⌘クリックで足した行（⇧↑↓ の範囲とは別に、選んだままにする） */
  #base: ReadonlySet<string> = new Set();
  /** ⌘K の検索で選んだタスク。そのリストが開いたら（開いていれば今すぐ）選ぶ */
  #reveal: { taskId: string; viewKey: string } | null = null;
  #listElement: HTMLElement | null = null;
  /** 選んでいる行を見えるところまで動かすのを待っているタイマー（revealSelected） */
  #revealTimer: ReturnType<typeof setTimeout> | undefined;

  /** 下書きを localStorage に残す */
  readonly #drafts: DraftStorage;
  /** 保存できなかったときの知らせを、操作の側で決めるもの（操作の id → 決め方） */
  readonly #failureHandlers = new Map<string, FailureHandler>();
  /** 開いている入力欄の、まだ送っていない文字を読む（`<タスクの id>:<項目>` → 読み方） */
  readonly #editing = new Map<string, () => string | undefined>();

  constructor(store: AppStore, options: ListUiOptions = {}) {
    this.store = store;
    this.#drafts = options.drafts ?? new DraftStorage();
    // 前に開いていたときの下書きを戻す（再読み込み・ログインのし直し・新しいバージョン）
    this.addDraft = this.#drafts.loadAddDraft();
    this.#draftQueue.replace(this.#drafts.loadAddQueue());
    this.#unsavedText.replace(this.#drafts.loadUnsaved());
    makeObservable<ListUi, "applySelection" | "applyOpen">(this, {
      view: observableRef,
      selectedId: observable,
      selection: observableRef,
      openId: observable,
      adding: observable,
      addDraft: observable,
      lastAddedId: observable,
      editingLocked: observable,
      sections: computed({ equals: sameSections }),
      rows: computed({ equals: compareShallow }),
      columns: computed({ equals: compareShallow }),
      selected: computed,
      selectedIds: computed({ equals: compareShallow }),
      selectedRows: computed({ equals: compareShallow }),
      draftCount: computed,
      setView: true,
      clearView: true,
      select: true,
      moveSelection: true,
      moveColumn: true,
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
      lockEditing: true,
      unlockEditing: true,
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

  /** ボードの列の名前（左から順）。列のない一覧では空 */
  get columns(): readonly string[] {
    const columns: string[] = [];
    for (const { column } of this.sections) {
      if (column !== undefined && !columns.includes(column)) columns.push(column);
    }
    return columns;
  }

  /** その列の行（上から順。閉じているまとまりの行は入らない） */
  columnRows(column: string): readonly TaskRow[] {
    const rows: TaskRow[] = [];
    for (const section of this.sections) {
      if (section.column !== column) continue;
      if (section.fold && !this.isFoldOpen(section.key)) continue;
      rows.push(...section.rows);
    }
    return rows;
  }

  /** そのタスクの行がある列（列のない一覧や、一覧にない行なら undefined） */
  columnOf(taskId: string): string | undefined {
    return this.sectionOf(taskId)?.column;
  }

  /**
   * ids の行がすべて入っている、並べ替えられるまとまり（なければ undefined）。並び方で並べ替えて見せているまとまり
   * （sorted）も返す（⌥↑↓ とドラッグは、受けたうえで「手動の並びのときに使えます」と知らせる）
   */
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

  /**
   * ids を一覧から抜いたときに次に選ぶ行（下の行、なければ上の行）。閉じられるまとまりの中と外、
   * ボードの列はまたがない
   */
  neighborAfter(ids: readonly string[]): string | null {
    const rows = this.rows;
    const removing = new Set(ids);
    const index = rows.findIndex((row) => removing.has(row.id));
    if (index < 0) return null;
    const groups = this.#rowGroups();
    const anchorGroup = groups.get(rows[index]?.id ?? "");
    const candidate = (row: TaskRow) => !removing.has(row.id) && groups.get(row.id) === anchorGroup;
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
    this.#column = null;
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
   * ボード（列のある一覧）では、今いる列の中だけを動く。
   * 開いているタスクは閉じる
   */
  moveSelection(delta: number): void {
    let rows = this.#navigableRows();
    if (rows.length === 0) return;
    const indexOfSelected = () =>
      this.selectedId === null ? -1 : rows.findIndex((r) => r.id === this.selectedId);
    let index = indexOfSelected();
    if (delta > 0 && index === rows.length - 1 && this.view?.onReachEnd) {
      this.view.onReachEnd();
      rows = this.#navigableRows();
    } else if (delta < 0 && index === 0 && this.view?.onReachStart) {
      // 上に行が足されると、選んでいる行の位置も変わる
      this.view.onReachStart();
      rows = this.#navigableRows();
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
   * ←→（ボード）：隣の列へ移る。行のない列は飛ばす。移った先では、前の列と同じ位置（上から何番目か）の行を選ぶ
   * （先の列の行が少なければ一番下）。何も選んでいなければ、→ で行のある一番左の列、← で行のある一番右の列の
   * 一番上を選ぶ。列のない一覧では何もしない。開いているタスクは閉じる
   */
  moveColumn(delta: -1 | 1): void {
    const columns = this.columns;
    const current = this.selectedId === null ? undefined : this.columnOf(this.selectedId);
    const hasRows = (column: string) => this.columnRows(column).length > 0;
    let target: string | undefined;
    let index = 0;
    if (current === undefined) {
      const filled = columns.filter(hasRows);
      target = delta > 0 ? filled[0] : filled.at(-1);
    } else {
      index = this.columnRows(current).findIndex((row) => row.id === this.selectedId);
      const from = columns.indexOf(current);
      for (let i = from + delta; i >= 0 && i < columns.length; i += delta) {
        const column = columns[i];
        if (column !== undefined && hasRows(column)) {
          target = column;
          break;
        }
      }
    }
    if (target === undefined) return;
    const rows = this.columnRows(target);
    const id = rows[Math.min(Math.max(index, 0), rows.length - 1)]?.id ?? null;
    if (this.openId !== null && this.openId !== id) this.applyOpen(null);
    this.applySelection(id);
  }

  /**
   * ⇧↑↓：選択の範囲を広げる・縮める。起点（最初に選んだ行）からカーソルまでを選ぶ。
   * ボードでは、今いる列の中だけで広げる。何も選んでいなければ ↑↓ と同じ。開いているタスクは閉じる
   */
  extendSelection(delta: number): void {
    const rows = this.#navigableRows();
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
    if (this.editingLocked) return;
    this.adding = false;
    this.applyOpen(id);
    this.applySelection(id);
  }

  close(): void {
    this.applyOpen(null);
  }

  toggleOpen(id: string): void {
    if (this.editingLocked) return;
    if (this.openId === id) this.close();
    else this.open(id);
  }

  // --- 追加欄 -----------------------------------------------------------------------------

  startAdding(): void {
    if (!this.view || this.editingLocked) return;
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
    this.#drafts.saveAddDraft(text);
  }

  /**
   * 追加できた。下書きを空にし、戻ってきた下書きの残りがあれば次を入れる。
   * そのあいだにほかのタブが別の下書きを書いていたら、それを残す（下書きはタブのあいだで1つ）
   */
  noteAdded(id: string): void {
    this.lastAddedId = id;
    this.addDraft = this.#drafts.clearAddDraftIf(this.addDraft);
    this.#fillDraftFromQueue();
  }

  /** 保存できなかった追加の文字を、追加欄の下書きに戻す（空なら1つ目を入れ、残りは順に） */
  restoreDrafts(titles: readonly string[]): void {
    const added = titles.filter((title) => title.trim() !== "");
    if (added.length > 0) this.#draftQueue.replace(this.#drafts.appendToAddQueue(added));
    this.#fillDraftFromQueue();
  }

  // --- 保存できていないタイトルとメモ -----------------------------------------------------

  unsavedText(taskId: string, field: TextField): string | undefined {
    return this.#unsavedText.get(textKey(taskId, field));
  }

  keepUnsavedText(taskId: string, field: TextField, value: string): void {
    const key = textKey(taskId, field);
    this.#unsavedText.set(key, value);
    this.#drafts.saveUnsaved(key, value);
  }

  clearUnsavedText(taskId: string, field: TextField): void {
    const key = textKey(taskId, field);
    if (!this.#unsavedText.has(key)) return;
    this.#unsavedText.delete(key);
    this.#drafts.removeUnsaved(key);
  }

  /**
   * 開いている入力欄（タイトル・メモ）の、まだ送っていない文字を読めるようにする（use-autosave）。
   * 読み込み直す直前とページを離れるときに、persistEditing で下書きへ書く。戻り値を呼ぶとやめる
   */
  trackEditing(taskId: string, field: TextField, read: () => string | undefined): () => void {
    const key = textKey(taskId, field);
    this.#editing.set(key, read);
    return () => {
      if (this.#editing.get(key) === read) this.#editing.delete(key);
    };
  }

  /**
   * 開いている入力欄の、まだ送っていない文字を、今すぐ（同期で）下書きへ書く。
   * 下書きがすべて localStorage に残っていれば true（書けなかったものがあれば false。読み込み直すと失う）
   */
  persistEditing(): boolean {
    runInAction(() => {
      for (const [key, read] of this.#editing) {
        const value = read();
        if (value === undefined) continue;
        this.#unsavedText.set(key, value);
        this.#drafts.saveUnsaved(key, value);
      }
    });
    return this.#drafts.persisted;
  }

  /**
   * 下書きの置き場。一覧の外の欄（サイドバーのプロジェクトの名前の欄など）も、同じ置き場に残す
   * （書けなかったものがあれば persistEditing が false を返し、新しいバージョンへ自動では読み込み直さない）
   */
  get drafts(): DraftStorage {
    return this.#drafts;
  }

  // --- 新しいバージョン -------------------------------------------------------------------

  /** 編集を止める（新しいバージョンへ読み込み直すまで）。開いているタスクと追加欄を閉じる（打った文字は下書きへ） */
  lockEditing(): void {
    this.editingLocked = true;
    this.applyOpen(null);
    this.adding = false;
  }

  unlockEditing(): void {
    this.editingLocked = false;
  }

  // --- 保存できなかったときの知らせ -------------------------------------------------------

  /**
   * その操作が保存できなかったときの知らせを、汎用の「保存できませんでした」の代わりに handler で決める
   * （プロジェクトのアーカイブを断られたときなど。知らせを2つ重ねないため）。保存できたら忘れる
   */
  onSaveFailed(operationId: string, handler: FailureHandler): void {
    const { store } = this;
    if (!store.replica.pending.some((batch) => batch.operationId === operationId)) return;
    this.#failureHandlers.set(operationId, handler);
    const stop = reaction(
      () => store.replica.pending.some((batch) => batch.operationId === operationId),
      (pending) => {
        if (pending) return;
        // 捨てられたときの知らせは、送信の列から外れた直後に届くので、それを待ってから忘れる
        queueMicrotask(() => {
          this.#failureHandlers.delete(operationId);
          stop();
        });
      },
    );
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

  /**
   * 自分の操作（⇧P・e・⌘Z・並び方の切り替え）で選んでいる行の位置が変わったときに、その行が見えるところまで
   * スクロールする（↑↓ と同じく、はみ出したときだけ最小限に動かす）。キーだけで操作していて、選んだ行を見失わないように。
   * 行が別の位置へ移る動き（layout。中身は transform）が終わってから測る（途中では前の位置で測ってしまう）。
   * ほかのタブの変更や同期で並びが変わったときは呼ばない（動かさない）
   */
  revealSelected(): void {
    const list = this.#listElement;
    if (!list) return;
    // 続けて呼ばれたら、最後の1回だけ測る
    clearTimeout(this.#revealTimer);
    let waits = 0;
    const reveal = () => {
      // 待つあいだに画面が変わっていたら（一覧が入れ替わった・外れた）何もしない。新しい画面に同じタスクの行があっても、
      // そこで選んでいない行を動かさないように。行も、その一覧の中のものだけを測る
      if (list !== this.#listElement || !list.isConnected) return;
      const id = list.getAttribute("aria-activedescendant");
      const row = id === null ? null : document.getElementById(id);
      if (!row || !list.contains(row)) return;
      // まだ動いている（行を包む要素に layout の transform が残っている）なら、止まるまで待つ（長くても 0.5 秒）
      let moving = false;
      for (
        let element = row.parentElement;
        element && element !== list;
        element = element.parentElement
      ) {
        if (getComputedStyle(element).transform !== "none") moving = true;
      }
      if (moving && waits++ < 10) this.#revealTimer = setTimeout(reveal, 50);
      else row.scrollIntoView?.({ block: "nearest" });
    };
    this.#revealTimer = setTimeout(reveal, DURATION.base * 1000);
  }

  // --- 動かす -----------------------------------------------------------------------------

  /** 行が消えたときの選択の追いかけと、知らせの受け取り、ほかのタブの下書きの追いかけ。戻り値を呼ぶと止める */
  start(): () => void {
    const disposers = [
      reaction(
        () => ({
          rows: this.rows,
          // ボードでは、選んでいるカードの列も見る（s で列だけが移り、上から並べた行の順が変わらないときも、
          // 最後にいた列と列の中の位置を追いかける）
          column: this.selectedId === null ? undefined : this.columnOf(this.selectedId),
        }),
        ({ rows }) => this.#followRows(rows),
        { equals: (a, b) => a.rows === b.rows && a.column === b.column },
      ),
      this.store.subscribe((notice) => this.#onNotice(notice)),
      this.toaster.start(this.store),
      this.#drafts.subscribe((change) => this.#onDraftChange(change)),
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
    this.#lastIndex = cursor === null ? -1 : this.#indexInScope(cursor);
  }

  /**
   * 行の位置（何番目か）。列のある一覧では、その行の列の中の何番目か（その列を「最後にいた列」として覚える）
   */
  #indexInScope(id: string): number {
    const column = this.columns.length === 0 ? undefined : this.columnOf(id);
    if (column === undefined) return this.rows.findIndex((row) => row.id === id);
    this.#column = column;
    return this.columnRows(column).findIndex((row) => row.id === id);
  }

  /**
   * ↑↓・⇧↑↓ で動く範囲。列のある一覧では、今いる列（選んでいる行の列。何も選んでいなければ最後にいた列、
   * その列に行がなければ行のある一番左の列）の行だけ
   */
  #navigableRows(): readonly TaskRow[] {
    const columns = this.columns;
    if (columns.length === 0) return this.rows;
    const current =
      (this.selectedId === null ? undefined : this.columnOf(this.selectedId)) ??
      (this.#column !== null && this.columnRows(this.#column).length > 0
        ? this.#column
        : columns.find((column) => this.columnRows(column).length > 0));
    return current === undefined ? [] : this.columnRows(current);
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
   * 選択中や開いている行が一覧から消えたら（同期・元に戻す・ほかのタブ）、同じ位置の行を選ぶ
   * （ボードでは、最後にいた列の同じ位置）。
   * 複数選んでいるときは、消えた行だけを選択から外す（カーソルの行が消えたら、同じ位置の1行を選ぶ）
   */
  #followRows(rows: readonly TaskRow[]): void {
    runInAction(() => {
      if (this.openId !== null && !rows.some((row) => row.id === this.openId)) this.applyOpen(null);
      if (this.selectedId === null) return;
      const index = rows.findIndex((row) => row.id === this.selectedId);
      if (index >= 0) {
        this.#lastIndex = this.#indexInScope(this.selectedId);
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
      const scope =
        this.columns.length > 0 && this.#column !== null ? this.columnRows(this.#column) : rows;
      const fallback = scope[Math.min(this.#lastIndex, scope.length - 1)];
      this.applySelection(this.#lastIndex >= 0 && fallback ? fallback.id : null);
    });
  }

  /**
   * 行ごとのまとまりの区切り（次に選ぶ行を探すときに、またがない範囲）：
   * ボードでは列、それ以外は閉じられるまとまりの中か外か
   */
  #rowGroups(): Map<string, string> {
    const groups = new Map<string, string>();
    for (const section of this.sections) {
      const group = section.column ?? (section.fold ? "fold" : "");
      for (const row of section.rows) groups.set(row.id, group);
    }
    return groups;
  }

  /** 追加欄の下書きが空なら、戻ってきた下書きの残りの先頭を入れる（ほかのタブと合わせた最新の残りから取る） */
  #fillDraftFromQueue(): void {
    if (this.addDraft.trim() !== "") return;
    const { taken, rest } = this.#drafts.takeFromAddQueue();
    this.#draftQueue.replace(rest);
    if (taken !== undefined) this.setAddDraft(taken);
  }

  /** ほかのタブが下書きを変えたら、合わせる */
  #onDraftChange(change: DraftChange): void {
    runInAction(() => {
      switch (change.kind) {
        case "add":
          this.addDraft = change.value;
          return;
        case "add-queue":
          this.#draftQueue.replace(change.value);
          return;
        case "unsaved":
          if (change.value === null) this.#unsavedText.delete(change.key);
          else this.#unsavedText.set(change.key, change.value);
          return;
        case "cleared":
          this.addDraft = "";
          this.#draftQueue.clear();
          this.#unsavedText.clear();
          return;
      }
    });
  }

  /**
   * 送信中の操作が捨てられたら、打った文字を下書きに戻す（保存の失敗、ログインが切れた、版が古い）。
   * 保存の失敗だけはトーストで知らせる（ログインと版はそれぞれの画面・帯が受け持つ）
   */
  #onNotice(notice: Notice): void {
    if (notice.type === "offline-blocked") return;
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
    if (notice.type !== "save-failed") return;
    const generic: FailureMessage = {
      title: isUndoConflict(notice)
        ? "ほかの画面で先に変更されていたため、元に戻せませんでした"
        : notice.reason === "conflict"
          ? "ほかの画面で先に変更されていたため、保存できませんでした"
          : "保存できませんでした",
      description:
        titles.length > 0
          ? "追加した文字は、追加欄の下書きに戻しました"
          : lost.size > 0
            ? "直した文字は、そのタスクを開くと欄に戻ります"
            : undefined,
    };
    const handlers = notice.discarded.flatMap((operation) => {
      const handler = this.#failureHandlers.get(operation.operationId);
      this.#failureHandlers.delete(operation.operationId);
      return handler ? [handler] : [];
    });
    const [handler] = handlers;
    if (!handler) {
      this.toaster.error(generic.title, generic.description);
      return;
    }
    // 操作の側の文言で1つにまとめて出す（下書きに戻したことは2行目に添える）
    void Promise.resolve(handler(notice.reason))
      .catch((error: unknown) => {
        console.error(error);
        return null;
      })
      .then((message) => {
        if (!message) {
          this.toaster.error(generic.title, generic.description);
          return;
        }
        const description = [message.description, generic.description]
          .filter((line) => line !== undefined)
          .join("\n");
        this.toaster.error(message.title, description === "" ? undefined : description);
      });
  }
}
