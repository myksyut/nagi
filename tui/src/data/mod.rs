//! データ層。画面は store（Store）だけを読み書きする
//! - 読む：store.lists()（各リスト）、store.replica.task(id) / project(id)、store.today など
//! - 操作：actions.rs の関数（追加・更新・完了・移動・並べ替え・締切・優先度・工数・削除・元に戻す）
//! - 知らせ：store.take_notices()

pub mod actions;
pub mod lists;
pub mod local_db;
pub mod net;
pub mod replica;
pub mod sort;
pub mod store;
#[cfg(test)]
mod tests;
pub mod undo;

use chrono::Utc;

use self::local_db::LocalDb;
use self::net::{ApiClient, NetEvent, NetTransport};
use self::store::StoreOptions;
use crate::config::Config;
use crate::dates::APP_TIME_ZONE;
use crate::log;

pub use actions::{AddTask, Destination, Placement};
pub use store::{Failure, Notice, OpResult, PerformOptions, SaveFailure, StopReason, Store};

/// ストアと通信のスレッドを作る。通信の結果は notify に渡る（画面や CLI が受け取って、ストアへ届ける）。
/// user_id は token の持ち主（auth::current_user_id）。手元の控えは、利用者ごとのものを開く。
/// 手元の控えが開けなければ、保存せずに動く
pub fn open_store(
    config: &Config,
    token: Option<String>,
    user_id: Option<&str>,
    notify: impl Fn(NetEvent) + Send + Clone + 'static,
) -> Store {
    let client = ApiClient::new(&config.server, token);
    let transport = NetTransport::spawn(client, notify);
    let local = match LocalDb::open(&config.db_path(user_id)) {
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
