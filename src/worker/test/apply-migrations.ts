import { applyD1Migrations, env } from "cloudflare:test";

// 各テストファイルの前に、migrations/ のマイグレーションをテスト用の D1 に当てる（当て済みなら何もしない）
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
