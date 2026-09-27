import { computed, type IComputedValue } from "mobx";
import type { AppStore } from "@/data";

/**
 * プロジェクトの色（8 色のパレット。名前で持ち、色の値は styles.css の --project-<名前>）。
 * 点・文字・棒の色に使う（点にはほのかな光を付ける。styles.css の project-dot）。
 *
 * **一時の決め方（チケット 9）**：プロジェクトのデータにまだ色（color）がないので、作成順で決める。
 * 削除済みを除くすべてのプロジェクト（アーカイブ済みも数に入れる）を作成順（created_at、同じなら id）に並べ、
 * i 番目に PROJECT_COLORS[i % 8] を付ける（アーカイブしても、ほかのプロジェクトの色がずれないように）。
 * チケット 10 が src/shared/palette.ts とプロジェクトの `color` を足すので、チケット 11 で
 * projectColorOf の中身をデータの `color` を読む形に差し替え、パレットの名前も palette.ts から取る。
 * 画面の側は projectColorOf / projectColorVar だけを使い、色の決め方を知らないようにしておく
 */

/** パレットの名前（この順に付ける）。styles.css の --project-* と同じ */
export const PROJECT_COLORS = [
  "violet",
  "sky",
  "pink",
  "amber",
  "emerald",
  "orange",
  "teal",
  "slate",
] as const;

export type ProjectColor = (typeof PROJECT_COLORS)[number];

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** ストアごとの「プロジェクトの id → 色の名前」（プロジェクトが増えた・消えたときだけ計算し直す） */
const colorMaps = new WeakMap<AppStore, IComputedValue<ReadonlyMap<string, ProjectColor>>>();

function colorMapOf(store: AppStore): ReadonlyMap<string, ProjectColor> {
  let map = colorMaps.get(store);
  if (!map) {
    map = computed(() => {
      const projects = store.replica
        .allProjects()
        .map((project) => project.peek())
        .filter((project) => project.deletedAt === null)
        .sort((a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id));
      return new Map(
        projects.map((project, i) => [
          project.id,
          PROJECT_COLORS[i % PROJECT_COLORS.length] ?? PROJECT_COLORS[0],
        ]),
      );
    });
    colorMaps.set(store, map);
  }
  return map.get();
}

/** そのプロジェクトの色の名前（見つからないときは最初の色） */
export function projectColorOf(store: AppStore, projectId: string): ProjectColor {
  return colorMapOf(store).get(projectId) ?? PROJECT_COLORS[0];
}

/** 色の名前の CSS の値（例：`var(--project-violet)`） */
export function projectColorVar(color: ProjectColor): string {
  return `var(--project-${color})`;
}
