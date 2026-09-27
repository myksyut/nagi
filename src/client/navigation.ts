/** サイドバーに並ぶリストと、その URL。サイドバーとルーティングの両方がここを見る */
export type ListKey = "inbox" | "today" | "upcoming" | "later" | "logbook";

export type ListEntry = { key: ListKey; path: string; label: string };

/** サイドバーの上に並ぶ「いつやるか」のリスト */
export const BUCKET_LISTS: readonly ListEntry[] = [
  { key: "inbox", path: "/inbox", label: "受信箱" },
  { key: "today", path: "/today", label: "今日" },
  { key: "upcoming", path: "/upcoming", label: "予定" },
  { key: "later", path: "/later", label: "あとで" },
];

/** サイドバーの一番下の完了ログ */
export const LOGBOOK: ListEntry = { key: "logbook", path: "/logbook", label: "完了ログ" };

/** サイドバーの「ビュー」の見出しの下に並ぶ画面（カレンダー・タイムライン） */
export type ViewKey = "calendar";

export type ViewEntry = { key: ViewKey; path: string; label: string };

export const CALENDAR: ViewEntry = { key: "calendar", path: "/calendar", label: "カレンダー" };

/**
 * 「ビュー」の並び（上から）。サイドバーはこれを並べ、アイコンと色は shell/list-icons.ts の VIEW_ICONS。
 * ビューを足すときは、ここと VIEW_ICONS に1行ずつ、app.tsx にルートを1行足す
 */
export const VIEWS: readonly ViewEntry[] = [CALENDAR];

export const HOME_PATH = "/today";

export const PROJECT_PATH_PATTERN = "/projects/:id";

export function projectPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}`;
}
