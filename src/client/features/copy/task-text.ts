import type { TaskRow } from "@/data";

/** 何件かのタスクのあいだにはさむ行（メモの中の空の行と見分けられるように） */
const SEPARATOR = "\n\n---\n\n";

/**
 * タスクをクリップボードに入れる形（⇧⌘C。チケット21）。1件ずつ、1行目にタイトル、空の行をはさんでメモ
 * （メモが空ならタイトルだけ）。メモの先頭の空の行と末尾の空白は落とす（最初の行の字下げは残す）。
 * 何件かあるときは、渡した順に並べ、あいだに「---」の行をはさむ
 */
export function taskClipboardText(tasks: readonly Pick<TaskRow, "title" | "memo">[]): string {
  return tasks
    .map(({ title, memo }) => {
      // 空白（全角の空白・ノーブレークスペースも）だけの行を先頭から落とす
      const body = memo.replace(/^(?:[^\S\n]*\n)+/, "").trimEnd();
      return body === "" ? title.trim() : `${title.trim()}\n\n${body}`;
    })
    .join(SEPARATOR);
}

/** コピーしたときのトーストの文言 */
export function copiedMessage(tasks: readonly Pick<TaskRow, "memo">[]): string {
  if (tasks.length > 1) return `${tasks.length}件のタイトルとメモをコピーしました`;
  return tasks[0]?.memo.trim() ? "タイトルとメモをコピーしました" : "タイトルをコピーしました";
}
