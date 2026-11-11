//! R tools storage (M18): planned risk per trade, the review-to-trade draft, helper settings and the stats join.
//! INFORMATIONAL ONLY, by the user's decision (no caps, it is their money): nothing in this module reads or changes a review,
//! a place outcome or any order tool, and nothing here can block or alter an order. Local SQLite only; no network.
//! Account numbers are never stored, only the masked form `••••1234`.
//!
//! The review-to-trade link: the realized-P&L feed has no order id, lot id or open date, so an
//! automatic link cannot be made safely. A placed draft can SUGGEST a closing trade when the match is exactly unique both ways;
//! a suggestion is data only. `promote` links a draft (or a manual entry) to a trade_key the user chose.
use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::error::AppError;
use crate::journal::clean_trade_key;
use crate::rh::orders::is_uuid;
use crate::rh::watch_writes::symbol_ok;

/// An unplaced draft (a review the user has not sent) lives one hour.
pub const DRAFT_OPEN_TTL_MS: i64 = 3_600_000;
/// After the order is placed the draft waits for the position to close: 90 days.
pub const DRAFT_PLACED_TTL_MS: i64 = 90 * 86_400_000;
pub const MAX_STATS_TRADES: usize = 5000;
const MAX_RISK_ROWS: i64 = 5000;
const MAX_USD: f64 = 1e9;
const MAX_PRICE: f64 = 1e12;
const MAX_NOTE_CHARS: usize = 500;
const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const BASES: [&str; 4] = ["equity_stop", "spread_max_loss", "stop_mult", "manual_dollars"];

fn invalid<T>(m: &str) -> Result<T, AppError> {
    Err(AppError::Invalid(m.into()))
}

// ---- settings ----

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct RiskSettings {
    pub default_risk_pct: f64,
    pub default_option_stop_mult: f64,
    pub r_fallback_enabled: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RiskSettingsIn {
    pub default_risk_pct: Option<f64>,
    pub default_option_stop_mult: Option<f64>,
    pub r_fallback_enabled: Option<bool>,
}

pub async fn settings_get(p: &SqlitePool) -> Result<RiskSettings, AppError> {
    sqlx::query("INSERT OR IGNORE INTO risk_settings (id) VALUES (1)").execute(p).await?;
    let r = sqlx::query("SELECT default_risk_pct, default_option_stop_mult, r_fallback_enabled FROM risk_settings WHERE id = 1").fetch_one(p).await?;
    Ok(RiskSettings {
        default_risk_pct: r.get("default_risk_pct"),
        default_option_stop_mult: r.get("default_option_stop_mult"),
        r_fallback_enabled: r.get::<i64, _>("r_fallback_enabled") != 0,
    })
}

pub async fn settings_set(p: &SqlitePool, s: RiskSettingsIn) -> Result<RiskSettings, AppError> {
    if let Some(v) = s.default_risk_pct {
        if !(v.is_finite() && v > 0.0 && v <= 100.0) {
            return invalid("default risk percent must be above 0 and at most 100");
        }
    }
    if let Some(v) = s.default_option_stop_mult {
        if !(v.is_finite() && v > 1.0 && v <= 50.0) {
            return invalid("option stop multiple must be above 1 and at most 50");
        }
    }
    sqlx::query("INSERT OR IGNORE INTO risk_settings (id) VALUES (1)").execute(p).await?;
    sqlx::query(
        "UPDATE risk_settings SET default_risk_pct = COALESCE(?1, default_risk_pct), \
         default_option_stop_mult = COALESCE(?2, default_option_stop_mult), r_fallback_enabled = COALESCE(?3, r_fallback_enabled) WHERE id = 1",
    )
    .bind(s.default_risk_pct)
    .bind(s.default_option_stop_mult)
    .bind(s.r_fallback_enabled.map(i64::from))
    .execute(p)
    .await?;
    settings_get(p).await
}

// ---- validation ----

/// `••••` (or `****`) followed by at most four letters/digits: the only account form this module accepts. A full number never fits.
fn masked_ok(a: &str) -> bool {
    let chars: Vec<char> = a.chars().collect();
    chars.len() >= 4
        && chars.len() <= 8
        && (chars[..4].iter().all(|c| *c == '\u{2022}') || chars[..4].iter().all(|c| *c == '*'))
        && chars[4..].iter().all(char::is_ascii_alphanumeric)
}

fn clean_masked(a: Option<&str>) -> Result<Option<String>, AppError> {
    match a.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(a) if masked_ok(a) => Ok(Some(a.to_string())),
        Some(_) => invalid("account must be the masked form (four dots then at most four characters); full account numbers are never stored"),
    }
}

