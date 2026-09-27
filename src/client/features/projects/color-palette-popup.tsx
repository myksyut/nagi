import { observer } from "mobx-react-lite";
import { type KeyboardEvent, useRef } from "react";
import { Popover, PopoverPopup } from "@/components/ui/popover";
import type { ProjectRow } from "@/data";
import { FIELD_SCENE_ORDER, registerFieldKeys } from "@/keyboard/field-keys";
import {
  PROJECT_COLOR_LABELS,
  PROJECT_COLORS,
  type ProjectColor,
  projectColorOf,
} from "@/lib/project-color";
import { cn } from "@/lib/utils";
import { useUi } from "@/tasks/ui-context";
import { ProjectDot } from "./project-dot";

// 色の候補の中のキー（ショートカットのページの「候補や欄の中」）。←→↑↓ は下の onKeyDown、色はボタンなので
// Enter と Space で押すと決まる。Esc は Base UI の Popover が閉じる（onOpenChange の escape-key）
registerFieldKeys({
  id: "project-color",
  label: "プロジェクトの色の候補",
  order: FIELD_SCENE_ORDER.projectColor,
  keys: [
    { label: "色を選ぶ", keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] },
    { label: "決める", keys: ["Enter", " "] },
    { label: "閉じる", keys: ["Escape"] },
  ],
});

/**
 * プロジェクトの色の選び直し（プロジェクトの画面の見出しの色の点を押すと開く）。パレットの 8 色を小さく並べ、
 * 選ぶと updateProject で色を変える（⌘Z で戻る）。Base UI の Popover を含むので、このモジュールは後から読み込む
 * （開閉の状態と色の点のボタンは color-palette.tsx）。
 * 出るときは 100ms で押した場所から広がり、消えるときだけ 150ms でフェードする。
 * キー：←→（↑↓）で色を移り、Enter か Space で決める。Esc で閉じて色の点のボタンへ戻る
 */
export const ProjectColorPalettePopup = observer(function ProjectColorPalettePopup({
  project,
  anchor,
  open,
  onClose,
  onClosed,
}: {
  project: ProjectRow;
  /** 押した色の点のボタン（ここから広がり、閉じたらここへフォーカスを戻す） */
  anchor: HTMLElement;
  /** false なら閉じる途中（消えるときのフェードのあいだ） */
  open: boolean;
  onClose: () => void;
  /** 消えるときのフェードが終わった */
  onClosed: () => void;
}) {
  const ui = useUi();
  const current = projectColorOf(ui.store, project.id);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const initialFocus = useRef<HTMLButtonElement | null>(null);

  /** 閉じて色の点のボタンへフォーカスを戻す */
  const close = () => {
    onClose();
    if (anchor.isConnected) anchor.focus();
  };

  const choose = (color: ProjectColor) => {
    const result = ui.store.actions.updateProject(project.id, { color });
    // オフラインで受け付けられなかったときは、開いたままにする（上部の帯が知らせる）
    if (!result.ok && result.reason === "offline") return;
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    event.preventDefault();
    const index = buttons.current.indexOf(document.activeElement as HTMLButtonElement);
    const next = (Math.max(index, 0) + delta + PROJECT_COLORS.length) % PROJECT_COLORS.length;
    buttons.current[next]?.focus();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next || !open) return;
        // Esc は色の点のボタンへ戻す。外をクリックしたときは、クリックした先にフォーカスを任せる
        if (details.reason === "escape-key") close();
        else onClose();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) onClosed();
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        align="start"
        aria-label="プロジェクトの色"
        data-keymap="off"
        initialFocus={initialFocus}
        finalFocus={false}
        // 出るときは 100ms、消えるときだけ 150ms でフェードする（消えるあいだはクリックを受けない）
        className="duration-(--duration-short) data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-(--duration-exit)"
      >
        <div
          role="radiogroup"
          aria-label="プロジェクトの色"
          className="-m-1.5 grid grid-cols-4 gap-1"
          onKeyDown={onKeyDown}
        >
          {PROJECT_COLORS.map((color, i) => {
            const checked = color === current;
            return (
              // biome-ignore lint/a11y/useSemanticElements: 色の見本のボタンを、選べる色の1つとして読み上げる
              <button
                key={color}
                ref={(element) => {
                  buttons.current[i] = element;
                  if (checked) initialFocus.current = element;
                }}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-label={PROJECT_COLOR_LABELS[color]}
                title={PROJECT_COLOR_LABELS[color]}
                tabIndex={checked ? 0 : -1}
                className={cn(
                  "grid size-8 place-items-center rounded-md outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                  checked && "bg-accent ring-1 ring-glass-edge",
                )}
                onClick={() => choose(color)}
              >
                <ProjectDot color={color} className="size-3.5" />
              </button>
            );
          })}
        </div>
      </PopoverPopup>
    </Popover>
  );
});
