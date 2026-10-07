//! データ層。画面は store（Store）だけを読み書きする
//! - 読む：store.lists()（各リスト）、store.replica.task(id) / project(id)、store.today など
//! - 操作：actions.rs の関数（追加・更新・完了・移動・並べ替え・締切・優先度・工数・削除・元に戻す）
//! - 知らせ：store.take_notices()

pub mod actions;
pub mod device;
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

use self::device::{DeviceDb, DeviceTransport};
use self::local_db::LocalDb;
use self::net::{ApiClient, NetEvent, NetTransport};
use self::store::StoreOptions;
use crate::config::Config;
use crate::dates::APP_TIME_ZONE;
use crate::log;

pub use actions::{AddTask, Destination, Placement};
pub use store::{Failure, Notice, OpResult, PerformOptions, SaveFailure, StopReason, Store};

/// ストアと、その相手（通信か、この端末のデータ）のスレッドを作る。結果は notify に渡る（画面や CLI が受け取って、
/// ストアへ届ける）。
/// - この端末だけで使うとき（Config::is_cloud が false）：相手は、この端末のデータ（device.rs）。それが正本なので、
///   手元の控えは持たない。データのファイルを開けなければ、動かさずに理由を返す
/// - Worker と同期するとき：相手は通信。user_id は token の持ち主（auth::current_user_id）で、手元の控えは、
///   利用者ごとのものを開く。手元の控えが開けなければ、保存せずに動く
pub fn open_store(
    config: &Config,
    token: Option<String>,
    user_id: Option<&str>,
    notify: impl Fn(NetEvent) + Send + Clone + 'static,
) -> Result<Store, String> {
    if !config.is_cloud() {
        let db = DeviceDb::open(&config.device_db_path())?;
        return Ok(Store::new(StoreOptions {
            transport: Box::new(DeviceTransport::spawn(db, APP_TIME_ZONE, notify)),
            local: None,
            clock: Box::new(Utc::now),
            tz: APP_TIME_ZONE,
        }));
    }
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
    Ok(Store::new(StoreOptions {
        transport: Box::new(transport),
        local,
        clock: Box::new(Utc::now),
        tz: APP_TIME_ZONE,
    }))
}
