//! Per-symbol Explain chat threads in the local SQLite file (M16 B3). Stored: the user's questions, the model's answers, token counts, the model
//! name, the prompt version, the grounding flags and the SHA-256 of the digest that was sent. NEVER stored: the digest body, any key, account
//! numbers, journal notes or raw provider errors. The setting `chat.saveHistory` (JSON bool, default on) off means nothing is written at all.
//! Limits: 200 messages per thread, 50 threads, 2 MB of text; the oldest go first and the thread being written is never the one evicted.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::error::AppError;

pub const MAX_MESSAGES_PER_THREAD: i64 = 200;
pub const MAX_THREADS: i64 = 50;
pub const MAX_TOTAL_BYTES: i64 = 2 * 1024 * 1024;
pub const MAX_TEXT_CHARS: usize = 8000;
pub const MAX_BATCH: usize = 8;
const MAX_FLAGGED_JSON: usize = 4096;
const MAX_TITLE_CHARS: usize = 60;
pub const SETTING_SAVE_HISTORY: &str = "chat.saveHistory";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewMessage {
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub prompt_tok: Option<i64>,
    #[serde(default)]
    pub completion_tok: Option<i64>,
    #[serde(default)]
    pub model: Option<String>,
    /// SHA-256 hex of the digest sent with this turn (64 lowercase hex characters).
    #[serde(default)]
    pub digest_hash: Option<String>,
    #[serde(default)]
    pub had_positions: bool,
    #[serde(default)]
    pub prompt_version: Option<String>,
    /// JSON array of grounding flags for this reply.
    #[serde(default)]
    pub flagged_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ThreadMeta {
    pub id: i64,
    pub symbol: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub messages: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct StoredMessage {
    pub id: i64,
    pub role: String,
    pub text: String,
    pub ts: i64,
    pub prompt_tok: Option<i64>,
    pub completion_tok: Option<i64>,
    pub model: Option<String>,
    pub digest_hash: Option<String>,
    pub had_positions: bool,
    pub prompt_version: Option<String>,
    pub flagged_json: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct AppendOut {
    pub thread_id: i64,
    pub message_ids: Vec<i64>,
}

fn invalid<T>(m: &str) -> Result<T, AppError> {
    Err(AppError::Invalid(m.into()))
}

/// `[A-Za-z0-9.-]{1,12}`, upper-cased.
fn clean_symbol(s: &str) -> Result<String, AppError> {
    if s.is_empty() || s.len() > 12 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return invalid("symbol must be 1 to 12 characters: A-Z, 0-9, '.' or '-'");
    }
    Ok(s.to_ascii_uppercase())
}

fn check_message(m: &NewMessage) -> Result<(), AppError> {
    if m.role != "user" && m.role != "assistant" {
        return invalid("role must be user or assistant");
    }
    if m.text.trim().is_empty() || m.text.chars().count() > MAX_TEXT_CHARS {
        return invalid("message text must be 1 to 8000 characters");
    }
    for t in [m.prompt_tok, m.completion_tok].into_iter().flatten() {
        if !(0..=10_000_000).contains(&t) {
            return invalid("token count out of range");
        }
    }
    if let Some(model) = &m.model {
        if !crate::llm::client::valid_model(model) {
            return invalid("bad model name");
        }
    }
    if let Some(h) = &m.digest_hash {
        if h.len() != 64 || !h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return invalid("digest hash must be 64 lowercase hex characters");
        }
    }
    if let Some(v) = &m.prompt_version {
        if v.is_empty() || v.len() > 32 || !v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) {
            return invalid("bad prompt version");
        }
    }
    if let Some(f) = &m.flagged_json {
        if f.len() > MAX_FLAGGED_JSON || !matches!(serde_json::from_str::<serde_json::Value>(f), Ok(serde_json::Value::Array(_))) {
            return invalid("flagged_json must be a JSON array of at most 4 KB");
        }
    }
    Ok(())
}

/// One clean line: control characters become spaces, runs of spaces collapse, at most 60 characters.
fn title_of(text: &str) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    let one = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    one.chars().take(MAX_TITLE_CHARS).collect()
}

