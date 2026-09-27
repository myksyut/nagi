import { PROJECT_COLORS, type ProjectColor } from "@shared/palette";
import type { AppStore } from "@/data";

/**
 * プロジェクトの色（8 色のパレット。名前で持ち、色の値は styles.css の --project-<名前>）。
 * 点・文字・棒の色に使う（点にはほのかな光を付ける。styles.css の project-dot）。
 * 色はデータ層の store.lists.projectColor(id) から取る（選んだ色 `color` があればその色、空なら作成順の色）。
 * 画面の側は projectColorOf / projectColorVar だけを使い、色の決め方を知らないようにしておく
 */

export { PROJECT_COLORS, type ProjectColor };

/** 色の選び直し（プロジェクトの画面の見出し）で、読み上げとツールチップに出す名前 */
export const PROJECT_COLOR_LABELS: Record<ProjectColor, string> = {
  violet: "紫",
  sky: "水色",
  pink: "ピンク",
  amber: "黄",
  emerald: "緑",
  orange: "橙",
  teal: "青緑",
  slate: "灰",
};

/**
 * そのプロジェクトの色の名前（見つからない・削除済みのときは最初の色）。
 * そのプロジェクトの色と作成順の並びだけを観測する（ほかのプロジェクトの名前や色が変わっても知らせない）
 */
export function projectColorOf(store: AppStore, projectId: string): ProjectColor {
  return store.lists.projectColor(projectId) ?? PROJECT_COLORS[0];
}

/** 色の名前の CSS の値（例：`var(--project-violet)`） */
export function projectColorVar(color: ProjectColor): string {
  return `var(--project-${color})`;
}
