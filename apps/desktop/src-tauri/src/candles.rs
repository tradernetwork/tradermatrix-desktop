//! Candle and snapshot storage (M11): every candle the chart sees, plus sampled snapshots, in the local SQLite file.
//! No network, no tool names, no raw SQL from the webview: the commands take typed rows, every identifier is checked
//! against a strict character set and every statement is parameterised. Nothing secret belongs here (no account numbers,
//! tokens or keys); the callers only pass market data. There is no retention policy yet (rows are never deleted).
use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::error::AppError;

pub const MAX_BATCH: usize = 5000;
pub const MAX_LOAD: u32 = 20_000;
pub const MAX_SNAPSHOT_JSON: usize = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CandleIn {
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CandleRow {
    pub ts: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
pub struct CandleStats {
    pub candles: i64,
    pub snapshots: i64,
    pub db_bytes: i64,
}

/// Milliseconds since the Unix epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// 2000-01-01 UTC in ms: nothing the chart can show is older.
const MIN_TS: i64 = 946_684_800_000;
const FUTURE_SLACK_MS: i64 = 86_400_000;

fn invalid<T>(m: &str) -> Result<T, AppError> {
    Err(AppError::Invalid(m.into()))
}

fn all_of(s: &str, max: usize, first: impl Fn(char) -> bool, rest: impl Fn(char) -> bool) -> bool {
    let mut it = s.chars();
    match it.next() {
        Some(c) if s.len() <= max && first(c) => it.all(rest),
        _ => false,
    }
}

/// `[a-z][a-z0-9_]{0,23}`
fn name_ok(s: &str) -> bool {
    all_of(s, 24, |c| c.is_ascii_lowercase(), |c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}
/// Equity symbol (`BRK.B`) or an option contract uuid: `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`
fn instrument_ok(s: &str) -> bool {
    all_of(s, 64, |c| c.is_ascii_alphanumeric(), |c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}
/// Timeframe id or Robinhood interval: `[A-Za-z0-9]{1,12}`
fn interval_ok(s: &str) -> bool {
    all_of(s, 12, |c| c.is_ascii_alphanumeric(), |c| c.is_ascii_alphanumeric())
}
/// Snapshot key: `[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`
fn key_ok(s: &str) -> bool {
    all_of(s, 64, |c| c.is_ascii_alphanumeric(), |c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn check_series(source: &str, instrument: &str, interval: &str) -> Result<(), AppError> {
    if !name_ok(source) {
        return invalid("source must be 1 to 24 characters: a-z, 0-9, '_', starting with a letter");
    }
    if !instrument_ok(instrument) {
        return invalid("instrument must be 1 to 64 characters: A-Z, a-z, 0-9, '.', '_' or '-'");
    }
    if !interval_ok(interval) {
        return invalid("interval must be 1 to 12 letters or digits");
    }
    Ok(())
}

fn check_row(b: &CandleIn, max_ts: i64) -> Result<(), AppError> {
    let prices = [b.open, b.high, b.low, b.close];
    if !prices.iter().all(|v| v.is_finite() && *v >= 0.0) || !b.volume.is_finite() || b.volume < 0.0 {
        return invalid("candle values must be finite and not negative");
    }
    if b.high < b.low {
        return invalid("candle high is below its low");
    }
    if b.ts < MIN_TS || b.ts > max_ts {
        return invalid("candle timestamp is out of range");
    }
    Ok(())
}

/// Validates the WHOLE batch, then writes it in one transaction (a bad row stores nothing). Upsert: a row is
/// replaced only by data fetched LATER (strictly greater `fetched_at`), so the still-forming bar updates and an old
/// response never overwrites a newer one. Returns the number of rows submitted.
pub async fn store_candles(p: &SqlitePool, source: &str, instrument: &str, interval: &str, bars: &[CandleIn], fetched_at: i64) -> Result<usize, AppError> {
    check_series(source, instrument, interval)?;
    if bars.len() > MAX_BATCH {
        return invalid("at most 5000 candles per call");
    }
    let max_ts = now_ms() + FUTURE_SLACK_MS;
    for b in bars {
        check_row(b, max_ts)?;
    }
    if bars.is_empty() {
        return Ok(0);
    }
    let mut tx = p.begin().await?;
    for b in bars {
        sqlx::query(
            "INSERT INTO candles (source, instrument, interval, ts, open, high, low, close, volume, fetched_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10) \
             ON CONFLICT(source, instrument, interval, ts) DO UPDATE SET \
               open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close, \
               volume = excluded.volume, fetched_at = excluded.fetched_at \
             WHERE excluded.fetched_at > candles.fetched_at",
        )
        .bind(source)
        .bind(instrument)
        .bind(interval)
        .bind(b.ts)
        .bind(b.open)
        .bind(b.high)
        .bind(b.low)
        .bind(b.close)
        .bind(b.volume)
        .bind(fetched_at)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(bars.len())
}

/// Candles with `from <= ts <= to` (ms, inclusive), oldest first. When more than `limit` match, the NEWEST `limit` are kept.
pub async fn load_candles(p: &SqlitePool, source: &str, instrument: &str, interval: &str, from: i64, to: i64, limit: u32) -> Result<Vec<CandleRow>, AppError> {
    check_series(source, instrument, interval)?;
    if limit == 0 || limit > MAX_LOAD {
        return invalid("limit must be 1 to 20000");
    }
    if from > to {
        return invalid("from is after to");
    }
    let rows = sqlx::query(
        "SELECT ts, open, high, low, close, volume FROM candles \
         WHERE source = ?1 AND instrument = ?2 AND interval = ?3 AND ts >= ?4 AND ts <= ?5 \
         ORDER BY ts DESC LIMIT ?6",
    )
    .bind(source)
    .bind(instrument)
    .bind(interval)
    .bind(from)
    .bind(to)
    .bind(i64::from(limit))
    .fetch_all(p)
    .await?;
    let mut out: Vec<CandleRow> = rows
        .iter()
        .map(|r| CandleRow { ts: r.get("ts"), open: r.get("open"), high: r.get("high"), low: r.get("low"), close: r.get("close"), volume: r.get("volume") })
        .collect();
    out.reverse();
    Ok(out)
}

/// One snapshot row (a quote, a TraderMatrix response). `json` must be valid JSON of at most 16 KB.
pub async fn store_snapshot(p: &SqlitePool, kind: &str, key: &str, json: &str, ts: i64) -> Result<(), AppError> {
    if !name_ok(kind) {
        return invalid("kind must be 1 to 24 characters: a-z, 0-9, '_', starting with a letter");
    }
    if !key_ok(key) {
        return invalid("key must be 1 to 64 characters: A-Z, a-z, 0-9, '.', '_', ':' or '-'");
    }
    if ts < 0 {
        return invalid("timestamp is negative");
    }
    if json.len() > MAX_SNAPSHOT_JSON {
        return invalid("snapshot is larger than 16 KB");
    }
    if serde_json::from_str::<serde_json::Value>(json).is_err() {
        return invalid("snapshot is not valid JSON");
    }
    sqlx::query(
        "INSERT INTO snapshots (kind, key, ts, json) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(kind, key, ts) DO UPDATE SET json = excluded.json",
    )
    .bind(kind)
    .bind(key)
    .bind(ts)
    .bind(json)
    .execute(p)
    .await?;
    Ok(())
}

/// Row counts and the database file size (page_count x page_size) for the chart's small readout.
pub async fn stats(p: &SqlitePool) -> Result<CandleStats, AppError> {
    let r = sqlx::query(
        "SELECT (SELECT COUNT(*) FROM candles) AS c, (SELECT COUNT(*) FROM snapshots) AS s, \
                (SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()) AS b",
    )
    .fetch_one(p)
    .await?;
    Ok(CandleStats { candles: r.get("c"), snapshots: r.get("s"), db_bytes: r.get("b") })
}

#[cfg(test)]
mod tests;
