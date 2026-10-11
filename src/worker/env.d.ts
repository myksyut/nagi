// Worker の設定値とバインディング。値は wrangler.jsonc の vars・d1_databases から入る
// （シークレットはない）。手元では .dev.vars の値（AUTH_DISABLED）も入る
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** /auth/device/start の回数制限（IP ごとに 60 秒で 5 回） */
    AUTH_START_LIMITER: RateLimit;
    /** /auth/device/token と /auth/logout の回数制限（IP ごとに 60 秒で 30 回） */
    AUTH_POLL_LIMITER: RateLimit;
    /** /api/* の回数制限（利用者ごとに 60 秒で 600 回） */
    API_LIMITER: RateLimit;
    APP_TIMEZONE: string;
    GITHUB_CLIENT_ID: string;
    /** 利用者を分ける前からあったデータの持ち主としてログインする GitHub ユーザー ID（なければ空） */
    OWNER_GITHUB_USER_ID?: string;
    /** "open" なら、GitHub のアカウントがあればだれでも登録できる。"allowlist"（既定）なら、許可した人だけ */
    SIGNUP?: string;
    /** SIGNUP が "allowlist" のときに登録・ログインできる GitHub ユーザー ID（カンマ区切り） */
    ALLOWED_GITHUB_USER_IDS?: string;
    /** "true" のとき、localhost からのリクエストに限ってログインを外す（手元の開発用） */
    AUTH_DISABLED?: string;
  }
  // `import { exports } from "cloudflare:workers"` の型（テストで Worker を呼ぶときに使う）
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
