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
use self::local_db::{LocalDb, PendingOwner};
use self::net::{ApiClient, NetEvent, NetTransport};
use self::store::StoreOptions;
use crate::config::Config;
use crate::dates::{APP_TIME_ZONE, device_time_zone};
use crate::log;

pub use actions::{AddTask, Destination, Placement};
pub use store::{Failure, Notice, OpResult, PerformOptions, SaveFailure, StopReason, Store};

/// ストアと、その相手（通信か、この端末のデータ）のスレッドを作る。結果は notify に渡る（画面や CLI が受け取って、
/// ストアへ届ける）。
/// - この端末だけで使うとき（Config::is_cloud が false）：相手は、この端末のデータ（device.rs）。それが正本なので、
///   手元の控えは持たない。データのファイルを開けなければ、動かさずに理由を返す。
///   日付の切り替え（午前 4 時）と「今日」は、この端末のタイムゾーンで決める
/// - Worker と同期するとき：相手は通信。token と user_id は、同じ時点のログイン（auth::current_login）から決めたもの
///   （user_id は token の持ち主）で、手元の控えは、利用者ごとのものを開く。手元の控えが開けなければ、保存せずに動く。
///   送れないまとまりは、user_id と token を持ち主として書き、同じ持ち主のときだけ送り直す。
///   利用者ごとの控えを開いたときは、持ち主を聞けなかったころに Worker ごとの控えへ同じ token で残したまとまりを、
///   そちらへ移してから読む（持ち主が分かるようになっても、送り直せるように）。
///   日付は、Worker が切り替える時刻に合わせて、利用者のタイムゾーンで決める。始めは、保存してあるログインの
///   タイムゾーン（なければ APP_TIME_ZONE の日本時間）で、差分の取得のたびに Worker が返すタイムゾーンに合わせる
pub fn open_store(
    config: &Config,
    token: Option<String>,
    user_id: Option<&str>,
    notify: impl Fn(NetEvent) + Send + Clone + 'static,
) -> Result<Store, String> {
    if !config.is_cloud() {
        let db = DeviceDb::open(&config.device_db_path())?;
        let tz = device_time_zone();
        return Ok(Store::new(StoreOptions {
            transport: Box::new(DeviceTransport::spawn(db, tz, notify)),
            local: None,
            owner: PendingOwner::default(),
            clock: Box::new(Utc::now),
            tz,
        }));
    }
    // NAGI_TOKEN の持ち主は、保存してあるログインの持ち主とは限らない。最初の同期の応答で合わせる
    let tz = config
        .saved_session()
        .filter(|_| !Config::has_env_token())
        .and_then(|session| session.time_zone?.parse().ok())
        .unwrap_or(APP_TIME_ZONE);
    let owner = PendingOwner::new(user_id, token.as_deref());
    let client = ApiClient::new(&config.server, token);
    let transport = NetTransport::spawn(client, notify);
    let local = open_local(config, user_id, &owner);
    Ok(Store::new(StoreOptions {
        transport: Box::new(transport),
        local,
        owner,
        clock: Box::new(Utc::now),
        tz,
    }))
}

/// user_id の手元の控えを開く。開けなければ None（保存せずに動く）
fn open_local(config: &Config, user_id: Option<&str>, owner: &PendingOwner) -> Option<LocalDb> {
    let path = config.db_path(user_id);
    let local = match LocalDb::open(&path) {
        Ok(local) => local,
        Err(error) => {
            log::error(&format!(
                "手元の控えを開けないため、保存せずに動きます: {error}"
            ));
            return None;
        }
    };
    let shared = config.db_path(None);
    if path != shared
        && let Err(error) = local.take_pending_from(&shared, owner)
    {
        log::error(&format!(
            "Worker ごとの控えに残した変更を、利用者の控えへ移せませんでした: {error}"
        ));
    }
    Some(local)
}
