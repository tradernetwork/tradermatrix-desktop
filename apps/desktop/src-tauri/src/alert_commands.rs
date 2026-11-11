//! Alert commands (M17): local SQLite only. INFORM ONLY: no order, ticket or network call lives here.
use sqlx::SqlitePool;
use tauri::State;

use crate::alerts::{self, Alert, AlertEvent, AlertPatch, FireExtra, FireOutcome, NewAlert};
use crate::error::AppError;
use crate::candles::now_ms;

#[tauri::command]
pub async fn alert_list(pool: State<'_, SqlitePool>) -> Result<Vec<Alert>, String> {
    Ok(alerts::list(&pool).await?)
}

#[tauri::command]
pub async fn alert_create(pool: State<'_, SqlitePool>, alert: NewAlert) -> Result<Alert, String> {
    Ok(alerts::create(&pool, now_ms(), alert).await?)
}

#[tauri::command]
pub async fn alert_update(pool: State<'_, SqlitePool>, id: i64, patch: AlertPatch) -> Result<Alert, String> {
    Ok(alerts::update(&pool, now_ms(), id, patch).await?)
}

#[tauri::command]
pub async fn alert_delete(pool: State<'_, SqlitePool>, id: i64) -> Result<(), String> {
    Ok(alerts::delete(&pool, id).await?)
}

/// The transactional single-fire guard: returns `fired` with the stored event, or `skipped` with the reason.
// Tauri maps each argument by name from the webview call, so the extra fields stay flat (one more would be a struct).
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn alert_fire(
    pool: State<'_, SqlitePool>,
    id: i64,
    side: i64,
    px: f64,
    quote_age_s: f64,
    kind: Option<String>,
    label: Option<String>,
    missed: Option<bool>,
) -> Result<FireOutcome, String> {
    Ok(alerts::fire_ex(&pool, now_ms(), id, side, px, quote_age_s, FireExtra { kind, label, missed: missed.unwrap_or(false) }).await?)
}

#[tauri::command]
pub async fn alert_events(pool: State<'_, SqlitePool>, limit: Option<u32>, unseen_only: Option<bool>) -> Result<Vec<AlertEvent>, String> {
    Ok(alerts::events(&pool, limit, unseen_only.unwrap_or(false)).await?)
}

/// Marks events seen (no ids = all unseen). Returns how many changed.
#[tauri::command]
pub async fn alert_events_ack(pool: State<'_, SqlitePool>, ids: Option<Vec<i64>>) -> Result<u64, String> {
    Ok(alerts::ack(&pool, ids).await?)
}

/// Title and body of an OS notice: control characters become spaces, ends are trimmed, 80 and 200 characters at most. An empty title is refused.
pub fn clean_notice(title: &str, body: &str) -> Result<(String, String), AppError> {
    let tidy = |s: &str, max: usize| s.chars().map(|c| if c.is_control() { ' ' } else { c }).collect::<String>().trim().chars().take(max).collect::<String>();
    let t = tidy(title, 80);
    if t.is_empty() {
        return Err(AppError::Invalid("notice title is empty".into()));
    }
    Ok((t, tidy(body, 200)))
}

/// Best-effort OS notification (M17b). Text only. `shown` or `unavailable` (no daemon, no permission, anything else): never an error, never retried here.
/// Missed-while-closed events never reach this command (the webview decides), and nothing here touches an order or the network.
#[tauri::command]
pub async fn alert_notify(app: tauri::AppHandle, title: String, body: String) -> Result<String, String> {
    use tauri_plugin_notification::NotificationExt;
    let (t, b) = clean_notice(&title, &body).map_err(|e| e.to_string())?;
    Ok(match app.notification().builder().title(t).body(b).show() {
        Ok(()) => "shown",
        Err(_) => "unavailable",
    }
    .to_string())
}