async fn save_history_on(p: &SqlitePool) -> bool {
    let v = crate::db::setting_get(p, SETTING_SAVE_HISTORY).await.ok().flatten();
    !matches!(v.as_deref().map(str::trim).map(serde_json::from_str::<bool>), Some(Ok(false)))
}

/// Appends messages to a thread (`None` starts a new one) and enforces the limits. Returns `None`, having written nothing, when
/// `chat.saveHistory` is off. Everything is validated first; a bad message stores nothing, not even the thread.
pub async fn append(p: &SqlitePool, now_ms: i64, thread_id: Option<i64>, symbol: &str, msgs: &[NewMessage]) -> Result<Option<AppendOut>, AppError> {
    let symbol = clean_symbol(symbol)?;
    if msgs.is_empty() || msgs.len() > MAX_BATCH {
        return invalid("append takes 1 to 8 messages");
    }
    // M16 B7: a key pasted into a question (or echoed in an answer) never reaches the database; the title is derived from the cleaned text too.
    let cleaned: Vec<NewMessage> = msgs
        .iter()
        .map(|m| NewMessage { text: crate::redact::redact_secrets(&m.text), flagged_json: m.flagged_json.as_deref().map(crate::redact::redact_secrets), ..m.clone() })
        .collect();
    let msgs = &cleaned[..];
    for m in msgs {
        check_message(m)?;
    }
    if !save_history_on(p).await {
        return Ok(None);
    }
    let mut tx = p.begin().await?;
    let tid = match thread_id {
        Some(id) => {
            let row = sqlx::query("SELECT symbol FROM explain_threads WHERE id = ?1").bind(id).fetch_optional(&mut *tx).await?;
            let Some(row) = row else { return Err(AppError::NotFound("thread".into())) };
            if row.get::<String, _>("symbol") != symbol {
                return invalid("that thread belongs to another symbol");
            }
            sqlx::query("UPDATE explain_threads SET updated_at = ?2 WHERE id = ?1").bind(id).bind(now_ms).execute(&mut *tx).await?;
            id
        }
        None => {
            let first = msgs.iter().find(|m| m.role == "user").unwrap_or(&msgs[0]);
            let title = title_of(&first.text);
            sqlx::query("INSERT INTO explain_threads (symbol, created_at, updated_at, title) VALUES (?1, ?2, ?2, ?3) RETURNING id")
                .bind(&symbol)
                .bind(now_ms)
                .bind(title)
                .fetch_one(&mut *tx)
                .await?
                .get::<i64, _>("id")
        }
    };
    let mut ids = Vec::with_capacity(msgs.len());
    for m in msgs {
        let id: i64 = sqlx::query(
            "INSERT INTO explain_messages (thread_id, role, text, ts, prompt_tok, completion_tok, model, digest_hash, had_positions, prompt_version, flagged_json) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11) RETURNING id",
        )
        .bind(tid)
        .bind(&m.role)
        .bind(&m.text)
        .bind(now_ms)
        .bind(m.prompt_tok)
        .bind(m.completion_tok)
        .bind(&m.model)
        .bind(&m.digest_hash)
        .bind(i64::from(m.had_positions))
        .bind(&m.prompt_version)
        .bind(&m.flagged_json)
        .fetch_one(&mut *tx)
        .await?
        .get("id");
        ids.push(id);
    }
    // 200 messages per thread: the oldest go.
    sqlx::query("DELETE FROM explain_messages WHERE thread_id = ?1 AND id NOT IN (SELECT id FROM explain_messages WHERE thread_id = ?1 ORDER BY id DESC LIMIT ?2)")
        .bind(tid)
        .bind(MAX_MESSAGES_PER_THREAD)
        .execute(&mut *tx)
        .await?;
    // 50 threads: the least recently updated go (with their messages).
    sqlx::query("DELETE FROM explain_threads WHERE id NOT IN (SELECT id FROM explain_threads ORDER BY updated_at DESC, id DESC LIMIT ?1)").bind(MAX_THREADS).execute(&mut *tx).await?;
    // 2 MB of text: whole oldest threads first (never the one being written), then the oldest messages of this one.
    loop {
        let bytes: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM explain_messages").fetch_one(&mut *tx).await?;
        if bytes <= MAX_TOTAL_BYTES {
            break;
        }
        let victim: Option<i64> = sqlx::query_scalar("SELECT id FROM explain_threads WHERE id != ?1 ORDER BY updated_at ASC, id ASC LIMIT 1").bind(tid).fetch_optional(&mut *tx).await?;
        match victim {
            Some(v) => {
                sqlx::query("DELETE FROM explain_threads WHERE id = ?1").bind(v).execute(&mut *tx).await?;
            }
            None => {
                sqlx::query("DELETE FROM explain_messages WHERE id = (SELECT MIN(id) FROM explain_messages WHERE thread_id = ?1)").bind(tid).execute(&mut *tx).await?;
            }
        }
    }
    tx.commit().await?;
    Ok(Some(AppendOut { thread_id: tid, message_ids: ids }))
}

