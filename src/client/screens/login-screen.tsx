import { useEffect } from "react";
import { useSearch } from "wouter";
import { Button } from "@/components/ui/button";

/** /auth/callback が失敗したときに付ける ?error= の値と、出す文言 */
const ERROR_MESSAGES: Record<string, string> = {
  forbidden: "このアカウントではログインできません",
  config: "ログインの設定が済んでいません",
};
const FALLBACK_ERROR_MESSAGE = "ログインできませんでした。もう一度お試しください";

export function LoginScreen() {
  const error = new URLSearchParams(useSearch()).get("error");

  useEffect(() => {
    document.title = "ログイン — nagi";
  }, []);

  return (
    <main className="flex min-h-dvh items-center justify-center px-4">
      <div className="flex w-full max-w-64 flex-col items-center gap-6">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden="true"
            className="size-6 rounded-lg bg-(image:--brand) shadow-[0_0_18px_var(--brand-glow)]"
          />
          <h1 className="font-semibold text-2xl tracking-tight">nagi</h1>
        </div>
        {/* GitHub へは画面ごと移る（/auth/login は Worker が返すリダイレクト） */}
        <Button className="w-full" render={<a href="/auth/login" />}>
          GitHub でログイン
        </Button>
        {error !== null && (
          <p role="alert" className="text-center text-muted-foreground text-sm">
            {ERROR_MESSAGES[error] ?? FALLBACK_ERROR_MESSAGE}
          </p>
        )}
      </div>
    </main>
  );
}
