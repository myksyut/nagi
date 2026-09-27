import { autoProjectColor } from "@shared/palette";
import { PlusIcon } from "lucide-react";
import { action, makeObservable, observable, runInAction, when } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useId, useRef } from "react";
import { type AppStore, type Notice, useStore } from "@/data";
import { FIELD_SCENE_ORDER, registerFieldKeys } from "@/keyboard/field-keys";
import { useKeyContext } from "@/keyboard/key-context";
import { type KeyContext, keymap } from "@/keyboard/keymap";
import { isComposingKey } from "@/keyboard/keys";
import { projectPath } from "@/navigation";
import type { DraftStorage } from "@/tasks/draft-storage";
import type { ListUi } from "@/tasks/list-ui";
import { useUi } from "@/tasks/ui-context";
import { normalizeName } from "./commands";
import { ProjectDot } from "./project-dot";
import { projectScreenKey } from "./project-view";

/**
 * プロジェクトを作る（Core Flows のフロー3「プロジェクトを作る」）。
 * サイドバーの「プロジェクト」の見出しの右の ＋ か、⌘K の「プロジェクトを作成」（register.tsx の割り当て。キーはなし）で、
 * プロジェクトの一覧の一番下に名前の欄が開く。欄の左には、作ると付く色の点（作成順の色。アーカイブ済みも数に入る）。
 * - Enter で作り、そのプロジェクトの画面を開いて一覧にフォーカスを移す（そのまま n でそのプロジェクトの「あとで」に足せる）。
 *   同じ名前（p の候補と同じ比べ方。アーカイブ済み・削除済みは比べない）があれば、作らずにそのプロジェクトを開く
 * - Esc で閉じる。何も打たずに外を押しても閉じる。打った名前があるまま外を押したときは欄を残す
 * - 変換を確定する Enter では作らない。オフラインなどで受け付けられなかったら、打った名前を残して開いたままにする
 * - 打った名前は黙って消さない（ProjectCreator）：送ったあとに保存できなかった作成（保存の失敗・ログインが切れた・
 *   版が古い）の名前は、すべて控えの列（localStorage。どのタブからも同じ1つ）に残し、次に欄を開いたときに古い順に入れる。
 *   欄に打っている途中の名前は、そのタブのものとしてメモリに持ち、画面を離れるとき（閉じる・読み込み直す）、
 *   ログインが切れた・版が古いとき、名前の欄を持つ部品がなくなるとき（⌘K のログアウトなど、アプリの中でログイン画面へ
 *   移るとき）に控えの列へ移す（タイトルとメモの persistEditing と同じ考え方）。
 *   ほかのタブの Esc や作成は、自分の欄の名前にしか触らないので、こちらの名前を消さない。打っている途中の名前は上書きしない
 * 作成はデータ層の createProject（⌘Z で取り消せる。トーストは出さない。取り消したときにそのプロジェクトの画面を
 * 開いていれば、プロジェクトの画面が今日へ移る）
 */

/** ＋ と ⌘K が呼ぶ割り当て（キーはなし。register.tsx） */
export const PROJECT_CREATE_BINDING_ID = "project.create";

/**
 * 名前の欄の開閉と、打った名前。一覧の状態（ListUi）ごとに1つ。
 * 控えの列は、一覧の下書きと同じ置き場（ui.drafts。localStorage）に、名前を1件ずつ別のキーで置く
 * （ほかのタブが同時に足した・取った名前を消さない。draft-storage.ts）。欄に打っている名前はこのタブのメモリだけに持ち、
 * localStorage の共有の場所には書かない（書くと、ほかのタブが空の欄を閉じる・別の名前で作るだけで消えたり
 * 上書きされたりするため）。ストアの知らせ（保存の失敗・ログインが切れた・版が古い）で捨てられた作成は、
 * 何件あってもすべて控えの列へ入れる。知らせ・pagehide・ほかのタブの変更を受けるのは start から止めるまで
 * （名前の欄を持つ部品の寿命。止めるときに打っている名前を控えへ移す）
 */
export class ProjectCreator {
  open = false;
  name = "";
  /** 開くたびに変わる番号（開いたままもう一度開くと、欄にフォーカスを戻す） */
  focusRequest = 0;
  /** 控えの列の残り（まだ欄に入れていない、保存できなかった名前）の数 */
  returnedCount = 0;
  readonly #store: AppStore;
  readonly #drafts: DraftStorage;

  constructor(store: AppStore, drafts: DraftStorage) {
    this.#store = store;
    this.#drafts = drafts;
    this.returnedCount = drafts.loadProjectNames().length;
    makeObservable(this, {
      open: observable,
      name: observable,
      focusRequest: observable,
      returnedCount: observable,
      show: action,
      close: action,
      setName: action,
      stash: action,
      syncReturned: action,
    });
  }

