//! Local trading journal (M7): notes in SQLite, linkable to a Robinhood trade by `trade_key`, exported as CSV.
//! Private by construction: nothing here talks to the network, and the webview only gets typed commands.
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::error::AppError;
use crate::rh::pnl::PnlTrade;
use crate::rh::watch_writes::symbol_ok;

pub const MAX_BODY_CHARS: usize = 10_000;
pub const MAX_TAGS: usize = 10;
pub const MAX_TAG_CHARS: usize = 32;
pub const MAX_LIST_LIMIT: u32 = 500;
const DEFAULT_LIST_LIMIT: u32 = 200;
const MAX_EXPORT_NOTES: i64 = 10_000;
const MAX_TEXT_FILTER: usize = 200;
const MAX_FILE_NAME: usize = 100;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const COLS: &str = "id, created_at, updated_at, symbol, account_masked, trade_key, body, tags";

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Note {
    pub id: i64,
    pub created_at: String,
    pub updated_at: String,
    pub symbol: Option<String>,
    pub account_masked: Option<String>,
    pub trade_key: Option<String>,
    pub body: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct NewNote {
    pub symbol: Option<String>,
    pub account_masked: Option<String>,
    pub trade_key: Option<String>,
    pub body: String,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct NoteFilter {
    pub symbol: Option<String>,
    pub trade_key: Option<String>,
    pub text: Option<String>,
    pub limit: Option<u32>,
}

fn invalid<T>(m: &str) -> Result<T, AppError> {
    Err(AppError::Invalid(m.into()))
}

fn printable(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

/// Non-empty, at most 10,000 characters, no control characters except newline and tab.
fn validate_body(body: &str) -> Result<(), AppError> {
    if body.trim().is_empty() {
        return invalid("note is empty");
    }
    if body.chars().count() > MAX_BODY_CHARS {
        return invalid("note is longer than 10,000 characters");
    }
    if body.chars().any(|c| c.is_control() && c != '\n' && c != '\t') {
        return invalid("note contains control characters");
    }
    Ok(())
}

/// At most 10 tags of 1 to 32 printable characters; trimmed, de-duplicated case-insensitively (first wins).
fn clean_tags(tags: &[String]) -> Result<Vec<String>, AppError> {
    if tags.len() > MAX_TAGS {
        return invalid("at most 10 tags");
    }
    let mut out: Vec<String> = Vec::new();
    for t in tags {
        let t = t.trim();
        if t.is_empty() || t.chars().count() > MAX_TAG_CHARS || !printable(t) {
            return invalid("each tag must be 1 to 32 printable characters");
        }
        if !out.iter().any(|o| o.eq_ignore_ascii_case(t)) {
            out.push(t.to_string());
        }
    }
    Ok(out)
}

fn clean_symbol(s: Option<&str>) -> Result<Option<String>, AppError> {
    match s.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) => {
            let u = s.to_ascii_uppercase();
            if symbol_ok(&u) { Ok(Some(u)) } else { invalid("symbol must be 1 to 10 characters: A-Z, 0-9, '.' or '-', starting with a letter") }
        }
    }
}

pub(crate) fn clean_trade_key(s: Option<&str>) -> Result<Option<String>, AppError> {
    match s.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(k) if k.len() <= 64 && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '#' || c == '-') => Ok(Some(k.to_string())),
        Some(_) => invalid("trade key is not valid"),
    }
}

fn clean_account(s: Option<&str>) -> Result<Option<String>, AppError> {
    match s.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(a) if a.chars().count() <= 32 && printable(a) => Ok(Some(a.to_string())),
        Some(_) => invalid("masked account is not valid"),
    }
}