/// Threads, most recently updated first (so the first one is the symbol's active thread). `None` = every symbol.
pub async fn list(p: &SqlitePool, symbol: Option<&str>) -> Result<Vec<ThreadMeta>, AppError> {
    let sym = symbol.map(clean_symbol).transpose()?;
    let rows = sqlx::query(
        "SELECT t.id, t.symbol, t.title, t.created_at, t.updated_at, (SELECT COUNT(*) FROM explain_messages m WHERE m.thread_id = t.id) AS n \
         FROM explain_threads t WHERE (?1 IS NULL OR t.symbol = ?1) ORDER BY t.updated_at DESC, t.id DESC",
    )
    .bind(sym)
    .fetch_all(p)
    .await?;
    Ok(rows.iter().map(|r| ThreadMeta { id: r.get("id"), symbol: r.get("symbol"), title: r.get("title"), created_at: r.get("created_at"), updated_at: r.get("updated_at"), messages: r.get("n") }).collect())
}

/// Messages of a thread, oldest first. An unknown thread is simply empty.
pub async fn load(p: &SqlitePool, thread_id: i64) -> Result<Vec<StoredMessage>, AppError> {
    let rows = sqlx::query(
        "SELECT id, role, text, ts, prompt_tok, completion_tok, model, digest_hash, had_positions, prompt_version, flagged_json \
         FROM explain_messages WHERE thread_id = ?1 ORDER BY id ASC",
    )
    .bind(thread_id)
    .fetch_all(p)
    .await?;
    Ok(rows
        .iter()
        .map(|r| StoredMessage {
            id: r.get("id"),
            role: r.get("role"),
            text: r.get("text"),
            ts: r.get("ts"),
            prompt_tok: r.get("prompt_tok"),
            completion_tok: r.get("completion_tok"),
            model: r.get("model"),
            digest_hash: r.get("digest_hash"),
            had_positions: r.get::<i64, _>("had_positions") != 0,
            prompt_version: r.get("prompt_version"),
            flagged_json: r.get("flagged_json"),
        })
        .collect())
}

