import { ja } from "@daypicker/react/locale/ja";
import { parseDateInput } from "@shared/date-input";
import { observer } from "mobx-react-lite";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Calendar } from "@/components/ui/calendar";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverPopup } from "@/components/ui/popover";
import { type TaskRow, useStore } from "@/data";
import { keymap } from "@/keyboard/keymap";
import { formatKey, isComposingKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";
import { moveTasks } from "@/tasks/commands";
import { taskRowId } from "@/tasks/task-item";
import { useUi } from "@/tasks/ui-context";
import { scheduleTasks, setDeadline } from "./commands";
import { type DateEntryKind, type DateEntryRequest, dateEntryOf } from "./date-entry";
import { formatLongDate } from "./labels";

/**
 * 日付の入力のポップオーバー（d と ⇧D で共通）。小さな入力欄が開き、打つと解釈した日付がその場で出る。
 * Enter で決定、Esc でやめる。カレンダーのクリックでも選べる。締切は欄を空にして Enter で外せる。
 * カレンダー（DayPicker と date-fns）を含むので、このモジュールは後から読み込む（開閉の状態は date-entry.tsx）。
 * 出るときは 100ms で押した場所から広がり、消えるときだけ 150ms でフェードする
 */

// --- 日付と Date（カレンダーはその端末の時間帯の Date で扱う） --------------------------------

function toLocalDate(date: string): Date {
  return new Date(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
}

function fromLocalDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function monthOf(date: string): Date {
  return new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, 1);
}

function keyLabel(id: string): string | undefined {
  const key = keymap.get(id)?.keys[0];
  return key === undefined ? undefined : formatKey(key);
}

// --- ポップオーバー ---------------------------------------------------------------------------

/**
 * 入力の後始末：対象の行が今の画面の一覧から消えたら閉じる。行ごと外れた（画面の切り替え、抜けていく動きの終わり）
 * ときも閉じる。どちらも一覧にフォーカスを戻す（ポップオーバーの入力欄にあったフォーカスが行き場を失うため）。
 * 外れたかどうかは、StrictMode の付け直しと区別するため、外れた直後の microtask で確かめる
 */
function useDismissWhenGone(request: DateEntryRequest, inList: boolean) {
  const ui = useUi();
  const mounted = useRef(false);
  useEffect(() => {
    if (!inList && dateEntryOf(ui).dismiss(request.id)) ui.focusList();
  }, [ui, request.id, inList]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      queueMicrotask(() => {
        if (!mounted.current && dateEntryOf(ui).dismiss(request.id)) ui.focusList();
      });
    };
  }, [ui, request.id]);
}

