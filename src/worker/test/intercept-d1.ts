import { type Db, getDb } from "../db/client";

/**
 * 同時に走る状況を、タイミング任せにせず決定的に作るためのテスト用ヘルパー。
 * D1Database を包み、batch() が呼ばれる直前・個々のクエリ（first/all/run/raw）が終わった直後に
 * 好きな処理を差し込める。差し込む処理の中で、別の（包んでいない）db を使って先行リクエストの
 * 続きを確定させる、といった使い方をする。
 *
 * 仕組み：drizzle-orm の D1 セッションは、単発のクエリなら
 * `client.prepare(sql).bind(...).all()`（get/all/run も同様）を呼び、db.batch() のときは
 * `client.prepare(sql).bind(...)` で作った「包んだままの文」の配列を `client.batch()` に渡す。
 * そのため batch() では、渡された文を WeakMap で本物の文に戻してから、本物の batch() を呼ぶ
 */
export type InterceptOptions = {
  /** batch() が呼ばれる直前に呼ぶ。何回目の batch() 呼び出しかを 1 始まりで渡す */
  beforeBatch?: (n: number) => void | Promise<void>;
  /** 個々のクエリ（first/all/run/raw）が終わった直後に呼ぶ。SQL 文字列と、何回目の呼び出しかを渡す */
  afterQuery?: (sql: string, n: number) => void | Promise<void>;
};

type Method = "first" | "all" | "run" | "raw";
const INTERCEPTED_METHODS: readonly Method[] = ["first", "all", "run", "raw"];

export function interceptD1(real: D1Database, opts: InterceptOptions): D1Database {
  let batchCalls = 0;
  let queryCalls = 0;
  const realOf = new WeakMap<object, D1PreparedStatement>();

  function wrap(stmt: D1PreparedStatement, sqlText: string): D1PreparedStatement {
    const wrapped = {} as Record<string, unknown>;
    wrapped.bind = (...values: unknown[]) => wrap(stmt.bind(...values), sqlText);
    for (const method of INTERCEPTED_METHODS) {
      wrapped[method] = async (...args: unknown[]) => {
        const fn = stmt[method] as (...a: unknown[]) => Promise<unknown>;
        const result = await fn.apply(stmt, args);
        queryCalls += 1;
        if (opts.afterQuery) await opts.afterQuery(sqlText, queryCalls);
        return result;
      };
    }
    const typed = wrapped as unknown as D1PreparedStatement;
    realOf.set(typed, stmt);
    return typed;
  }

  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (query: string) => wrap(target.prepare(query), query);
      }
      if (prop === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          batchCalls += 1;
          if (opts.beforeBatch) await opts.beforeBatch(batchCalls);
          const reals = statements.map((statement) => realOf.get(statement) ?? statement);
          return target.batch(reals);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/** interceptD1 で包んだ D1Database から、drizzle のインスタンスを作る */
export function interceptedDb(real: D1Database, opts: InterceptOptions): Db {
  return getDb(interceptD1(real, opts));
}
