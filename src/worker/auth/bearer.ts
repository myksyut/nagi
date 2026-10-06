/**
 * `Authorization: Bearer <token>` のトークンを取り出す。ヘッダがない・形が違うときは null。
 * TUI は、ログインで受け取ったセッションのトークンをこの形で毎回付ける（Cookie は使わない）
 */
export function readBearerToken(header: string | undefined): string | null {
  const match = /^Bearer +([A-Za-z0-9\-._~+/]+=*)$/i.exec(header ?? "");
  return match?.[1] ?? null;
}
