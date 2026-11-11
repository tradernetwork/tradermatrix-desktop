//! Explain-only chat commands for the webview (M14, M14b). `explain_ask` takes a model id, a digest, a question, the earlier turns, the teaching mode (closed enum string `beginner|trader`, anything else is `bad_request`) and up to two lens ids (M20b, closed list in `llm/lenses.rs`, anything else is `bad_request` before any request; the card text is compiled in).
//! Provider, endpoint and key are saved by ONE command (`llm_config_set`) so a saved key can never be re-pointed at a new host; the
//! key is never returned. There is no raw request, no tool name and no order path here.
use std::sync::Arc;

use serde_json::json;
use sqlx::SqlitePool;
use tauri::{Emitter, State};
use zeroize::Zeroizing;

use crate::explain_run::{self, AskOut};
use crate::explain_threads::{self, AppendOut, NewMessage, StoredMessage, ThreadMeta};
use crate::explain_usage::{self, UsageSummary};
use crate::llm::cli_registry::{self, CliDetect};
use crate::llm::openrouter_login::{LoginStart, OrTauriOpener};
use crate::llm::provider::preset;
use crate::llm::{ChatEvent, Detect, Emit, LlmState, LlmStatus, StreamParams, Turn};

/// Refreshes the Rust-side mirrors of the `llm.experimentalCli` and `llm.advancedCli` settings (JSON `true`; anything else is off). Read before every save, test and ask.
async fn sync_experimental(llm: &LlmState, pool: &SqlitePool) {
    let flag = |v: Option<String>| v.and_then(|v| serde_json::from_str::<bool>(&v).ok()).unwrap_or(false);
    llm.set_experimental_cli(flag(crate::db::setting_get(pool, "llm.experimentalCli").await.ok().flatten()));
    llm.set_advanced_cli(flag(crate::db::setting_get(pool, "llm.advancedCli").await.ok().flatten()));
}

/// Streams one explain call (M16 B1). Events `explain:delta`, `explain:done`, `explain:error` (each tagged with `request_id`) go to the webview
/// as the reply arrives; the returned value is the authority (the full reply, usage, the digest hash). A user stop returns `end: "cancelled"`
/// with the partial text and emits nothing further. Errors are the fixed codes (`budget` when a local budget is used up).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // a Tauri command takes each argument by name
pub async fn explain_ask(
    app: tauri::AppHandle,
    llm: State<'_, Arc<LlmState>>,
    pool: State<'_, SqlitePool>,
    model: String,
    digest: String,
    question: String,
    history: Vec<Turn>,
    mode: String,
    request_id: String,
    lenses: Vec<String>,
) -> Result<AskOut, String> {
    let emit: Emit = Arc::new(move |e| {
        let _ = match e {
            ChatEvent::Delta { request_id, text } => app.emit("explain:delta", json!({ "request_id": request_id, "text": text })),
            ChatEvent::Done { request_id, text, usage } => app.emit("explain:done", json!({ "request_id": request_id, "text": text, "usage": usage })),
            ChatEvent::Error { request_id, code, partial } => app.emit("explain:error", json!({ "request_id": request_id, "code": code, "partial": partial })),
        };
    });
    sync_experimental(&llm, &pool).await;
    let p = StreamParams { model, digest, question, history, mode, lenses };
    explain_run::run(&llm, &pool, &explain_usage::today_utc(), &request_id, p, emit).await.map_err(|e| e.code().to_string())
}

/// The Stop button: ends the in-flight request with this id. Any other id does nothing.
#[tauri::command]
pub async fn explain_stop(llm: State<'_, Arc<LlmState>>, request_id: String) -> Result<(), String> {
    llm.stop_request(&request_id);
    Ok(())
}

/// The header meter. `reset_session` zeroes the session token count first (a session wipe).
#[tauri::command]
pub async fn explain_usage_summary(llm: State<'_, Arc<LlmState>>, pool: State<'_, SqlitePool>, reset_session: bool) -> Result<UsageSummary, String> {
    let st = llm.config_status().await;
    let provider = st.provider.clone().unwrap_or_default();
    let model = st.model.clone().filter(|m| !m.is_empty()).or_else(|| preset(&provider).map(|p| p.default_model.to_string())).unwrap_or_default();
    Ok(explain_run::summary(&llm, &pool, &explain_usage::today_utc(), &provider, &model, reset_session).await)
}

#[tauri::command]
pub async fn explain_thread_list(pool: State<'_, SqlitePool>, symbol: Option<String>) -> Result<Vec<ThreadMeta>, String> {
    Ok(explain_threads::list(&pool, symbol.as_deref()).await?)
}

