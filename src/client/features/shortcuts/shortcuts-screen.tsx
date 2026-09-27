import { SearchIcon } from "lucide-react";
import { observer } from "mobx-react-lite";
import { type ComponentType, type ReactNode, useEffect, useId, useRef } from "react";
import { Kbd } from "@/components/ui/kbd";
import { QuickAddHost } from "@/features/quick-add/quick-add";
import { fieldKeyScenes } from "@/keyboard/field-keys";
import { useKeyContext } from "@/keyboard/key-context";
import { keymap } from "@/keyboard/keymap";
import { formatKey } from "@/keyboard/keys";
import { cn } from "@/lib/utils";
import {
  bindingSections,
  fieldKeySections,
  type ShortcutRow,
  type ShortcutSection,
} from "./shortcut-list";
import { shortcutsPageOf } from "./state";

/**
 * ショートカットのページの中身（後から読み込む。見出しは起動側の lazy.tsx から Heading として受け取る）。
 * - キーマップの割り当てを、まとまり（タスク・いつやる・移動・リスト・全体）ごとの段にして横に並べる（幅で 1〜3 段）。
 *   各行は操作の名前と、右にキー（割り当てたキーはすべて）。決まった画面だけで効くキーには、効く画面を添える
 * - 一番下に、候補や欄の中のキー（keyboard/field-keys.ts に各機能が登録したもの）を場面ごとに
 * - 見出しの右の欄で、操作の名前かキーの一部で絞り込む。開くとここにフォーカスがある。当てはまらなければ「見つかりません」。
 *   Esc は、欄の中でも外でも、文字があれば消し、空なら前の画面に戻る（キーマップの `shortcuts.escape`。文字は state.ts）。
 *   欄の中の `?` は文字として入る
 * どちらの一覧も登録から作る（ページに手で書かない）ので、割り当てを足すとそのまま出る。
 * 右下の「＋」と n は、このページでも小さな追加欄を開く（一覧の追加欄がないため）
 */
export const ShortcutsScreen = observer(function ShortcutsScreen({
  Heading,
}: {
  /** 見出し（起動側の lazy.tsx の部品。読み込む前と同じ形で、右に絞り込みの欄を置く） */
  Heading: ComponentType<{ actions?: ReactNode }>;
}) {
  const { ui } = useKeyContext();
  const page = shortcutsPageOf(ui);
  const { filter } = page;
  const bindings = bindingSections(keymap.list(), filter);
  const fields = fieldKeySections(fieldKeyScenes(), filter);
  const empty = bindings.length === 0 && fields.length === 0;

  return (
    <>
      <Heading
        actions={<FilterInput value={filter} onChange={(value) => page.setFilter(value)} />}
      />
      {empty ? (
        <p role="status" className="py-14 text-center text-muted-foreground text-sm">
          見つかりません
        </p>
      ) : (
        <>
          {bindings.length > 0 && <SectionGrid sections={bindings} className="mt-7" />}
          {fields.length > 0 && (
            <section
              aria-labelledby="shortcuts-in-fields"
              className="mt-7 border-border border-t pt-5"
            >
              <h2
                id="shortcuts-in-fields"
                className="mb-3 font-medium text-[11px] text-muted-foreground"
              >
                候補や欄の中
              </h2>
              <SectionGrid sections={fields} headingLevel="h3" />
            </section>
          )}
        </>
      )}
      <QuickAddHost />
    </>
  );
});

/** 絞り込みの欄。開くとフォーカスがある */
function FilterInput({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const hintId = useId();
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="relative ms-auto w-60 flex-none self-center">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-faint-foreground"
      />
      <input
        ref={input}
        aria-label="ショートカットを絞り込む"
        aria-describedby={hintId}
        placeholder="操作の名前かキーで絞り込む"
        className="h-8 w-full rounded-lg border border-input bg-card ps-8 pe-2.5 text-[13px] outline-none placeholder:text-muted-foreground/70 focus-visible:border-(--selection-ring) focus-visible:shadow-[0_0_14px_var(--selection-glow)]"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
      <span id={hintId} className="sr-only">
        Esc で文字を消す。空のときは前の画面に戻る
      </span>
    </div>
  );
}

/** 段を横に並べる（ページの幅で 1〜3 段） */
function SectionGrid({
  sections,
  headingLevel = "h2",
  className,
}: {
  sections: readonly ShortcutSection[];
  headingLevel?: "h2" | "h3";
  className?: string;
}) {
  const Heading = headingLevel;
  return (
    <div
      className={cn(
        "grid grid-cols-1 items-start gap-x-8 gap-y-6 @xl:grid-cols-2 @4xl:grid-cols-3",
        className,
      )}
    >
      {sections.map((section) => (
        <section key={section.key} aria-label={section.title}>
          <Heading className="mb-1.5 font-medium text-[11px] text-muted-foreground">
            {section.title}
          </Heading>
          <ul>
            {section.rows.map((row) => (
              <Row key={row.key} row={row} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 1行：操作の名前、効く画面（あれば）、キー（すべて。キーがなければ「キーなし」） */
function Row({ row }: { row: ShortcutRow }) {
  return (
    <li className="flex min-h-8 items-center gap-2.5 border-border/60 border-b py-1 text-[13px]">
      <span className="min-w-0 flex-1 text-foreground/85">{row.label}</span>
      {row.where !== undefined && (
        <span className="flex-none text-[11px] text-faint-foreground">{row.where}</span>
      )}
      {row.keys.length > 0 ? (
        <span className="flex flex-none gap-1">
          {row.keys.map((key) => (
            <Kbd key={key} className="text-foreground/85">
              {formatKey(key)}
            </Kbd>
          ))}
        </span>
      ) : (
        <span className="flex-none text-[11px] text-faint-foreground">キーなし</span>
      )}
    </li>
  );
}
