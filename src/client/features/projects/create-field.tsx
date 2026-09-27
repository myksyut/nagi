import { autoProjectColor } from "@shared/palette";
import { PlusIcon } from "lucide-react";
import { action, makeObservable, observable, when } from "mobx";
import { observer } from "mobx-react-lite";
import { useEffect, useId, useRef } from "react";
import { useStore } from "@/data";
import { FIELD_SCENE_ORDER, registerFieldKeys } from "@/keyboard/field-keys";
import { useKeyContext } from "@/keyboard/key-context";
import { type KeyContext, keymap } from "@/keyboard/keymap";
import { isComposingKey } from "@/keyboard/keys";
import { projectPath } from "@/navigation";
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
 * - 変換を確定する Enter では作らない。オフラインなどで受け付けられなかったら、打った名前を残して開いたままにする。
 *   送ったあとに保存できなかったときは、打った名前を欄に戻す（次に ＋ で開くと入っている）
 * 作成はデータ層の createProject（⌘Z で取り消せる。トーストは出さない。取り消したときにそのプロジェクトの画面を
 * 開いていれば、プロジェクトの画面が今日へ移る）
 */

/** ＋ と ⌘K が呼ぶ割り当て（キーはなし。register.tsx） */
export const PROJECT_CREATE_BINDING_ID = "project.create";

/** 名前の欄の開閉と、打った名前。一覧の状態（ListUi）ごとに1つ */
export class ProjectCreator {
  open = false;
  name = "";
  /** 開くたびに変わる番号（開いたままもう一度開くと、欄にフォーカスを戻す） */
  focusRequest = 0;

  constructor() {
    makeObservable(this, {
      open: observable,
      name: observable,
      focusRequest: observable,
      show: action,
      close: action,
      setName: action,
    });
  }

  show(): void {
    this.open = true;
    this.focusRequest += 1;
  }

  /** 閉じる（打った名前も消す） */
  close(): void {
    this.open = false;
    this.name = "";
  }

  setName(name: string): void {
    this.name = name;
  }
}

const creators = new WeakMap<ListUi, ProjectCreator>();

export function projectCreatorOf(ui: ListUi): ProjectCreator {
  let creator = creators.get(ui);
  if (!creator) {
    creator = new ProjectCreator();
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
    // 送ったあとに保存できなかったら（プロジェクトは消え、画面は今日へ移る）、打った名前を欄に戻す
    ui.onSaveFailed(result.operationId, () => {
      if (creator.open && creator.name.trim() !== "") return null;
      creator.setName(name);
      return {
        title: "保存できませんでした",
        description: `「${name}」は、＋ で開く名前の欄に戻しました`,
      };
    });
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

/** プロジェクトの一覧の一番下に開く名前の欄（開いているときだけ描く） */
export const ProjectCreateField = observer(function ProjectCreateField() {
  const ui = useUi();
  const creator = projectCreatorOf(ui);
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
        {offline ? "オフラインのため、今は作れません" : "Enter で作って開く ・ Esc でやめる"}
      </p>
    </>
  );
});
