use std::sync::Arc;

use sqlx::SqlitePool;
use tauri::State;

use crate::candles::{self, CandleIn, CandleRow, CandleStats};
use crate::db::{self, LayoutMeta};
use crate::error::AppError;
use crate::journal::{self, NewNote, Note, NoteFilter};
use crate::rh_commands::RhState;
use crate::secrets::{BackendStatus, SecretStore};
use crate::vault::Vault;
use serde::Serialize;
use zeroize::Zeroizing;

type Secrets<'a> = State<'a, Arc<dyn SecretStore>>;

// There is deliberately NO `secret_get` command: secrets never reach the webview.

#[tauri::command]
pub async fn layout_list(pool: State<'_, SqlitePool>) -> Result<Vec<LayoutMeta>, String> {
    Ok(db::layout_list(&pool).await?)
}

#[tauri::command]
pub async fn layout_save(pool: State<'_, SqlitePool>, name: String, json: String) -> Result<LayoutMeta, String> {
    Ok(db::layout_save(&pool, &name, &json).await?)
}

#[tauri::command]
pub async fn layout_load(pool: State<'_, SqlitePool>, name: String) -> Result<Option<String>, String> {
    Ok(db::layout_load(&pool, &name).await?)
}

#[tauri::command]
pub async fn layout_delete(pool: State<'_, SqlitePool>, name: String) -> Result<(), String> {
    Ok(db::layout_delete(&pool, &name).await?)
}

#[tauri::command]
pub async fn setting_get(pool: State<'_, SqlitePool>, key: String) -> Result<Option<String>, String> {
    Ok(db::setting_get(&pool, &key).await?)
}

#[tauri::command]
pub async fn setting_set(pool: State<'_, SqlitePool>, key: String, value: String) -> Result<(), String> {
    Ok(db::setting_set(&pool, &key, &value).await?)
}

/// The only slot the webview may set, test or delete (M14 widened this to two; M14b reverted it). `robinhood_oauth`, `llm_api_key` and
/// `llm_config` are written by Rust alone (the LLM pair only through `llm_config_set`, which seals key and endpoint together).
/// Nothing can be read back: there is no `secret_get`.
const WEBVIEW_SLOTS: [&str; 1] = ["tm_api_key"];

fn webview_slot(slot: &str) -> Result<(), AppError> {
    if WEBVIEW_SLOTS.contains(&slot) {
        Ok(())
    } else {
        Err(AppError::Invalid("the app may only manage the tm_api_key secret".into()))
    }
}

pub(crate) fn webview_secret_set(store: &dyn SecretStore, slot: &str, value: &str) -> Result<(), AppError> {
    webview_slot(slot)?;
    store.set(slot, value)
}
pub(crate) fn webview_secret_exists(store: &dyn SecretStore, slot: &str) -> Result<bool, AppError> {
    webview_slot(slot)?;
    store.exists(slot)
}
pub(crate) fn webview_secret_delete(store: &dyn SecretStore, slot: &str) -> Result<(), AppError> {
    webview_slot(slot)?;
    store.delete(slot)
}

/// Keyring (D-Bus) and vault (argon2, fsync) work runs on a blocking thread so a stalled Secret Service or a
/// slow disk cannot freeze the UI.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|_| "background task failed".to_string())
}

#[tauri::command]
pub async fn secret_set(store: Secrets<'_>, slot: String, value: String) -> Result<(), String> {
    let store = store.inner().clone();
    let value = Zeroizing::new(value);
    Ok(blocking(move || webview_secret_set(&*store, &slot, &value)).await??)
}

#[tauri::command]
pub async fn secret_exists(store: Secrets<'_>, slot: String) -> Result<bool, String> {
    let store = store.inner().clone();
    Ok(blocking(move || webview_secret_exists(&*store, &slot)).await??)
}

#[tauri::command]
pub async fn secret_delete(store: Secrets<'_>, slot: String) -> Result<(), String> {
    let store = store.inner().clone();
    Ok(blocking(move || webview_secret_delete(&*store, &slot)).await??)
}

#[tauri::command]
pub async fn secret_backend_status(store: Secrets<'_>) -> Result<BackendStatus, String> {
    let store = store.inner().clone();
    blocking(move || store.status()).await
}

#[derive(Serialize)]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
    pub backend: String,
}

// Passphrase arguments are never logged and never echoed in errors (AppError carries no input text).

#[tauri::command]
pub async fn vault_status(vault: State<'_, Arc<Vault>>, store: Secrets<'_>) -> Result<VaultStatus, String> {
    let (vault, store) = (vault.inner().clone(), store.inner().clone());
    blocking(move || VaultStatus { exists: vault.exists(), unlocked: vault.is_unlocked(), backend: store.status().backend }).await
}

#[tauri::command]
pub async fn vault_create(vault: State<'_, Arc<Vault>>, passphrase: String) -> Result<(), String> {
    let v = vault.inner().clone();
    let passphrase = Zeroizing::new(passphrase);
    blocking(move || v.create(&passphrase)).await?.map_err(String::from)
}

#[tauri::command]
pub async fn vault_unlock(vault: State<'_, Arc<Vault>>, passphrase: String) -> Result<(), String> {
    let v = vault.inner().clone();
    let passphrase = Zeroizing::new(passphrase);
    blocking(move || v.unlock(&passphrase)).await?.map_err(String::from)
}

