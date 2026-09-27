/**
 * 空の表示に添える「＋ か N で追加」（右下の「＋」か n で追加欄が開く）。
 * 今日の「すべて完了しました」（静かに出すだけ）と、追加しても入らない完了ログには添えない
 */
export function AddHint() {
  return <p className="mt-1.5 text-faint-foreground text-xs">＋ か N で追加</p>;
}
