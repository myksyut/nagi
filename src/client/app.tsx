import type { ComponentType } from "react";
import { Redirect, Route, Switch } from "wouter";
import { LazyCalendarScreen } from "./features/calendar/lazy";
import { ProjectScreen } from "./features/projects/project-screen";
import { LazyShortcutsScreen } from "./features/shortcuts/lazy";
import { LazyTimelineScreen } from "./features/timeline/lazy";
import {
  BUCKET_LISTS,
  CALENDAR,
  HOME_PATH,
  type ListKey,
  LOGBOOK,
  PROJECT_PATH_PATTERN,
  SHORTCUTS,
  TIMELINE,
} from "./navigation";
import { InboxScreen } from "./screens/inbox-screen";
import { LaterScreen } from "./screens/later-screen";
import { LazyLogbookScreen } from "./screens/lazy-logbook-screen";
import { LoginScreen } from "./screens/login-screen";
import { TodayScreen } from "./screens/today-screen";
import { UpcomingScreen } from "./screens/upcoming-screen";
import { AppShell } from "./shell/app-shell";

const SCREENS: Record<ListKey, ComponentType> = {
  inbox: InboxScreen,
  today: TodayScreen,
  upcoming: UpcomingScreen,
  later: LaterScreen,
  // 完了ログは後から読み込む
  logbook: LazyLogbookScreen,
};

/**
 * 画面のルーティング。ロケーションは外側の <Router> から受け取る
 * （本番はブラウザの URL、テストは memoryLocation）。ストアは外側の <StoreProvider> から受け取る
 */
export function App() {
  return (
    <Switch>
      <Route path="/login" component={LoginScreen} />
      <Route>
        <AppShell>
          <Switch>
            {[...BUCKET_LISTS, LOGBOOK].map((list) => (
              <Route key={list.key} path={list.path} component={SCREENS[list.key]} />
            ))}
            {/* ビュー（後から読み込む） */}
            <Route path={CALENDAR.path} component={LazyCalendarScreen} />
            <Route path={TIMELINE.path} component={LazyTimelineScreen} />
            {/* ショートカットのページ（後から読み込む） */}
            <Route path={SHORTCUTS.path} component={LazyShortcutsScreen} />
            {/* プロジェクトごとに一覧の状態を分けるので、プロジェクトが変わったら作り直す */}
            <Route path={PROJECT_PATH_PATTERN}>
              {(params) => <ProjectScreen key={params.id} id={params.id} />}
            </Route>
            {/* `/` と未知の URL は今日へ */}
            <Route>
              <Redirect to={HOME_PATH} replace />
            </Route>
          </Switch>
        </AppShell>
      </Route>
    </Switch>
  );
}
