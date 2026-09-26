/**
 * 各機能の登録（キーの割り当て・行の右側の情報・開いたタスクの欄）を読み込む。
 * features/<名前>/register.ts(x) を自動で読み込むので、機能を足すときは自分のフォルダを作るだけでよい
 * （このファイルは直さない。5 と 6 が並行して足しても、同じファイルを取り合わないように）。
 * 登録の口は keyboard/keymap.ts（registerKeyBindings）と tasks/extensions.ts（registerRowMeta・registerDetailField）
 */
import.meta.glob("./*/register.{ts,tsx}", { eager: true });
