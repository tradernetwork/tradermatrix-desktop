//! TraderMatrix commands for the webview: four typed, read-only reads, a key-presence status and (M8) three
//! watchlist commands: list, add one symbol, create an empty list. No removal, no notes.
//! There is no generic call command, no tool name and no free-form arguments from the webview, and the
//! API key itself is never returned (the key is written with `secret_set` and only ever read in Rust).
use std::sync::Arc;

use tauri::State;

use crate::tm::types::{ApexLevels, ExpectedMove, IvRank, Snapshot, TmAddOutcome, TmWatchlistMeta, TmWatchlists};
use crate::tm::{TmState, TmStatus};

type Tm<'a> = State<'a, Arc<TmState>>;

/// Reads the secret store (keyring D-Bus or vault), so it runs on a blocking thread.
#[tauri::command]
pub async fn tm_status(tm: Tm<'_>) -> Result<TmStatus, String> {
    let tm = tm.inner().clone();
    tauri::async_runtime::spawn_blocking(move || tm.status()).await.map_err(|_| "status task failed".to_string())
}

#[tauri::command]
pub async fn tm_apex_levels(tm: Tm<'_>, symbol: String, expiration: Option<String>) -> Result<ApexLevels, String> {
    Ok(tm.apex_levels(&symbol, expiration.as_deref()).await?)
}

#[tauri::command]
pub async fn tm_expected_move(tm: Tm<'_>, symbol: String) -> Result<ExpectedMove, String> {
    Ok(tm.expected_move(&symbol).await?)
}

#[tauri::command]
pub async fn tm_iv_rank(tm: Tm<'_>, symbol: String) -> Result<IvRank, String> {
    Ok(tm.iv_rank(&symbol).await?)
}

#[tauri::command]
pub async fn tm_snapshot(tm: Tm<'_>, symbol: String) -> Result<Snapshot, String> {
    Ok(tm.snapshot(&symbol).await?)
}

/// M8: the account's lists, tickers only (notes never leave Rust).
#[tauri::command]
pub async fn tm_watchlists(tm: Tm<'_>) -> Result<TmWatchlists, String> {
    Ok(tm.watchlists().await?)
}

/// M8: adds one symbol to a list (name or id). Non-money write; adds only.
#[tauri::command]
pub async fn tm_watchlist_add(tm: Tm<'_>, list: String, ticker: String) -> Result<TmAddOutcome, String> {
    Ok(tm.watchlist_add(&list, &ticker).await?)
}

/// M8: creates an empty list with this name.
#[tauri::command]
pub async fn tm_watchlist_create(tm: Tm<'_>, name: String) -> Result<TmWatchlistMeta, String> {
    Ok(tm.watchlist_create(&name).await?)
}