fn pos_opt(name: &str, v: Option<f64>) -> Result<Option<f64>, AppError> {
    match v {
        None => Ok(None),
        Some(x) if x.is_finite() && x > 0.0 && x <= MAX_PRICE => Ok(Some(x)),
        Some(_) => Err(AppError::Invalid(format!("{name} must be a number above zero"))),
    }
}

struct Core {
    account_masked: Option<String>,
    symbol: String,
    instrument: String,
    risk_basis: String,
    planned_risk_usd: f64,
    qty: Option<f64>,
    entry_price: Option<f64>,
    stop_price: Option<f64>,
    multiplier: i64,
}

struct CoreIn<'a> {
    account_masked: Option<&'a str>,
    symbol: &'a str,
    instrument: &'a str,
    risk_basis: &'a str,
    planned_risk_usd: f64,
    qty: Option<f64>,
    entry_price: Option<f64>,
    stop_price: Option<f64>,
    multiplier: Option<i64>,
}

fn core(i: CoreIn<'_>) -> Result<Core, AppError> {
    let account_masked = clean_masked(i.account_masked)?;
    let symbol = i.symbol.trim().to_ascii_uppercase();
    if !symbol_ok(&symbol) {
        return invalid("symbol must be 1 to 10 characters: A-Z, 0-9, '.' or '-', starting with a letter");
    }
    if !["equity", "option"].contains(&i.instrument) {
        return invalid("instrument must be equity or option");
    }
    if !BASES.contains(&i.risk_basis) {
        return invalid("risk basis must be equity_stop, spread_max_loss, stop_mult or manual_dollars");
    }
    // Conventions are never mixed silently: a stock basis on an option (or the reverse) is refused.
    let fits = match i.risk_basis {
        "equity_stop" => i.instrument == "equity",
        "spread_max_loss" | "stop_mult" => i.instrument == "option",
        _ => true,
    };
    if !fits {
        return invalid("the risk basis does not fit the instrument");
    }
    if !(i.planned_risk_usd.is_finite() && i.planned_risk_usd > 0.0 && i.planned_risk_usd <= MAX_USD) {
        return invalid("planned risk must be a dollar amount above zero");
    }
    let multiplier = match i.multiplier {
        None => if i.instrument == "option" { 100 } else { 1 },
        Some(m) if (1..=1000).contains(&m) => m,
        Some(_) => return invalid("multiplier must be 1 to 1000"),
    };
    Ok(Core {
        account_masked,
        symbol,
        instrument: i.instrument.to_string(),
        risk_basis: i.risk_basis.to_string(),
        planned_risk_usd: i.planned_risk_usd,
        qty: pos_opt("quantity", i.qty)?,
        entry_price: pos_opt("entry price", i.entry_price)?,
        stop_price: pos_opt("stop price", i.stop_price)?,
        multiplier,
    })
}

fn trade_key_of(k: &str) -> Result<String, AppError> {
    clean_trade_key(Some(k))?.ok_or_else(|| AppError::Invalid("trade key is required".into()))
}

fn id_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

