import { createContext, type ReactNode, useContext } from "react";
import { useUi } from "./ui-context";

/**
 * 開いたタスクの欄（メモ・チェックリスト・小さなボタン）が、どこに出ているか。
 * - 一覧の中（既定。リストの行の下に広がる）：閉じると、開いたタスクを閉じて一覧へフォーカスを戻す
 * - 小さな詳細（task-detail-popover.tsx。カレンダーとタイムラインのポップオーバー）：閉じるとポップオーバーを閉じ、
 *   押した場所へフォーカスを戻す。欄から開く日付の入力と p の候補は、行ではなく小さな詳細の中に描く（detached）
 */
export type DetailSurface = {
  /** 閉じる（入力欄の Esc、タイトルの Enter）。打った文字は、呼ぶ側が先に保存しておく */
  close: () => void;
  /** 小さな詳細の中か */
  detached: boolean;
  /**
   * 欄の中の要素の id に付ける接頭辞。一覧の中は ""（これまでどおりの id）、小さな詳細は詳細ごとに別の値。
   * 同じタスクが一覧と小さな詳細の両方に出ても id が重ならず、id で探すフォーカスの移し先が相手の側へ飛ばないように
   */
  idScope: string;
};

const DetailSurfaceContext = createContext<DetailSurface | null>(null);

export function DetailSurfaceProvider({
  value,
  children,
}: {
  value: DetailSurface;
  children: ReactNode;
}) {
  return <DetailSurfaceContext value={value}>{children}</DetailSurfaceContext>;
}

/** 開いたタスクの欄のいる場所。小さな詳細の外（一覧の中）なら、閉じると開いたタスクを閉じて一覧へ戻る */
export function useDetailSurface(): DetailSurface {
  const ui = useUi();
  return (
    useContext(DetailSurfaceContext) ?? {
      close: () => {
        ui.close();
        ui.focusList();
      },
      detached: false,
      idScope: "",
    }
  );
}
