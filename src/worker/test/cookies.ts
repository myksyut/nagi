/** テストで Set-Cookie / Cookie ヘッダを読み書きするための小さなヘルパー */

export type ParsedCookie = {
  name: string;
  value: string;
  attrs: Record<string, string | true>;
};

/** `Set-Cookie` ヘッダ1本を解析する（`response.headers.getSetCookie()` の各要素に使う） */
export function parseSetCookie(header: string): ParsedCookie {
  const [pair = "", ...rest] = header.split(";").map((part) => part.trim());
  const eq = pair.indexOf("=");
  const name = pair.slice(0, eq);
  const value = pair.slice(eq + 1);
  const attrs: Record<string, string | true> = {};
  for (const part of rest) {
    const i = part.indexOf("=");
    if (i === -1) attrs[part] = true;
    else attrs[part.slice(0, i)] = part.slice(i + 1);
  }
  return { name, value, attrs };
}

/** `Set-Cookie` ヘッダの配列から、指定した名前の Cookie を探す */
export function findSetCookie(setCookies: string[], name: string): ParsedCookie | undefined {
  return setCookies.map(parseSetCookie).find((cookie) => cookie.name === name);
}

/** リクエストに付ける `Cookie` ヘッダを組み立てる */
export function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
}
