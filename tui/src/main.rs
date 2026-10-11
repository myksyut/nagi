//! nagi：TODO アプリの TUI と CLI。データは、この端末だけに置くか（ローカル）、ログインして Worker（Cloudflare）と
//! 同期する（そのときは、手元に控えの SQLite を持つ）

mod auth;
mod cli;
mod config;
mod data;
mod dates;
mod log;
mod model;
mod rank;
mod ui;
mod upgrade;

use std::process::ExitCode;

use cli::Command;
use config::{Config, DEFAULT_SERVER};

/// 版の正本は Cargo.toml の `version`（Release のタグ `v<版>` と、ワークフロー（tui.yml）の check で突き合わせる）
const VERSION: &str = env!("CARGO_PKG_VERSION");

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let invocation = match cli::parse(&args) {
        Ok(invocation) => invocation,
        Err(message) => {
            eprintln!("{message}\n\n使い方は `nagi --help` で見られます");
            return ExitCode::from(2);
        }
    };
    match invocation.command {
        Command::Help => {
            let locations = Config::new(None).map_or_else(|message| message, |c| c.locations());
            cli::emit(&format!(
                "{}\n\n本番：{DEFAULT_SERVER}\n\n{locations}",
                cli::HELP
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
                    eprintln!("起動できませんでした：{error}");
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

fn fail(message: &str) -> ExitCode {
    eprintln!("{message}");
    ExitCode::FAILURE
}

/// 置き場を決めてフォルダを作り、記録を始める。クラウドでフォルダを作れなければ、手元の控えなしで続ける
fn prepared_config(server: Option<String>) -> Result<Config, ExitCode> {
    let config = Config::new(server).map_err(|message| fail(&message))?;
    match config.prepare_dirs().map_err(|message| fail(&message))? {
        None => log::init(&config.log_path()),
        Some(reason) => eprintln!("{reason}\n手元の控えと記録なしで続けます"),
    }
    Ok(config)
}
