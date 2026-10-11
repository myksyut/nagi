export type AppEnv = {
  Bindings: Cloudflare.Env;
  Variables: {
    /** ログインしている利用者（users.id）。/api/* では requireSession が入れる */
    userId: string;
    /** その利用者の IANA タイムゾーン。設定がなければ null（APP_TIMEZONE として扱う）。/api/* では requireSession が入れる */
    timeZone: string | null;
  };
};
