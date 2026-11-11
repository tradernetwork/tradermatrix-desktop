//! Chart alerts in the local SQLite file (M17). INFORM ONLY: nothing here places, reviews, cancels or fills an order, calls the network or
//! touches a secret. Rows hold no account number, no key and no digest body. Times are UTC epoch milliseconds.
//! `fire` is the ONE place an event is written: a single guarded UPDATE decides (enabled, armed, not snoozed, not expired, cooldown over), so two
//! panes or two polls firing the same alert in the same instant produce exactly one event.
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

use crate::error::AppError;

pub const MAX_ALERTS: i64 = 200;
pub const MAX_EVENTS: i64 = 1000;
pub const MAX_EVENTS_LIST: u32 = 1000;
pub const MAX_ACK_IDS: usize = 500;
const MAX_REF_PARAM: usize = 256;
const DEFAULT_COOLDOWN_S: i64 = 300;
const DEFAULT_HYSTERESIS_PCT: f64 = 0.05;

const KINDS: [&str; 6] = ["price", "verdict", "pnl", "iv", "earnings", "order"];
const REF_KINDS: [&str; 12] = ["price", "apex", "flip", "em_hi", "em_lo", "fib", "atr", "sma", "pnl", "verdict", "iv", "order"];
const DIRS: [&str; 3] = ["up", "down", "either"];
const MODES: [&str; 2] = ["cross", "touch"];
const REPEATS: [&str; 2] = ["once", "rearm"];

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct NewAlert {
    pub symbol: String,
    pub kind: String,
    pub ref_kind: String,
    #[serde(default)]
    pub ref_param: Option<String>,
    pub price: f64,
    pub dir: String,
    #[serde(default)]
    pub tf: Option<String>,
    pub mode: String,
    pub repeat: String,
    #[serde(default)]
    pub cooldown_s: Option<i64>,
    #[serde(default)]
    pub hysteresis_pct: Option<f64>,
    #[serde(default)]
    pub expires_at: Option<i64>,
    #[serde(default)]
    pub extended_hours: bool,
    #[serde(default)]
    pub last_side: Option<i64>,
}

/// Every field optional. `snooze_until` of 0 means "not snoozed". `observe_px` is the latest price: a disarmed `rearm` alert re-arms when it has
/// retreated `hysteresis_pct` from the level (and its side is reset to the side the price is on). `last_side` is how a drag resets the side.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct AlertPatch {
    pub price: Option<f64>,
    pub dir: Option<String>,
    pub mode: Option<String>,
    pub cooldown_s: Option<i64>,
    pub hysteresis_pct: Option<f64>,
    pub expires_at: Option<i64>,
    pub snooze_until: Option<i64>,
    pub enabled: Option<bool>,
    pub extended_hours: Option<bool>,
    pub last_side: Option<i64>,
    pub armed: Option<bool>,
    pub observe_px: Option<f64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Alert {
    pub id: i64,
    pub symbol: String,
    pub kind: String,
    pub ref_kind: String,
    pub ref_param: Option<String>,
    pub price: f64,
    pub dir: String,
    pub tf: Option<String>,
    pub mode: String,
    pub repeat: String,
    pub cooldown_s: i64,
    pub hysteresis_pct: f64,
    pub expires_at: Option<i64>,
    pub snooze_until: Option<i64>,
    pub enabled: bool,
    pub extended_hours: bool,
    pub last_side: Option<i64>,
    pub armed: bool,
    pub last_fired_at: Option<i64>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct AlertEvent {
    pub id: i64,
    pub alert_id: i64,
    pub fired_at: i64,
    pub symbol: String,
    pub label: String,
    pub trigger_px: f64,
    pub ref_px: f64,
    pub quote_age_s: f64,
    pub kind: String,
    pub seen: bool,
    pub missed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum FireOutcome {
    Fired { event: AlertEvent },
    /// `reason`: missing, disabled, disarmed, snoozed, expired or cooldown.
    Skipped { reason: String },
}

fn invalid<T>(m: &str) -> Result<T, AppError> {
    Err(AppError::Invalid(m.into()))
}

fn clean_symbol(s: &str) -> Result<String, AppError> {
    if s.is_empty() || s.len() > 12 || !s.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-') {
        return invalid("symbol must be 1 to 12 characters: A-Z, 0-9, '.' or '-'");
    }
    Ok(s.to_ascii_uppercase())
}

fn one_of(v: &str, set: &[&str], what: &str) -> Result<(), AppError> {
    if set.contains(&v) {
        Ok(())
    } else {
        invalid(&format!("bad {what}"))
    }
}

fn check_price(p: f64) -> Result<(), AppError> {
    if p.is_finite() && p > 0.0 && p < 1e9 {
        Ok(())
    } else {
        invalid("price must be a finite number above 0")
    }
}

fn check_cooldown(c: i64) -> Result<(), AppError> {
    if (0..=86_400).contains(&c) {
        Ok(())
    } else {
        invalid("cooldown must be 0 to 86400 seconds")
    }
}

fn check_hysteresis(h: f64) -> Result<(), AppError> {
    if h.is_finite() && (0.0..=5.0).contains(&h) {
        Ok(())
    } else {
        invalid("hysteresis must be 0 to 5 percent")
    }
}

fn check_side(s: i64) -> Result<(), AppError> {
    if (-1..=1).contains(&s) {
        Ok(())
    } else {
        invalid("side must be -1, 0 or 1")
    }
}

fn check_ts(t: i64) -> Result<(), AppError> {
    if (0..=4_102_444_800_000).contains(&t) {
        Ok(())
    } else {
        invalid("time out of range")
    }
}

fn check_ref_param(kind: &str, p: &Option<String>) -> Result<(), AppError> {
    if let Some(p) = p {
        if kind == "price" {
            return invalid("a manual price alert has no reference parameter");
        }
        if p.is_empty() || p.len() > MAX_REF_PARAM || p.chars().any(|c| c.is_control()) {
            return invalid("reference parameter must be 1 to 256 characters without control characters");
        }
    }
    Ok(())
}

fn check_tf(tf: &Option<String>) -> Result<(), AppError> {
    if let Some(t) = tf {
        if t.is_empty() || t.len() > 8 || !t.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return invalid("bad timeframe");
        }
    }
    Ok(())
}

