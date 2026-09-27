import { LoadFailedNote } from "@/components/waiting-input";
import { defer, useDeferred } from "@/lib/deferred";

/**
 * ボードの画面は、起動に要らないので後から読み込む（起動のあとの空いた時間に先読みする）。
 * 先読みの前に開かれたときは、届いたら見出しの下に描く（届くまでは一覧がないので、キーの操作は何もしない）。
 * 読み込めなかったときは、読み直せる一行を出す
 */
const board = defer(() => import("./board"));

export type BoardTarget = { kind: "today" } | { kind: "project"; projectId: string };

export function LazyBoard({ target }: { target: BoardTarget }) {
  const { module, failed, retry } = useDeferred(board);
  if (module) {
    return target.kind === "today" ? (
      <module.TodayBoard />
    ) : (
      <module.ProjectBoard projectId={target.projectId} />
    );
  }
  if (!failed) return null;
  return (
    <div className="mt-5">
      <LoadFailedNote what="ボード" onRetry={retry} />
    </div>
  );
}