// ---- trade_risk ----

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TradeRisk {
    pub trade_key: String,
    pub created_at: String,
    pub updated_at: String,
    pub account_masked: Option<String>,
    pub symbol: String,
    pub instrument: String,
    pub risk_basis: String,
    pub planned_risk_usd: f64,
    pub qty: Option<f64>,
    pub entry_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub multiplier: i64,
    /// `draft` (recorded at review time, promoted by the user) or `manual`.
    pub source: String,
    /// True for a manual entry: the R was set after the trade, not before it.
    pub after_the_fact: bool,
    pub note: Option<String>,
}

const RISK_COLS: &str = "trade_key, created_at, updated_at, account_masked, symbol, instrument, risk_basis, planned_risk_usd, qty, entry_price, stop_price, multiplier, source, note";

fn to_risk(r: &sqlx::sqlite::SqliteRow) -> TradeRisk {
    let source: String = r.get("source");
    TradeRisk {
        trade_key: r.get("trade_key"),
        created_at: r.get("created_at"),
        updated_at: r.get("updated_at"),
        account_masked: r.get("account_masked"),
        symbol: r.get("symbol"),
        instrument: r.get("instrument"),
        risk_basis: r.get("risk_basis"),
        planned_risk_usd: r.get("planned_risk_usd"),
        qty: r.get("qty"),
        entry_price: r.get("entry_price"),
        stop_price: r.get("stop_price"),
        multiplier: r.get("multiplier"),
        after_the_fact: source == "manual",
        source,
        note: r.get("note"),
    }
}

async fn upsert_risk<'e, E>(e: E, key: &str, c: &Core, source: &str, note: Option<&str>) -> Result<TradeRisk, AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let sql = format!(
        "INSERT INTO trade_risk ({RISK_COLS}) VALUES (?1, {NOW}, {NOW}, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12) \
         ON CONFLICT(trade_key) DO UPDATE SET updated_at = {NOW}, account_masked = excluded.account_masked, symbol = excluded.symbol, \
         instrument = excluded.instrument, risk_basis = excluded.risk_basis, planned_risk_usd = excluded.planned_risk_usd, qty = excluded.qty, \
         entry_price = excluded.entry_price, stop_price = excluded.stop_price, multiplier = excluded.multiplier, source = excluded.source, note = excluded.note \
         RETURNING {RISK_COLS}"
    );
    let row = sqlx::query(&sql)
        .bind(key)
        .bind(&c.account_masked)
        .bind(&c.symbol)
        .bind(&c.instrument)
        .bind(&c.risk_basis)
        .bind(c.planned_risk_usd)
        .bind(c.qty)
        .bind(c.entry_price)
        .bind(c.stop_price)
        .bind(c.multiplier)
        .bind(source)
        .bind(note)
        .fetch_one(e)
        .await?;
    Ok(to_risk(&row))
}

// ---- drafts ----

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Draft {
    pub review_id: String,
    pub created_at: i64,
    pub account_masked: Option<String>,
    pub symbol: String,
    /// The ENTRY side of the reviewed order (`buy` or `sell`).
    pub side: String,
    pub instrument: String,
    pub risk_basis: String,
    pub planned_risk_usd: f64,
    pub qty: Option<f64>,
    pub entry_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub multiplier: i64,
    pub order_id: Option<String>,
    pub placed_at: Option<i64>,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct DraftFields {
    pub side: String,
    pub account_masked: Option<String>,
    pub symbol: String,
    pub instrument: String,
    pub risk_basis: String,
    pub planned_risk_usd: f64,
    pub qty: Option<f64>,
    pub entry_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub multiplier: Option<i64>,
}

/// Exactly one of `fields` (store or refresh the draft at review time) or `order_id` (the place outcome was `placed`: attach it to the
/// EXISTING live draft; a draft that expired or never existed is not recreated).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct DraftIn {
    pub review_id: String,
    pub fields: Option<DraftFields>,
    pub order_id: Option<String>,
}