  /**
   * 受け始める：ストアの知らせ、画面を離れるとき（pagehide）、ほかのタブの控えの列の変更。
   * 戻り値を呼ぶと、打っている名前を控えへ移してから止める（名前の欄を持つ部品がなくなるとき。
   * ⌘K のログアウトのように pagehide の出ない移動でも名前を失わないように）。
   * 先に pagehide や 401・409 で移していれば欄は空なので、二重には積まない
   */
  start(win: Window = window): () => void {
    const stopNotices = this.#store.subscribe((notice) => this.#onNotice(notice));
    const stash = () => this.stash();
    win.addEventListener("pagehide", stash);
    const stopDrafts = this.#drafts.subscribe((change) => {
      if (change.kind === "project-names" || change.kind === "cleared") this.syncReturned();
    }, win);
    return () => {
      this.stash();
      stopNotices();
      win.removeEventListener("pagehide", stash);
      stopDrafts();
    };
  }

  /** 開く。欄が空なら、控えの列の先頭を入れる */
  show(): void {
    this.open = true;
    this.focusRequest += 1;
    this.#fillFromReturned();
  }

  /** 閉じる（作れたとき・Esc・空のまま外を押したとき。このタブの欄の名前も消す。ほかのタブの名前と控えの列には触らない） */
  close(): void {
    this.open = false;
    this.name = "";
  }

  setName(name: string): void {
    this.name = name;
  }

  /**
   * 欄に打っている名前を控えの列の後ろへ移して、欄を閉じる（画面を離れるとき・ログインが切れた・版が古いとき）。
   * 次にどのタブで欄を開いても、その名前が入る
   */
  stash(): void {
    if (this.name.trim() !== "") {
      this.returnedCount = this.#drafts.appendProjectNames([this.name]);
    }
    this.close();
  }

  /** ほかのタブが控えの列を変えた（足した・取った・すべて消えた）。数を読み直す */
  syncReturned(): void {
    this.returnedCount = this.#drafts.loadProjectNames().length;
  }

  /** 欄が空なら、控えの列の一番古い名前を入れる（ほかのタブと合わせた最新の列から取る） */
  #fillFromReturned(): void {
    if (this.name.trim() !== "") return;
    const { taken, remaining } = this.#drafts.takeProjectName();
    this.returnedCount = remaining;
    if (taken !== undefined) this.setName(taken);
  }

  /**
   * 捨てられた作成の名前を、すべて控えの列へ。開いていて空の欄には、すぐに先頭を入れる。
   * ログインが切れた・版が古いときは、この画面ではもう作れない（ログイン画面へ移る・読み込み直す）ので、
   * 欄に打っている名前も控えの列へ移す
   */
  #onNotice(notice: Notice): void {
    if (notice.type === "offline-blocked") return;
    const names = notice.discarded.flatMap((operation) =>
      operation.mutations.flatMap((mutation) =>
        mutation.type === "project.create" ? [mutation.project.name] : [],
      ),
    );
    runInAction(() => {
      if (names.length > 0) this.returnedCount = this.#drafts.appendProjectNames(names);
      if (notice.type !== "save-failed") this.stash();
      else if (names.length > 0 && this.open) this.#fillFromReturned();
    });
  }
}

const creators = new WeakMap<ListUi, ProjectCreator>();

export function projectCreatorOf(ui: ListUi): ProjectCreator {
  let creator = creators.get(ui);
  if (!creator) {
    creator = new ProjectCreator(ui.store, ui.drafts);
    creators.set(ui, creator);
  }
  return creator;
}

/**
 * 打った名前で作る（同じ名前があれば作らずに開く）。作れたら・開いたら欄を閉じて true。
 * 空の名前や、オフラインなどで受け付けられなかったときは、欄を開いたままにして false
 */
export function submitProjectName(context: KeyContext): boolean {
  const { store, ui } = context;
  const creator = projectCreatorOf(ui);
  const name = creator.name.trim();
  if (name === "") return false;
  const key = normalizeName(name);
  let id = store.lists.projects.find((project) => normalizeName(project.name) === key)?.id;
  if (id === undefined) {
    const result = store.actions.createProject(name);
    if (!result.ok) return false;
    id = result.ids[0];
    if (id === undefined) return false;
    // 送ったあとに保存できなかったら、プロジェクトは消え（画面は今日へ移る）、名前は控えの列へ戻る（ProjectCreator）。
    // ここで決めるのは、そのときのトーストの文言だけ
    ui.onSaveFailed(result.operationId, () => ({
      title: "保存できませんでした",
      description: "作れなかったプロジェクトの名前は、＋ で開く欄に戻しました",
    }));
  }
  creator.close();
  openProject(context, id);
  return true;
}

