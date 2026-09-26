import { defineConfig } from "drizzle-kit";

// 出力先は wrangler.jsonc の migrations_dir と同じ。適用は wrangler（pnpm db:migrate:local / remote）で行う
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/worker/db/schema.ts",
  out: "./migrations",
});
