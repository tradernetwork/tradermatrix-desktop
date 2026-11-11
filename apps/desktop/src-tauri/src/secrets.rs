use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;

use std::sync::Arc;

use crate::error::AppError;
use crate::vault::Vault;

pub const SERVICE: &str = "app.rebull.desktop";
pub const SLOTS: [&str; 4] = ["robinhood_oauth", "tm_api_key", "llm_api_key", "llm_config"];
const MAX_SECRET_LEN: usize = 64 * 1024;

#[derive(Serialize, Clone, PartialEq, Debug)]
pub struct BackendStatus {
    pub available: bool,
    pub backend: String,
    pub detail: String,
}

/// `get` is for Rust-side callers only (M3). It is never exposed as a Tauri command.
pub trait SecretStore: Send + Sync {
    fn set(&self, slot: &str, value: &str) -> Result<(), AppError>;
    fn exists(&self, slot: &str) -> Result<bool, AppError>;
    fn delete(&self, slot: &str) -> Result<(), AppError>;
    fn get(&self, slot: &str) -> Result<Option<String>, AppError>;
    fn status(&self) -> BackendStatus;
}

pub(crate) fn check_slot(slot: &str) -> Result<(), AppError> {
    if SLOTS.contains(&slot) {
        Ok(())
    } else {
        Err(AppError::Invalid(format!("unknown secret slot: {slot}")))
    }
}

pub(crate) fn check_value(value: &str) -> Result<(), AppError> {
    if value.is_empty() {
        return Err(AppError::Invalid("secret value is empty".into()));
    }
    if value.len() > MAX_SECRET_LEN {
        return Err(AppError::Invalid("secret value too large".into()));
    }
    Ok(())
}

pub struct KeyringStore;

impl KeyringStore {
    fn entry(slot: &str) -> Result<keyring::Entry, AppError> {
        keyring::Entry::new(SERVICE, slot).map_err(|e| AppError::Secret(e.to_string()))
    }
}

impl SecretStore for KeyringStore {
    fn set(&self, slot: &str, value: &str) -> Result<(), AppError> {
        check_slot(slot)?;
        check_value(value)?;
        Self::entry(slot)?
            .set_password(value)
            .map_err(|e| AppError::Secret(e.to_string()))
    }

    fn exists(&self, slot: &str) -> Result<bool, AppError> {
        Ok(self.get(slot)?.is_some())
    }

    fn delete(&self, slot: &str) -> Result<(), AppError> {
        check_slot(slot)?;
        match Self::entry(slot)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(AppError::Secret(e.to_string())),
        }
    }

    fn get(&self, slot: &str) -> Result<Option<String>, AppError> {
        check_slot(slot)?;
        match Self::entry(slot)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(AppError::Secret(e.to_string())),
        }
    }

    fn status(&self) -> BackendStatus {
        let backend = if cfg!(target_os = "linux") {
            "secret-service"
        } else {
            "os-keyring"
        }
        .to_string();
        // A probe read of a slot that is never written; NoEntry means the backend answered.
        let probe = std::panic::catch_unwind(|| {
            keyring::Entry::new(SERVICE, "__status_probe")
                .and_then(|e| e.get_password().map(|_| ()))
        });
        match probe {
            Ok(Ok(())) | Ok(Err(keyring::Error::NoEntry)) => BackendStatus {
                available: true,
                backend,
                detail: "OS keyring reachable".into(),
            },
            Ok(Err(e)) => BackendStatus {
                available: false,
                backend,
                detail: format!("no usable keyring (secrets cannot be saved): {e}"),
            },
            Err(_) => BackendStatus {
                available: false,
                backend,
                detail: "keyring backend panicked while probing (secrets cannot be saved)".into(),
            },
        }
    }
}

/// OS keyring when it answers, otherwise the encrypted vault.
pub fn select_store(vault: Arc<Vault>) -> Arc<dyn SecretStore> {
    if KeyringStore.status().available {
        Arc::new(KeyringStore)
    } else {
        vault
    }
}

#[derive(Default)]
pub struct MemoryStore {
    map: Mutex<HashMap<String, String>>,
}

