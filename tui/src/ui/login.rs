//! ログインの画面（GitHub のデバイスフロー）。コードと URL を出し、承認されるまで別のスレッドで確かめに行く

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent};

use super::app::{App, Overlay};
use super::text::TextInput;
use super::{AppEvent, build_store};
use crate::auth::{self, DevicePoll, DeviceStart};
use crate::data::StopReason;
use crate::data::local_db::unsent_count_at;
use crate::data::net::ApiClient;
use crate::i18n::{Msg, fill, t};

pub enum LoginStep {
    /// まだ始めていない（Enter で始める）
    Idle,
    /// コードを発行してもらっている
    Starting,
    /// 利用者の承認を待っている
    Waiting {
        user_code: String,
        verification_uri: String,
        expires_at: Instant,
    },
    /// 失敗した（Enter でやり直す）
    Failed(String),
}

pub struct Login {
    pub step: LoginStep,
    /// ログインの画面を出した理由（「ログインが切れました」など）
    pub reason: Option<String>,
    /// 確かめに行くスレッドを止める合図
    cancel: Arc<AtomicBool>,
    /// ロゴの日の出の起点。Enter で作り直しても、日の出をやり直さない
    pub shown_at: Instant,
}

impl Login {
    pub fn new(reason: Option<&str>) -> Login {
        Login {
            step: LoginStep::Idle,
            reason: reason.map(str::to_string),
            cancel: Arc::new(AtomicBool::new(false)),
            shown_at: Instant::now(),
        }
    }
}

impl Drop for Login {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

/// ログインのスレッドからの知らせ
pub enum LoginEvent {
    Started(Result<DeviceStart, String>),
    Polled(Result<DevicePoll, String>),
}

/// クラウドのアカウントを消した結果（Ok は、Worker が 204 を返した）と、消すのに使ったログイン
pub struct AccountDeleted {
    pub user_id: String,
    pub token: String,
    pub result: Result<(), String>,
}

impl App {
    /// ログインの画面を出す（通信は止まっている）
    pub fn show_login(&mut self, reason: Option<&str>) {
        self.overlay = None;
        self.detail = None;
        self.stop_adding();
        self.login = Some(Login::new(reason));
    }

    pub fn handle_login_key(&mut self, key: &KeyEvent) {
        match key.code {
            // この端末だけで使っているときは、ログインをやめて戻れる
            KeyCode::Esc if !self.config.is_cloud() => self.cancel_login(),
            KeyCode::Char('q') | KeyCode::Esc => self.should_quit = true,
            KeyCode::Enter => {
                let idle = self.login.as_ref().is_some_and(|login| {
                    matches!(login.step, LoginStep::Idle | LoginStep::Failed(_))
                });
                if idle {
                    self.start_login();
                }
            }
            _ => {}
        }
    }

    /// ログインをやめて、この端末のデータに戻る。ログインを始めると世代が進んで、前のストアへの知らせは
    /// 捨てられるので、ストアを作り直す
    fn cancel_login(&mut self) {
        self.login = None;
        if self.rebuild_store(None) {
            self.sync_now();
            self.reconcile();
        }
    }

    /// ストアと、その相手（通信か、この端末のデータ）を作り直す。作れなければ、前のストアのまま false
    fn rebuild_store(&mut self, token: Option<String>) -> bool {
        self.generation += 1;
        match build_store(
            &self.config,
            token,
            self.user_id.as_deref(),
            self.events.clone(),
            self.generation,
        ) {
            Ok(store) => {
                self.store = store;
                true
            }
            Err(message) => {
                crate::log::error(&message);
                self.toast_error(t(Msg::DataOpenFailed), Some(&message));
                false
            }
        }
    }

    /// デバイスフローを始める。コードの発行と、承認の確かめは別のスレッドで行う
    fn start_login(&mut self) {
        let reason = self.login.as_ref().and_then(|login| login.reason.clone());
        let shown_at = self.login.as_ref().map(|login| login.shown_at);
        let mut login = Login::new(reason.as_deref());
        if let Some(shown_at) = shown_at {
            login.shown_at = shown_at;
        }
        login.step = LoginStep::Starting;
        let cancel = Arc::clone(&login.cancel);
        self.login = Some(login);
        self.generation += 1;
        let generation = self.generation;
        let client = ApiClient::new(&self.config.server, None);
        let events = self.events.clone();
        thread::spawn(move || {
            let send = |event| events.send(AppEvent::Login(generation, event)).is_ok();
            let started = auth::start(&client);
            let Ok(start) = started.clone() else {
                send(LoginEvent::Started(started));
                return;
            };
            if !send(LoginEvent::Started(Ok(start.clone()))) {
                return;
            }
            let deadline = Instant::now() + Duration::from_secs(start.expires_in);
            let mut interval = start.interval.max(1);
            loop {
                // 止める合図を見ながら待つ
                let wake = Instant::now() + Duration::from_secs(interval);
                while Instant::now() < wake {
                    if cancel.load(Ordering::Relaxed) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(200));
                }
                if Instant::now() >= deadline {
                    send(LoginEvent::Polled(Ok(DevicePoll::Expired)));
                    return;
                }
                match auth::poll(&client, &start.device_code) {
                    Ok(DevicePoll::Pending) => {}
                    Ok(DevicePoll::SlowDown(next)) => interval = next.max(interval + 1),
                    // 通信のつまずきは、次の回でもう一度確かめる
                    Err(_) if !cancel.load(Ordering::Relaxed) => {}
                    other => {
                        send(LoginEvent::Polled(other));
                        return;
                    }
                }
            }
        });
    }

