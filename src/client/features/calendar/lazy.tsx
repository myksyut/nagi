import { type CSSProperties, type ReactNode, useEffect } from "react";
import { LoadFailedNote } from "@/components/waiting-input";
import { defer, useDeferred } from "@/lib/deferred";
import { CALENDAR } from "@/navigation";
import { ScreenHeading } from "@/screens/list-screen";
import { VIEW_ICONS } from "@/shell/list-icons";

/**
 * カレンダーの画面は、起動に要らないので後から読み込む（データは起動時に全件読んでいる）。
 * ふだんは起動のあとの空いた時間に先読みしてあるので、6 で開くときに待たない。
 * 先読みの前に開かれたときは、見出しだけ先に出して、届いたら画面ごと描く。読み込めなかったときは、読み直せる一行を出す
 */
const calendar = defer(() => import("./calendar-screen"));

export function LazyCalendarScreen() {
  const { module, failed, retry } = useDeferred(calendar);
  useEffect(() => {
    document.title = `${CALENDAR.label} — nagi`;
  }, []);
  if (module) return <module.CalendarScreen Heading={CalendarHeading} />;
  return (
    // 幅の上限を外す（右の枠。shell/app-shell.tsx）。読み込む前と後で見出しの幅を変えない
    <div data-wide-view="">
      <CalendarHeading />
      {failed && (
        <div className="mt-5">
          <LoadFailedNote what="カレンダー" onRetry={retry} />
        </div>
      )}
    </div>
  );
}

/** 見出し（カレンダーの色のアイコンと名前）。読み込む前も、読み込んだあとも同じ形 */
export function CalendarHeading({
  subtitle,
  actions,
}: {
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  const { Icon, color } = VIEW_ICONS.calendar;
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
      subtitle={subtitle}
      actions={actions}
    >
      <h1 className="font-[650] text-[26px] leading-tight tracking-[-0.01em]">{CALENDAR.label}</h1>
    </ScreenHeading>
  );
}
