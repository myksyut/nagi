// テストのときだけ入るバインディング（vitest.config.ts）
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
    /** マイグレーションのテスト用の、空の D1（DB とは別。0002 のテスト） */
    MIGRATION_TEST_DB: D1Database;
    /** マイグレーションのテスト用の、空の D1（DB とも MIGRATION_TEST_DB とも別。0003 のテスト） */
    MIGRATION_0003_TEST_DB: D1Database;
  }
}