fn alert_of(r: &SqliteRow) -> Alert {
    Alert {
        id: r.get("id"),
        symbol: r.get("symbol"),
        kind: r.get("kind"),
        ref_kind: r.get("ref_kind"),
        ref_param: r.get("ref_param"),
        price: r.get("price"),
        dir: r.get("dir"),
        tf: r.get("tf"),
        mode: r.get("mode"),
        repeat: r.get("repeat"),
        cooldown_s: r.get("cooldown_s"),
        hysteresis_pct: r.get("hysteresis_pct"),
        expires_at: r.get("expires_at"),
        snooze_until: r.get("snooze_until"),
        enabled: r.get::<i64, _>("enabled") != 0,
        extended_hours: r.get::<i64, _>("extended_hours") != 0,
        last_side: r.get("last_side"),
        armed: r.get::<i64, _>("armed") != 0,
        last_fired_at: r.get("last_fired_at"),
        created_at: r.get("created_at"),
    }
}

fn event_of(r: &SqliteRow) -> AlertEvent {
    AlertEvent {
        id: r.get("id"),
        alert_id: r.get("alert_id"),
        fired_at: r.get("fired_at"),
        symbol: r.get("symbol"),
        label: r.get("label"),
        trigger_px: r.get("trigger_px"),
        ref_px: r.get("ref_px"),
        quote_age_s: r.get("quote_age_s"),
        kind: r.get("kind"),
        seen: r.get::<i64, _>("seen") != 0,
        missed: r.get::<i64, _>("missed") != 0,
    }
}

const ALERT_COLS: &str = "id, symbol, kind, ref_kind, ref_param, price, dir, tf, mode, \"repeat\" AS \"repeat\", cooldown_s, hysteresis_pct, expires_at, snooze_until, enabled, extended_hours, last_side, armed, last_fired_at, created_at";

async fn get(p: &SqlitePool, id: i64) -> Result<Option<Alert>, AppError> {
    let row = sqlx::query(&format!("SELECT {ALERT_COLS} FROM alerts WHERE id = ?1")).bind(id).fetch_optional(p).await?;
    Ok(row.as_ref().map(alert_of))
}

pub async fn list(p: &SqlitePool) -> Result<Vec<Alert>, AppError> {
    let rows = sqlx::query(&format!("SELECT {ALERT_COLS} FROM alerts ORDER BY id")).fetch_all(p).await?;
    Ok(rows.iter().map(alert_of).collect())
}