const DRAFT_COLS: &str = "review_id, created_at, account_masked, symbol, side, instrument, risk_basis, planned_risk_usd, qty, entry_price, stop_price, multiplier, order_id, placed_at, expires_at";

fn to_draft(r: &sqlx::sqlite::SqliteRow) -> Draft {
    Draft {
        review_id: r.get("review_id"),
        created_at: r.get("created_at"),
        account_masked: r.get("account_masked"),
        symbol: r.get("symbol"),
        side: r.get("side"),
        instrument: r.get("instrument"),
        risk_basis: r.get("risk_basis"),
        planned_risk_usd: r.get("planned_risk_usd"),
        qty: r.get("qty"),
        entry_price: r.get("entry_price"),
        stop_price: r.get("stop_price"),
        multiplier: r.get("multiplier"),
        order_id: r.get("order_id"),
        placed_at: r.get("placed_at"),
        expires_at: r.get("expires_at"),
    }
}

async fn purge(p: &SqlitePool, now: i64) -> Result<(), AppError> {
    sqlx::query("DELETE FROM review_risk_draft WHERE expires_at < ?1").bind(now).execute(p).await?;
    Ok(())
}

async fn live_draft<'e, E>(e: E, now: i64, review_id: &str) -> Result<Option<Draft>, AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    let sql = format!("SELECT {DRAFT_COLS} FROM review_risk_draft WHERE review_id = ?1 AND expires_at >= ?2");
    Ok(sqlx::query(&sql).bind(review_id).bind(now).fetch_optional(e).await?.map(|r| to_draft(&r)))
}

async fn live_drafts(p: &SqlitePool, now: i64) -> Result<Vec<Draft>, AppError> {
    let sql = format!("SELECT {DRAFT_COLS} FROM review_risk_draft WHERE expires_at >= ?1 ORDER BY created_at DESC, review_id");
    Ok(sqlx::query(&sql).bind(now).fetch_all(p).await?.iter().map(to_draft).collect())
}

pub async fn draft_put(p: &SqlitePool, now: i64, d: DraftIn) -> Result<Draft, AppError> {
    if !is_uuid(&d.review_id) {
        return invalid("review id is not valid");
    }
    purge(p, now).await?;
    match (d.fields, d.order_id) {
        (Some(f), None) => {
            if !["buy", "sell"].contains(&f.side.as_str()) {
                return invalid("side must be buy or sell");
            }
            let c = core(CoreIn {
                account_masked: f.account_masked.as_deref(),
                symbol: &f.symbol,
                instrument: &f.instrument,
                risk_basis: &f.risk_basis,
                planned_risk_usd: f.planned_risk_usd,
                qty: f.qty,
                entry_price: f.entry_price,
                stop_price: f.stop_price,
                multiplier: f.multiplier,
            })?;
            if live_draft(p, now, &d.review_id).await?.is_some_and(|x| x.order_id.is_some()) {
                return invalid("the order for this draft was already placed");
            }
            let sql = format!(
                "INSERT OR REPLACE INTO review_risk_draft ({DRAFT_COLS}) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, NULL, NULL, ?13) RETURNING {DRAFT_COLS}"
            );
            let row = sqlx::query(&sql)
                .bind(&d.review_id)
                .bind(now)
                .bind(&c.account_masked)
                .bind(&c.symbol)
                .bind(&f.side)
                .bind(&c.instrument)
                .bind(&c.risk_basis)
                .bind(c.planned_risk_usd)
                .bind(c.qty)
                .bind(c.entry_price)
                .bind(c.stop_price)
                .bind(c.multiplier)
                .bind(now.saturating_add(DRAFT_OPEN_TTL_MS))
                .fetch_one(p)
                .await?;
            Ok(to_draft(&row))
        }
        (None, Some(order_id)) => {
            if !id_ok(&order_id) {
                return invalid("order id is not valid");
            }
            let Some(existing) = live_draft(p, now, &d.review_id).await? else {
                return Err(AppError::NotFound("no live risk draft for this review (it expired or was never saved); nothing was recorded".into()));
            };
            match existing.order_id.as_deref() {
                Some(o) if o == order_id => return Ok(existing),
                Some(_) => return invalid("a different order is already attached to this draft"),
                None => {}
            }
            let sql = format!("UPDATE review_risk_draft SET order_id = ?1, placed_at = ?2, expires_at = ?3 WHERE review_id = ?4 RETURNING {DRAFT_COLS}");
            let row = sqlx::query(&sql).bind(&order_id).bind(now).bind(now.saturating_add(DRAFT_PLACED_TTL_MS)).bind(&d.review_id).fetch_one(p).await?;
            Ok(to_draft(&row))
        }
        _ => invalid("send either the draft fields or an order id, not both and not neither"),
    }
}