fn to_note(r: &sqlx::sqlite::SqliteRow) -> Note {
    let tags: String = r.get("tags");
    Note {
        id: r.get("id"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
        symbol: r.get("symbol"),
        account_masked: r.get("account_masked"),
        trade_key: r.get("trade_key"),
        body: r.get("body"),
        tags: serde_json::from_str(&tags).unwrap_or_default(),
    }
}

fn tags_json(tags: &[String]) -> String {
    serde_json::to_string(tags).unwrap_or_else(|_| "[]".into())
}

pub async fn note_add(p: &SqlitePool, n: NewNote) -> Result<Note, AppError> {
    validate_body(&n.body)?;
    let tags = clean_tags(&n.tags)?;
    let symbol = clean_symbol(n.symbol.as_deref())?;
    let key = clean_trade_key(n.trade_key.as_deref())?;
    let acct = clean_account(n.account_masked.as_deref())?;
    let sql = format!(
        "INSERT INTO journal_notes (created_at, updated_at, symbol, account_masked, trade_key, body, tags) \
         VALUES ({NOW}, {NOW}, ?1, ?2, ?3, ?4, ?5) RETURNING {COLS}"
    );
    let row = sqlx::query(&sql).bind(symbol).bind(acct).bind(key).bind(&n.body).bind(tags_json(&tags)).fetch_one(p).await?;
    Ok(to_note(&row))
}

/// Edits body and tags only; symbol, account and trade link are fixed at creation.
pub async fn note_update(p: &SqlitePool, id: i64, body: &str, tags: &[String]) -> Result<Note, AppError> {
    validate_body(body)?;
    let tags = clean_tags(tags)?;
    let sql = format!("UPDATE journal_notes SET body = ?1, tags = ?2, updated_at = {NOW} WHERE id = ?3 RETURNING {COLS}");
    let row = sqlx::query(&sql).bind(body).bind(tags_json(&tags)).bind(id).fetch_optional(p).await?;
    row.map(|r| to_note(&r)).ok_or_else(|| AppError::NotFound(format!("note {id}")))
}

pub async fn note_delete(p: &SqlitePool, id: i64) -> Result<(), AppError> {
    let r = sqlx::query("DELETE FROM journal_notes WHERE id = ?1").bind(id).execute(p).await?;
    if r.rows_affected() == 0 {
        return Err(AppError::NotFound(format!("note {id}")));
    }
    Ok(())
}

fn like_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len() + 2);
    for c in s.chars() {
        if matches!(c, '\\' | '%' | '_') {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

/// Newest first (creation time, then id). `text` is a literal, case-insensitive substring over body, tags and symbol.
pub async fn notes_list(p: &SqlitePool, f: &NoteFilter) -> Result<Vec<Note>, AppError> {
    let limit = f.limit.unwrap_or(DEFAULT_LIST_LIMIT);
    if limit == 0 || limit > MAX_LIST_LIMIT {
        return invalid("limit must be 1 to 500");
    }
    let symbol = clean_symbol(f.symbol.as_deref())?;
    let key = clean_trade_key(f.trade_key.as_deref())?;
    let text = match f.text.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(t) if t.chars().count() > MAX_TEXT_FILTER => return invalid("search text is too long"),
        Some(t) => Some(format!("%{}%", like_escape(t))),
    };
    let sql = format!(
        "SELECT {COLS} FROM journal_notes WHERE (?1 IS NULL OR symbol = ?1) AND (?2 IS NULL OR trade_key = ?2) \
         AND (?3 IS NULL OR body LIKE ?3 ESCAPE '\\' OR tags LIKE ?3 ESCAPE '\\' OR symbol LIKE ?3 ESCAPE '\\') \
         ORDER BY created_at DESC, id DESC LIMIT ?4"
    );
    let rows = sqlx::query(&sql).bind(symbol).bind(key).bind(text).bind(i64::from(limit)).fetch_all(p).await?;
    Ok(rows.iter().map(to_note).collect())
}

/// Every note for the CSV export, capped at 10,000; the flag says notes were left out (reported like trades).
pub async fn notes_all(p: &SqlitePool) -> Result<(Vec<Note>, bool), AppError> {
    notes_all_capped(p, MAX_EXPORT_NOTES).await
}

pub async fn notes_all_capped(p: &SqlitePool, cap: i64) -> Result<(Vec<Note>, bool), AppError> {
    let sql = format!("SELECT {COLS} FROM journal_notes ORDER BY created_at DESC, id DESC LIMIT ?1");
    let rows = sqlx::query(&sql).bind(cap.saturating_add(1)).fetch_all(p).await?;
    let mut notes: Vec<Note> = rows.iter().map(to_note).collect();
    let truncated = notes.len() as i64 > cap;
    notes.truncate(usize::try_from(cap).unwrap_or(0));
    Ok((notes, truncated))
}

/// `rebull-journal-<YYYY-MM-DD>-<second of day>-<millis>-<seq>-<span>.csv`. The process-wide sequence number
/// keeps two exports in the same millisecond apart (`write_export` never overwrites).
pub fn export_file_name(unix_ms: u64, span: &str) -> String {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let secs = i64::try_from(unix_ms / 1000).unwrap_or(0);
    format!("rebull-journal-{}-{}-{:03}-{seq}-{span}.csv", crate::rh_commands::ymd_utc(secs), secs.rem_euclid(86_400), unix_ms % 1000)
}

// ---- CSV ----

/// Formula-injection guard: a text cell that starts with = + - @ tab or CR gets a leading apostrophe.
fn guard(s: &str) -> String {
    if s.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{s}") } else { s.to_string() }
}

/// RFC 4180 quoting: wrap when the cell has a comma, quote, CR or LF; double the quotes.
fn quote(s: &str) -> String {
    if s.contains([',', '"', '\n', '\r']) { format!("\"{}\"", s.replace('"', "\"\"")) } else { s.to_string() }
}

/// One TEXT cell: guarded, then quoted.
pub fn csv_cell(s: &str) -> String {
    quote(&guard(s))
}

/// Numeric columns are written from f64 (digits, '-', '.'), so a negative P&L stays a number and is not apostrophe-prefixed.
fn num(v: Option<f64>) -> String {
    v.map(|f| format!("{f}")).unwrap_or_default()
}

fn tags_cell(tags: &[String]) -> String {
    quote(&tags.iter().map(|t| guard(t)).collect::<Vec<_>>().join("; "))
}

const HEADER: &str = "kind,date,symbol,side,quantity,price,realized_gain,trade_key,note,tags,note_created_at";

fn linked<'a>(notes: &'a [Note], key: &str) -> Vec<&'a Note> {
    notes.iter().filter(|n| n.trade_key.as_deref() == Some(key)).collect()
}