pub async fn create(p: &SqlitePool, now_ms: i64, n: NewAlert) -> Result<Alert, AppError> {
    let symbol = clean_symbol(&n.symbol)?;
    one_of(&n.kind, &KINDS, "kind")?;
    one_of(&n.ref_kind, &REF_KINDS, "reference kind")?;
    one_of(&n.dir, &DIRS, "direction")?;
    one_of(&n.mode, &MODES, "mode")?;
    one_of(&n.repeat, &REPEATS, "repeat")?;
    check_price(n.price)?;
    let cooldown = n.cooldown_s.unwrap_or(DEFAULT_COOLDOWN_S);
    check_cooldown(cooldown)?;
    let hyst = n.hysteresis_pct.unwrap_or(DEFAULT_HYSTERESIS_PCT);
    check_hysteresis(hyst)?;
    check_ref_param(&n.ref_kind, &n.ref_param)?;
    check_tf(&n.tf)?;
    if let Some(s) = n.last_side {
        check_side(s)?;
    }
    if let Some(t) = n.expires_at {
        check_ts(t)?;
    }
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM alerts").fetch_one(p).await?;
    if count >= MAX_ALERTS {
        return invalid("too many alerts (200 at most)");
    }
    let id: i64 = sqlx::query(
        "INSERT INTO alerts (symbol, kind, ref_kind, ref_param, price, dir, tf, mode, \"repeat\", cooldown_s, hysteresis_pct, expires_at, extended_hours, last_side, created_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15) RETURNING id",
    )
    .bind(&symbol)
    .bind(&n.kind)
    .bind(&n.ref_kind)
    .bind(&n.ref_param)
    .bind(n.price)
    .bind(&n.dir)
    .bind(&n.tf)
    .bind(&n.mode)
    .bind(&n.repeat)
    .bind(cooldown)
    .bind(hyst)
    .bind(n.expires_at)
    .bind(i64::from(n.extended_hours))
    .bind(n.last_side)
    .bind(now_ms)
    .fetch_one(p)
    .await?
    .get("id");
    get(p, id).await?.ok_or_else(|| AppError::NotFound("alert".into()))
}

fn sign_of(px: f64, level: f64) -> i64 {
    if px > level {
        1
    } else if px < level {
        -1
    } else {
        0
    }
}

/// A fired `rearm` alert re-arms once the price is `hysteresis_pct` percent away from the level on the opposite side to the one it fired on.
fn retreated(a: &Alert, px: f64) -> bool {
    let band = a.price * a.hysteresis_pct / 100.0;
    match a.last_side {
        Some(1) => px <= a.price - band,
        Some(-1) => px >= a.price + band,
        _ => false,
    }
}

pub async fn update(p: &SqlitePool, _now_ms: i64, id: i64, patch: AlertPatch) -> Result<Alert, AppError> {
    if let Some(d) = &patch.dir {
        one_of(d, &DIRS, "direction")?;
    }
    if let Some(m) = &patch.mode {
        one_of(m, &MODES, "mode")?;
    }
    if let Some(x) = patch.price {
        check_price(x)?;
    }
    if let Some(c) = patch.cooldown_s {
        check_cooldown(c)?;
    }
    if let Some(h) = patch.hysteresis_pct {
        check_hysteresis(h)?;
    }
    if let Some(s) = patch.last_side {
        check_side(s)?;
    }
    for t in [patch.expires_at, patch.snooze_until].into_iter().flatten() {
        check_ts(t)?;
    }
    if let Some(x) = patch.observe_px {
        if !x.is_finite() || x <= 0.0 {
            return invalid("observed price must be a finite number above 0");
        }
    }
    let mut tx = p.begin().await?;
    // the first statement is a write, so the transaction takes the write lock before anything is read
    let touched = sqlx::query(
        "UPDATE alerts SET price = COALESCE(?2, price), dir = COALESCE(?3, dir), mode = COALESCE(?4, mode), cooldown_s = COALESCE(?5, cooldown_s), \
         hysteresis_pct = COALESCE(?6, hysteresis_pct), expires_at = COALESCE(?7, expires_at), snooze_until = COALESCE(?8, snooze_until), \
         enabled = COALESCE(?9, enabled), extended_hours = COALESCE(?10, extended_hours), last_side = COALESCE(?11, last_side), armed = COALESCE(?12, armed) \
         WHERE id = ?1",
    )
    .bind(id)
    .bind(patch.price)
    .bind(&patch.dir)
    .bind(&patch.mode)
    .bind(patch.cooldown_s)
    .bind(patch.hysteresis_pct)
    .bind(patch.expires_at)
    .bind(patch.snooze_until)
    .bind(patch.enabled.map(i64::from))
    .bind(patch.extended_hours.map(i64::from))
    .bind(patch.last_side)
    .bind(patch.armed.map(i64::from))
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if touched == 0 {
        return Err(AppError::NotFound("alert".into()));
    }
    if let Some(px) = patch.observe_px {
        let row = sqlx::query(&format!("SELECT {ALERT_COLS} FROM alerts WHERE id = ?1")).bind(id).fetch_one(&mut *tx).await?;
        let a = alert_of(&row);
        if a.repeat == "rearm" && a.enabled && !a.armed && retreated(&a, px) {
            sqlx::query("UPDATE alerts SET armed = 1, last_side = ?2 WHERE id = ?1").bind(id).bind(sign_of(px, a.price)).execute(&mut *tx).await?;
        }
    }
    tx.commit().await?;
    get(p, id).await?.ok_or_else(|| AppError::NotFound("alert".into()))
}

