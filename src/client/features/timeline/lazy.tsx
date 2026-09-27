import { useEffect } from "react";
import { LoadFailedNote } from "@/components/waiting-input";
import { defer, useDeferred } from "@/lib/deferred";
import { TIMELINE_TITLE, TimelineHeading } from "./timeline-heading";

/**
 * タイムラインの画面は、起動に要らないので後から読み込む（データは起動時に全件読んでいる）。
 * ふだんは起動のあとの空いた時間に先読みしてあるので、7 で開くときに待たない。
 * 先読みの前に開かれたときは見出しだけを先に出し、画面が届いたら描き直す。読み込めなかったときは、読み直せる一行を出す
 */
const timeline = defer(() => import("./timeline-screen"));

export function LazyTimelineScreen() {
  const { module, failed, retry } = useDeferred(timeline);
  useEffect(() => {
    document.title = `${TIMELINE_TITLE} — nagi`;
  }, []);
  if (module) return <module.TimelineScreen />;
  return (
    <div data-wide-view="">
      <TimelineHeading />
      {failed && (
        <div className="mt-5">
          <LoadFailedNote what={TIMELINE_TITLE} onRetry={retry} />
        </div>
      )}
    </div>
  );
}
