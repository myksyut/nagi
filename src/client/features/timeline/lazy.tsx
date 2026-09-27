import { type CSSProperties, type ReactNode, useEffect } from "react";
import { LoadFailedNote } from "@/components/waiting-input";
import { defer, useDeferred } from "@/lib/deferred";
import { TIMELINE } from "@/navigation";
import { ScreenHeading } from "@/screens/list-screen";
import { VIEW_ICONS } from "@/shell/list-icons";

/**
 * タイムラインの画面は、起動に要らないので後から読み込む（データは起動時に全件読んでいる）。
 * ふだんは起動のあとの空いた時間に先読みしてあるので、7 で開くときに待たない。
 * 先読みの前に開かれたときは、見出しだけ先に出して、届いたら画面ごと描く。読み込めなかったときは、読み直せる一行を出す
 */
const timeline = defer(() => import("./timeline-screen"));

export function LazyTimelineScreen() {
  const { module, failed, retry } = useDeferred(timeline);
  useEffect(() => {
    document.title = `${TIMELINE.label} — nagi`;
  }, []);
  if (module) return <module.TimelineScreen Heading={TimelineHeading} />;
  return (
    // 幅の上限を外す（右の枠。shell/app-shell.tsx）。読み込む前と後で見出しの幅を変えない
    <div data-wide-view="">
      <TimelineHeading />
      {failed && (
        <div className="mt-5">
          <LoadFailedNote what={TIMELINE.label} onRetry={retry} />
        </div>
      )}
    </div>
  );
}

/** 見出し（タイムラインの色のアイコンと名前）。読み込む前も、読み込んだあとも同じ形。actions に「今日」と絞り込み */
export function TimelineHeading({ actions }: { actions?: ReactNode }) {
  const { Icon, color } = VIEW_ICONS.timeline;
  return (
    <ScreenHeading
      leading={
        <span
          aria-hidden="true"
          className="list-tile grid size-7.5 flex-none place-items-center rounded-[9px]"
          style={{ "--tile": color } as CSSProperties}
        >
          <Icon className="size-4.5" strokeWidth={1.75} />
        </span>
      }
      actions={actions}
    >
      <h1 className="font-[650] text-[26px] leading-tight tracking-[-0.01em]">{TIMELINE.label}</h1>
    </ScreenHeading>
  );
}