/// Deleting an alert keeps the events it already produced.
pub async fn delete(p: &SqlitePool, id: i64) -> Result<(), AppError> {
    let n = sqlx::query("DELETE FROM alerts WHERE id = ?1").bind(id).execute(p).await?.rows_affected();
    if n == 0 {
        return Err(AppError::NotFound("alert".into()));
    }
    Ok(())
}

fn label_of(a: &Alert, side: i64) -> String {
    let way = match side {
        1 => "above",
        -1 => "below",
        _ => "at",
    };
    format!("{} {} {:.2}", a.symbol, way, a.price)
}

const EVENT_KINDS: [&str; 3] = ["fire", "missed", "level_gone"];
const MAX_LABEL: usize = 160;
/// A referenced level that vanished snoozes its alert for this long (the user can clear the snooze any time).
const LEVEL_GONE_SNOOZE_MS: i64 = 24 * 3_600_000;

/// What the caller may add to a fire: an event kind (`fire` default, `missed` for the app-closed pass, `level_gone` for a vanished reference),
/// a label for non-price alerts (verdict, P&L, IV rank, earnings, order state), and the missed flag. Plain data, no order or account content.
#[derive(Debug, Clone, Default)]
pub struct FireExtra {
    pub kind: Option<String>,
    pub label: Option<String>,
    pub missed: bool,
}

fn check_label(l: &str) -> Result<(), AppError> {
    if l.is_empty() || l.chars().count() > MAX_LABEL || l.chars().any(|c| c.is_control()) {
        return invalid("label must be 1 to 160 characters without control characters");
    }
    Ok(())
}

pub async fn fire(p: &SqlitePool, now_ms: i64, id: i64, side: i64, px: f64, quote_age_s: f64) -> Result<FireOutcome, AppError> {
    fire_ex(p, now_ms, id, side, px, quote_age_s, FireExtra::default()).await
}