fn unmatched<'a>(notes: &'a [Note], trades: &[PnlTrade]) -> Vec<&'a Note> {
    notes.iter().filter(|n| !n.trade_key.as_deref().is_some_and(|k| trades.iter().any(|t| t.trade_key == k))).collect()
}

/// Data rows `export_csv` writes: one per trade (one per linked note when it has notes) plus every unmatched note.
pub fn export_row_count(notes: &[Note], trades: &[PnlTrade]) -> usize {
    trades.iter().map(|t| linked(notes, &t.trade_key).len().max(1)).sum::<usize>() + unmatched(notes, trades).len()
}

/// Trades first (most recent first, as given), each followed by its notes, then notes that match no trade.
pub fn export_csv(notes: &[Note], trades: &[PnlTrade]) -> String {
    let mut out = String::from(HEADER);
    out.push_str("\r\n");
    let mut push = |cells: [String; 11]| {
        out.push_str(&cells.join(","));
        out.push_str("\r\n");
    };
    for t in trades {
        let base = |note: Option<&Note>| -> [String; 11] {
            [
                "trade".into(),
                csv_cell(t.timestamp.as_deref().unwrap_or("")),
                csv_cell(&t.symbol),
                csv_cell(t.side.as_deref().unwrap_or("")),
                num(t.quantity),
                num(t.price),
                num(t.realized_gain),
                csv_cell(&t.trade_key),
                note.map(|n| csv_cell(&n.body)).unwrap_or_default(),
                note.map(|n| tags_cell(&n.tags)).unwrap_or_default(),
                note.map(|n| csv_cell(&n.created_at)).unwrap_or_default(),
            ]
        };
        let ns = linked(notes, &t.trade_key);
        if ns.is_empty() {
            push(base(None));
        }
        for n in ns {
            push(base(Some(n)));
        }
    }
    for n in unmatched(notes, trades) {
        push([
            "note".into(),
            csv_cell(&n.created_at),
            csv_cell(n.symbol.as_deref().unwrap_or("")),
            String::new(),
            String::new(),
            String::new(),
            String::new(),
            csv_cell(n.trade_key.as_deref().unwrap_or("")),
            csv_cell(&n.body),
            tags_cell(&n.tags),
            csv_cell(&n.created_at),
        ]);
    }
    out
}

/// `../x`, separators, NULs, dot-files, `..` and over-long names are refused; anything else outside `[A-Za-z0-9._-]`
/// becomes `_`, and `.csv` is appended when missing.
fn clean_file_name(name: &str) -> Result<String, AppError> {
    if name.is_empty() || name.len() > MAX_FILE_NAME || name.starts_with('.') || name.contains("..") || name.contains(['/', '\\', '\0']) {
        return invalid("export file name is not valid");
    }
    let mut n: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' }).collect();
    if !n.to_ascii_lowercase().ends_with(".csv") {
        n.push_str(".csv");
    }
    Ok(n)
}

/// Writes `<dir>/<sanitised name>` with mode 0600 (dir 0700). Never overwrites and never follows an existing name
/// (`create_new`), so a planted symlink at the target is an error, not a write.
pub fn write_export(dir: &Path, name: &str, csv: &str) -> Result<PathBuf, AppError> {
    let name = clean_file_name(name)?;
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
    let mut f = opts.open(&path)?;
    f.write_all(csv.as_bytes())?;
    Ok(path)
}
