//! 画面。端末のイベント・通信の結果・ログインの知らせを1本の列で受け、1つずつ処理して描き直す

pub mod app;
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

use chrono::Utc;
use crossterm::event::{
    self, DisableBracketedPaste, DisableFocusChange, EnableBracketedPaste, EnableFocusChange, Event,
};
use crossterm::execute;

use self::app::App;
use self::login::LoginEvent;
use crate::config::Config;
use crate::data::local_db::LocalDb;
use crate::data::net::{ApiClient, NetEvent, NetTransport};
use crate::data::store::StoreOptions;
use crate::data::{StopReason, Store};
use crate::dates::APP_TIME_ZONE;
use crate::log;

/// 画面のスレッドへ届くもの。通信とログインの知らせには、作ったときの世代を付ける
/// （ログインし直してストアを作り直したあとに届いた、古い通信の結果を捨てるため）
pub enum AppEvent {
    Term(Event),
    Net(u64, NetEvent),
    Login(u64, LoginEvent),
}

/// 何も起きないあいだの、描き直しの間隔（トーストを片付ける・午前4時を確かめる）
const TICK: Duration = Duration::from_millis(250);
/// 終了のときに、送信中の操作が保存されるのを待つ時間
const QUIT_GRACE: Duration = Duration::from_secs(4);

/// ストアと通信のスレッドを作る。手元の控えが開けなければ、保存せずに動く
pub fn build_store(
    config: &Config,
    token: Option<String>,
    events: Sender<AppEvent>,
    generation: u64,
) -> Store {
    let client = ApiClient::new(&config.server, token);
    let transport = NetTransport::spawn(client, move |event| {
        let _ = events.send(AppEvent::Net(generation, event));
    });
    let local = match LocalDb::open(&config.db_path()) {
        Ok(local) => Some(local),
        Err(error) => {
            log::error(&format!(
                "手元の控えを開けないため、保存せずに動きます: {error}"
            ));
            None
        }
    };
    Store::new(StoreOptions {
        transport: Box::new(transport),
        local,
        clock: Box::new(Utc::now),
        tz: APP_TIME_ZONE,
    })
}

pub fn run(config: Config) -> io::Result<()> {
    let (events, inbox) = mpsc::channel::<AppEvent>();
    let token = config.load_token();
    let needs_login = token.is_none() && !config.is_local();
    let store = build_store(&config, token, events.clone(), 0);
    let mut app = App::new(config, store, events.clone());
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
        let first = match inbox.recv_timeout(TICK) {
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
