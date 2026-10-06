//! ログインの画面（GitHub のデバイスフロー）。コードと URL を出し、承認されるまで別のスレッドで確かめに行く

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{KeyCode, KeyEvent};

use super::app::App;
use super::{AppEvent, build_store};
use crate::auth::{self, DevicePoll, DeviceStart};
use crate::data::net::ApiClient;

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
}

impl Login {
    pub fn new(reason: Option<&str>) -> Login {
        Login {
            step: LoginStep::Idle,
            reason: reason.map(str::to_string),
            cancel: Arc::new(AtomicBool::new(false)),
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

    /// デバイスフローを始める。コードの発行と、承認の確かめは別のスレッドで行う
    fn start_login(&mut self) {
        let reason = self.login.as_ref().and_then(|login| login.reason.clone());
        let mut login = Login::new(reason.as_deref());
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
                    if let Err(error) = self.config.save_session(&token, user_id.as_deref()) {
                        crate::log::error(&format!("トークンを保存できませんでした: {error}"));
                    }
                    self.login = None;
                    // 新しいログインで、ストアと通信を作り直す。手元の控えは、ログインした利用者のものを開く
                    // （前と別の利用者なら別の控えなので、前の利用者の行は混ざらない）
                    self.generation += 1;
                    self.user_id = user_id;
                    self.store = build_store(
                        &self.config,
                        Some(token),
                        self.user_id.as_deref(),
                        self.events.clone(),
                        self.generation,
                    );
                    self.sync_now();
                    self.reconcile();
                }
                DevicePoll::Expired => {
                    login.step = LoginStep::Failed(
                        "コードの期限が切れました。もう一度やり直してください".to_string(),
                    );
                }
                DevicePoll::Denied => {
                    login.step = LoginStep::Failed("GitHub で承認されませんでした".to_string());
                }
                DevicePoll::Forbidden => {
                    login.step = LoginStep::Failed(
                        "この GitHub アカウントでは、nagi を使えません".to_string(),
                    );
                }
                DevicePoll::Pending | DevicePoll::SlowDown(_) => {}
            },
        }
    }

    /// ログアウト。Worker のセッションを消し、手元のトークンと控えも消して、ログインの画面へ
    pub fn logout(&mut self) {
        if self.config.is_local() && self.config.saved_token().is_none() {
            self.toast_info("手元の開発サーバーでは、ログインなしで使っています");
            return;
        }
        if let Some(token) = self.config.saved_token() {
            let client = ApiClient::new(&self.config.server, Some(token));
            thread::spawn(move || auth::logout(&client));
        }
        self.config.clear_token();
        // 手元の控えを消して、空のストアにする（通信はしない）
        self.generation += 1;
        self.config.remove_db(self.user_id.as_deref());
        self.user_id = None;
        self.store = build_store(
            &self.config,
            None,
            None,
            self.events.clone(),
            self.generation,
        );
        self.show_login(Some("ログアウトしました"));
    }
}