/** プロジェクトの画面を開き、その一覧にフォーカスを移す（一覧が描かれてから） */
function openProject({ ui, navigate }: KeyContext, id: string): void {
  const previous = ui.view;
  if (previous?.key === projectScreenKey(id)) {
    ui.focusList();
    return;
  }
  // 画面を移ると、新しい一覧が描かれて ui.view が変わる（一覧の要素は、そのときには登録済み）
  when(
    () => ui.view !== null && ui.view !== previous,
    () => ui.focusList(),
  );
  navigate(projectPath(id));
}

// 名前の欄の中のキー（ショートカットのページの「候補や欄の中」）。下の NameField の onKeyDown と同じ
registerFieldKeys({
  id: "project-name",
  label: "プロジェクトの名前の欄",
  order: FIELD_SCENE_ORDER.projectName,
  keys: [
    { label: "作って開く（同じ名前があれば開く）", keys: ["Enter"] },
    { label: "やめる", keys: ["Escape"] },
  ],
});

/**
 * 「プロジェクト」の見出しの右の ＋。いつも見える（控えめな色で、マウスを乗せると明るく）。
 * 押しても、開いている名前の欄からフォーカスを奪わない（打っている名前はそのまま）
 */
export function CreateProjectButton() {
  const context = useKeyContext();
  return (
    <button
      type="button"
      aria-label="プロジェクトを作成"
      title="プロジェクトを作成"
      className="-my-1 ms-auto grid size-4.5 flex-none place-items-center rounded-[5px] text-faint-foreground outline-none hover:bg-primary/16 hover:text-primary-text focus-visible:bg-primary/16 focus-visible:text-primary-text focus-visible:outline-2 focus-visible:outline-ring"
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => keymap.run(PROJECT_CREATE_BINDING_ID, context)}
    >
      <PlusIcon aria-hidden="true" className="size-3.5" strokeWidth={2} />
    </button>
  );
}

/**
 * プロジェクトの一覧の一番下に開く名前の欄（開いているときだけ描く）。
 * サイドバーにいつも置き、置いているあいだだけ ProjectCreator を動かす（start）。なくなるとき（⌘K のログアウトで
 * ログイン画面へ移るなど）は、打っている名前を控えの列へ移して止める
 */
export const ProjectCreateField = observer(function ProjectCreateField() {
  const ui = useUi();
  const creator = projectCreatorOf(ui);
  useEffect(() => creator.start(), [creator]);
  if (!creator.open) return null;
  return (
    <li>
      <NameField creator={creator} />
    </li>
  );
});

const NameField = observer(function NameField({ creator }: { creator: ProjectCreator }) {
  const context = useKeyContext();
  const { ui } = context;
  const store = useStore();
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const offline = !store.isOnline;
  // 作ると付く色：作成順（削除済みを除き、アーカイブ済みも数に入れる）で、今あるプロジェクトの次
  const color = autoProjectColor(store.lists.projectColors.size);
  const { focusRequest } = creator;

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusRequest は、開き直したときにフォーカスを戻すためだけに使う
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: "nearest" });
  }, [focusRequest]);

  return (
    <>
      <div className="row-selected flex items-center gap-2.5 rounded-lg px-2.5 py-[7px]">
        <ProjectDot color={color} className="mx-[3.5px] size-[9px]" />
        <input
          ref={input}
          aria-label="新しいプロジェクトの名前"
          aria-describedby={hintId}
          placeholder="プロジェクト名"
          className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-faint-foreground"
          value={creator.name}
          onChange={(event) => creator.setName(event.target.value)}
          onKeyDown={(event) => {
            if (isComposingKey(event.nativeEvent)) return;
            if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
            if (event.key === "Enter") {
              event.preventDefault();
              submitProjectName(context);
            } else if (event.key === "Escape") {
              event.preventDefault();
              creator.close();
              ui.focusList();
            }
          }}
          onBlur={(event) => {
            // ウインドウを切り替えただけ（フォーカスが戻ってくる）ときは閉じない
            if (event.relatedTarget === null && !document.hasFocus()) return;
            // 何も打っていなければ閉じる。打った名前があれば残す（Enter か Esc で終える）
            if (creator.name.trim() === "") creator.close();
          }}
        />
      </div>
      <p id={hintId} className="mx-2.5 mt-1.5 mb-1 text-[11px] text-faint-foreground">
        {offline
          ? "オフラインのため、今は作れません"
          : `${creator.returnedCount > 0 ? `ほかに ${creator.returnedCount}件 ・ ` : ""}Enter で作って開く ・ Esc でやめる`}
      </p>
    </>
  );
});
