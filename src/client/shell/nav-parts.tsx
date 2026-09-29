import { observer } from "mobx-react-lite";
import { AnimatePresence, m } from "motion/react";
import { useState } from "react";
import { DURATION, EASE_OUT } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * サイドバーの行の部品（リストの行とプロジェクトの行で共通）。見た目はデザインの方向 A「夜の深み」：
 * 選んでいるリストは左から紫がにじみ、左の辺に細い線。ホバーは白をわずかに重ねる。
 * フォーカスの輪郭は outline で、選んでいる行の見た目とは別に出す
 */

/**
 * サイドバーの1行の見た目。
 * dropping は、運んでいる行を重ねているあいだ（落とすと移せる）
 */
export function navLinkClassName(active: boolean, dropping = false): string {
  return cn(
    "flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] outline-none",
    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
    !active && "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
    active &&
      "bg-(image:--sidebar-active) text-sidebar-accent-foreground shadow-[inset_2px_0_0_var(--sidebar-primary)]",
    dropping &&
      "bg-primary/15 text-sidebar-accent-foreground outline-1 -outline-offset-1 outline-primary/60",
  );
}

/**
 * サイドバーの1行の名前。畳んだとき（帯）は、行の幅が縮んで名前が切れ、さらに透明にする
 * （読み上げには残る。名前は帯の右に出す札で見せる。sidebar.tsx の useRailTip）
 */
export const navLabelClassName =
  "min-w-0 flex-1 truncate transition-opacity duration-(--duration-short) rail:opacity-0";

/**
 * サイドバーのアイコンの色。色は意味のあるところにだけ使う：ふだんは控えめな灰、今いる場所だけ選択の紫
 * （リストごとの色は付けない。プロジェクトは色の点で見分ける）
 */
export function navIconColor(active: boolean): string {
  return active ? "var(--nav-icon-current)" : "var(--nav-icon)";
}

/**
 * 件数を読んで出す（0 件なら出さない）。件数はここでだけ読むので、件数が変わっても描き直すのは数字だけ
 * （行のリンクやドラッグの受け口、色の点は描き直さない）
 */
export const NavCountOf = observer(function NavCountOf({ count }: { count: () => number }) {
  const n = count();
  return n > 0 ? <NavCount count={n} /> : null;
});

/** 件数の数字が入れ替わるときの動き（増えたら下から、減ったら上から。数字だけが小さく入れ替わる） */
const COUNT_VARIANTS = {
  enter: (direction: number) => ({ y: direction * 6, opacity: 0 }),
  shown: { y: 0, opacity: 1, transition: { duration: DURATION.short, ease: EASE_OUT } },
  leave: (direction: number) => ({
    y: direction * -6,
    opacity: 0,
    transition: { duration: DURATION.exit, ease: EASE_OUT },
  }),
};

/**
 * サイドバーの未完了の件数（受信箱 3 → 2 など）。行の右端に出す。数字だけが小さく入れ替わる
 * （transitions.dev の数字の入れ替えを写したもの）。
 * 最初の描画とリストの切り替えでは動かさない。読み上げには「（3件）」を出す。
 * 畳んだとき（帯）は透明にする（帯の右に出す札が data-nav-count を読んで、名前に添える）
 */
export function NavCount({ count }: { count: number }) {
  // 前の件数との比べ（描き直しのたびではなく、件数が変わったときだけ向きを決める）
  const [last, setLast] = useState({ count, direction: 1 });
  if (last.count !== count) setLast({ count, direction: count > last.count ? 1 : -1 });
  const { direction } = last;
  return (
    <span
      data-nav-count={count}
      className="relative ml-auto inline-grid flex-none justify-items-end text-[11px] text-faint-foreground tabular-nums transition-opacity duration-(--duration-short) rail:opacity-0"
    >
      <span className="sr-only">（{count}件）</span>
      {/*
        抜けていく数字は、新しい数字と同じ升目に重ねる。popLayout（抜けていく要素の位置を描き直しの途中で測る）は
        使わない（完了のたびにレイアウトの計算を起こさないため）
      */}
      <AnimatePresence initial={false} custom={direction}>
        <m.span
          key={count}
          aria-hidden="true"
          className="col-start-1 row-start-1"
          custom={direction}
          variants={COUNT_VARIANTS}
          initial="enter"
          animate="shown"
          exit="leave"
        >
          {count}
        </m.span>
      </AnimatePresence>
    </span>
  );
}
