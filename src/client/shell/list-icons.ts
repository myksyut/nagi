import {
  CalendarDaysIcon,
  CalendarRangeIcon,
  ChartNoAxesGanttIcon,
  CheckIcon,
  InboxIcon,
  KeyboardIcon,
  LayersIcon,
  type LucideIcon,
  SunIcon,
} from "lucide-react";
import type { ListKey, ViewKey } from "../navigation";

/**
 * リスト・ビュー・ショートカットのページのアイコン（lucide の線のアイコン）。サイドバーと見出しで使う。
 * アイコンにはリストごとの色を付けない。サイドバーでは控えめな灰（--nav-icon）、今いる場所だけ選択の紫
 * （--nav-icon-current。nav-parts.tsx の navIconColor）。見出しの台（list-tile）はいつも選択の紫
 */
export const LIST_ICONS: Record<ListKey, LucideIcon> = {
  inbox: InboxIcon,
  today: SunIcon,
  upcoming: CalendarDaysIcon,
  later: LayersIcon,
  logbook: CheckIcon,
};

/** 「ビュー」のアイコン */
export const VIEW_ICONS: Record<ViewKey, LucideIcon> = {
  calendar: CalendarRangeIcon,
  timeline: ChartNoAxesGanttIcon,
};

/** ショートカットのページのアイコン（キーボード） */
export const SHORTCUTS_ICON: LucideIcon = KeyboardIcon;