// ---- promote ----

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct ManualRisk {
    pub account_masked: Option<String>,
    pub symbol: String,
    pub instrument: String,
    pub risk_basis: String,
    pub planned_risk_usd: f64,
    pub qty: Option<f64>,
    pub entry_price: Option<f64>,
    pub stop_price: Option<f64>,
    pub multiplier: Option<i64>,
    pub note: Option<String>,
}

/// Link planned risk to a journal trade. Exactly one of `review_id` (promote that placed draft) or `manual` (typed in, any time, any trade).
/// The trade key is always chosen by the user; nothing is promoted automatically.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct PromoteIn {
    pub trade_key: String,
    pub review_id: Option<String>,
    pub manual: Option<ManualRisk>,
}

pub async fn promote(p: &SqlitePool, now: i64, i: PromoteIn) -> Result<TradeRisk, AppError> {
    let key = trade_key_of(&i.trade_key)?;
    match (i.review_id, i.manual) {
        (None, Some(m)) => {
            let note = match m.note.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                None => None,
                Some(n) if n.chars().count() > MAX_NOTE_CHARS || n.chars().any(char::is_control) => return invalid("note must be one line of at most 500 characters"),
                Some(n) => Some(n.to_string()),
            };
            let c = core(CoreIn {
                account_masked: m.account_masked.as_deref(),
                symbol: &m.symbol,
                instrument: &m.instrument,
                risk_basis: &m.risk_basis,
                planned_risk_usd: m.planned_risk_usd,
                qty: m.qty,
                entry_price: m.entry_price,
                stop_price: m.stop_price,
                multiplier: m.multiplier,
            })?;
            upsert_risk(p, &key, &c, "manual", note.as_deref()).await
        }
        (Some(rv), None) => {
            if !is_uuid(&rv) {
                return invalid("review id is not valid");
            }
            purge(p, now).await?;
            let mut tx = p.begin().await?;
            let Some(d) = live_draft(&mut *tx, now, &rv).await? else {
                return Err(AppError::NotFound("no live risk draft for this review (it expired or was never saved)".into()));
            };
            if d.order_id.is_none() {
                return invalid("this draft's order was not placed, so there is no trade to link it to");
            }
            let c = core(CoreIn {
                account_masked: d.account_masked.as_deref(),
                symbol: &d.symbol,
                instrument: &d.instrument,
                risk_basis: &d.risk_basis,
                planned_risk_usd: d.planned_risk_usd,
                qty: d.qty,
                entry_price: d.entry_price,
                stop_price: d.stop_price,
                multiplier: Some(d.multiplier),
            })?;
            let r = upsert_risk(&mut *tx, &key, &c, "draft", None).await?;
            sqlx::query("DELETE FROM review_risk_draft WHERE review_id = ?1").bind(&rv).execute(&mut *tx).await?;
            tx.commit().await?;
            Ok(r)
        }
        _ => invalid("promote either a review draft or a manual entry, not both and not neither"),
    }
}

// ---- state + stats ----

