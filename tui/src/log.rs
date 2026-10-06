//! 記録。画面を汚さないよう、端末ではなくファイル（データの置き場の nagi.log）に書く

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

static FILE: OnceLock<Mutex<File>> = OnceLock::new();

/// 記録の書き先を決める（開けなければ、記録は捨てる）
pub fn init(path: &Path) {
    if let Ok(file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = FILE.set(Mutex::new(file));
    }
}

pub fn error(message: &str) {
    if let Some(file) = FILE.get()
        && let Ok(mut file) = file.lock()
    {
        let now = chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
        let _ = writeln!(file, "{now} {message}");
    }
}
