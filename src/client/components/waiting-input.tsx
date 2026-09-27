import { type CSSProperties, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { isComposingKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";

/**
 * 後から読み込む部品（⌘K・日付の入力・p の候補・`?` の一覧）を待つあいだと、読み込めなかったときに出す小さな欄。
 * 開いた瞬間にフォーカスを受け取り、アプリのキーを止める（`data-keymap="off"`）。そのため、待っているあいだに
 * 打ったキーが一覧への別の操作（t で今日へ、など）にならない。打った文字は持ち主が持ち、届いたら本物の入力欄へ移す。
 * Esc で閉じる。読み込めなかったときは「読み込めませんでした・もう一度」を出す（閉じることもできる）。
 * 本物のポップオーバーと同じく body の直下に描く（行の動きの transform に位置を引きずられないように）
 */
export function WaitingInput({
  label,
  placeholder,
  value,
  onChange,
  onCancel,
  failed,
  onRetry,
  className,
  style,
}: {
  label: string;
  placeholder?: string;
  /** 打った文字。undefined なら文字を受けない（`?` の一覧） */
  value?: string;
  onChange?: (value: string) => void;
  onCancel: () => void;
  failed: boolean;
  onRetry: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const takesText = value !== undefined;
  return createPortal(
    // biome-ignore lint/a11y/useSemanticElements: 読み込み待ちの、ポップオーバーの代わりのまとまり
    <div
      role="group"
      aria-label={label}
      aria-busy={!failed}
      data-keymap="off"
      data-slot="waiting-input"
      className={cn(
        "z-50 flex flex-col gap-1.5 rounded-lg border bg-popover p-2 text-popover-foreground text-sm shadow-lg/5",
        className,
      )}
      style={style}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (isComposingKey(event.nativeEvent)) return;
        if (event.key === "Escape") {
          event.preventDefault();
          onCancel();
        } else if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
          // 届くまでは決められない（届いたら、打った文字のまま本物の入力欄で決める）
          event.preventDefault();
        }
      }}
    >
      {takesText ? (
        <input
          // biome-ignore lint/a11y/noAutofocus: 開いた瞬間にキーを受け止めるため
          autoFocus
          aria-label={label}
          className="h-8 w-full bg-transparent px-1 outline-none placeholder:text-muted-foreground/60"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
        />
      ) : (
        <FocusHolder label={label} />
      )}
      {failed ? (
        <p role="alert" className="px-1 text-muted-foreground text-xs">
          読み込めませんでした・
          <button
            type="button"
            className="rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={onRetry}
          >
            もう一度
          </button>
        </p>
      ) : (
        !takesText && <p className="px-1 text-muted-foreground text-xs">読み込んでいます…</p>
      )}
    </div>,
    document.body,
  );
}

/** 文字を受けない欄で、フォーカスを受け止めておく要素 */
function FocusHolder({ label }: { label: string }) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    element?.focus({ preventScroll: true });
  }, [element]);
  return (
    <div ref={setElement} tabIndex={-1} className="px-1 text-muted-foreground text-xs outline-none">
      {label}
    </div>
  );
}

/**
 * 要素の下に合わせて置く位置（fixed）。本物のポップオーバーと同じく、要素の下の端から少し離す。
 * align が end なら右の端をそろえる
 */
export function useAnchoredStyle(anchor: Element | null, align: "start" | "end"): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", visibility: "hidden" });
  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setStyle(
      align === "start"
        ? { position: "fixed", top: rect.bottom + 4, left: rect.left }
        : { position: "fixed", top: rect.bottom + 4, right: window.innerWidth - rect.right },
    );
  }, [anchor, align]);
  return style;
}

/** 後から読み込む部品が読み込めなかったときの一行（画面の中に置く。チェックリスト・完了ログ） */
export function LoadFailedNote({ what, onRetry }: { what: string; onRetry: () => void }) {
  return (
    <p role="alert" className="text-muted-foreground text-xs">
      {what}を読み込めませんでした・
      <button
        type="button"
        className="rounded-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onRetry}
      >
        もう一度
      </button>
    </p>
  );
}
