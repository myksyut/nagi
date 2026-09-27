import { reaction } from "mobx";
import { observer } from "mobx-react-lite";
import { type KeyboardEvent, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { BeamLine } from "@/components/beam-line";
import { Popover, PopoverPopup } from "@/components/ui/popover";
import { useStore } from "@/data";
import { formatLongDate } from "@/features/dates/labels";
import { ProjectDot } from "@/features/projects/project-dot";
import { FIELD_SCENE_ORDER, registerFieldKeys } from "@/keyboard/field-keys";
import { isComposingKey } from "@/keyboard/keys";
import { projectColorOf } from "@/lib/project-color";
import { cn } from "@/lib/utils";
import { ADD_BUTTON_ELEMENT_ID } from "@/shell/add-button";
import { undo } from "@/tasks/commands";
import { taskDetailPopoverOf } from "@/tasks/task-detail-popover";
import { useUi } from "@/tasks/ui-context";
import { QUICK_ADD_SCREENS, type QuickAddRequest, quickAddOf } from "./state";

// 小さな追加欄の中のキー（ショートカットのページの「候補や欄の中」）。Enter・Esc は下の onKeyDown、
// ←→ は行き先の切り替え（ChoiceSwitch のラジオ。Tab で来たとき）
registerFieldKeys({
  id: "quick-add",
  label: `小さな追加欄（${QUICK_ADD_SCREENS}）`,
  order: FIELD_SCENE_ORDER.quickAdd,
  keys: [
    { label: "追加して続けて打つ", keys: ["Enter"] },
    { label: "閉じる", keys: ["Escape"] },
    { label: "行き先（受信箱｜今日）を切り替える", keys: ["ArrowLeft", "ArrowRight"] },
  ],
});

/**
 * 小さな追加欄（カレンダーとタイムライン。13 が作り、14 もつなぐ。17 でショートカットのページにも置いた）。使い方は README の「小さな追加欄」。
 * - 右下の「＋」と n：「＋」の上に開き、行き先を「受信箱｜今日」から選ぶ（開くたびに受信箱から）
 * - カレンダーの日のマスの「＋」：そのマスの下に開き、その日の予定として追加する（今日か過去の日なら今日へ）
 * どちらも、タイトルを打って Enter で追加し、開いたまま続けて追加できる。Esc で閉じて、開いた要素へフォーカスを戻す。
 * 外を押すと閉じる。変換を確定する Enter では追加しない。打った文字は一覧の追加欄と同じ下書き（ui.addDraft）に
 * 残す（閉じても、オフラインでも、保存できずに戻ってきたときも消えない）。
 * 追加しても画面に出ないことがある（受信箱など）ので、追加したら「受信箱に追加しました・元に戻す」を出す。
 * 中ではアプリの1文字のキーを止める（data-keymap="off"）。欄から小さな詳細は開かない（開いたら閉じる）
 */

/** 開いた画面ごとに1つ置く。画面が消えると閉じる */
export const QuickAddHost = observer(function QuickAddHost({
  projectId = null,
}: {
  /** 追加したタスクに付けるプロジェクト（カレンダーの絞り込みで選んでいるプロジェクトなど）。null なら付けない */
  projectId?: string | null;
}) {
  const ui = useUi();
  const state = quickAddOf(ui);
  // 欄を描ける画面が出ているあいだだけ、n と右下の「＋」をこの欄につなぐ
  useLayoutEffect(() => {
    state.addHost();
    return () => state.removeHost();
  }, [state]);
  useEffect(
    () =>
      reaction(
        () => state.request,
        (request) => {
          // 小さな詳細と重ねて開かない
          if (request) taskDetailPopoverOf(ui).close();
        },
      ),
    [ui, state],
  );
  useEffect(
    () =>
      reaction(
        () => ui.editingLocked,
        (locked) => {
          if (locked) state.dismiss();
        },
      ),
    [ui, state],
  );
  const shown = state.request ?? state.leaving;
  if (shown === null) return null;
  return (
    <QuickAddPopup
      key={shown.id}
      request={shown}
      open={state.request?.id === shown.id}
      projectId={projectId}
    />
  );
});

type Choice = "inbox" | "today";

const CHOICES: readonly { value: Choice; label: string }[] = [
  { value: "inbox", label: "受信箱" },
  { value: "today", label: "今日" },
];

/** 行き先の名前（「受信箱」「今日」「10月5日(月)」） */
function placeName(request: QuickAddRequest, choice: Choice, today: string): string {
  if (request.target.kind === "date") {
    const { on } = request.target;
    return on <= today ? "今日" : formatLongDate(on, today);
  }
  return choice === "inbox" ? "受信箱" : "今日";
}

function focusElement(element: Element | null): void {
  if (element instanceof HTMLElement && element.isConnected) element.focus();
}

const QuickAddPopup = observer(function QuickAddPopup({
  request,
  open,
  projectId,
}: {
  request: QuickAddRequest;
  /** false なら閉じる途中（消えるときのフェードのあいだ） */
  open: boolean;
  projectId: string | null;
}) {
  const ui = useUi();
  const store = useStore();
  const state = quickAddOf(ui);
  const input = useRef<HTMLInputElement>(null);
  const [choice, setChoice] = useState<Choice>("inbox");
  const [focused, setFocused] = useState(false);
  const offlineNoteId = useId();
  const offline = !store.isOnline;
  const fab = request.anchor === null;
  const anchor = request.anchor ?? document.getElementById(ADD_BUTTON_ELEMENT_ID);
  const place = placeName(request, choice, store.today);
  const label = `${place}に追加`;
  const project = projectId === null ? undefined : store.project(projectId);

  const close = () => {
    state.close(request.id);
    focusElement(request.returnFocus ?? document.getElementById(ADD_BUTTON_ELEMENT_ID));
  };

  const add = () => {
    const title = ui.addDraft.trim();
    if (title === "") return;
    const result = store.actions.addTask(
      request.target.kind === "date"
        ? { title, projectId, bucket: "scheduled", on: request.target.on }
        : { title, projectId, bucket: choice },
    );
    // オフラインなどで受け付けられなかったら、打った文字は下書きとして残す（オフラインなら上部の帯が強調される）
    if (!result.ok) {
      if (result.reason === "invalid") ui.toaster.error("保存できませんでした");
      return;
    }
    const id = result.ids[0];
    if (id !== undefined) ui.noteAdded(id);
    ui.toaster.undoable(`${place}に追加しました`, result.operationId, () => undo(ui));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isComposingKey(event.nativeEvent)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "Enter") {
      event.preventDefault();
      add();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next, details) => {
        if (next || !open) return;
        // 右下の「＋」を押したときは閉じない（「＋」が自分で開閉する。toggleFromFab）
        const target = details.event?.target;
        if (
          details.reason === "outside-press" &&
          target instanceof Element &&
          target.closest(`#${ADD_BUTTON_ELEMENT_ID}`)
        ) {
          return;
        }
        // Esc は開いた要素へ戻す。外を押したときは、押した先にフォーカスを任せる
        if (details.reason === "escape-key") close();
        else state.close(request.id);
      }}
      onOpenChangeComplete={(next) => {
        if (!next) state.left(request.id);
      }}
    >
      <PopoverPopup
        anchor={anchor}
        side={fab ? "top" : "bottom"}
        align={fab ? "end" : "start"}
        sideOffset={fab ? 12 : 4}
        aria-label={label}
        data-keymap="off"
        initialFocus={input}
        finalFocus={false}
        // 出るときは 100ms で開いた場所から広がり、消えるときだけ 150ms でフェードする（消えるあいだはクリックを受けない）
        className="w-[22rem] duration-(--duration-short) data-starting-style:scale-95 data-ending-style:pointer-events-none data-ending-style:opacity-0 data-ending-style:duration-(--duration-exit)"
      >
        <div className="flex flex-col gap-2.5">
          <BeamLine active={focused} radius={10}>
            <div className="flex min-h-9 items-center gap-3 rounded-[10px] border border-primary/35 bg-(--selection) px-3 py-1.5 text-sm focus-within:border-(--selection-ring) focus-within:ring-1 focus-within:ring-ring/40">
              <span
                aria-hidden="true"
                className="size-[17px] flex-none rounded-full border-(--circle) border-[1.6px] border-dashed"
              />
              <input
                ref={input}
                aria-label={label}
                aria-describedby={offline ? offlineNoteId : undefined}
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60"
                placeholder="新しいタスク"
                value={ui.addDraft}
                onChange={(event) => ui.setAddDraft(event.target.value)}
                onKeyDown={onKeyDown}
                onFocus={() => setFocused(true)}
                onBlur={() => setFocused(false)}
              />
            </div>
          </BeamLine>
          {offline && (
            <p id={offlineNoteId} className="px-1 text-muted-foreground text-xs">
              オフラインのため、今は追加できません。入力は下書きとして残ります
            </p>
          )}
          <div className="flex min-h-7 items-center gap-2 px-1 text-muted-foreground text-xs">
            {request.target.kind === "choice" ? (
              <ChoiceSwitch value={choice} onChange={setChoice} />
            ) : (
              <span>{label}</span>
            )}
            {project && (
              <span className="flex min-w-0 items-center gap-1.5">
                <ProjectDot color={projectColorOf(store, project.id)} className="size-1.5" />
                <span className="truncate">{project.name}</span>
              </span>
            )}
            <span className="ml-auto flex-none">
              {ui.draftCount > 0 && `ほかに下書き ${ui.draftCount}件・`}Enter で追加
            </span>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
});

