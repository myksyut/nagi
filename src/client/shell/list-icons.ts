import {
  CalendarDaysIcon,
  CalendarRangeIcon,
  CheckIcon,
  InboxIcon,
  LayersIcon,
  type LucideIcon,
  SunIcon,
} from "lucide-react";
import type { ListKey, ViewKey } from "../navigation";

/**
 * リストごとのアイコンと色（lucide の線のアイコンを、リストの色で塗る）。サイドバーと見出しで使う。
 * 色の値は styles.css の --list-*（受信箱：青、今日：琥珀、予定：橙、あとで：青緑、完了ログ：灰）
 */
export const LIST_ICONS: Record<ListKey, { Icon: LucideIcon; color: string }> = {
  inbox: { Icon: InboxIcon, color: "var(--list-inbox)" },
  today: { Icon: SunIcon, color: "var(--list-today)" },
  upcoming: { Icon: CalendarDaysIcon, color: "var(--list-upcoming)" },
  later: { Icon: LayersIcon, color: "var(--list-later)" },
  logbook: { Icon: CheckIcon, color: "var(--list-logbook)" },
};

/** 「ビュー」のアイコンと色（カレンダー：紫、タイムライン：緑） */
export const VIEW_ICONS: Record<ViewKey, { Icon: LucideIcon; color: string }> = {
  calendar: { Icon: CalendarRangeIcon, color: "var(--list-calendar)" },
};
