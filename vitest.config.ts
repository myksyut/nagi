import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

/**
 * テストは2つの project に分ける
 * - worker：Workers 用テストプール（workerd の中）。D1 込みで、各テストファイルの前にマイグレーションを当てる
 * - shared：src/shared（Worker が使う型・検証スキーマ・論理日付・並び順キー）。Node でそのまま回す
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./migrations", import.meta.url)),
  );

  return {
    test: {
      projects: [
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: "./wrangler.jsonc" },
              miniflare: {
                // マイグレーションのテスト用の、空の D1（DB とは別。好きな版まで当てて、行を入れてから次を当てる）。
                // 版ごとに分ける（前の版のテストが最後まで当てた D1 を、次の版のテストが使わないように）
                d1Databases: {
                  MIGRATION_TEST_DB: "migration-test",
                  MIGRATION_0003_TEST_DB: "migration-0003-test",
                  MIGRATION_0004_TEST_DB: "migration-0004-test",
                },
                // テスト用の値。wrangler.jsonc や .dev.vars の値より優先される
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  GITHUB_CLIENT_ID: "test-client-id",
                  OWNER_GITHUB_USER_ID: "1001",
                  SIGNUP: "allowlist",
                  ALLOWED_GITHUB_USER_IDS: "",
                  AUTH_DISABLED: "false",
                },
              },
            }),
          ],
          test: {
            name: "worker",
            include: ["src/worker/**/*.test.ts"],
            setupFiles: ["./src/worker/test/apply-migrations.ts"],
          },
        },
        {
          test: {
            name: "shared",
            include: ["src/shared/**/*.test.ts"],
            environment: "node",
          },
        },
      ],
    },
  };
});