/**
 * 行き先の切り替え「受信箱｜今日」（ラジオ。Tab で来て ←→ でも切り替わる）。
 * 押したときはフォーカスを入力欄に残す（続けて打てるように）
 */
function ChoiceSwitch({ value, onChange }: { value: Choice; onChange: (value: Choice) => void }) {
  const name = useId();
  return (
    <fieldset className="m-0 flex min-w-0 rounded-lg border border-border bg-muted p-0.5">
      <legend className="sr-only">行き先</legend>
      {CHOICES.map((option) => {
        const checked = option.value === value;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: キーでは中のラジオが受ける（←→ で切り替わる）
          <label
            key={option.value}
            className={cn(
              "rounded-md px-2.5 py-0.5 has-focus-visible:outline-2 has-focus-visible:outline-ring",
              checked ? "bg-accent text-foreground" : "hover:text-foreground",
            )}
            onMouseDown={(event) => event.preventDefault()}
            // 押したときはラジオへフォーカスを移さずに切り替える（入力欄で続けて打てるように）。
            // ラジオ自身のクリック（キーボードの ←→・Space でブラウザが送る）は止めない。止めると、ブラウザが
            // DOM の checked を元に戻し、読み上げに出る行き先と実際の行き先が食い違う
            onClick={(event) => {
              if (event.target instanceof HTMLInputElement) return;
              event.preventDefault();
              onChange(option.value);
            }}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={checked}
              className="sr-only"
              onChange={() => onChange(option.value)}
            />
            {option.label}
          </label>
        );
      })}
    </fieldset>
  );
}
