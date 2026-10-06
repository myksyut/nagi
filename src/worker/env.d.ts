// Worker の設定値とバインディング。値は wrangler.jsonc の vars・d1_databases から入る
// （シークレットはない）。手元では .dev.vars の値（AUTH_DISABLED）も入る
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    APP_TIMEZONE: string;
    GITHUB_CLIENT_ID: string;
    ALLOWED_GITHUB_USER_ID: string;
    /** "true" のとき、localhost からのリクエストに限ってログインを外す（手元の開発用） */
    AUTH_DISABLED?: string;
  }
  // `import { exports } from "cloudflare:workers"` の型（テストで Worker を呼ぶときに使う）
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
