import { and, asc, eq, gt, isNull, lte, or, type SQL, sql } from "drizzle-orm";
import type { ExportKind, ExportPage } from "../../shared/export";
import type { Project, Task } from "../../shared/model";
import type { Db } from "../db/client";
import { projects, tasks } from "../db/schema";
import { projectColumns, taskColumns } from "../sync/rows";

/** 1 ページの行数の上限 */
export const PAGE_ROWS = 1000;

/**
 * 1 ページの大きさの上限。行の大きさは、長さの決まらない文字列の列（tasks は title・memo・checklist（保存してある
 * JSON の文字列）・rank、projects は name）の UTF-8 のバイト数（octet_length）に、ほかの列と JSON の鍵・オブジェクトの
 * ぶんとして ROW_OVERHEAD を足したもの。
 * - 1 行の最大：長さは UTF-16 の単位で数え、1 単位は UTF-8 で 3 バイトまで（保存した checklist の JSON では、制御文字の
 *   \u00XX で 6 バイトまで）。title 500 × 3 + memo 20,000 × 3 + checklist 200 × 500 × 6 + 項目の id と鍵 200 × 60
 *   + rank 1024 + ROW_OVERHEAD で 680 KB 未満（制御文字のない文章なら 380 KB 未満）。どの 1 行も上限に収まるので、
 *   1 ページが上限を超えることはない
 * - Worker のメモリ（128 MB）：数えたバイトを B とする。文字列は UTF-16（ASCII でも、2 バイトの文字列に混ざると 2 バイト）で
 *   1 バイトあたり 2 バイトまで。JSON の文字列は制御文字の \u00XX で 6 倍、UTF-16 なら 12 バイトまで。
 *   D1 の結果を読むとき（届いた JSON ≤ 6B、その文字列 ≤ 12B、行 ≤ 2B）と、応答を作るとき（行と checklist の
 *   配列 ≤ 4B、JSON の文字列 ≤ 12B、UTF-8 の本文 ≤ 6B）のどちらも 24B 以下で、B = 2 MiB なら 48 MiB 以下。
 *   制御文字のない文章なら、その数分の 1
 * - ページの数：上限の行ばかり 20,000 行なら、1 ページ 3 行（制御文字のない文章なら 5 行）で 6,700（4,000）ページ。
 *   小さい行は 1000 行ずつなので、行の数で区切られるページは、プロジェクトとタスクで合わせて 21 ほど
 */
export const PAGE_BYTES = 2 * 1024 * 1024;
export const ROW_OVERHEAD = 1024;

type Keyed = typeof tasks | typeof projects;

/**
 * after より後の id の最大 PAGE_ROWS 行の大きさと、id の順の大きさの累計（total）・順位（n）・行数（available）。
 * 大きさだけを読む（本文は、選んだ行だけを外の問い合わせで読む）
 */
function pageWindow(db: Db, table: Keyed, size: SQL, userId: string, after: string | undefined) {
  const sized = db
    .select({ id: table.id, size: sql<number>`${size} + ${ROW_OVERHEAD}`.as("size") })
    .from(table)
    .where(
      and(
        eq(table.userId, userId),
        isNull(table.deletedAt),
        after === undefined ? undefined : gt(table.id, after),
      ),
    )
    .orderBy(asc(table.id))
    .limit(PAGE_ROWS)
    .as("sized");
  return db.$with("page").as(
    db
      .select({
        id: sized.id,
        total: sql<number>`sum(${sized.size}) over (order by ${sized.id})`.as("total"),
        n: sql<number>`row_number() over (order by ${sized.id})`.as("n"),
        available: sql<number>`count(*) over ()`.as("available"),
      })
      .from(sized),
  );
}

/** 次のページの after。大きさで区切ったか、PAGE_ROWS 行を読み切ったときは最後の行の id、そうでなければ終わり */
function nextAfter(rows: { row: { id: string }; available: number }[]): string | null {
  const last = rows.at(-1);
  if (last === undefined) return null;
  return rows.length < last.available || last.available === PAGE_ROWS ? last.row.id : null;
}

/**
 * 書き出しの 1 ページ。利用者の行を、論理削除のものを除いて、id が after より後のものから id の順に、
 * 大きさの累計が budget に収まるところまで（最低 1 行、最大 PAGE_ROWS 行）読む。
 * 大きさを測るのと行を読むのは一つの SQL の文なので、同じ時点の行で区切る（D1 への問い合わせはページごとに 1 回）。
 * id は変わらないので、ページのあいだに書き換えた行も 1 回だけ出る。ただしページごとに別の時点なので、全体は
 * ある時点の写しではない（読んでいるあいだに作った行・消した行は、入ることも入らないこともある）
 */
export async function readExportPage(
  db: Db,
  userId: string,
  kind: ExportKind,
  after: string | undefined,
  budget: number = PAGE_BYTES,
): Promise<ExportPage<Project> | ExportPage<Task>> {
  if (kind === "projects") {
    const page = pageWindow(db, projects, sql`octet_length(${projects.name})`, userId, after);
    const rows = await db
      .with(page)
      .select({ row: projectColumns, available: page.available })
      .from(projects)
      .innerJoin(page, and(eq(projects.userId, userId), eq(projects.id, page.id)))
      .where(or(eq(page.n, 1), lte(page.total, budget)))
      .orderBy(asc(projects.id));
    return { rows: rows.map(({ row }) => row), next: nextAfter(rows) };
  }
  const page = pageWindow(
    db,
    tasks,
    sql`octet_length(${tasks.title}) + octet_length(${tasks.memo}) + octet_length(${tasks.checklist}) + octet_length(${tasks.rank})`,
    userId,
    after,
  );
  const rows = await db
    .with(page)
    .select({ row: taskColumns, available: page.available })
    .from(tasks)
    .innerJoin(page, and(eq(tasks.userId, userId), eq(tasks.id, page.id)))
    .where(or(eq(page.n, 1), lte(page.total, budget)))
    .orderBy(asc(tasks.id));
  return { rows: rows.map(({ row }) => row), next: nextAfter(rows) };
}
