/**
 * 文字をクリップボードに入れる。入れられたら true。
 * ブラウザの Clipboard API（navigator.clipboard.writeText）を使う。https の本番と localhost、デスクトップ版
 * （WKWebView）で使え、キーやクリックの中から呼べば許される。API がないときや断られたとき（ウインドウに
 * フォーカスがないなど）は false
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard;
  if (typeof clipboard?.writeText !== "function") return false;
  try {
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
