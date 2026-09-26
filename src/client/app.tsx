import type { ComponentType } from "react";
import { Redirect, Route, Switch } from "wouter";
import { BUCKET_LISTS, HOME_PATH, type ListKey, LOGBOOK, PROJECT_PATH_PATTERN } from "./navigation";
import { InboxScreen } from "./screens/inbox-screen";
import { LaterScreen } from "./screens/later-screen";
import { ListScreen } from "./screens/list-screen";
import { LogbookScreen } from "./screens/logbook-screen";
import { LoginScreen } from "./screens/login-screen";
import { TodayScreen } from "./screens/today-screen";
import { UpcomingScreen } from "./screens/upcoming-screen";
import { AppShell } from "./shell/app-shell";

const SCREENS: Record<ListKey, ComponentType> = {
  inbox: InboxScreen,
  today: TodayScreen,
  upcoming: UpcomingScreen,
  later: LaterScreen,
  logbook: LogbookScreen,
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
            {/* プロジェクトの画面は 6 で作る */}
            <Route path={PROJECT_PATH_PATTERN}>
              <ListScreen title="プロジェクト" />
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
