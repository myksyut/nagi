import { Redirect, Route, Switch } from "wouter";
import { BUCKET_LISTS, HOME_PATH, LOGBOOK, PROJECT_PATH_PATTERN } from "./navigation";
import { ListScreen } from "./screens/list-screen";
import { LoginScreen } from "./screens/login-screen";
import { TodayPreview } from "./screens/today-preview";
import { AppShell } from "./shell/app-shell";

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
              <Route key={list.key} path={list.path}>
                <ListScreen title={list.label}>
                  {/* 仮の表示（4 で置き換える） */}
                  {list.key === "today" && <TodayPreview />}
                </ListScreen>
              </Route>
            ))}
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
