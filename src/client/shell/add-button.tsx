import { PlusIcon } from "lucide-react";
import { Kbd } from "@/components/ui/kbd";
import { useKeyContext } from "@/keyboard/key-context";
import { keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";

/** 押したときに呼ぶ割り当て（n と同じ入口） */
export const ADD_BINDING_ID = "task.add";

/**
 * 右下の「＋」（すべての画面で同じ位置）。押すと n と同じ割り当てを呼ぶ（新しいタスクが入る位置に追加欄が開く。
 * 行き先・オフラインのときの扱い・読み込み前に効かないことも n と同じ）。
 * マウスを乗せると、キー（キーマップの先頭のキー。N）を左に添える。乗せると光が少し強くなる（光の要素の opacity）。
 * 押してもフォーカスを奪わない（開いている追加欄で押しても、入力を続けられる）
 */
export function AddButton() {
  const context = useKeyContext();
  const key = keymap.get(ADD_BINDING_ID)?.keys[0];
  return (
    <div className="group/fab pointer-events-none fixed right-7.5 bottom-7 z-30 flex items-center gap-3">
      {key !== undefined && (
        <Kbd
          aria-hidden="true"
          className="opacity-0 transition-opacity duration-(--duration-short) group-focus-within/fab:opacity-100 group-hover/fab:opacity-100"
        >
          {formatKey(key)}
        </Kbd>
      )}
      <button
        type="button"
        aria-label="タスクを追加"
        aria-keyshortcuts={key}
        className="pointer-events-auto relative grid size-13.5 place-items-center rounded-full bg-(image:--fab) text-white shadow-[0_10px_30px_var(--fab-shadow),inset_0_0_0_1px_rgb(255_255_255/12%)] outline-none focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-ring"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => keymap.run(ADD_BINDING_ID, context)}
      >
        {/* マウスを乗せると強くなる光（動かすのは opacity だけ） */}
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-full opacity-0 shadow-[0_0_28px_6px_var(--fab-shadow)] transition-opacity duration-(--duration-short) group-hover/fab:opacity-100"
        />
        <PlusIcon aria-hidden="true" className="relative size-6.5" strokeWidth={2} />
      </button>
    </div>
  );
}
