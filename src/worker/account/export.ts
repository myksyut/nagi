import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from "../../shared/export";
import type { Db } from "../db/client";
import { projects, tasks } from "../db/schema";
import { projectColumns, taskColumns } from "../sync/rows";

/** 1 ページに読む行数の上限 */
const PAGE_SIZE = 1000;
/** 1 ページの文章の量の目安（文字数）。1 行だけで超えるときは、その 1 行で 1 ページにする */
const PAGE_BYTES = 4 * 1024 * 1024;
/** これだけたまったら、応答へ流す（文字数） */
const CHUNK_LENGTH = 64 * 1024;

type Sized = { id: string; size: number };

/**
 * id の順に、1 ページずつ読む。seq は行を書き換えるたびに進むので、seq で区切ると、読んでいるあいだに
 * 書き換えた行が後のページにもう一度出る。id は変わらないので、どの行も 1 回だけ出る。
 * 1 ページは、まず次の最大 1000 行の id と大きさ（文章の列の長さ）だけを読み、大きさの合計が pageBytes に
 * 収まるところ（最低 1 行）までを決めてから、その id の範囲の全部の列を読む。
 * 読み出しはページごとに 2 回なので、D1 への問い合わせは、利用者の行 N に対して、およそ 2 × ページ数
 * （1000 行ごと、大きい行が続けばそれより細かく）になる
 */
async function* rowsById<Row extends { id: string }>(
  pageBytes: number,
  readSizes: (afterId: string | undefined) => Promise<Sized[]>,
  readRows: (afterId: string | undefined, lastId: string) => Promise<Row[]>,
): AsyncGenerator<Row> {
  let afterId: string | undefined;
  for (;;) {
    const sizes = await readSizes(afterId);
    let count = 0;
    let bytes = 0;
    for (const { size } of sizes) {
      if (count > 0 && bytes + size > pageBytes) break;
      bytes += size;
      count += 1;
    }
    const last = sizes[count - 1];
    if (last === undefined) return;
    yield* await readRows(afterId, last.id);
    if (count === sizes.length && sizes.length < PAGE_SIZE) return;
    afterId = last.id;
  }
}

/** 書き出しの JSON（exportSchema の形。2 文字の字下げ）を、ページを読みながら少しずつ作る */
async function* documentText(
  db: Db,
  userId: string,
  now: Date,
  pageBytes: number,
): AsyncGenerator<string> {
  const head = JSON.stringify(
    {
      format: EXPORT_FORMAT,
      formatVersion: EXPORT_FORMAT_VERSION,
      exportedAt: now.toISOString(),
      app: "nagi-worker",
    },
    null,
    2,
  );
  // 閉じの "\n}" を外して、続けて配列を書く
  let text = head.slice(0, -2);
  // deletedAt は isNull で絞ってあるので、どの行も null
  const lists = [
    [
      "projects",
      rowsById(
        pageBytes,
        (afterId) =>
          db
            .select({ id: projects.id, size: sql<number>`length(${projects.name})` })
            .from(projects)
            .where(
              and(
                eq(projects.userId, userId),
                isNull(projects.deletedAt),
                afterId === undefined ? undefined : gt(projects.id, afterId),
              ),
            )
            .orderBy(asc(projects.id))
            .limit(PAGE_SIZE),
        (afterId, lastId) =>
          db
            .select(projectColumns)
            .from(projects)
            .where(
              and(
                eq(projects.userId, userId),
                isNull(projects.deletedAt),
                afterId === undefined ? undefined : gt(projects.id, afterId),
                lte(projects.id, lastId),
              ),
            )
            .orderBy(asc(projects.id)),
      ),
    ],
    [
      "tasks",
      rowsById(
        pageBytes,
        (afterId) =>
          db
            .select({
              id: tasks.id,
              size: sql<number>`length(${tasks.title}) + length(${tasks.memo}) + length(${tasks.checklist})`,
            })
            .from(tasks)
            .where(
              and(
                eq(tasks.userId, userId),
                isNull(tasks.deletedAt),
                afterId === undefined ? undefined : gt(tasks.id, afterId),
              ),
            )
            .orderBy(asc(tasks.id))
            .limit(PAGE_SIZE),
        (afterId, lastId) =>
          db
            .select(taskColumns)
            .from(tasks)
            .where(
              and(
                eq(tasks.userId, userId),
                isNull(tasks.deletedAt),
                afterId === undefined ? undefined : gt(tasks.id, afterId),
                lte(tasks.id, lastId),
              ),
            )
            .orderBy(asc(tasks.id)),
      ),
    ],
  ] as const;
  for (const [key, rows] of lists) {
    text += `,\n  ${JSON.stringify(key)}: [`;
    let first = true;
    for await (const row of rows) {
      text += `${first ? "\n" : ",\n"}    ${JSON.stringify(row, null, 2).replaceAll("\n", "\n    ")}`;
      first = false;
      if (text.length >= CHUNK_LENGTH) {
        yield text;
        text = "";
      }
    }
    text += first ? "]" : "\n  ]";
  }
  yield `${text}\n}`;
}

/**
 * 利用者の行を、論理削除のものを除いて、id の順に、文章が pageBytes（最大 1000 行）に収まるページごとに読み、
 * 書き出しの JSON として流す
 * （全部の行も、JSON の全体も持たない）。
 * ページごとに別の読み出しなので、ある時点の写しではない。読んでいるあいだに作った行・消した行は、入ることも
 * 入らないこともあり、プロジェクトを読み終えてから作ったプロジェクトを指すタスクも入りうる
 * （取り込みは、ないプロジェクトを指すタスクを、プロジェクトから外して入れる）。
 * 最初のページは応答を返す前に読む（読めなければ、途中で切れた 200 ではなく、エラーの応答になる）
 */
export async function exportAccount(
  db: Db,
  userId: string,
  now: Date,
  pageBytes: number = PAGE_BYTES,
): Promise<ReadableStream<Uint8Array>> {
  const chunks = documentText(db, userId, now, pageBytes);
  const encoder = new TextEncoder();
  const first = await chunks.next();
  let pending: string | undefined = first.done ? undefined : first.value;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending !== undefined) {
        controller.enqueue(encoder.encode(pending));
        pending = undefined;
        return;
      }
      const next = await chunks.next();
      if (next.done) {
        controller.close();
      } else {
        controller.enqueue(encoder.encode(next.value));
      }
    },
    async cancel() {
      await chunks.return(undefined);
    },
  });
}