impl MemoryStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, HashMap<String, String>>, AppError> {
        self.map
            .lock()
            .map_err(|_| AppError::Secret("memory store poisoned".into()))
    }
}

impl SecretStore for MemoryStore {
    fn set(&self, slot: &str, value: &str) -> Result<(), AppError> {
        check_slot(slot)?;
        check_value(value)?;
        self.lock()?.insert(slot.to_string(), value.to_string());
        Ok(())
    }

    fn exists(&self, slot: &str) -> Result<bool, AppError> {
        check_slot(slot)?;
        Ok(self.lock()?.contains_key(slot))
    }

    fn delete(&self, slot: &str) -> Result<(), AppError> {
        check_slot(slot)?;
        self.lock()?.remove(slot);
        Ok(())
    }

    fn get(&self, slot: &str) -> Result<Option<String>, AppError> {
        check_slot(slot)?;
        Ok(self.lock()?.get(slot).cloned())
    }

    fn status(&self) -> BackendStatus {
        BackendStatus {
            available: true,
            backend: "memory".into(),
            detail: "in-memory test store".into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_slot_rejected() {
        let s = MemoryStore::new();
        assert!(matches!(s.set("nope", "x"), Err(AppError::Invalid(_))));
        assert!(matches!(s.exists("nope"), Err(AppError::Invalid(_))));
        assert!(matches!(s.delete("nope"), Err(AppError::Invalid(_))));
        assert!(matches!(s.get("nope"), Err(AppError::Invalid(_))));
    }

    #[test]
    fn empty_value_rejected() {
        let s = MemoryStore::new();
        assert!(matches!(s.set("robinhood_oauth", ""), Err(AppError::Invalid(_))));
    }

    #[test]
    fn set_exists_get_delete() {
        let s = MemoryStore::new();
        assert!(!s.exists("tm_api_key").unwrap());
        s.set("tm_api_key", "abc").unwrap();
        assert!(s.exists("tm_api_key").unwrap());
        assert_eq!(s.get("tm_api_key").unwrap().as_deref(), Some("abc"));
        s.delete("tm_api_key").unwrap();
        assert!(!s.exists("tm_api_key").unwrap());
    }

    /// M15 rename: the product name changed, the identity of the stored data did not. The vault, rebull.db and the lock file
    /// live under the Tauri identifier and these constants; moving any of them would orphan existing user data.
    #[test]
    fn data_identity_is_pinned_to_the_pre_rename_values() {
        assert_eq!(SERVICE, "app.rebull.desktop");
        assert_eq!(crate::startup::LOCK_FILE, "rebull.lock");
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["identifier"], "app.rebull.desktop");
        assert_eq!(conf["productName"], "TraderMatrix Desktop");
        assert_eq!(conf["app"]["windows"][0]["title"], "TraderMatrix Desktop");
        let cargo = include_str!("../Cargo.toml");
        assert!(cargo.contains("name = \"tradermatrix-desktop\""), "package/binary name");
        assert!(cargo.contains("name = \"rebull_lib\""), "crate lib name stays");
    }

    #[test]
    fn delete_unset_slot_ok() {
        let s = MemoryStore::new();
        s.delete("robinhood_oauth").unwrap();
    }

    #[test]
    fn select_store_picks_a_known_backend() {
        let v = Arc::new(Vault::new(std::env::temp_dir().join("rebull-select-store-unused.rbv")));
        let b = select_store(v).status().backend;
        assert!(b == "vault" || b == "secret-service" || b == "os-keyring", "{b}");
    }

    #[test]
    fn keyring_status_has_shape_and_never_panics() {
        let st = KeyringStore.status();
        assert!(!st.detail.is_empty());
        assert!(!st.backend.is_empty());
    }

    #[test]
    fn keyring_rejects_bad_input_before_touching_backend() {
        assert!(matches!(KeyringStore.set("nope", "x"), Err(AppError::Invalid(_))));
        assert!(matches!(KeyringStore.set("tm_api_key", ""), Err(AppError::Invalid(_))));
    }
}
