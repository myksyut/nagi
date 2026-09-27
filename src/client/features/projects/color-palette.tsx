import { observer } from "mobx-react-lite";
import { type CSSProperties, useState } from "react";
import { useAnchoredStyle, WaitingInput } from "@/components/waiting-input";
import { type ProjectRow, useStore } from "@/data";
import { defer, useDeferred } from "@/lib/deferred";
import { PROJECT_COLOR_LABELS, projectColorOf, projectColorVar } from "@/lib/project-color";
import { ProjectDot } from "./project-dot";

/**
 * プロジェクトの画面の見出しの色の点。押すとパレット（8 色）が小さく開き、選び直せる（⌘Z で戻る）。
 * パレットの中身（Base UI の Popover）は color-palette-popup.tsx にあり、起動に要らないので後から読み込む
 * （ふだんは起動のあとの空いた時間に先読みしてある）。届く前に押したときは、待ちの欄を出す
 */

const popup = defer(() => import("./color-palette-popup"));

let nextPaletteId = 1;

/** 開いているか、閉じる途中か（消えるときのフェードのあいだも描き続ける） */
type PaletteState = { id: number; anchor: HTMLElement; open: boolean } | null;

export const ProjectColorButton = observer(function ProjectColorButton({
  project,
}: {
  project: ProjectRow;
}) {
  const store = useStore();
  const color = projectColorOf(store, project.id);
  const [palette, setPalette] = useState<PaletteState>(null);
  const { module, failed, retry } = useDeferred(popup, palette !== null, palette?.id);

  const close = () => setPalette((current) => current && { ...current, open: false });

  return (
    <>
      <button
        type="button"
        aria-label={`プロジェクトの色：${PROJECT_COLOR_LABELS[color]}`}
        title="色を変える"
        aria-haspopup="dialog"
        aria-expanded={palette?.open ?? false}
        // リストの見出しのアイコンの台と同じ形で、プロジェクトの色を淡く敷く
        className="list-tile grid size-7.5 flex-none place-items-center rounded-[9px] outline-none hover:brightness-125 focus-visible:outline-2 focus-visible:outline-ring"
        style={{ "--tile": projectColorVar(color) } as CSSProperties}
        onClick={(event) => {
          const anchor = event.currentTarget;
          // 開いているときに押したら閉じる（ポップオーバーの外を押したことにもなり、先に閉じ始めていることもある）。
          // パレットが届く前（待ちの欄）なら、フェードなしで閉じる
          setPalette((current) => {
            if (!current) return { id: nextPaletteId++, anchor, open: true };
            return popup.current ? { ...current, open: false } : null;
          });
        }}
      >
        <ProjectDot color={color} className="size-2.5" />
      </button>
      {palette &&
        (module ? (
          <module.ProjectColorPalettePopup
            key={palette.id}
            project={project}
            anchor={palette.anchor}
            open={palette.open}
            onClose={close}
            onClosed={() =>
              setPalette((current) =>
                current?.id === palette.id && !current.open ? null : current,
              )
            }
          />
        ) : (
          palette.open && (
            <PaletteWaiting
              anchor={palette.anchor}
              failed={failed}
              onRetry={retry}
              onCancel={() => {
                setPalette(null);
                palette.anchor.focus();
              }}
            />
          )
        ))}
    </>
  );
});

/** パレットが届くまでの待ちの欄（色の点のボタンの下に出す） */
function PaletteWaiting({
  anchor,
  failed,
  onRetry,
  onCancel,
}: {
  anchor: HTMLElement;
  failed: boolean;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const style = useAnchoredStyle(anchor, "start");
  return (
    <WaitingInput
      label="プロジェクトの色"
      onCancel={onCancel}
      failed={failed}
      onRetry={onRetry}
      className="w-40"
      style={style}
    />
  );
}
