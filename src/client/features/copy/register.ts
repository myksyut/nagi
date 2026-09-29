import { registerKeyBindings } from "@/keyboard/keymap";
import { writeClipboardText } from "@/lib/clipboard";
import { selectionForOperation } from "@/tasks/commands";
import { copiedMessage, taskClipboardText } from "./task-text";

/**
 * 21 の登録：⇧⌘C で、選んでいるタスクのタイトルとメモをクリップボードに入れる（⌘K の同じ名前の操作も）。
 * 形は task-text.ts。入れたら画面下のトーストで知らせ、入れられなかったら「コピーできませんでした」。
 * 一覧とボードで選んでいるタスクが対象（入力欄とポップオーバーの中では、ほかのタスクのキーと同じく効かない）。
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
    const text = taskClipboardText(rows);
    const message = copiedMessage(rows);
    void writeClipboardText(text).then((copied) => {
      if (copied) ui.toaster.notice(message);
      else ui.toaster.error("コピーできませんでした");
    });
  },
});