    pub fn on_login_event(&mut self, event: LoginEvent) {
        let Some(login) = &mut self.login else {
            return;
        };
        match event {
            LoginEvent::Started(Ok(start)) => {
                login.step = LoginStep::Waiting {
                    user_code: start.user_code,
                    verification_uri: start.verification_uri,
                    expires_at: Instant::now() + Duration::from_secs(start.expires_in),
                };
            }
            LoginEvent::Started(Err(message)) | LoginEvent::Polled(Err(message)) => {
                login.step = LoginStep::Failed(message);
            }
            LoginEvent::Polled(Ok(result)) => match result {
                DevicePoll::Ok { token, user_id } => {
                    // この端末だけで使っていたなら、そのデータはそのまま残る（クラウドへは移さない）
                    let left_on_device = !self.config.is_cloud();
                    if let Err(error) = self.config.save_session(&token, user_id.as_deref()) {
                        crate::log::error(&fill(Msg::LogSaveTokenFailed, &[&error]));
                    }
                    self.login = None;
                    // 新しいログインで、ストアと通信を作り直す。手元の控えは、ログインした利用者のものを開く
                    // （前と別の利用者なら別の控えなので、前の利用者の行は混ざらない）
                    self.user_id = user_id;
                    if self.rebuild_store(Some(token)) {
                        self.sync_now();
                        self.reconcile();
                    }
                    if left_on_device {
                        self.toast_info(t(Msg::LoginSyncStartedKeepLocal));
                    }
                }
                DevicePoll::Expired => {
                    login.step = LoginStep::Failed(t(Msg::LoginCodeExpired).to_string());
                }
                DevicePoll::Denied => {
                    login.step = LoginStep::Failed(t(Msg::LoginDenied).to_string());
                }
                DevicePoll::Forbidden => {
                    login.step = LoginStep::Failed(t(Msg::LoginNotInvited).to_string());
                }
                DevicePoll::Pending | DevicePoll::SlowDown(_) => {}
            },
        }
    }

    /// アカウントを消した結果。世代やログインの画面にかかわらず、必ずここで片付ける。
    /// 消せたら、消したアカウントのログインと控えを消して、この端末のデータに戻る（local.db は、そのまま）
    pub fn on_account_deleted(&mut self, deleted: AccountDeleted) {
        self.deleting_account = false;
        match deleted.result {
            Ok(()) => {
                self.overlay = None;
                self.login = None;
                crate::cli::forget_deleted_login(&self.config, &deleted.user_id, &deleted.token);
                self.return_to_device(t(Msg::AccountDeletedNotice), t(Msg::AccountDeletedToast));
            }
            Err(message) => {
                if let Some(Overlay::DeleteAccount { deleting, .. }) = &mut self.overlay {
                    *deleting = false;
                }
                self.toast_error(t(Msg::AccountDeleteFailed), Some(&message));
            }
        }
    }

    /// ログインが切れていたら、ログインの画面を出す。アカウントを消しているあいだは出さない（消した結果で片付ける）
    pub fn show_login_if_unauthorized(&mut self) {
        if self.login.is_none()
            && !self.deleting_account
            && self.store.stopped_by == Some(StopReason::Unauthorized)
        {
            self.show_login(Some(t(Msg::LoginExpiredRelogin)));
        }
    }