#[tauri::command]
pub async fn explain_thread_load(pool: State<'_, SqlitePool>, thread_id: i64) -> Result<Vec<StoredMessage>, String> {
    Ok(explain_threads::load(&pool, thread_id).await?)
}

/// Saves turns into a thread (none = a new thread). Writes nothing and returns null when the `chat.saveHistory` setting is off.
#[tauri::command]
pub async fn explain_thread_append(pool: State<'_, SqlitePool>, thread_id: Option<i64>, symbol: String, messages: Vec<NewMessage>) -> Result<Option<AppendOut>, String> {
    Ok(explain_threads::append(&pool, crate::candles::now_ms(), thread_id, &symbol, &messages).await?)
}

/// One message (with its partner) or, with no message id, the whole thread.
#[tauri::command]
pub async fn explain_thread_delete(pool: State<'_, SqlitePool>, thread_id: i64, message_id: Option<i64>) -> Result<(), String> {
    Ok(explain_threads::delete(&pool, thread_id, message_id).await?)
}

#[tauri::command]
pub async fn explain_thread_delete_all(pool: State<'_, SqlitePool>) -> Result<(), String> {
    Ok(explain_threads::delete_all(&pool).await?)
}

/// Writes `<app data>/exports/tradermatrix-explain-*.md` (mode 0600) for one thread (or all) and returns the path.
#[tauri::command]
pub async fn explain_thread_export(app: tauri::AppHandle, pool: State<'_, SqlitePool>, thread_id: Option<i64>) -> Result<String, String> {
    use tauri::Manager;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("exports");
    let path = explain_threads::export_to_dir(&pool, &dir, thread_id, crate::candles::now_ms()).await?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // a Tauri command takes each argument by name
pub async fn llm_config_set(llm: State<'_, Arc<LlmState>>, pool: State<'_, SqlitePool>, provider: String, base_url: Option<String>, api_key: Option<String>, model: Option<String>, compat: Option<bool>, lan_http: Option<bool>) -> Result<LlmStatus, String> {
    sync_experimental(&llm, &pool).await;
    llm.config_set(provider, base_url, api_key.map(Zeroizing::new), model, compat, lan_http).await
}

#[tauri::command]
pub async fn llm_config_status(llm: State<'_, Arc<LlmState>>) -> Result<LlmStatus, String> {
    Ok(llm.config_status().await)
}

#[tauri::command]
pub async fn llm_config_clear(llm: State<'_, Arc<LlmState>>) -> Result<(), String> {
    llm.config_clear().await
}

/// A fixed tiny ping through the configured provider (no chart data). Ok(()) or a fixed error code.
#[tauri::command]
pub async fn llm_test(llm: State<'_, Arc<LlmState>>, pool: State<'_, SqlitePool>) -> Result<(), String> {
    sync_experimental(&llm, &pool).await;
    llm.ping().await.map_err(|e| e.code().to_string())
}

#[tauri::command]
pub async fn llm_detect(llm: State<'_, Arc<LlmState>>) -> Result<Detect, String> {
    Ok(llm.detect().await)
}

/// Which agent CLIs from the static roster are on this computer. A PATH walk over absolute entries; NOTHING is executed. Returns binary names only (no paths).
#[tauri::command]
pub async fn llm_cli_detect() -> Result<CliDetect, String> {
    let path = std::env::var("PATH").unwrap_or_default();
    tauri::async_runtime::spawn_blocking(move || cli_registry::detect(&path)).await.map_err(|_| "background task failed".to_string())
}

/// The "Check version" link on a found CLI: runs `<binary> --version` (3 s, cleared environment, empty temp folder). Explicit user action only. Returns one clean line or a fixed code.
#[tauri::command]
pub async fn llm_cli_check_version(cli_id: String) -> Result<String, String> {
    cli_registry::check_version(&cli_id).await.map_err(|e| e.code().to_string())
}

/// "Sign in with OpenRouter": opens the browser and returns only the link and a pending id. The key never reaches the webview.
#[tauri::command]
pub async fn llm_openrouter_login_start(app: tauri::AppHandle, llm: State<'_, Arc<LlmState>>) -> Result<LoginStart, String> {
    llm.openrouter_login_start(&OrTauriOpener(app)).await.map_err(|e| e.code().to_string())
}

/// `pending`, `done`, `expired` or `failed`.
#[tauri::command]
pub async fn llm_openrouter_login_status(llm: State<'_, Arc<LlmState>>, pending_id: String) -> Result<String, String> {
    Ok(llm.openrouter_login_status(&pending_id).as_str().to_string())
}
