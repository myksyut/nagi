// テストのときだけ入るバインディング（vitest.config.ts）
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    /** マイグレーションのテスト用の、空の D1（DB とは別） */
    MIGRATION_TEST_DB: D1Database;
  }
}
