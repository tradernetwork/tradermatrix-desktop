//! R-tool commands (M18): local SQLite only. INFORMATIONAL: no review, place or order tool is reachable from here, there is no network call,
//! and nothing in these commands can block, change or condition an order. Names carry no order verb on purpose.
use sqlx::SqlitePool;
use tauri::State;

use crate::candles::now_ms;
use crate::risk::{self, Draft, DraftIn, PromoteIn, RiskSettings, RiskSettingsIn, RiskState, RiskStatsOut, RiskTradeIn, TradeRisk};

/// Helper settings, every stored trade risk and the live drafts (expired ones are dropped first).
#[tauri::command]
pub async fn risk_get(pool: State<'_, SqlitePool>) -> Result<RiskState, String> {
    Ok(risk::get_state(&pool, now_ms()).await?)
}

#[tauri::command]
pub async fn risk_set(pool: State<'_, SqlitePool>, settings: RiskSettingsIn) -> Result<RiskSettings, String> {
    Ok(risk::settings_set(&pool, settings).await?)
}

/// Store the planned risk under a review id (`fields`), or attach the order id once the outcome was `placed` (`order_id`). Never touches the order.
#[tauri::command]
pub async fn risk_draft_put(pool: State<'_, SqlitePool>, draft: DraftIn) -> Result<Draft, String> {
    Ok(risk::draft_put(&pool, now_ms(), draft).await?)
}

/// Link planned risk to a journal trade key the user picked: from a placed draft, or typed in manually at any time.
#[tauri::command]
pub async fn risk_promote(pool: State<'_, SqlitePool>, promote: PromoteIn) -> Result<TradeRisk, String> {
    Ok(risk::promote(&pool, now_ms(), promote).await?)
}

/// Joins stored risk to the trades the webview already holds (counts for "N of M trades have R") and returns unique-match suggestions.
#[tauri::command]
pub async fn risk_stats(pool: State<'_, SqlitePool>, account_masked: Option<String>, trades: Vec<RiskTradeIn>) -> Result<RiskStatsOut, String> {
    Ok(risk::stats(&pool, now_ms(), account_masked.as_deref(), &trades).await?)
}