/// `message_id` None deletes the whole thread. Some(id) deletes that message together with its partner (a question takes the answer that follows
/// it, an answer takes the question before it); a thread left with no messages is deleted too. An id from another thread does nothing.
pub async fn delete(p: &SqlitePool, thread_id: i64, message_id: Option<i64>) -> Result<(), AppError> {
    let mut tx = p.begin().await?;
    match message_id {
        None => {
            sqlx::query("DELETE FROM explain_messages WHERE thread_id = ?1").bind(thread_id).execute(&mut *tx).await?;
            sqlx::query("DELETE FROM explain_threads WHERE id = ?1").bind(thread_id).execute(&mut *tx).await?;
        }
        Some(mid) => {
            let row = sqlx::query("SELECT role FROM explain_messages WHERE id = ?1 AND thread_id = ?2").bind(mid).bind(thread_id).fetch_optional(&mut *tx).await?;
            if let Some(row) = row {
                let role: String = row.get("role");
                let partner: Option<i64> = if role == "user" {
                    sqlx::query_scalar("SELECT id FROM explain_messages WHERE thread_id = ?1 AND id > ?2 AND role = 'assistant' AND id = (SELECT MIN(id) FROM explain_messages WHERE thread_id = ?1 AND id > ?2)")
                        .bind(thread_id)
                        .bind(mid)
                        .fetch_optional(&mut *tx)
                        .await?
                } else {
                    sqlx::query_scalar("SELECT id FROM explain_messages WHERE thread_id = ?1 AND id < ?2 AND role = 'user' AND id = (SELECT MAX(id) FROM explain_messages WHERE thread_id = ?1 AND id < ?2)")
                        .bind(thread_id)
                        .bind(mid)
                        .fetch_optional(&mut *tx)
                        .await?
                };
                for id in std::iter::once(mid).chain(partner) {
                    sqlx::query("DELETE FROM explain_messages WHERE id = ?1").bind(id).execute(&mut *tx).await?;
                }
                let left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM explain_messages WHERE thread_id = ?1").bind(thread_id).fetch_one(&mut *tx).await?;
                if left == 0 {
                    sqlx::query("DELETE FROM explain_threads WHERE id = ?1").bind(thread_id).execute(&mut *tx).await?;
                }
            }
        }
    }
    tx.commit().await?;
    Ok(())
}

/// "Delete all chat history": every thread and message. Usage counters (the meter) are not chat history and stay.
pub async fn delete_all(p: &SqlitePool) -> Result<(), AppError> {
    let mut tx = p.begin().await?;
    sqlx::query("DELETE FROM explain_messages").execute(&mut *tx).await?;
    sqlx::query("DELETE FROM explain_threads").execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

fn render(t: &ThreadMeta, msgs: &[StoredMessage]) -> String {
    let mut s = format!("# Explain chat: {}\n\nThread: {}\nStarted: {} UTC\n\n", t.symbol, t.title, crate::rh_commands::ymd_utc(t.created_at / 1000));
    for m in msgs {
        if m.role == "user" {
            s.push_str("## You\n\n");
        } else {
            s.push_str("## Arya\n\n");
        }
        s.push_str(m.text.trim_end());
        s.push_str("\n\n");
        if m.role == "assistant" {
            let mut meta = vec![];
            if let Some(model) = &m.model {
                meta.push(format!("model {model}"));
            }
            if let Some(v) = &m.prompt_version {
                meta.push(format!("prompt {v}"));
            }
            if !meta.is_empty() {
                s.push_str(&format!("_{}_\n\n", meta.join(", ")));
            }
        }
    }
    s
}

/// Markdown export of one thread (`Some`) or all of them (`None`), written to `<dir>/tradermatrix-explain-<SYMBOL|all>-<date>-<secs>-<ms>-<seq>.md`
/// with mode 0600 (dir 0700), `create_new` (never overwrites, never follows a planted link). No digest, hash or key goes in.
pub async fn export_to_dir(p: &SqlitePool, dir: &Path, thread_id: Option<i64>, now_ms: i64) -> Result<PathBuf, AppError> {
    let all = list(p, None).await?;
    let chosen: Vec<ThreadMeta> = match thread_id {
        Some(id) => vec![all.into_iter().find(|t| t.id == id).ok_or_else(|| AppError::NotFound("thread".into()))?],
        None => {
            let mut v = all;
            v.reverse();
            v
        }
    };
    if chosen.is_empty() {
        return invalid("there is no chat history to export");
    }
    let mut body = String::new();
    for t in &chosen {
        body.push_str(&render(t, &load(p, t.id).await?));
    }
    // Rows written before B7 may still hold a pasted key: the export is cleaned on the way out as well.
    let body = crate::redact::redact_secrets(&body);
    let label = if thread_id.is_some() { chosen[0].symbol.clone() } else { "all".to_string() };
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let secs = now_ms / 1000;
    let name = format!("tradermatrix-explain-{label}-{}-{}-{:03}-{seq}.md", crate::rh_commands::ymd_utc(secs), secs.rem_euclid(86_400), now_ms.rem_euclid(1000));
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    let path = dir.join(name);
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    use std::io::Write;
    opts.open(&path)?.write_all(body.as_bytes())?;
    Ok(path)
}
