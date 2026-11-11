//! Startup guards: one instance per data dir, and private file modes for the data dir and the database.
use std::fs::File;
use std::path::Path;

use crate::error::AppError;

pub const LOCK_FILE: &str = "rebull.lock";

/// Held in Tauri state for the life of the app; dropping it releases the single-instance lock.
pub struct InstanceLock(pub File);

/// Takes an exclusive, non-blocking lock on `<dir>/rebull.lock` for the life of the returned handle (keep it
/// alive for the whole process). A second instance gets an error instead of sharing the vault and the DB.
pub fn acquire_instance_lock(dir: &Path) -> Result<File, AppError> {
    let mut o = std::fs::OpenOptions::new();
    o.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let f = o.open(dir.join(LOCK_FILE))?;
    match f.try_lock() {
        Ok(()) => Ok(f),
        Err(std::fs::TryLockError::WouldBlock) => Err(AppError::Invalid("another TraderMatrix Desktop instance is already running".into())),
        Err(std::fs::TryLockError::Error(e)) => Err(e.into()),
    }
}

/// Data dir 0700; the database, its WAL/SHM side files and the lock file 0600 (those that exist).
pub fn harden_data_dir(dir: &Path) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        for f in ["rebull.db", "rebull.db-wal", "rebull.db-shm", LOCK_FILE] {
            match std::fs::set_permissions(dir.join(f), std::fs::Permissions::from_mode(0o600)) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            }
        }
    }
    #[cfg(not(unix))]
    let _ = dir;
    Ok(())
}

/// Creates the database file 0600 before SQLite opens it, so it is never world-readable, not even briefly.
pub fn precreate_private(path: &Path) -> Result<(), AppError> {
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!(
            "rebull-startup-{}-{}",
            std::process::id(),
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
        ));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    /// R7: a second instance cannot take the lock while the first holds it; the lock frees when dropped.
    #[test]
    fn instance_lock_is_exclusive() {
        let d = tmp();
        let first = acquire_instance_lock(&d).unwrap();
        let e = acquire_instance_lock(&d).unwrap_err();
        assert!(e.to_string().contains("already running"), "{e}");
        drop(first);
        assert!(acquire_instance_lock(&d).is_ok());
    }

    /// R5: data dir 0700; database, WAL, SHM and the lock file 0600.
    #[test]
    fn data_dir_and_db_files_are_private() {
        let d = tmp();
        std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        for f in ["rebull.db", "rebull.db-wal", "rebull.db-shm"] {
            std::fs::write(d.join(f), b"x").unwrap();
            std::fs::set_permissions(d.join(f), std::fs::Permissions::from_mode(0o644)).unwrap();
        }
        harden_data_dir(&d).unwrap();
        assert_eq!(mode(&d), 0o700);
        for f in ["rebull.db", "rebull.db-wal", "rebull.db-shm"] {
            assert_eq!(mode(&d.join(f)), 0o600, "{f}");
        }
        // Missing files are fine (first run, or WAL not created yet).
        let e = tmp();
        harden_data_dir(&e).unwrap();
        assert_eq!(mode(&e), 0o700);
    }
}
