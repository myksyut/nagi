//! nagi：自分専用の TODO アプリの TUI。データは Worker（Cloudflare）にあり、手元には控え（SQLite）を持つ

mod auth;
mod config;
mod data;
mod dates;
mod log;
mod model;
mod rank;
mod ui;

use std::process::ExitCode;

use config::{Config, DEFAULT_SERVER};

/// 版。Release のビルドでは、ワークフロー（tui.yml）が NAGI_VERSION に Release の版（0.1.<実行の番号>）を入れる。
/// 手元のビルドでは Cargo.toml の版
const VERSION: &str = match option_env!("NAGI_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};

const HELP: &str = "\
nagi — 自分専用の TODO アプリ

使い方：
  nagi [--server <URL>]

  --server <URL>   接続する Worker（省くと環境変数 NAGI_SERVER、なければ本番）
                   手元の開発サーバーなら http://localhost:5317
  -h, --help       この説明
  -V, --version    版

キーの一覧は、起動してから ? で見られます";

fn main() -> ExitCode {
    let mut server = None;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "-h" | "--help" => {
                println!("{HELP}\n\n本番：{DEFAULT_SERVER}");
                return ExitCode::SUCCESS;
            }
            "-V" | "--version" => {
                println!("nagi {VERSION}");
                return ExitCode::SUCCESS;
            }
            "--server" => match args.next() {
                Some(url) => server = Some(url),
                None => {
                    eprintln!("--server には URL が要ります");
                    return ExitCode::from(2);
                }
            },
            other => {
                eprintln!("知らない引数です：{other}\n\n{HELP}");
                return ExitCode::from(2);
            }
        }
    }
    let config = Config::new(server);
    log::init(&config.log_path());
    match ui::run(config) {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("端末を使えませんでした：{error}");
            ExitCode::FAILURE
        }
    }
}
