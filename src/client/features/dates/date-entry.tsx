import { ja } from "@daypicker/react/locale/ja";
import { parseDateInput } from "@shared/date-input";
import { action, makeObservable, observable, observableRef } from "mobx";
import { observer } from "mobx-react-lite";
import { type KeyboardEvent, useRef, useState } from "react";
import { Calendar } from "@/components/ui/calendar";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverPopup } from "@/components/ui/popover";
import { type TaskRow, useStore } from "@/data";
import { keymap } from "@/keyboard/keymap";
import { formatKey, isComposingKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";
import { moveTasks } from "@/tasks/commands";
import type { ListUi } from "@/tasks/list-ui";
import { taskRowId } from "@/tasks/task-item";
import { useUi } from "@/tasks/ui-context";
import { scheduleTasks, setDeadline } from "./commands";
import { formatLongDate } from "./labels";

/**
 * 日付の入力（d と ⇧D で共通）。小さな入力欄が開き、打つと解釈した日付がその場で出る。
 * Enter で決定、Esc でやめる。カレンダーのクリックでも選べる。締切は欄を空にして Enter で外せる。
 *
 * 開いているかどうかは一覧の状態（ListUi）ごとに1つだけ持つ。ポップオーバーは、対象のタスク（複数なら先頭）の
 * 行の右側の枠（register.tsx の締切の表示）が描く。行に合わせて開き、小さなボタンから開いたときはボタンに合わせる
 */

export type DateEntryKind = "schedule" | "deadline";

type DateEntryRequest = {
  /** 開くたびに変わる番号（入力欄の中身を開くたびに空から始めるため） */
  id: number;
  kind: DateEntryKind;
  taskIds: readonly string[];
  /** ポップオーバーを合わせる要素。null なら対象の行 */
  anchor: Element | null;
};

export class DateEntry {
  request: DateEntryRequest | null = null;
  /** ポップオーバーを描く行（行ごとに自分の id だけを観測する） */
  readonly #hosts = observable.map<string, true>();
  #nextId = 1;

  constructor() {
    makeObservable(this, { request: observableRef, open: action, close: action });
  }

  open(kind: DateEntryKind, taskIds: readonly string[], anchor: Element | null = null): void {
    const host = taskIds[0];
    this.close();
    if (host === undefined) return;
    this.request = { id: this.#nextId++, kind, taskIds: [...taskIds], anchor };
    this.#hosts.set(host, true);
  }

  close(): void {
    this.request = null;
    this.#hosts.clear();
  }

  /** この行がポップオーバーを描くか */
  isHost(taskId: string): boolean {
    return this.#hosts.has(taskId);
  }

  isOpenFor(kind: DateEntryKind, taskId: string): boolean {
    return this.request?.kind === kind && this.request.taskIds[0] === taskId;
  }
}

const entries = new WeakMap<ListUi, DateEntry>();

/** 一覧の状態ごとの日付の入力 */
export function dateEntryOf(ui: ListUi): DateEntry {
  let entry = entries.get(ui);
  if (!entry) {
    entry = new DateEntry();
    entries.set(ui, entry);
  }
  return entry;
}

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

/** 行の右側の枠から描く。開いていなければ何も描かない */
export const DateEntryPopover = observer(function DateEntryPopover({ task }: { task: TaskRow }) {
  const ui = useUi();
  const request = dateEntryOf(ui).request;
  if (!request || request.taskIds[0] !== task.id) return null;
  return <DateEntryPanel key={request.id} request={request} task={task} />;
});

const DateEntryPanel = observer(function DateEntryPanel({
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
  const current = kind === "schedule" ? task.scheduledOn : task.deadlineOn;
  const [text, setText] = useState("");
  const parsed = text.trim() === "" ? null : parseDateInput(text, today);
  const [month, setMonth] = useState(() => monthOf(current ?? today));
  const input = useRef<HTMLInputElement>(null);
  const anchor = request.anchor ?? document.getElementById(taskRowId(task.id));

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
        if (kind === "deadline" && current !== null) commit(null);
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
        task.completedAt === null &&
        (task.bucket === "scheduled" || task.bucket === "later");

  const label = kind === "schedule" ? "予定の日付" : "締切";
  const selected = parsed ?? current;

  return (
    <Popover
      open
      onOpenChange={(open, details) => {
        if (open) return;
        // Esc は一覧に戻す。外をクリックしたときは、クリックした先にフォーカスを任せる
        if (details.reason === "escape-key") finish();
        else entry.close();
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
        className="duration-(--duration-short) data-ending-style:opacity-0 data-ending-style:duration-(--duration-exit)"
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
              <span className="text-muted-foreground">
                {kind === "deadline" && current !== null
                  ? `締切 ${formatLongDate(current, today)}・空のまま Enter で外す`
                  : kind === "schedule" && current !== null
                    ? `予定 ${formatLongDate(current, today)}`
                    : ""}
              </span>
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
    if (task.deadlineOn === null) return null;
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
