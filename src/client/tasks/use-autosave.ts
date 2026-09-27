import { reaction } from "mobx";
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskRow } from "@/data";
import type { TextField } from "./list-ui";
import { useUi } from "./ui-context";

/** 打つのが止まってから保存するまでの時間 */
export const AUTOSAVE_DELAY_MS = 500;

/**
 * タイトルとメモの自動保存。打つのが止まったら・フォーカスが外れたら・閉じたら保存する。
 * - 保存は「元に戻す」（⌘Z）の対象にしない（入力欄の中の取り消しはブラウザの標準に任せる）
 * - 日本語の変換中は保存しない（確定してから）
 * - 入力中は、ストアの値が変わっても（同期など）打っている文字を上書きしない
 * - 保存できなかった文字は、ListUi の「保存できていない文字」に残る（閉じたあとの失敗も）。
 *   開いているあいだに失敗したら欄に戻し、閉じていたら次に開いたときに欄に戻す。
 *   ただし失敗した版のあとに打った、まだ送っていない文字があれば、そちらを残す
 * - オフラインなどで保存できないまま閉じたときも、打った文字を残す
 * - 読み込み直す直前やページを離れるときも、まだ送っていない文字を下書きへ書く（ListUi.trackEditing）
 * - 空のタイトルは保存しない（閉じると元のタイトルに戻る）
 * 部品は observer で包む（task[field] の変化を受け取るため）
 */
export function useAutosave(task: TaskRow, field: TextField) {
  const ui = useUi();
  const { store } = ui;
  const stored = task[field];
  const [initial] = useState(() => {
    const unsaved = ui.unsavedText(task.id, field);
    return { value: unsaved ?? stored, unsaved: unsaved !== undefined };
  });
  const [draft, setDraft] = useState(initial.value);
  const draftRef = useRef(initial.value);
  /** ストアに渡していない変更がある（打ったあと、まだ送っていない。戻ってきた文字も含む） */
  const dirty = useRef(initial.unsaved);
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
      ui.clearUnsavedText(task.id, field);
      return;
    }
    const result = store.actions.updateTask(
      task.id,
      { [field]: value },
      { undoable: false, autosave: true },
    );
    // 送れたら「保存できていない文字」から外す（送った版が失敗したら、知らせを受けて ListUi が入れ直す）。
    // オフラインなどで受け付けられなかったら、次の機会にもう一度保存する
    if (result.ok || result.reason === "noop") {
      dirty.current = false;
      ui.clearUnsavedText(task.id, field);
    }
  }, [ui, store, task, field]);

  const schedule = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, AUTOSAVE_DELAY_MS);
  }, [flush]);

  // 入力していないあいだは、ストアの値（同期・ほかのタブの変更）に合わせる
  useEffect(() => {
    if (!focused.current && !dirty.current) setValue(stored);
  }, [stored, setValue]);

  // 開いているあいだに送った版が保存できなかったら、その文字を欄に戻す。
  // そのあとに打った、まだ送っていない文字があれば（dirty）、新しいほうを残す（次の保存で送る）
  useEffect(
    () =>
      reaction(
        () => ui.unsavedText(task.id, field),
        (unsaved) => {
          if (unsaved === undefined || dirty.current) return;
          dirty.current = true;
          setValue(unsaved);
        },
      ),
    [ui, task, field, setValue],
  );

  // まだ送っていない文字を、読み込み直す直前やページを離れるときに下書きへ書けるようにする（ListUi.persistEditing）
  useEffect(
    () =>
      ui.trackEditing(task.id, field, () => {
        if (!dirty.current) return undefined;
        const value = draftRef.current;
        return field === "title" && value.trim() === "" ? undefined : value;
      }),
    [ui, task, field],
  );

  // 閉じるとき（部品が消えるとき）に保存する。保存できなければ、打った文字を次に開いたときのために残す
  useEffect(
    () => () => {
      flush();
      const value = draftRef.current;
      if (dirty.current && !(field === "title" && value.trim() === "")) {
        ui.keepUnsavedText(task.id, field, value);
      }
    },
    [flush, ui, task, field],
  );

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
