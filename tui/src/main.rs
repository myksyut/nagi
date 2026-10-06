//! nagi：自分専用の TODO アプリの TUI と CLI。データは Worker（Cloudflare）にあり、手元には控え（SQLite）を持つ

mod auth;
mod cli;
mod config;
mod data;
mod dates;
mod log;
mod model;
mod rank;
mod ui;

use std::process::ExitCode;

use cli::Command;
use config::{Config, DEFAULT_SERVER};

/// 版。Release のビルドでは、ワークフロー（tui.yml）が NAGI_VERSION に Release の版（0.1.<実行の番号>）を入れる。
/// 手元のビルドでは Cargo.toml の版
const VERSION: &str = match option_env!("NAGI_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

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
            cli::emit(&format!("{}\n\n本番：{DEFAULT_SERVER}", cli::HELP));
            ExitCode::SUCCESS
        }
        Command::Version => {
            cli::emit(&format!("nagi {VERSION}"));
            ExitCode::SUCCESS
        }
        Command::Tui => {
            let config = Config::new(invocation.server);
            log::init(&config.log_path());
            match ui::run(config) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("端末を使えませんでした：{error}");
                    ExitCode::FAILURE
                }
            }
        }
        command => {
            let config = Config::new(invocation.server);
            log::init(&config.log_path());
            cli::run(&config, command)
        }
    }
}
