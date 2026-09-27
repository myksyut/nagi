import { defer, useDeferred } from "@/lib/deferred";
import { ListScreen } from "./list-screen";

/**
 * 完了ログの一覧は、起動に要らないので後から読み込む（データは起動時に全件読んでいる）。
 * ふだんは起動のあとの空いた時間に先読みしてあるので、5 で開くときに待たない。
 * 見出しは先に出しておき、先読みの前に開かれたときは、一覧が届いたら見出しの下に描く
 */
const logbook = defer(() => import("./logbook-screen"));

export function LazyLogbookScreen() {
  const module = useDeferred(logbook);
  return <ListScreen title="完了ログ">{module && <module.LogbookList />}</ListScreen>;
}
