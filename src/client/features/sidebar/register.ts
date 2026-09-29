import { registerKeyBindings } from "@/keyboard/keymap";
import { SIDEBAR_TOGGLE_BINDING_ID, toggleSidebar } from "@/shell/sidebar-state";

/**
 * 20 の登録：⌘\ でサイドバーを畳む・広げる（⌘K の同じ名前の操作と、サイドバーの一番下のボタンも同じ割り当て）。
 * JIS キーボードの ¥ のキー（⌘¥）でも効かせる。データを変えないので、読み込みの前でも、入力欄の中でも、
 * ポップオーバー（カレンダーの小さな追加欄・小さな詳細など）の中でも効かせる
 */
registerKeyBindings({
  id: SIDEBAR_TOGGLE_BINDING_ID,
  label: "サイドバーを畳む・広げる",
  group: "全体",
  keys: ["Mod+\\", "Mod+¥"],
  allowInInput: true,
  allowInPopover: true,
  allowBeforeLoad: true,
  run: ({ ui }) => toggleSidebar(ui),
});
