import { useCallback, useEffect, useRef, useState } from "react";
import { type TaskRow, useStore } from "@/data";

/** 打つのが止まってから保存するまでの時間 */
export const AUTOSAVE_DELAY_MS = 500;

type Field = "title" | "memo";

/**
 * タイトルとメモの自動保存。打つのが止まったら・フォーカスが外れたら・閉じたら保存する。
 * - 保存は「元に戻す」（⌘Z）の対象にしない（入力欄の中の取り消しはブラウザの標準に任せる）
 * - 日本語の変換中は保存しない（確定してから）
 * - 入力中は、ストアの値が変わっても（同期など）打っている文字を上書きしない
 * - 保存できなかったとき（save-failed）は、打った文字を入力欄に残す
 * - 空のタイトルは保存しない（閉じると元のタイトルに戻る）
 * 部品は observer で包む（task[field] の変化を受け取るため）
 */
export function useAutosave(task: TaskRow, field: Field) {
  const store = useStore();
  const stored = task[field];
  const [draft, setDraft] = useState(stored);
  const draftRef = useRef(stored);
  /** ストアに渡していない変更がある */
  const dirty = useRef(false);
  const focused = useRef(false);
  const composing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setValue = useCallback((value: string) => {
    draftRef.current = value;
    setDraft(value);
  }, []);

  const flush = useCallback(() => {
    clearTimeout(timer.current);
    if (!dirty.current || composing.current) return;
    const value = draftRef.current;
    if (field === "title" && value.trim() === "") return;
    const current = store.task(task.id)?.peek();
    if (!current || current[field] === value) {
      dirty.current = false;
      return;
    }
    const result = store.actions.updateTask(task.id, { [field]: value }, { undoable: false });
    // オフラインなどで受け付けられなかったら、次の機会にもう一度保存する
    if (result.ok || result.reason === "noop") dirty.current = false;
  }, [store, task, field]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
  }, [flush]);

  // 入力していないあいだは、ストアの値（同期・ほかのタブの変更）に合わせる
  useEffect(() => {
    if (!focused.current && !dirty.current) setValue(stored);
  }, [stored, setValue]);

  // 保存できずに捨てられた変更は、打った文字として入力欄に戻す
  useEffect(
    () =>
      store.subscribe((notice) => {
        if (notice.type !== "save-failed") return;
        let lost: string | undefined;
        for (const operation of notice.discarded) {
          for (const mutation of operation.mutations) {
            if (mutation.type !== "task.update" || mutation.id !== task.id) continue;
            const value = mutation.changes[field];
            if (typeof value === "string") lost = value;
          }
        }
        if (lost === undefined) return;
        dirty.current = true;
        setValue(lost);
      }),
    [store, task, field, setValue],
  );

  // 閉じるとき（部品が消えるとき）に保存する
  useEffect(() => () => flush(), [flush]);

  return {
    value: draft,
    onChange: (value: string) => {
      setValue(value);
      dirty.current = true;
      if (!composing.current) schedule();
    },
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      focused.current = false;
      flush();
    },
    onCompositionStart: () => {
      composing.current = true;
      clearTimeout(timer.current);
    },
    onCompositionEnd: () => {
      composing.current = false;
      schedule();
    },
    /** 今すぐ保存する（Enter や Esc で閉じる前に） */
    flush,
  };
}
