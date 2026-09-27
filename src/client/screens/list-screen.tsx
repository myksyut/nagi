import { observer } from "mobx-react-lite";
import { type CSSProperties, type ReactNode, useEffect } from "react";
import { useStore } from "@/data";
import type { ListKey } from "@/navigation";
import { LIST_ICONS } from "@/shell/list-icons";

/**
 * リストの画面の枠：見出し（リストの色のアイコンと名前）と、その下の小さな一行（今日なら日付、未完了の件数）。
 * 中身（一覧）は、手元の控えを読み終えてから描く（それまではキーの操作も受け付けない）。
 * 件数は関数で受け取り、見出しの一行（HeadingSubtitle）の中だけで読む。画面の部品が件数を読むと、
 * 完了や振り分けのたびに画面ごと描き直し、一覧（TaskList）に新しい空の表示が渡って全行を描き直してしまう
 */
export const ListScreen = observer(function ListScreen({
  title,
  list,
  date,
  count,
  points,
  actions,
  children,
}: {
  title: string;
  /** アイコンと色を決めるリスト */
  list: ListKey;
  /** 見出しの下に出す日付（今日だけ。例：「9月28日 月曜日」） */
  date?: string;
  /** 未完了の件数を読む（0 件なら出さない。完了ログでは渡さない） */
  count?: () => number;
  /** 未完了の工数の合計を読む（今日だけ。0 なら出さない） */
  points?: () => number;
  /** 見出しの右に置く操作（今日の並び方と「リスト｜ボード」、あとでの並び方） */
  actions?: ReactNode;
  children?: ReactNode;
}) {
  const store = useStore();
  useEffect(() => {
    document.title = `${title} — nagi`;
  }, [title]);
  const { Icon, color } = LIST_ICONS[list];

  return (
    <>
      <ScreenHeading
        leading={
          <span
            aria-hidden="true"
            className="list-tile grid size-7.5 flex-none place-items-center rounded-[9px]"
            style={{ "--tile": color } as CSSProperties}
          >
            <Icon className="size-4.5" strokeWidth={1.75} />
          </span>
        }
        subtitle={<HeadingSubtitle date={date} count={count} points={points} />}
        actions={actions}
      >
        <h1 className="font-[650] text-[26px] leading-tight tracking-[-0.01em]">{title}</h1>
      </ScreenHeading>
      {store.loaded && children}
    </>
  );
});

/**
 * 見出しの下の一行（「9月28日 月曜日 ・ 5 件 ・ 工数 8」）。件数と工数はここでだけ読む（変わっても描き直すのはこの一行だけ）。
 * 工数のあるタスクがなければ工数は出さない
 */
const HeadingSubtitle = observer(function HeadingSubtitle({
  date,
  count,
  points,
}: {
  date?: string;
  count?: () => number;
  points?: () => number;
}) {
  const n = count?.() ?? 0;
  const m = points?.() ?? 0;
  const text = [date, n > 0 && `${n} 件`, m > 0 && `工数 ${m}`].filter(Boolean).join(" ・ ");
  if (text === "") return null;
  return <p className="mt-1 text-[13px] text-muted-foreground">{text}</p>;
});

/**
 * 見出しの並び（プロジェクトの画面も同じ形）：左にアイコンか色の点、右に名前と小さな一行、さらに右に操作
 */
export function ScreenHeading({
  leading,
  subtitle,
  actions,
  children,
}: {
  leading: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** 名前（h1） */
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 items-end gap-3.5">
      {leading}
      <div className="min-w-0 flex-1">
        {children}
        {typeof subtitle === "string"
          ? subtitle !== "" && <p className="mt-1 text-[13px] text-muted-foreground">{subtitle}</p>
          : subtitle}
      </div>
      {actions}
    </div>
  );
}
