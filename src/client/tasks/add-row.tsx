import { observer } from "mobx-react-lite";
import { useEffect, useId, useRef, useState } from "react";
import { BeamLine } from "@/components/beam-line";
import { FIELD_SCENE_ORDER, registerFieldKeys } from "@/keyboard/field-keys";
import { isComposingKey } from "@/keyboard/keys";
import type { ListView } from "./list-ui";
import { useUi } from "./ui-context";

// 追加欄の中のキー（ショートカットのページの「候補や欄の中」）。下の onKeyDown と同じ
registerFieldKeys({
  id: "add-row",
  label: "追加欄",
  order: FIELD_SCENE_ORDER.addRow,
  keys: [
    { label: "追加して続けて打つ", keys: ["Enter"] },
    { label: "閉じる（最後に追加したタスクを選ぶ）", keys: ["Escape"] },
  ],
});

/**
 * 追加欄。新しいタスクが入る位置に開き、行き先を小さく出す。
 * Enter で追加して、そのまま次を打てる。Esc で閉じると、最後に追加したタスクが選ばれる。
 * 変換を確定する Enter では追加しない。ほかの場所をクリックしたら閉じる（打った文字は下書きとして残る。localStorage にも）。
 * オフラインのあいだは「オフラインのため、今は追加できません」と出す（打つことはでき、Enter では追加しない）。
 * 入力しているあいだ（フォーカスがあるあいだ）だけ、下の辺に border-beam を流す
 */
export const AddRow = observer(function AddRow({ view }: { view: ListView }) {
  const ui = useUi();
  const input = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const offline = !ui.store.isOnline;
  const offlineNoteId = useId();

  useEffect(() => {
    const element = input.current;
    if (!element) return;
    element.focus({ preventScroll: true });
    element.scrollIntoView?.({ block: "nearest" });
  }, []);

  const add = () => {
    const title = ui.addDraft.trim();
    if (title === "") return;
    const { bucket, projectId = null } = view.addTo;
    const result = ui.store.actions.addTask({ title, bucket, projectId });
    // オフラインなどで受け付けられなかったら、打った文字は下書きとして残す（オフラインなら上部の帯が強調される）
    if (result.ok && result.ids[0] !== undefined) ui.noteAdded(result.ids[0]);
  };

  const close = () => {
    ui.stopAdding();
    ui.focusList();
  };

  return (
    <BeamLine active={focused} radius={10}>
      {/* biome-ignore lint/a11y/useSemanticElements: 一覧（listbox）の中に開く追加欄のまとまり */}
      <div
        role="group"
        aria-label={view.addTo.label}
        className="flex flex-col rounded-[10px] border border-primary/35 bg-(--selection) px-3 py-2 text-sm focus-within:border-(--selection-ring) focus-within:ring-1 focus-within:ring-ring/40"
      >
        <div className="flex min-h-6 items-center gap-3">
          <span
            aria-hidden="true"
            className="size-[17px] flex-none rounded-full border-(--circle) border-[1.6px] border-dashed"
          />
          <input
            ref={input}
            aria-label={view.addTo.label}
            aria-describedby={offline ? offlineNoteId : undefined}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60"
            placeholder="新しいタスク"
            value={ui.addDraft}
            onChange={(event) => ui.setAddDraft(event.target.value)}
            onKeyDown={(event) => {
              if (isComposingKey(event.nativeEvent)) return;
              if (event.metaKey || event.ctrlKey || event.altKey) return;
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              } else if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
            onFocus={() => setFocused(true)}
            onBlur={(event) => {
              setFocused(false);
              // ウインドウを切り替えただけ（フォーカスが戻ってくる）ときは閉じない
              if (event.relatedTarget === null && !document.hasFocus()) return;
              ui.stopAdding();
            }}
          />
          <span className="flex-none text-muted-foreground text-xs">
            {ui.draftCount > 0 && `ほかに下書き ${ui.draftCount}件・`}
            {view.addTo.label}
          </span>
        </div>
        {offline && (
          <p id={offlineNoteId} className="mt-1 pl-[29px] text-muted-foreground text-xs">
            オフラインのため、今は追加できません。入力は下書きとして残ります
          </p>
        )}
      </div>
    </BeamLine>
  );
});