#[derive(Debug, Clone, Serialize)]
pub struct RiskState {
    pub settings: RiskSettings,
    pub risk: Vec<TradeRisk>,
    pub drafts: Vec<Draft>,
}

pub async fn get_state(p: &SqlitePool, now: i64) -> Result<RiskState, AppError> {
    purge(p, now).await?;
    let settings = settings_get(p).await?;
    let sql = format!("SELECT {RISK_COLS} FROM trade_risk ORDER BY updated_at DESC, trade_key LIMIT ?1");
    let risk = sqlx::query(&sql).bind(MAX_RISK_ROWS).fetch_all(p).await?.iter().map(to_risk).collect();
    Ok(RiskState { settings, risk, drafts: live_drafts(p, now).await? })
}

/// One row of the trade list the webview already holds (from `rh_pnl_trades`). Nothing here is stored.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct RiskTradeIn {
    pub trade_key: String,
    pub symbol: String,
    pub side: Option<String>,
    pub quantity: Option<f64>,
    pub realized_gain: Option<f64>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct StatRow {
    pub trade_key: String,
    pub symbol: String,
    pub planned_risk_usd: f64,
    pub risk_basis: String,
    pub source: String,
    pub realized_gain: Option<f64>,
    pub closed_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Suggestion {
    pub review_id: String,
    pub trade_key: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RiskStatsOut {
    /// Trades (of the list sent) that have a recorded risk. The TS stats lib turns these into R.
    pub rows: Vec<StatRow>,
    /// M in "N of M trades have R".
    pub trades_total: usize,
    /// N in "N of M trades have R".
    pub with_risk: usize,
    /// Placed drafts that match exactly one of the unlinked trades and vice versa. DATA ONLY: nothing is linked until `risk_promote`.
    pub suggestions: Vec<Suggestion>,
}

pub async fn stats(p: &SqlitePool, now: i64, account_masked: Option<&str>, trades: &[RiskTradeIn]) -> Result<RiskStatsOut, AppError> {
    if trades.len() > MAX_STATS_TRADES {
        return invalid("at most 5000 trades per call");
    }
    let account = clean_masked(account_masked)?;
    let mut keys: Vec<String> = Vec::with_capacity(trades.len());
    for t in trades {
        keys.push(trade_key_of(&t.trade_key)?);
    }
    purge(p, now).await?;
    let sql = format!("SELECT {RISK_COLS} FROM trade_risk LIMIT 20000");
    let known: HashMap<String, TradeRisk> = sqlx::query(&sql).fetch_all(p).await?.iter().map(to_risk).map(|r| (r.trade_key.clone(), r)).collect();
    let mut rows = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut unlinked: Vec<RiskTradeIn> = Vec::new();
    for (t, k) in trades.iter().zip(&keys) {
        if !seen.insert(k.as_str()) {
            continue;
        }
        match known.get(k) {
            Some(r) => rows.push(StatRow {
                trade_key: k.clone(),
                symbol: r.symbol.clone(),
                planned_risk_usd: r.planned_risk_usd,
                risk_basis: r.risk_basis.clone(),
                source: r.source.clone(),
                realized_gain: t.realized_gain.filter(|g| g.is_finite()),
                closed_at: t.timestamp.clone(),
            }),
            None => unlinked.push(t.clone()),
        }
    }
    let suggestions = match &account {
        Some(a) => suggest(&live_drafts(p, now).await?, &unlinked, a),
        None => Vec::new(),
    };
    Ok(RiskStatsOut { with_risk: rows.len(), rows, trades_total: trades.len(), suggestions })
}

// ---- the suggestion rule (pure) ----

fn same_qty(a: f64, b: f64) -> bool {
    a.is_finite() && b.is_finite() && (a - b).abs() <= 1e-9 * a.abs().max(1.0)
}

fn opposite(entry: &str, close: &str) -> bool {
    matches!((entry, close.to_ascii_lowercase().as_str()), ("buy", "sell") | ("sell", "buy"))
}

/// A trade is a candidate close of a placed draft when: same account mask, same symbol, the opposite side, the SAME quantity (a partial
/// or larger close never matches), and a parseable close time from the moment the order was placed to 90 days later (both edges inclusive).
fn candidate(d: &Draft, account: &str, t: &RiskTradeIn) -> bool {
    let (Some(placed), Some(dq), Some(tq), Some(side), Some(ts)) = (d.placed_at, d.qty, t.quantity, t.side.as_deref(), t.timestamp.as_deref().and_then(parse_iso_ms)) else {
        return false;
    };
    d.order_id.is_some()
        && d.account_masked.as_deref() == Some(account)
        && d.symbol.eq_ignore_ascii_case(t.symbol.trim())
        && opposite(&d.side, side)
        && same_qty(dq, tq)
        && ts >= placed
        && ts <= placed.saturating_add(DRAFT_PLACED_TTL_MS)
}

/// Only exact one-to-one matches: the draft has exactly one candidate close AND that close has exactly one candidate draft.
/// Everything ambiguous is left alone (never guess). This is still only a suggestion: the real link is `promote`.
pub fn suggest(drafts: &[Draft], trades: &[RiskTradeIn], account: &str) -> Vec<Suggestion> {
    let mut out = Vec::new();
    for d in drafts {
        let hits: Vec<&RiskTradeIn> = trades.iter().filter(|t| candidate(d, account, t)).collect();
        let [t] = hits.as_slice() else { continue };
        if drafts.iter().filter(|o| candidate(o, account, t)).count() == 1 {
            out.push(Suggestion { review_id: d.review_id.clone(), trade_key: t.trade_key.clone() });
        }
    }
    out
}

// ---- time ----

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn month_days(y: i64, m: i64) -> i64 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if (y % 4 == 0 && y % 100 != 0) || y % 400 == 0 => 29,
        _ => 28,
    }
}

