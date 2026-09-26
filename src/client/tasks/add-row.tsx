import { observer } from "mobx-react-lite";
import { useEffect, useRef } from "react";
import { isComposingKey } from "@/keyboard/keys";
import type { ListView } from "./list-ui";
import { useUi } from "./ui-context";

/**
 * 追加欄。新しいタスクが入る位置に開き、行き先を小さく出す。
 * Enter で追加して、そのまま次を打てる。Esc で閉じると、最後に追加したタスクが選ばれる。
 * 変換を確定する Enter では追加しない。ほかの場所をクリックしたら閉じる（打った文字は下書きとして残る）
 */
export const AddRow = observer(function AddRow({ view }: { view: ListView }) {
  const ui = useUi();
  const input = useRef<HTMLInputElement>(null);

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
    // オフラインなどで受け付けられなかったら、打った文字は残す（見せ方は 8）
    if (result.ok && result.ids[0] !== undefined) ui.noteAdded(result.ids[0]);
  };

  const close = () => {
    ui.stopAdding();
    ui.focusList();
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: 一覧（listbox）の中に開く追加欄のまとまり
    <div
      role="group"
      aria-label={view.addTo.label}
      className="flex min-h-9 items-center gap-2.5 rounded-md border border-primary/30 px-2.5 py-1.5 text-sm focus-within:border-primary/80 focus-within:ring-1 focus-within:ring-ring/40"
    >
      <span
        aria-hidden="true"
        className="size-4 flex-none rounded-full border-[1.5px] border-muted-foreground/45 border-dashed"
      />
      <input
        ref={input}
        aria-label={view.addTo.label}
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
        onBlur={(event) => {
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
  );
});