/// The single-fire guard. One UPDATE flips the alert's state only when it may fire right now; the event is written only if that row changed.
/// `once` alerts disable themselves; `rearm` alerts disarm until the price retreats (see `update` with `observe_px`). A skipped call still
/// records `side`, so a crossing that was held back by the cooldown is never fired late for a flip that is long over.
/// `kind = level_gone` is not a fire: it snoozes the alert for 24 h (guarded, so exactly one event) and leaves the fire state alone.
pub async fn fire_ex(p: &SqlitePool, now_ms: i64, id: i64, side: i64, px: f64, quote_age_s: f64, extra: FireExtra) -> Result<FireOutcome, AppError> {
    check_side(side)?;
    if !px.is_finite() || px <= 0.0 {
        return invalid("trigger price must be a finite number above 0");
    }
    if !quote_age_s.is_finite() || quote_age_s < 0.0 {
        return invalid("quote age must be a finite number of seconds, 0 or more");
    }
    let kind = extra.kind.as_deref().unwrap_or("fire");
    one_of(kind, &EVENT_KINDS, "event kind")?;
    if let Some(l) = &extra.label {
        check_label(l)?;
    }
    let missed = extra.missed || kind == "missed";
    let mut tx = p.begin().await?;
    let changed = if kind == "level_gone" {
        sqlx::query("UPDATE alerts SET snooze_until = ?2 + ?3 WHERE id = ?1 AND enabled = 1 AND (snooze_until IS NULL OR snooze_until <= ?2)")
            .bind(id)
            .bind(now_ms)
            .bind(LEVEL_GONE_SNOOZE_MS)
            .execute(&mut *tx)
            .await?
            .rows_affected()
    } else {
        sqlx::query(
            "UPDATE alerts SET last_fired_at = ?2, last_side = ?3, \
               enabled = CASE WHEN \"repeat\" = 'once' THEN 0 ELSE enabled END, \
               armed = CASE WHEN \"repeat\" = 'rearm' THEN 0 ELSE armed END \
             WHERE id = ?1 AND enabled = 1 AND armed = 1 \
               AND (snooze_until IS NULL OR snooze_until <= ?2) \
               AND (expires_at IS NULL OR expires_at > ?2) \
               AND (last_fired_at IS NULL OR last_fired_at <= ?2 - cooldown_s * 1000)",
        )
        .bind(id)
        .bind(now_ms)
        .bind(side)
        .execute(&mut *tx)
        .await?
        .rows_affected()
    };
    let row = sqlx::query(&format!("SELECT {ALERT_COLS} FROM alerts WHERE id = ?1")).bind(id).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        tx.commit().await?;
        return Ok(FireOutcome::Skipped { reason: "missing".into() });
    };
    let a = alert_of(&row);
    if changed == 0 {
        if kind != "level_gone" {
            sqlx::query("UPDATE alerts SET last_side = ?2 WHERE id = ?1").bind(id).bind(side).execute(&mut *tx).await?;
        }
        tx.commit().await?;
        let reason = if !a.enabled {
            "disabled"
        } else if !a.armed && kind != "level_gone" {
            "disarmed"
        } else if a.snooze_until.is_some_and(|s| s > now_ms) {
            "snoozed"
        } else if a.expires_at.is_some_and(|e| e <= now_ms) {
            "expired"
        } else {
            "cooldown"
        };
        return Ok(FireOutcome::Skipped { reason: reason.into() });
    }
    let label = extra.label.clone().unwrap_or_else(|| label_of(&a, side));
    let eid: i64 = sqlx::query(
        "INSERT INTO alert_events (alert_id, fired_at, symbol, label, trigger_px, ref_px, quote_age_s, kind, seen, missed) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9) RETURNING id",
    )
    .bind(id)
    .bind(now_ms)
    .bind(&a.symbol)
    .bind(&label)
    .bind(px)
    .bind(a.price)
    .bind(quote_age_s)
    .bind(kind)
    .bind(i64::from(missed))
    .fetch_one(&mut *tx)
    .await?
    .get("id");
    // the history is capped: the oldest go first
    sqlx::query("DELETE FROM alert_events WHERE id NOT IN (SELECT id FROM alert_events ORDER BY id DESC LIMIT ?1)").bind(MAX_EVENTS).execute(&mut *tx).await?;
    let ev = event_of(&sqlx::query("SELECT * FROM alert_events WHERE id = ?1").bind(eid).fetch_one(&mut *tx).await?);
    tx.commit().await?;
    Ok(FireOutcome::Fired { event: ev })
}

/// Newest first. `limit` is capped at 1000.
pub async fn events(p: &SqlitePool, limit: Option<u32>, unseen_only: bool) -> Result<Vec<AlertEvent>, AppError> {
    let limit = i64::from(limit.unwrap_or(200).clamp(1, MAX_EVENTS_LIST));
    let rows = sqlx::query("SELECT * FROM alert_events WHERE (?1 = 0 OR seen = 0) ORDER BY fired_at DESC, id DESC LIMIT ?2")
        .bind(i64::from(unseen_only))
        .bind(limit)
        .fetch_all(p)
        .await?;
    Ok(rows.iter().map(event_of).collect())
}

/// Marks events seen (`None` = every unseen event). Returns how many changed.
pub async fn ack(p: &SqlitePool, ids: Option<Vec<i64>>) -> Result<u64, AppError> {
    match ids {
        None => Ok(sqlx::query("UPDATE alert_events SET seen = 1 WHERE seen = 0").execute(p).await?.rows_affected()),
        Some(ids) => {
            if ids.len() > MAX_ACK_IDS {
                return invalid("too many ids");
            }
            let mut tx = p.begin().await?;
            let mut n = 0;
            for id in ids {
                n += sqlx::query("UPDATE alert_events SET seen = 1 WHERE id = ?1 AND seen = 0").bind(id).execute(&mut *tx).await?.rows_affected();
            }
            tx.commit().await?;
            Ok(n)
        }
    }
}
