//! nagi：TODO アプリの TUI と CLI。データは、この端末だけに置くか（ローカル）、ログインして Worker（Cloudflare）と
//! 同期する（そのときは、手元に控えの SQLite を持つ）

mod auth;
mod cli;
mod config;
mod data;
mod dates;
mod i18n;
mod log;
mod model;
mod rank;
mod ui;
mod upgrade;

use std::process::ExitCode;

use cli::Command;
use config::{Config, DEFAULT_SERVER};
use i18n::{LangSources, Msg, fill, t};

/// 版。Release のビルドでは、ワークフロー（tui.yml）が NAGI_VERSION に Release の版（0.1.<実行の番号>）を入れる。
/// 手元のビルドでは Cargo.toml の版
const VERSION: &str = match option_env!("NAGI_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    // 言語は引数を読む前に決める（引数の誤りの文も表を通すため）
    let lang_flag = cli::lang_flag(&args);
    init_lang(lang_flag.as_deref());
    if let Some(Err(message)) = lang_flag.as_deref().map(i18n::check_lang_flag) {
        return usage_error(&message);
    }
    let invocation = match cli::parse(&args) {
        Ok(invocation) => invocation,
        Err(message) => return usage_error(&message),
    };
    match invocation.command {
        Command::Help => {
            let locations = Config::new(None).map_or_else(|message| message, |c| c.locations());
            cli::emit(&fill(
                Msg::HelpPage,
                &[&t(Msg::CliHelp), &DEFAULT_SERVER, &locations],
            ));
            ExitCode::SUCCESS
        }
        Command::Version => {
            cli::emit(&format!("nagi {VERSION}"));
            ExitCode::SUCCESS
        }
        Command::Tui => {
            let config = match prepared_config(invocation.server) {
                Ok(config) => config,
                Err(code) => return code,
            };
            match ui::run(config) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("{}", fill(Msg::StartFailed, &[&error]));
                    ExitCode::FAILURE
                }
            }
        }
        // 書き出すデータがなければ何も作らないので、フォルダも記録も用意しない
        Command::Export(args) => match Config::new(invocation.server) {
            Ok(config) => cli::run(&config, Command::Export(args)),
            Err(message) => fail(&message),
        },
        command => match prepared_config(invocation.server) {
            Ok(config) => cli::run(&config, command),
            Err(code) => code,
        },
    }
}

fn init_lang(flag: Option<&str>) {
    let saved = config::saved_lang(|name| std::env::var_os(name));
    let env = |name: &str| std::env::var(name).ok();
    let (lc_all, lc_messages, lang) = (env("LC_ALL"), env("LC_MESSAGES"), env("LANG"));
    i18n::init(i18n::resolve_lang(&LangSources {
        flag,
        prefs: saved.as_deref(),
        lc_all: lc_all.as_deref(),
        lc_messages: lc_messages.as_deref(),
        lang: lang.as_deref(),
    }));
}

/// 引数の誤りを知らせる。終了コード 2
fn usage_error(message: &str) -> ExitCode {
    eprintln!("{}", fill(Msg::UsageHint, &[&message]));
    ExitCode::from(2)
}

fn fail(message: &str) -> ExitCode {
    eprintln!("{message}");
    ExitCode::FAILURE
}

/// 置き場を決めてフォルダを作り、記録を始める。クラウドでフォルダを作れなければ、手元の控えなしで続ける
fn prepared_config(server: Option<String>) -> Result<Config, ExitCode> {
    let config = Config::new(server).map_err(|message| fail(&message))?;
    match config.prepare_dirs().map_err(|message| fail(&message))? {
        None => log::init(&config.log_path()),
        Some(reason) => eprintln!("{}", fill(Msg::ContinueWithoutLocalCopy, &[&reason])),
    }
    Ok(config)
}