    /// ログアウト。Worker のセッションを消し、手元のトークンと控えも消す。そのあとは、この端末のデータに戻る
    /// （Worker を名指しして使っているときは、ログインの画面へ）。
    /// 控えに送っていない変更があれば（あるかを確かめられなければ）、一度目は消えることを知らせるだけにし、
    /// もう一度選んだときにログアウトする
    pub fn logout(&mut self) {
        if !self.logout_warned {
            let message = match unsent_count_at(&self.config.db_path(self.user_id.as_deref())) {
                Ok(0) => None,
                Ok(count) => Some(fill(Msg::UnsentCountLogoutWarning, &[&count])),
                Err(_) => Some(t(Msg::UnsentUnknownLogoutWarning).to_string()),
            };
            if let Some(message) = message {
                self.logout_warned = true;
                self.toast_error(&message, Some(t(Msg::LogoutAgainHint)));
                return;
            }
        }
        if self.config.is_dev_server() && self.config.saved_token().is_none() {
            self.toast_info(t(Msg::DevServerNoLogin));
            return;
        }
        if let Some(token) = self.config.saved_token() {
            let client = ApiClient::new(&self.config.server, Some(token));
            thread::spawn(move || auth::logout(&client));
        }
        self.config.clear_token();
        self.return_to_device(t(Msg::LoggedOutNotice), t(Msg::LoggedOutLocalToast));
    }

    /// 手元のログインの控えを消して、この端末のデータに戻る（Worker を名指ししているときは、ログインの画面へ）。
    /// トークンは、呼ぶ前に消しておく
    fn return_to_device(&mut self, login_reason: &str, device_message: &str) {
        // 手元の控えを消す
        self.config.remove_db(self.user_id.as_deref());
        self.user_id = None;
        self.logout_warned = false;
        let rebuilt = self.rebuild_store(None);
        if self.config.is_cloud() {
            // Worker を名指しして使っている：空のストアのまま、ログインの画面へ（通信はしない）
            self.show_login(Some(login_reason));
        } else if rebuilt {
            self.sync_now();
            self.reconcile();
            self.toast_info(device_message);
        }
    }

    /// Ctrl+K の「アカウントを削除」。件数と書き出しの案内を出す確かめの画面を開く（`delete` と打つまで消さない）
    pub fn open_delete_account(&mut self) {
        if self.user_id.is_none() || self.delete_account_token().is_none() {
            self.toast_error(
                t(Msg::AccountDeleteNoOwner),
                Some(t(Msg::AccountDeleteRelogin)),
            );
            return;
        }
        let replica = &self.store.replica;
        let tasks = replica
            .tasks()
            .filter(|task| task.deleted_at.is_none())
            .count();
        let projects = replica
            .projects()
            .filter(|project| project.deleted_at.is_none())
            .count();
        self.overlay = Some(Overlay::DeleteAccount {
            input: TextInput::default(),
            tasks,
            projects,
            deleting: false,
        });
    }

    /// 環境変数 NAGI_TOKEN があればそれ、なければ保存してあるログインのトークン（auth::current_login と同じ決め方）
    fn delete_account_token(&self) -> Option<String> {
        std::env::var("NAGI_TOKEN")
            .ok()
            .filter(|token| !token.is_empty())
            .or_else(|| self.config.saved_token())
    }

    pub fn delete_account_key(
        &mut self,
        key: KeyEvent,
        mut input: TextInput,
        tasks: usize,
        projects: usize,
        deleting: bool,
    ) -> Option<Overlay> {
        if !deleting {
            if key.code == KeyCode::Enter {
                if input.text().trim() == "delete" {
                    self.delete_account();
                    return Some(Overlay::DeleteAccount {
                        input,
                        tasks,
                        projects,
                        deleting: true,
                    });
                }
            } else {
                input.handle_key(key);
            }
        }
        Some(Overlay::DeleteAccount {
            input,
            tasks,
            projects,
            deleting,
        })
    }

    /// Worker にアカウントを消させる。通信は別のスレッドで行い、返事は世代を付けずに送る（on_account_deleted）
    fn delete_account(&mut self) {
        let (Some(user_id), Some(token)) = (self.user_id.clone(), self.delete_account_token())
        else {
            return;
        };
        self.deleting_account = true;
        let client = ApiClient::new(&self.config.server, Some(token.clone()));
        let events = self.events.clone();
        thread::spawn(move || {
            let result = client.delete_account(&user_id);
            let _ = events.send(AppEvent::AccountDeleted(AccountDeleted {
                user_id,
                token,
                result,
            }));
        });
    }
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::path::{Path, PathBuf};
    use std::rc::Rc;
    use std::sync::mpsc;

    use super::*;
    use crate::config::Config;
    use crate::data::Store;
    use crate::data::store::{ApiFailure, StoreOptions, Transport};
    use crate::dates::{APP_TIME_ZONE, parse_iso};
    use crate::model::MutationBatch;

    /// 差分の取得を頼まれた回数を数える
    struct CountingSyncs(Rc<Cell<usize>>);

