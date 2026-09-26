import { observer } from "mobx-react-lite";
import { type FormEvent, useState } from "react";
import { type TaskRow, useStore } from "@/data";

/**
 * 仮の表示（チケット 4 で置き換える）。データ層を実際のブラウザで確かめるためだけに、
 * 今日の中身を文字で並べ、追加・完了・完了を外す・元に戻すを呼べるようにしている
 */
export const TodayPreview = observer(function TodayPreview() {
  const store = useStore();
  const [title, setTitle] = useState("");

  const add = (event: FormEvent) => {
    event.preventDefault();
    const result = store.actions.addTask({ title, bucket: "today" });
    if (result.ok) setTitle("");
  };

  return (
    <div className="mt-6 flex flex-col gap-4 text-sm">
      <p className="text-muted-foreground text-xs">
        仮の表示（{store.today}・{store.loaded ? "読み込み済み" : "読み込み中"}・
        {store.synced ? "同期済み" : "未同期"}・{store.isOnline ? "オンライン" : "オフライン"}
        ・送信中 {store.pendingCount}）
      </p>
      <form onSubmit={add}>
        <input
          aria-label="今日に追加（仮）"
          className="w-full rounded-md border border-border bg-transparent px-3 py-1.5"
          placeholder="今日に追加（仮）"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
        />
      </form>
      <ul aria-label="今日（仮）" className="flex flex-col gap-1">
        {store.lists.today.map((task) => (
          <PreviewRow key={task.id} task={task} />
        ))}
      </ul>
      <p>完了 {store.lists.completedTodayCount}件</p>
      <ul aria-label="今日完了したもの（仮）" className="flex flex-col gap-1 text-muted-foreground">
        {store.lists.completedToday.map((task) => (
          <PreviewRow key={task.id} task={task} />
        ))}
      </ul>
      <div>
        <button
          type="button"
          className="rounded-md border border-border px-2 py-1 disabled:opacity-50"
          disabled={!store.canUndo}
          onClick={() => store.actions.undo()}
        >
          元に戻す（仮）
        </button>
      </div>
    </div>
  );
});

const PreviewRow = observer(function PreviewRow({ task }: { task: TaskRow }) {
  const store = useStore();
  const done = task.completedAt !== null;
  return (
    <li className="flex items-center gap-2">
      <button
        type="button"
        className="rounded-md border border-border px-2 py-0.5 text-xs"
        onClick={() =>
          done ? store.actions.uncompleteTasks([task.id]) : store.actions.completeTasks([task.id])
        }
      >
        {done ? "外す" : "完了"}
      </button>
      <span>
        {store.lists.isArrivedToday(task) && "● "}
        {task.title}
      </span>
    </li>
  );
});
