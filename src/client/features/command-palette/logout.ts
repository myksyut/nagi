/**
 * ログアウト（⌘K の「ログアウト」から）。セッションを消してもらう。
 * Worker は書き込みの要求に JSON の本文を求めるので、本文は `{}` にする（1 の決まり）。
 * 消せたら true（呼ぶ側がログイン画面へ移る）。通信に失敗したら false
 */
export async function logout(fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  try {
    const response = await fetchImpl("/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
    });
    return response.ok;
  } catch {
    return false;
  }
}
