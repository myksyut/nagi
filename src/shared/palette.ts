/**
 * プロジェクトの色のパレット。D1 と API には名前だけを持ち、色の値そのものは画面が決める
 * （色味を調整しても、データを書き換えずに済むように）。名前を消したり並びを変えたりしない
 */
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

export function isProjectColor(value: unknown): value is ProjectColor {
  return typeof value === "string" && (PROJECT_COLORS as readonly string[]).includes(value);
}

/** 作成順で i 番目（0 始まり）のプロジェクトの色。i を 8 で割った余りの色 */
export function autoProjectColor(index: number): ProjectColor {
  const count = PROJECT_COLORS.length;
  return PROJECT_COLORS[((Math.trunc(index) % count) + count) % count] as ProjectColor;
}

/** 作成順の色を決めるのに使うプロジェクトの項目 */
export type ColoredProject = {
  id: string;
  color: ProjectColor | null;
  createdAt: string;
  deletedAt: string | null;
};

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 作成順の並び：削除済みを除くすべてのプロジェクト（アーカイブ済みも数に入れる）を、
 * 作成の時刻（createdAt）の順、同じなら id の順に並べる
 */
export function orderForAutoColor<T extends ColoredProject>(projects: Iterable<T>): T[] {
  return Array.from(projects)
    .filter((project) => project.deletedAt === null)
    .sort((a, b) => compareStrings(a.createdAt, b.createdAt) || compareStrings(a.id, b.id));
}

/**
 * 各プロジェクトの色（id → 色）。color があればその色、空なら作成順の i 番目に autoProjectColor(i)。
 * 削除済みのプロジェクトは入れない
 */
export function resolveProjectColors(
  projects: Iterable<ColoredProject>,
): Map<string, ProjectColor> {
  const colors = new Map<string, ProjectColor>();
  orderForAutoColor(projects).forEach((project, i) => {
    colors.set(project.id, project.color ?? autoProjectColor(i));
  });
  return colors;
}
