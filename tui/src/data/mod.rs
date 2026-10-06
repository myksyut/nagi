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

pub use actions::{AddTask, Destination, Placement};
pub use store::{Failure, Notice, OpResult, PerformOptions, SaveFailure, StopReason, Store};