    impl Transport for CountingSyncs {
        fn mutate(&mut self, _batch: MutationBatch) {}
        fn sync(&mut self, _cursor: u64) {
            self.0.set(self.0.get() + 1);
        }
    }

    /// user-a のログインでアカウントを消していて、Worker の返事を待っている画面。保存してあるログインは saved
    fn deleting(dir: &Path, saved: (&str, &str)) -> (App, Rc<Cell<usize>>) {
        let syncs = Rc::new(Cell::new(0));
        let store = Store::new(StoreOptions {
            transport: Box::new(CountingSyncs(Rc::clone(&syncs))),
            local: None,
            owner: Default::default(),
            clock: Box::new(|| parse_iso("2026-10-06T03:00:00.000Z").unwrap()),
            tz: APP_TIME_ZONE,
        });
        let config = Config::at("https://nagi.example.com", dir);
        config.save_session(saved.0, Some(saved.1)).unwrap();
        std::fs::write(config.db_path(Some("user-a")), b"replica").unwrap();
        let (events, _) = mpsc::channel();
        let mut app = App::new(config, store, Some("user-a".into()), events);
        app.overlay = Some(Overlay::DeleteAccount {
            input: TextInput::new("delete"),
            tasks: 0,
            projects: 0,
            deleting: true,
        });
        app.deleting_account = true;
        (app, syncs)
    }

    fn temp_dir(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("nagi-login-test-{name}-{}", uuid::Uuid::now_v7()))
    }

    fn deleted(result: Result<(), String>) -> AccountDeleted {
        AccountDeleted {
            user_id: "user-a".into(),
            token: "token-a".into(),
            result,
        }
    }

    /// 送ってあった差分の取得が、Worker でアカウントが消えたあとに 401 で返る
    fn unauthorized_sync(app: &mut App) {
        app.store.sync();
        app.store.on_sync_done(Err(ApiFailure::Unauthorized));
    }

    #[test]
    fn 消しているあいだは同期せず_401でもログインの画面を出さず_消せたら手元を片付けてこの端末に戻る()
     {
        let dir = temp_dir("deleting");
        let (mut app, syncs) = deleting(&dir, ("token-a", "user-a"));

        app.sync_now();
        app.on_focus_gained();
        app.tick();
        assert_eq!(syncs.get(), 0);

        unauthorized_sync(&mut app);
        app.tick();
        app.show_login_if_unauthorized();
        assert!(app.login.is_none());
        assert!(matches!(
            app.overlay,
            Some(Overlay::DeleteAccount { deleting: true, .. })
        ));

        app.on_account_deleted(deleted(Ok(())));

        assert!(!app.deleting_account);
        assert!(app.overlay.is_none());
        assert!(app.login.is_none());
        assert_eq!(app.config.saved_session(), None);
        assert!(!app.config.db_path(Some("user-a")).exists());
        assert_eq!(app.user_id, None);
        assert!(!app.config.is_cloud());
        app.show_login_if_unauthorized();
        assert!(app.login.is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn ログインの画面が出て世代が進んでいても_消せたら閉じてこの端末に戻る() {
        let dir = temp_dir("deleting-login");
        let (mut app, _) = deleting(&dir, ("token-a", "user-a"));
        app.login = Some(Login::new(Some("ログインが切れました")));
        app.generation += 1;

        app.on_account_deleted(deleted(Ok(())));

        assert!(app.login.is_none());
        assert_eq!(app.config.saved_session(), None);
        assert!(!app.config.db_path(Some("user-a")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 別の利用者の保存してあるログインは_消したあとも残る() {
        let dir = temp_dir("deleting-other");
        // NAGI_TOKEN の user-a を消した。保存してあるのは user-b のログイン
        let (mut app, _) = deleting(&dir, ("token-b", "user-b"));

        app.on_account_deleted(deleted(Ok(())));

        assert_eq!(app.config.saved_token().as_deref(), Some("token-b"));
        assert!(!app.config.db_path(Some("user-a")).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn 消せなかったら_確かめの画面に戻り_ログインが切れていればログインの画面を出す() {
        let dir = temp_dir("deleting-failed");
        let (mut app, _) = deleting(&dir, ("token-a", "user-a"));
        unauthorized_sync(&mut app);

        app.on_account_deleted(deleted(Err("ログインが切れています".into())));

        assert!(!app.deleting_account);
        assert!(matches!(
            app.overlay,
            Some(Overlay::DeleteAccount {
                deleting: false,
                ..
            })
        ));
        assert_eq!(app.config.saved_token().as_deref(), Some("token-a"));
        assert!(app.config.db_path(Some("user-a")).exists());
        app.show_login_if_unauthorized();
        assert!(app.login.is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
