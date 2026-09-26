import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const alias = {
  "@": fileURLToPath(new URL("./src/client", import.meta.url)),
  "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
};

/**
 * テストは2つの project に分ける
 * - worker：Workers 用テストプール（workerd の中）。D1 込みで、各テストファイルの前にマイグレーションを当てる
 * - client：happy-dom と fake-indexeddb。タイマーは各テストで vi.useFakeTimers() を使う
 * src/shared のテストは client の project で回す
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
                // テスト用の値。wrangler.jsonc や .dev.vars の値より優先される
                bindings: {
                  TEST_MIGRATIONS: migrations,
                  GITHUB_CLIENT_ID: "test-client-id",
                  GITHUB_CLIENT_SECRET: "test-client-secret",
                  ALLOWED_GITHUB_USER_ID: "1001",
                  AUTH_DISABLED: "false",
                },
              },
            }),
          ],
          resolve: { alias },
          test: {
            name: "worker",
            include: ["src/worker/**/*.test.ts"],
            setupFiles: ["./src/worker/test/apply-migrations.ts"],
          },
        },
        {
          plugins: [react()],
          resolve: { alias },
          test: {
            name: "client",
            include: ["src/client/**/*.test.{ts,tsx}", "src/shared/**/*.test.ts"],
            environment: "happy-dom",
            setupFiles: ["./src/client/test/setup.ts"],
          },
        },
      ],
    },
  };
});
