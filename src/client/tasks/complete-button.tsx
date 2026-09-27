import { cn } from "@/lib/utils";
import { completeButtonId } from "./completion-ring";

/**
 * 行の左の丸（完了ボタン）。完了すると丸が埋まり、チェックが描かれる（約 150ms）。
 * 同時に丸から光の輪が広がる（completion-ring.ts。丸の位置を、タスクの id から作った要素の id で引く）。
 * 進行中のタスクは、丸の半分を紫で塗る（styles.css の status-in-progress）。
 * 一覧ではキーボードで x を使うので、Tab では止まらない。小さな詳細（x が効かない）では focusable にして、
 * Tab で止まり Enter・Space で押せるようにする
 */
export function CompleteButton({
  taskId,
  done,
  inProgress = false,
  title,
  onToggle,
  id = completeButtonId(taskId),
  focusable = false,
}: {
  taskId: string;
  done: boolean;
  /** 進行中（未完了で startedAt がある） */
  inProgress?: boolean;
  title: string;
  /** 押した（button は押した丸。光の輪をそこから出すときに使う） */
  onToggle: (button: HTMLButtonElement) => void;
  /** 要素の id（一覧の行の丸は completeButtonId。光の輪は、完了にしたタスクの丸をこの id で引く） */
  id?: string;
  /** Tab で止まる（小さな詳細の中）。一覧の行では止まらない */
  focusable?: boolean;
}) {
  const started = inProgress && !done;
  return (
    <button
      type="button"
      tabIndex={focusable ? 0 : -1}
      aria-label={
        done
          ? `「${title}」の完了を外す`
          : started
            ? `「${title}」を完了にする（進行中）`
            : `「${title}」を完了にする`
      }
      aria-pressed={done}
      id={id}
      data-status={done ? "completed" : started ? "in-progress" : "not-started"}
      onClick={(event) => {
        event.stopPropagation();
        onToggle(event.currentTarget);
      }}
      className={cn(
        "relative grid size-[17px] flex-none place-items-center rounded-full border-[1.6px] transition-colors",
        done
          ? "border-primary bg-primary text-primary-foreground"
          : started
            ? "status-in-progress hover:border-primary-text"
            : "border-(--circle) hover:border-primary-text",
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
