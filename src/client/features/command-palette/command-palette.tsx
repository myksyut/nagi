import { observer } from "mobx-react-lite";
import { useState } from "react";
import { BeamLine } from "@/components/beam-line";
import {
  Command,
  CommandCollection,
  CommandDialog,
  CommandDialogPopup,
  CommandEmpty,
  CommandGroup,
  CommandGroupLabel,
  CommandInput,
  CommandItem,
  CommandList,
  CommandPanel,
} from "@/components/ui/command";
import { Kbd } from "@/components/ui/kbd";
import type { TaskRow } from "@/data";
import { useKeyContext } from "@/keyboard/key-context";
import { type KeyContext, keymap } from "@/keyboard/keymap";
import { isComposingKey } from "@/keyboard/keys";
import { projectPath } from "@/navigation";
import { logout } from "./logout";
import { type Overlays, overlaysOf } from "./overlays";
import {
  type PaletteActions,
  type PaletteGroup,
  type PaletteItem,
  paletteGroups,
} from "./palette-items";
import { locationOf } from "./search";

/**
 * ⌘K：タスクの検索（完了ログも含む）、リストやプロジェクトへの移動、選んでいるタスクへの操作を、名前で探して実行する。
 * キーの操作は、キーを押したときと同じキーマップの run を呼ぶ（キー操作の状況は React の context から受け取る）。
 * 選んだコマンドは、⌘K が外れた直後に呼ぶ（閉じる途中のダイアログやフォーカスの戻し先にフォーカスを取られないように）。
 * 8 で後から読み込めるよう、⌘K の部品はこのモジュールにまとめる（開閉の状態と ⌘K のキーは overlays・register）
 */
export const CommandPalette = observer(function CommandPalette({
  initialQuery = "",
}: {
  /** 開いたときの検索欄の文字（読み込みを待つあいだに打った文字） */
  initialQuery?: string;
}) {
  const context = useKeyContext();
  const overlays = overlaysOf(context.ui);
  return (
    <CommandDialog
      open={overlays.palette}
      onOpenChange={(open) => {
        if (open) overlays.openPalette();
        else overlays.closePalette();
      }}
      onOpenChangeComplete={(open) => {
        // 選んだコマンドは、ふつうは下の finalFocus（⌘K が外れた直後）で呼ぶ。呼ばれなかったときの受け皿
        if (!open) setTimeout(() => runPending(context, overlays), 0);
      }}
    >
      <CommandDialogPopup
        aria-label="検索とコマンド"
        // ⌘K の中ではアプリのキーを止める（打った文字や ↑↓ は ⌘K が受ける）
        data-keymap="off"
        // ⌘K が外れるときに呼ばれる。コマンドを選んでいたら、外れた直後にそれを呼ぶ（フォーカスはコマンドに任せる）。
        // Esc や外のクリックで閉じたときは元の場所へ戻す。元の場所がもうない（追加欄はフォーカスが外れると閉じる）ときは一覧へ
        finalFocus={() => {
          // StrictMode の付け直し（開いたまま）では何もしない
          if (overlays.palette) return true;
          const back = overlays.returnFocus;
          overlays.returnFocus = null;
          if (overlays.pendingRun !== null) {
            queueMicrotask(() => runPending(context, overlays));
            return false;
          }
          if (back instanceof HTMLElement && back.isConnected) return back;
          queueMicrotask(() => context.ui.focusList());
          return false;
        }}
        // ⌘K は即時に出す（本体は動かさない。背景の暗転だけが短くフェードする）
        className="transition-none"
      >
        <PaletteContent context={context} initialQuery={initialQuery} />
      </CommandDialogPopup>
    </CommandDialog>
  );
});

/** ⌘K で選んだコマンドを呼ぶ（まだ呼んでいなければ）。先に一覧へフォーカスを戻す（コマンドが入力欄などへ移す） */
function runPending(context: KeyContext, overlays: Overlays): void {
  const run = overlays.takePendingRun();
  if (!run) return;
  context.ui.focusList();
  run();
}

/** 開くたびに作り直す（打った文字は開くたびに空から） */
const PaletteContent = observer(function PaletteContent({
  context,
  initialQuery,
}: {
  context: KeyContext;
  initialQuery: string;
}) {
  const { ui, store, navigate } = context;
  const overlays = overlaysOf(ui);
  const [query, setQuery] = useState(initialQuery);

  const actions: PaletteActions = {
    runBinding: (id) => keymap.run(id, context),
    openProject: (projectId) => navigate(projectPath(projectId)),
    openTask: (task: TaskRow) => {
      const { list, path } = locationOf(store, task);
      ui.reveal(task.id, list);
      navigate(path);
    },
    logout: () => {
      void logout().then((ok) => {
        if (ok) navigate("/login");
        else ui.toaster.error("ログアウトできませんでした");
      });
    },
  };
  const groups = paletteGroups(context, query, actions);

  const choose = (item: PaletteItem) => overlays.runFromPalette(item.run);

  return (
    <Command
      items={groups}
      filter={null}
      value={query}
      onValueChange={(value, details) => {
        // 項目を選んだときに Base UI が入力欄をその名前で埋めるのは受けない
        if (details.reason !== "item-press") setQuery(value);
      }}
    >
      {/* 入力欄の下の辺に border-beam（⌘K を開いているあいだ流す） */}
      <BeamLine active radius={0}>
        <CommandInput
          aria-label="検索とコマンド"
          placeholder="タスクを検索、コマンドを実行…"
          // 読み込みを待つあいだに打った文字が入っているときも、続きを打てるよう末尾から
          onFocus={(event) => {
            const { length } = event.currentTarget.value;
            event.currentTarget.setSelectionRange(length, length);
          }}
          onKeyDown={(event) => {
            // 変換中のキー（確定の Enter を含む）は Base UI に渡さない。Base UI が止めるのは keyCode 229 のときだけで、
            // isComposing だけが立つ確定の Enter ではコマンドを実行してしまう
            if (isComposingKey(event.nativeEvent)) {
              event.preventBaseUIHandler();
              return;
            }
            // ⌘K をもう一度押すと閉じる
            if (event.key.toLowerCase() === "k" && event.metaKey && !event.ctrlKey) {
              event.preventDefault();
              overlays.closePalette();
            }
          }}
        />
      </BeamLine>
      <CommandPanel>
        <CommandEmpty>見つかりません</CommandEmpty>
        <CommandList>
          {(group: PaletteGroup) => (
            <CommandGroup key={group.value} items={group.items}>
              <CommandGroupLabel>{group.value}</CommandGroupLabel>
              <CommandCollection>
                {(item: PaletteItem) => (
                  <CommandItem key={item.value} value={item} onClick={() => choose(item)}>
                    <span className="min-w-0 truncate">{item.label}</span>
                    {item.detail !== undefined && (
                      <span className="ms-2 flex-none text-muted-foreground text-xs">
                        {item.detail}
                      </span>
                    )}
                    {item.shortcut !== undefined && (
                      <Kbd className="ms-auto flex-none">{item.shortcut}</Kbd>
                    )}
                  </CommandItem>
                )}
              </CommandCollection>
            </CommandGroup>
          )}
        </CommandList>
      </CommandPanel>
    </Command>
  );
});
