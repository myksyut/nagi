import type { TaskRow } from "@/data";
import { registerKeyBindings } from "@/keyboard/keymap";
import { writeClipboardText } from "@/lib/clipboard";
import { selectionForOperation } from "@/tasks/commands";
import type { ListUi } from "@/tasks/list-ui";
import { copiedMessage, taskClipboardText } from "./task-text";

/**
 * 21 の登録：⇧⌘C で、選んでいるタスクのタイトルとメモをクリップボードに入れる（⌘K の同じ名前の操作も）。
 * 形は task-text.ts。入れたら画面下のトーストで知らせ、入れられなかったら「コピーできませんでした」。
 * 一覧とボードで選んでいるタスクが対象（入力欄とポップオーバーの中では、ほかのタスクのキーと同じく効かない）。
 * 保存できていないタイトルとメモがあれば、開いたときに欄に出るそちらを入れる（shownText）。
 * データは変えないので、元に戻すものはない
 */
registerKeyBindings({
  id: "task.copy",
  label: "タイトルとメモをコピー",
  group: "タスク",
  keys: ["Mod+Shift+c"],
  when: ({ ui }) => ui.selected !== undefined,
  run: ({ ui }) => {
    const rows = selectionForOperation(ui);
    if (!rows || rows.length === 0) return;
    // 文字は押したときのものを入れる（入れ終わるまでに変わっても、押したときの形のまま）
    const tasks = rows.map((row) => shownText(ui, row));
    const text = taskClipboardText(tasks);
    const message = copiedMessage(tasks);
    void writeClipboardText(text).then((copied) => {
      if (copied) ui.toaster.notice(message);
      else ui.toaster.error("コピーできませんでした");
    });
  },
});

/**
 * タスクを開いたときに欄に出る文字。保存できていない文字（オフラインで閉じた・保存に失敗した）があれば、
 * そちらを使う（use-autosave と同じ）。タイトルは空なら保存しない決まりなので、空のときは保存したほうを使う
 */
function shownText(ui: ListUi, row: TaskRow): Pick<TaskRow, "title" | "memo"> {
  const title = ui.unsavedText(row.id, "title");
  return {
    title: title !== undefined && title.trim() !== "" ? title : row.title,
    memo: ui.unsavedText(row.id, "memo") ?? row.memo,
  };
}