/** 開いている入力（request）か、閉じる途中の入力（消えるときのフェードのあいだ）を描く */
export const DateEntryPanel = observer(function DateEntryPanel({
  request,
  task,
}: {
  request: DateEntryRequest;
  task: TaskRow;
}) {
  const ui = useUi();
  const store = useStore();
  const entry = dateEntryOf(ui);
  const today = store.today;
  const { kind, taskIds } = request;
  // 複数のタスクにかけるとき（7 の複数選択）は、今の値がそろっているときだけ出す
  const targets = taskIds.flatMap((id) => {
    const row = id === task.id ? task : store.task(id);
    return row ? [row] : [];
  });
  const dateOf = (row: TaskRow) => (kind === "schedule" ? row.scheduledOn : row.deadlineOn);
  const current = targets.every((row) => dateOf(row) === dateOf(task)) ? dateOf(task) : null;
  const anyHasValue = targets.some((row) => dateOf(row) !== null);
  const [text, setText] = useState("");
  const parsed = text.trim() === "" ? null : parseDateInput(text, today);
  const [month, setMonth] = useState(() => monthOf(current ?? today));
  const input = useRef<HTMLInputElement>(null);
  const inList = ui.view === request.view && ui.rows.some((row) => row.id === task.id);
  useDismissWhenGone(request, inList);
  const anchor = request.anchor ?? document.getElementById(taskRowId(task.id));
  /** 閉じる途中なら false（フェードが終わったら entry.left で描くのをやめる） */
  const open = entry.request?.id === request.id;

  /** 閉じて一覧にフォーカスを戻す（キーの操作を続けられるように） */
  const finish = () => {
    entry.close();
    ui.focusList();
  };

  const commit = (date: string | null) => {
    finish();
    if (kind === "schedule") {
      if (date !== null) scheduleTasks(ui, taskIds, date);
    } else {
      setDeadline(ui, taskIds, date);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Escape") {
      event.preventDefault();
      finish();
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (text.trim() === "") {
        // 締切は、欄を空にして Enter で外す。予定は何もせずに閉じる
        if (kind === "deadline" && anyHasValue) commit(null);
        else finish();
      } else if (parsed !== null) {
        commit(parsed);
      }
    }
  };

  const moves =
    kind === "schedule"
      ? parsed !== null && parsed <= today
      : parsed !== null &&
        parsed <= today &&
        targets.some(
          (row) =>
            row.completedAt === null && (row.bucket === "scheduled" || row.bucket === "later"),
        );

  const label = kind === "schedule" ? "予定の日付" : "締切";
  const selected = parsed ?? current;
  /** 何も打っていないときの一行（複数なら件数、今の値、締切の外し方） */
  const emptyHint = [
    targets.length > 1 ? `${targets.length}件` : null,
    ...(kind === "deadline" && current !== null
      ? [`締切 ${formatLongDate(current, today)}`, "空のまま Enter で外す"]
      : kind === "deadline" && anyHasValue
        ? ["空のまま Enter で締切を外す"]
        : kind === "schedule" && current !== null
          ? [`予定 ${formatLongDate(current, today)}`]
          : []),
  ]
    .filter((part) => part !== null)
    .join("・");

  // 行が一覧から消えた（抜けていく動きのあいだも）ら描かない。閉じるのは useDismissWhenGone
  if (!inList) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next || !open) return;
        // Esc は一覧に戻す。外をクリックしたときは、クリックした先にフォーカスを任せる
        if (details.reason === "escape-key") finish();
        else entry.close();
      }}
      onOpenChangeComplete={(next) => {
        if (!next) entry.left(request.id);
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side="bottom"
        align="start"
        aria-label={kind === "schedule" ? "日付を決めて予定へ" : "締切"}
        data-keymap="off"
        initialFocus={input}
        finalFocus={false}
        // 出るときは 100ms、消えるときだけ 150ms でフェードする（消えるあいだはクリックを受けない）
        className="duration-(--duration-short) data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-(--duration-exit)"
        // 行の中から描いているので、クリックが行（開く・閉じる）へ伝わらないようにする
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex w-[16.5rem] flex-col gap-1.5">
          <input
            ref={input}
            aria-label={label}
            className="h-8 w-full border-b bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:border-primary/70"
            placeholder={kind === "schedule" ? "明日、金曜、10/3 など" : "締切（金曜、10/3 など）"}
            value={text}
            onChange={(event) => {
              const next = event.target.value;
              setText(next);
              const date = next.trim() === "" ? null : parseDateInput(next, today);
              if (date !== null) setMonth(monthOf(date));
            }}
            onKeyDown={onKeyDown}
          />
          <p aria-live="polite" className="min-h-5 px-1 text-xs leading-5">
            {text.trim() === "" ? (
              <span className="text-muted-foreground">{emptyHint}</span>
            ) : parsed === null ? (
              <span className="text-muted-foreground">日付として読めません</span>
            ) : (
              <>
                <span className="text-primary">→ {formatLongDate(parsed, today)}</span>
                {moves && <span className="ml-1.5 text-muted-foreground">今日へ入ります</span>}
              </>
            )}
          </p>
          <Calendar
            mode="single"
            locale={ja}
            className="self-center"
            today={toLocalDate(today)}
            selected={selected === null ? undefined : toLocalDate(selected)}
            month={month}
            onMonthChange={setMonth}
            // 選び直しで選択が外れる（undefined）ときも、押した日で決める
            onSelect={(_: Date | undefined, day: Date) => commit(fromLocalDate(day))}
          />
          <Footer kind={kind} task={task} taskIds={taskIds} onDone={finish} />
        </div>
      </PopoverPopup>
    </Popover>
  );
});

/** 下の小さなボタン：予定では「今日」「あとで」、締切では「締切を外す」 */
const Footer = observer(function Footer({
  kind,
  task,
  taskIds,
  onDone,
}: {
  kind: DateEntryKind;
  task: TaskRow;
  taskIds: readonly string[];
  onDone: () => void;
}) {
  const ui = useUi();
  const buttonClassName =
    "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-muted-foreground text-xs hover:bg-accent hover:text-foreground";

  if (kind === "deadline") {
    const store = ui.store;
    const anyHasDeadline = taskIds.some((id) => (store.task(id) ?? task).deadlineOn !== null);
    if (!anyHasDeadline) return null;
    return (
      <div className="flex justify-end border-t pt-1.5">
        <button
          type="button"
          className={buttonClassName}
          onClick={() => {
            onDone();
            setDeadline(ui, taskIds, null);
          }}
        >
          締切を外す
        </button>
      </div>
    );
  }

  const destinations = [
    { bucket: "today", label: "今日", key: keyLabel("task.today") },
    { bucket: "later", label: "あとで", key: keyLabel("task.later") },
  ] as const;
  return (
    <div className="flex justify-end gap-1 border-t pt-1.5">
      {destinations.map(({ bucket, label, key }) => (
        <button
          key={bucket}
          type="button"
          className={cn(buttonClassName, task.bucket === bucket && "text-foreground")}
          onClick={() => {
            onDone();
            moveTasks(ui, taskIds, bucket);
          }}
        >
          {label}
          {key !== undefined && <Kbd>{key}</Kbd>}
        </button>
      ))}
    </div>
  );
});
