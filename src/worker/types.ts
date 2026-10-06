export type AppEnv = {
  Bindings: Cloudflare.Env;
  Variables: {
    /** ログインしている利用者（users.id）。/api/* では requireSession が入れる */
    userId: string;
  };
};
