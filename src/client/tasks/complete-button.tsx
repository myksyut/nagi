import { cn } from "@/lib/utils";

/**
 * 行の左の丸（完了ボタン）。完了すると丸が埋まり、チェックが描かれる（約 150ms）。
 * キーボードでは x を使うので、Tab では止まらない
 */
export function CompleteButton({
  done,
  title,
  onToggle,
}: {
  done: boolean;
  title: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={done ? `「${title}」の完了を外す` : `「${title}」を完了にする`}
      aria-pressed={done}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      className={cn(
        "relative grid size-4 flex-none place-items-center rounded-full border-[1.5px] transition-colors",
        done
          ? "border-primary bg-primary text-primary-foreground"
          : "border-muted-foreground/45 hover:border-primary",
      )}
    >
      <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true">
        {/* チェックは線を描くように出す（CSS の stroke-dashoffset。行ごとに Motion の部品を作らない） */}
        <path
          d="M4 8.5 7 11.2 12 5.2"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          strokeDasharray={1}
          strokeDashoffset={done ? 0 : 1}
          className={cn(
            "transition-[stroke-dashoffset,opacity] duration-(--duration-exit) ease-out",
            done ? "opacity-100" : "opacity-0",
          )}
        />
      </svg>
    </button>
  );
}
