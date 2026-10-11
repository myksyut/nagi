import { and, asc, eq, gt, isNull } from "drizzle-orm";
import { EXPORT_FORMAT, EXPORT_FORMAT_VERSION } from "../../shared/export";
import type { Db } from "../db/client";
import { projects, tasks } from "../db/schema";
import { projectColumns, taskColumns } from "../sync/rows";

/** 1 回に読む行数 */
const PAGE_SIZE = 1000;
/** これだけたまったら、応答へ流す（文字数） */
const CHUNK_LENGTH = 64 * 1024;

/**
 * id の順に、1 ページずつ読む。seq は行を書き換えるたびに進むので、seq で区切ると、読んでいるあいだに
 * 書き換えた行が後のページにもう一度出る。id は変わらないので、どの行も 1 回だけ出る
 */
async function* rowsById<Row extends { id: string }>(
  readPage: (afterId: string | undefined) => Promise<Row[]>,
): AsyncGenerator<Row> {
  let afterId: string | undefined;
  for (;;) {
    const page = await readPage(afterId);
    yield* page;
    const last = page.at(-1);
    if (page.length < PAGE_SIZE || last === undefined) return;
    afterId = last.id;
  }
}

/** 書き出しの JSON（exportSchema の形。2 文字の字下げ）を、ページを読みながら少しずつ作る */
async function* documentText(db: Db, userId: string, now: Date): AsyncGenerator<string> {
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
      rowsById((afterId) =>
        db
          .select(projectColumns)
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
      ),
    ],
    [
      "tasks",
      rowsById((afterId) =>
        db
          .select(taskColumns)
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
 * 利用者の行を、論理削除のものを除いて、id の順に 1000 行ずつ読み、書き出しの JSON として流す
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
): Promise<ReadableStream<Uint8Array>> {
  const chunks = documentText(db, userId, now);
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
