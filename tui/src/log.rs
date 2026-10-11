//! 記録。画面を汚さないよう、端末ではなくファイル（データの置き場の nagi.log）に書く

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

static FILE: OnceLock<Mutex<File>> = OnceLock::new();

/// これを超えて育った記録は、次の起動で一つ前の世代にする
const MAX_BYTES: u64 = 1024 * 1024;

fn previous_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(".1");
    PathBuf::from(name)
}

/// 大きくなった記録を `<名前>.1` に名前を変える（世代は一つだけ。前の `.1` は上書きする）
fn rotate(path: &Path) {
    if fs::metadata(path).is_ok_and(|meta| meta.len() > MAX_BYTES) {
        let _ = fs::rename(path, previous_path(path));
    }
}

fn open(path: &Path) -> std::io::Result<File> {
    let mut options = OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

/// 記録の書き先を決める（開けなければ、記録は捨てる）
pub fn init(path: &Path) {
    rotate(path);
    if let Ok(file) = open(path) {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "nagi-log-test-{}-{}",
            std::process::id(),
            uuid::Uuid::now_v7()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn 大きくなった記録は_一つ前の世代にして_前の世代を上書きする() {
        let dir = temp_dir();
        let path = dir.join("nagi.log");
        let previous = dir.join("nagi.log.1");
        fs::write(&previous, "old generation").unwrap();
        fs::write(&path, vec![b'a'; MAX_BYTES as usize + 1]).unwrap();

        rotate(&path);

        assert!(!path.exists());
        assert_eq!(fs::metadata(&previous).unwrap().len(), MAX_BYTES + 1);
        assert!(!dir.join("nagi.log.2").exists());
    }

    #[test]
    fn 上限以下の記録はそのまま() {
        let dir = temp_dir();
        let path = dir.join("nagi.log");
        fs::write(&path, vec![b'a'; MAX_BYTES as usize]).unwrap();

        rotate(&path);

        assert_eq!(fs::metadata(&path).unwrap().len(), MAX_BYTES);
        assert!(!dir.join("nagi.log.1").exists());
    }

    #[cfg(unix)]
    #[test]
    fn 記録は自分だけが読める権限で作る() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let path = dir.join("nagi.log");
        drop(open(&path).unwrap());
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
