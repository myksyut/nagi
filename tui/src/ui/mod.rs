//! 画面。端末のイベント・通信の結果・ログインの知らせを1本の列で受け、1つずつ処理して描き直す

pub mod app;
mod clipboard;
mod commands;
mod input;
mod keys;
pub mod list;
mod login;
mod render;
pub mod text;
pub mod theme;
pub mod views;

use std::io::{self, stdout};
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use crossterm::event::{
    self, DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange, Event,
};
use crossterm::execute;

use self::app::App;
use self::login::LoginEvent;
use crate::config::Config;
use crate::data::net::NetEvent;
use crate::data::{StopReason, Store, open_store};

/// 画面のスレッドへ届くもの。通信とログインの知らせには、作ったときの世代を付ける
/// （ログインし直してストアを作り直したあとに届いた、古い通信の結果を捨てるため）
pub enum AppEvent {
    Term(Event),
    Net(u64, NetEvent),
    Login(u64, LoginEvent),
}

/// 何も起きないあいだの、描き直しの間隔（トーストを片付ける・午前4時を確かめる）
const TICK: Duration = Duration::from_millis(250);
/// ログインの画面で、ロゴを動かすための描き直しの間隔
const ANIMATION_TICK: Duration = Duration::from_millis(50);
/// 終了のときに、送信中の操作が保存されるのを待つ時間
const QUIT_GRACE: Duration = Duration::from_secs(4);

/// ストアと、その相手（通信か、この端末のデータ）のスレッドを作る。結果は、世代を付けて画面のスレッドへ送る
pub fn build_store(
    config: &Config,
    token: Option<String>,
    user_id: Option<&str>,
    events: Sender<AppEvent>,
    generation: u64,
) -> Result<Store, String> {
    open_store(config, token, user_id, move |event| {
        let _ = events.send(AppEvent::Net(generation, event));
    })
}

pub fn run(config: Config) -> io::Result<()> {
    let (events, inbox) = mpsc::channel::<AppEvent>();
    let token = config.load_token();
    // この端末だけで使うときは、ログインは要らない
    let needs_login = config.is_cloud() && token.is_none() && !config.is_dev_server();
    let user_id = crate::auth::current_user_id(&config);
    let store = build_store(&config, token, user_id.as_deref(), events.clone(), 0)
        .map_err(io::Error::other)?;
    let mut app = App::new(config, store, user_id, events.clone());
    if needs_login {
        app.show_login(None);
    } else {
        app.sync_now();
    }

    // 端末のイベントは、専用のスレッドで読んで列に入れる
    thread::spawn(move || {
        while let Ok(event) = event::read() {
            if events.send(AppEvent::Term(event)).is_err() {
                break;
            }
        }
    });

    let mut terminal = ratatui::init();
    execute!(stdout(), EnableBracketedPaste, EnableFocusChange)?;
    let result = main_loop(&mut terminal, &mut app, &inbox);
    let _ = execute!(stdout(), DisableBracketedPaste, DisableFocusChange);
    ratatui::restore();
    result
}

fn main_loop(
    terminal: &mut ratatui::DefaultTerminal,
    app: &mut App,
    inbox: &mpsc::Receiver<AppEvent>,
) -> io::Result<()> {
    let mut quit_deadline: Option<Instant> = None;
    loop {
        terminal.draw(|frame| render::draw(frame, app))?;
        let wait = if app.login.is_some() {
            ANIMATION_TICK
        } else {
            TICK
        };
        let first = match inbox.recv_timeout(wait) {
            Ok(event) => Some(event),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => return Ok(()),
        };
        // たまっている分は、描き直す前にまとめて処理する（貼り付けや押しっぱなしで遅れないように）
        for event in first.into_iter().chain(inbox.try_iter()) {
            match event {
                AppEvent::Term(_) if quit_deadline.is_some() => {}
                AppEvent::Term(Event::Key(key)) => app.handle_key(key),
                AppEvent::Term(Event::Paste(text)) => app.handle_paste(&text),
                AppEvent::Term(Event::FocusGained) => app.on_focus_gained(),
                AppEvent::Term(_) => {}
                AppEvent::Net(generation, event) if generation == app.generation => {
                    app.on_net(event);
                }
                AppEvent::Login(generation, event) if generation == app.generation => {
                    app.on_login_event(event);
                }
                AppEvent::Net(..) | AppEvent::Login(..) => {}
            }
        }
        app.tick();
        if app.login.is_none() && app.store.stopped_by == Some(StopReason::Unauthorized) {
            app.show_login(Some("ログインが切れました。もう一度ログインしてください"));
        }
        if app.should_quit {
            // 送信中の操作があれば、保存されるのを少し待ってから終わる
            let deadline = *quit_deadline.get_or_insert_with(|| Instant::now() + QUIT_GRACE);
            let saving = app.login.is_none()
                && app.store.pending_count() > 0
                && app.store.is_online
                && app.store.stopped_by.is_none();
            if !saving || Instant::now() >= deadline {
                return Ok(());
            }
        }
    }
}