/// `YYYY-MM-DDTHH:MM:SS[.fff](Z|+HH:MM|-HH:MM)` to epoch milliseconds. Anything else (no zone, a space instead of T, an impossible date) is
/// `None`, and a trade without a readable time is never matched.
pub fn parse_iso_ms(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |a: usize, n: usize| -> Option<i64> {
        let part = b.get(a..a + n)?;
        part.iter().all(u8::is_ascii_digit).then(|| part.iter().fold(0i64, |v, c| v * 10 + i64::from(c - b'0')))
    };
    if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let (y, mo, d, h, mi, sec) = (num(0, 4)?, num(5, 2)?, num(8, 2)?, num(11, 2)?, num(14, 2)?, num(17, 2)?);
    if !(1..=12).contains(&mo) || d < 1 || d > month_days(y, mo) || h > 23 || mi > 59 || sec > 59 {
        return None;
    }
    let mut i = 19;
    let mut ms = 0i64;
    if b.get(i) == Some(&b'.') {
        let start = i + 1;
        i = start;
        while b.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return None;
        }
        let digits: Vec<i64> = b[start..i].iter().take(3).map(|c| i64::from(c - b'0')).collect();
        ms = (0..3).map(|k| digits.get(k).copied().unwrap_or(0)).fold(0, |v, x| v * 10 + x);
    }
    let offset_min = match b.get(i..) {
        Some(b"Z") => 0,
        Some(z) if z.len() == 6 && (z[0] == b'+' || z[0] == b'-') && z[3] == b':' => {
            let (oh, om) = (num(i + 1, 2)?, num(i + 4, 2)?);
            if oh > 23 || om > 59 {
                return None;
            }
            let v = oh * 60 + om;
            if z[0] == b'+' { v } else { -v }
        }
        _ => return None,
    };
    let secs = days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + sec - offset_min * 60;
    Some(secs * 1000 + ms)
}