/// Locks the vault and drops any Robinhood token pair still waiting to be saved into it.
#[tauri::command]
pub async fn vault_lock(vault: State<'_, Arc<Vault>>, rh: State<'_, Arc<RhState>>) -> Result<(), String> {
    rh.forget_pending().await;
    let v = vault.inner().clone();
    blocking(move || v.lock()).await
}

// ---- M7 journal: local SQLite only. Nothing here is sent anywhere. ----

#[tauri::command]
pub async fn journal_list(pool: State<'_, SqlitePool>, filter: NoteFilter) -> Result<Vec<Note>, String> {
    Ok(journal::notes_list(&pool, &filter).await?)
}

#[tauri::command]
pub async fn journal_add(pool: State<'_, SqlitePool>, note: NewNote) -> Result<Note, String> {
    Ok(journal::note_add(&pool, note).await?)
}

#[tauri::command]
pub async fn journal_update(pool: State<'_, SqlitePool>, id: i64, body: String, tags: Vec<String>) -> Result<Note, String> {
    Ok(journal::note_update(&pool, id, &body, &tags).await?)
}

#[tauri::command]
pub async fn journal_delete(pool: State<'_, SqlitePool>, id: i64) -> Result<(), String> {
    Ok(journal::note_delete(&pool, id).await?)
}

// ---- M11 candles + snapshots: local SQLite only. No network, no tool names, no raw SQL. ----

#[tauri::command]
pub async fn candles_store(pool: State<'_, SqlitePool>, source: String, instrument: String, interval: String, bars: Vec<CandleIn>) -> Result<usize, String> {
    Ok(candles::store_candles(&pool, &source, &instrument, &interval, &bars, candles::now_ms()).await?)
}

#[tauri::command]
pub async fn candles_load(pool: State<'_, SqlitePool>, source: String, instrument: String, interval: String, from: i64, to: i64, limit: u32) -> Result<Vec<CandleRow>, String> {
    Ok(candles::load_candles(&pool, &source, &instrument, &interval, from, to, limit).await?)
}

#[tauri::command]
pub async fn snapshot_store(pool: State<'_, SqlitePool>, kind: String, key: String, json: String) -> Result<(), String> {
    Ok(candles::store_snapshot(&pool, &kind, &key, &json, candles::now_ms()).await?)
}

#[tauri::command]
pub async fn candles_stats(pool: State<'_, SqlitePool>) -> Result<CandleStats, String> {
    Ok(candles::stats(&pool).await?)
}

#[derive(Serialize)]
pub struct ExportResult {
    pub path: String,
    pub rows: usize,
    /// More trades exist than the 5-page cap returned, or more notes than the 10,000-note cap.
    pub truncated: bool,
}

/// Reads the account's trades for `span` (through the P&L path), merges the user's notes by `trade_key`, writes
/// `<app_data_dir>/exports/<name>.csv` (mode 0600) and returns the path. No new fs capability: Rust writes it.
#[tauri::command]
pub async fn journal_export_csv(
    app: tauri::AppHandle,
    pool: State<'_, SqlitePool>,
    rh: State<'_, Arc<RhState>>,
    span: String,
    account: String,
) -> Result<ExportResult, String> {
    use tauri::Manager;
    let trades = rh.pnl_trades(&account, &span, None, None).await?;
    let (notes, notes_truncated) = journal::notes_all(&pool).await?;
    let csv = journal::export_csv(&notes, &trades.trades);
    let rows = journal::export_row_count(&notes, &trades.trades);
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("exports");
    let unix_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let name = journal::export_file_name(unix_ms, &span);
    let path = journal::write_export(&dir, &name, &csv)?;
    Ok(ExportResult { path: path.to_string_lossy().into_owned(), rows, truncated: trades.next_cursor.is_some() || notes_truncated })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secrets::MemoryStore;

    /// R5 (M14b): exactly `tm_api_key` is reachable from the webview; the OAuth slot and the LLM key/config slots are Rust-only.
    #[test]
    fn webview_secret_commands_only_touch_the_tm_key() {
        let s = MemoryStore::new();
        s.set("robinhood_oauth", "{\"keep\":1}").unwrap();
        s.set("llm_api_key", "sk-test-KEY").unwrap();
        s.set("llm_config", "{\"provider\":\"custom\"}").unwrap();
        webview_secret_set(&s, "tm_api_key", "td_live_TESTKEY").unwrap();
        assert!(webview_secret_exists(&s, "tm_api_key").unwrap());
        webview_secret_delete(&s, "tm_api_key").unwrap();
        assert!(!webview_secret_exists(&s, "tm_api_key").unwrap());
        // everything else, including near-misses and the LLM slots M14 used to allow, stays refused
        for bad in ["robinhood_oauth", "llm_api_key", "llm_config", "llm_api_key ", "LLM_API_KEY", "tm_api_key2", "tm_api_key ", "TM_API_KEY", "llm", ""] {
            assert!(matches!(webview_secret_set(&s, bad, "x"), Err(AppError::Invalid(_))), "{bad:?}");
            assert!(matches!(webview_secret_exists(&s, bad), Err(AppError::Invalid(_))), "{bad:?}");
            assert!(matches!(webview_secret_delete(&s, bad), Err(AppError::Invalid(_))), "{bad:?}");
        }
        assert_eq!(WEBVIEW_SLOTS.len(), 1);
        assert_eq!(s.get("llm_api_key").unwrap().as_deref(), Some("sk-test-KEY"));
        assert_eq!(s.get("llm_config").unwrap().as_deref(), Some("{\"provider\":\"custom\"}"));
        assert_eq!(s.get("robinhood_oauth").unwrap().as_deref(), Some("{\"keep\":1}"));
    }
}
