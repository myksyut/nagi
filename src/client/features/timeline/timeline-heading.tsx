import { ChartNoAxesGanttIcon } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

export const TIMELINE_TITLE = "タイムライン";

/** タイムラインのアイコンと色（lucide の線のアイコンを、リストの色の緑で塗る。styles.css の --list-timeline） */
export const TIMELINE_ICON = { Icon: ChartNoAxesGanttIcon, color: "var(--list-timeline)" };

/**
 * 見出し（タイムラインの色のアイコンと名前）。actions に「今日」と絞り込みを入れる。
 * 形はリストの画面の見出し（screens/list-screen.tsx の ScreenHeading）とそろえるが、import はしない
 * （後から読み込む画面が list-screen を import すると、起動の JS の分け方が変わり、gzip で約 1.3KB 増えるため）
 */
export function TimelineHeading({ actions }: { actions?: ReactNode }) {
  const { Icon, color } = TIMELINE_ICON;
  return (
    <div className="flex min-w-0 items-end gap-3.5">
      <span
        aria-hidden="true"
        className="list-tile grid size-7.5 flex-none place-items-center rounded-[9px]"
        style={{ "--tile": color } as CSSProperties}
      >
        <Icon className="size-4.5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="font-[650] text-[26px] leading-tight tracking-[-0.01em]">
          {TIMELINE_TITLE}
        </h1>
      </div>
      {actions}
    </div>
  );
}
