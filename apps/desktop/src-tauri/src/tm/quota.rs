//! TraderMatrix call budget (M20a). TM publishes its MCP limits: 12 tool calls per minute per account on every tier, and a
//! daily budget (25 on the free preview, 200 on Premium). The app runs under the SAME limits customers get: no owner bypass.
//!
//! `Gate` is a pure state machine (no clock, no I/O): every method takes the current time in epoch milliseconds, so tests drive
//! it with a fake clock. It holds
//!   * a SLIDING 60 s window of send times (a hard wall: never more than `per_min` sends in any 60 s, which is stricter than a token bucket),
//!   * today's count (UTC day, unverified against the server's own boundary) with the limit the server told us, and
//!   * backoffs learned from the server's own messages ("Slow down" 60 s, "TraderMatrix is busy" 30 s, "Daily limit reached" = stop for the day).
//!
//! Priorities: `Interactive` (the symbol on screen) > `Background` (watchlist sync, stored snapshots) > `Opportunistic` (alert polling, skill
//! refresh). Background and opportunistic calls are DROPPED when under 20% of the day is left; opportunistic calls never wait; background calls
//! keep 2 per-minute slots free for the symbol on screen. A future limits source (RateLimit headers, a usage tool) plugs in through `learn`
//! and `set_budgets`; nothing here depends on one.
use std::collections::VecDeque;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sqlx::{Row, SqlitePool};

use crate::db;
use crate::error::AppError;
use crate::rh::RhError;

pub const BUDGETS_SETTING: &str = "tm.quota.budgets";
pub const DEFAULT_PER_MIN: u32 = 10;
pub const DEFAULT_PER_DAY: u32 = 200;
/// TM's published per-minute limit for ALL tiers: the setting can lower it, never raise it.
pub const MAX_PER_MIN: u32 = 12;
/// A generous ceiling (the Developer API add-on raises TM's limits); it only guards against typos.
pub const MAX_PER_DAY: u32 = 10_000;

const WINDOW_MS: i64 = 60_000;
const DAY_MS: i64 = 86_400_000;
const SLOW_DOWN_MS: i64 = 60_000;
const BUSY_MS: i64 = 30_000;
/// An interactive call waits at most this long for a slot; past it the caller gets "TM throttled until ..." at once.
const MAX_WAIT_INTERACTIVE_MS: i64 = 20_000;
/// A background call (sync) may wait out a full window, so a long sync keeps going at the allowed pace on its own.
const MAX_WAIT_BACKGROUND_MS: i64 = 65_000;
/// Per-minute slots background calls leave free for the symbol on screen.
const BACKGROUND_RESERVE: u32 = 2;

// ---------------------------------------------------------------- time

/// Epoch-millisecond clock with an awaitable sleep, so a fake one can make waits instant in tests.
#[async_trait::async_trait]
pub trait Clock: Send + Sync {
    fn now_ms(&self) -> i64;
    async fn sleep_until_ms(&self, t: i64);
}

pub struct SystemClock;

#[async_trait::async_trait]
impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
    }
    async fn sleep_until_ms(&self, t: i64) {
        let d = (t - self.now_ms()).max(0) as u64;
        tokio::time::sleep(Duration::from_millis(d)).await;
    }
}

/// Test clock: `sleep_until_ms` jumps time forward to the target (concurrent sleepers never add up).
#[cfg(test)]
pub struct FakeClock(std::sync::atomic::AtomicI64);

#[cfg(test)]
impl FakeClock {
    pub fn new(ms: i64) -> Self {
        Self(std::sync::atomic::AtomicI64::new(ms))
    }
    pub fn advance(&self, ms: i64) {
        self.0.fetch_add(ms, std::sync::atomic::Ordering::SeqCst);
    }
    pub fn set(&self, ms: i64) {
        self.0.store(ms, std::sync::atomic::Ordering::SeqCst);
    }
}

#[cfg(test)]
#[async_trait::async_trait]
impl Clock for FakeClock {
    fn now_ms(&self) -> i64 {
        self.0.load(std::sync::atomic::Ordering::SeqCst)
    }
    async fn sleep_until_ms(&self, t: i64) {
        self.0.fetch_max(t, std::sync::atomic::Ordering::SeqCst);
        tokio::task::yield_now().await;
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn utc_ms(y: i64, mo: i64, d: i64, h: i64, mi: i64, s: i64) -> i64 {
    ((days_from_civil(y, mo, d) * 24 + h) * 60 + mi) * 60_000 + s * 1000
}

fn day_number(ms: i64) -> i64 {
    ms.div_euclid(DAY_MS)
}

/// `YYYY-MM-DD` of the UTC day.
pub fn day_string(ms: i64) -> String {
    let (y, m, d) = civil_from_days(day_number(ms));
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn iso_utc(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let (y, mo, d) = civil_from_days(secs.div_euclid(86_400));
    let r = secs.rem_euclid(86_400);
    format!("{y:04}-{mo:02}-{d:02}T{:02}:{:02}:{:02}Z", r / 3600, (r % 3600) / 60, r % 60)
}

/// The next UTC midnight strictly after `ms`.
pub fn next_midnight_ms(ms: i64) -> i64 {
    (day_number(ms) + 1) * DAY_MS
}

// ---------------------------------------------------------------- types

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Priority {
    Interactive,
    Background,
    Opportunistic,
}

impl Priority {
    /// `None` is interactive. Anything else must be one of the three names.
    pub fn parse(s: Option<&str>) -> Result<Priority, RhError> {
        match s {
            None | Some("interactive") => Ok(Priority::Interactive),
            Some("background") => Ok(Priority::Background),
            Some("opportunistic") => Ok(Priority::Opportunistic),
            Some(_) => Err(RhError::Invalid("priority must be interactive, background or opportunistic".into())),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Budgets {
    pub per_min: u32,
    pub per_day: u32,
}

impl Default for Budgets {
    fn default() -> Self {
        Self { per_min: DEFAULT_PER_MIN, per_day: DEFAULT_PER_DAY }
    }
}

impl Budgets {
    pub fn validate(per_min: u32, per_day: u32) -> Result<Budgets, RhError> {
        if !(1..=MAX_PER_MIN).contains(&per_min) {
            return Err(RhError::Invalid(format!("calls per minute must be 1 to {MAX_PER_MIN} (TraderMatrix allows {MAX_PER_MIN} on every plan)")));
        }
        if !(1..=MAX_PER_DAY).contains(&per_day) {
            return Err(RhError::Invalid(format!("calls per day must be 1 to {MAX_PER_DAY}")));
        }
        Ok(Budgets { per_min, per_day })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DenyKind {
    /// Today's budget is spent (or the server said so): nothing is sent until the UTC day rolls over.
    DailyExhausted,
    /// Under 20% of today's budget is left: only the symbol on screen may spend it.
    LowBudget,
    /// The per-minute wall or a server backoff, and the wait would be too long.
    Throttled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Admit {
    Go,
    Wait { until_ms: i64 },
    Deny { kind: DenyKind, until_ms: i64, message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Signal {
    /// "Daily limit reached", with the limit when the text names one.
    DailyLimit(Option<u32>),
    SlowDown,
    Busy,
}

/// What the header chip and every degraded TM surface read. Counts and times only; nothing secret.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct QuotaStatus {
    pub day: String,
    pub used: u32,
    /// The effective daily limit: the user's setting, or a smaller one the server told us.
    pub limit: u32,
    pub remaining: u32,
    pub per_min: u32,
    pub per_day: u32,
    pub limit_seen: Option<u32>,
    pub window_used: u32,
    /// A per-minute wall or server backoff is holding calls back until this time.
    pub throttled_until_ms: Option<i64>,
    pub paused: bool,
    pub paused_until_ms: Option<i64>,
    /// A result carried TM's `preview` marker today (free tier: lists cut short).
    pub preview: bool,
    pub now_ms: i64,
}

/// One row of `tm_quota`.
#[derive(Debug, Clone, PartialEq)]
pub struct DayRow {
    pub day: String,
    pub used: u32,
    pub limit_seen: Option<u32>,
    pub paused: bool,
}

// ---------------------------------------------------------------- the gate

pub struct Gate {
    budgets: Budgets,
    day: Option<i64>,
    used: u32,
    limit_seen: Option<u32>,
    paused: bool,
    sent: VecDeque<i64>,
    slow_until: i64,
    preview: bool,
}

impl Gate {
    pub fn new(budgets: Budgets) -> Gate {
        Gate { budgets, day: None, used: 0, limit_seen: None, paused: false, sent: VecDeque::new(), slow_until: 0, preview: false }
    }

    pub fn set_budgets(&mut self, b: Budgets) {
        self.budgets = b;
    }

    pub fn note_preview(&mut self) {
        self.preview = true;
    }

    fn rollover(&mut self, now: i64) {
        let d = day_number(now);
        match self.day {
            Some(prev) if d <= prev => {}
            Some(_) => {
                self.day = Some(d);
                self.used = 0;
                self.limit_seen = None;
                self.paused = false;
                self.preview = false;
            }
            None => self.day = Some(d),
        }
    }

    fn prune(&mut self, now: i64) {
        while self.sent.front().is_some_and(|&t| t <= now - WINDOW_MS) {
            self.sent.pop_front();
        }
    }

    fn limit(&self) -> u32 {
        self.budgets.per_day.min(self.limit_seen.unwrap_or(u32::MAX))
    }

    /// Loads today's stored row; a row for any other day is ignored (a new day starts at zero).
    pub fn restore(&mut self, now: i64, row: DayRow) {
        self.rollover(now);
        if row.day == day_string(now) {
            self.used = row.used;
            self.limit_seen = row.limit_seen;
            self.paused = row.paused;
        }
    }

    pub fn day_row(&mut self, now: i64) -> DayRow {
        self.rollover(now);
        DayRow { day: day_string(now), used: self.used, limit_seen: self.limit_seen, paused: self.paused }
    }

    /// The decision for a call right now, WITHOUT recording it.
    pub fn check(&mut self, now: i64, p: Priority) -> Admit {
        self.rollover(now);
        self.prune(now);
        let limit = self.limit();
        let midnight = next_midnight_ms(now);
        if self.paused || self.used >= limit {
            return Admit::Deny {
                kind: DenyKind::DailyExhausted,
                until_ms: midnight,
                message: format!("TM paused until {}: daily budget used ({} of {} calls)", iso_utc(midnight), self.used.min(limit), limit),
            };
        }
        let remaining = limit - self.used;
        if p != Priority::Interactive && u64::from(remaining) * 5 < u64::from(limit) {
            return Admit::Deny {
                kind: DenyKind::LowBudget,
                until_ms: midnight,
                message: format!("TM paused until {}: daily budget nearly used ({remaining} of {limit} calls left, kept for the symbol on screen)", iso_utc(midnight)),
            };
        }
        let cap = match p {
            Priority::Interactive => self.budgets.per_min,
            _ => self.budgets.per_min.saturating_sub(BACKGROUND_RESERVE).max(1),
        } as usize;
        let mut until = self.slow_until;
        if self.sent.len() >= cap {
            until = until.max(self.sent[self.sent.len() - cap] + WINDOW_MS);
        }
        if until > now {
            let max_wait = match p {
                Priority::Interactive => MAX_WAIT_INTERACTIVE_MS,
                Priority::Background => MAX_WAIT_BACKGROUND_MS,
                Priority::Opportunistic => 0,
            };
            if until - now > max_wait {
                let why = if self.slow_until > now { "TraderMatrix asked us to slow down".to_string() } else { format!("{} calls per minute used", self.budgets.per_min) };
                return Admit::Deny { kind: DenyKind::Throttled, until_ms: until, message: format!("TM throttled until {}: {why}", iso_utc(until)) };
            }
            return Admit::Wait { until_ms: until };
        }
        Admit::Go
    }

    /// `check`, and on `Go` the send is recorded (window and daily count).
    pub fn try_acquire(&mut self, now: i64, p: Priority) -> Admit {
        let a = self.check(now, p);
        if a == Admit::Go {
            self.sent.push_back(now);
            self.used = self.used.saturating_add(1);
        }
        a
    }

    /// Takes in what the server said. A daily limit jumps the counter to the limit and pauses until rollover.
    pub fn learn(&mut self, now: i64, s: Signal) {
        self.rollover(now);
        match s {
            Signal::DailyLimit(n) => {
                if let Some(n) = n {
                    self.limit_seen = Some(n);
                }
                self.used = self.used.max(self.limit());
                self.paused = true;
            }
            Signal::SlowDown => self.slow_until = self.slow_until.max(now + SLOW_DOWN_MS),
            Signal::Busy => self.slow_until = self.slow_until.max(now + BUSY_MS),
        }
    }

    pub fn status(&mut self, now: i64) -> QuotaStatus {
        self.rollover(now);
        self.prune(now);
        let limit = self.limit();
        let paused = self.paused || self.used >= limit;
        let per_min = self.budgets.per_min as usize;
        let mut throttled = (self.slow_until > now).then_some(self.slow_until);
        if self.sent.len() >= per_min {
            let t = self.sent[self.sent.len() - per_min] + WINDOW_MS;
            throttled = Some(throttled.map_or(t, |x| x.max(t)));
        }
        QuotaStatus {
            day: day_string(now),
            used: self.used,
            limit,
            remaining: limit.saturating_sub(self.used),
            per_min: self.budgets.per_min,
            per_day: self.budgets.per_day,
            limit_seen: self.limit_seen,
            window_used: self.sent.len() as u32,
            throttled_until_ms: throttled,
            paused,
            paused_until_ms: paused.then(|| next_midnight_ms(now)),
            preview: self.preview,
            now_ms: now,
        }
    }
}

// ---------------------------------------------------------------- reading the server's words

/// Recognises TM's own limit messages. Text is matched case-insensitively; anything else (including "Premium feature") is not a budget signal.
pub fn signal_from_text(text: &str) -> Option<Signal> {
    let t = text.to_ascii_lowercase();
    if t.contains("daily limit reached") {
        return Some(Signal::DailyLimit(parse_limit(&t)));
    }
    if t.contains("slow down") {
        return Some(Signal::SlowDown);
    }
    if t.contains("is busy") {
        return Some(Signal::Busy);
    }
    None
}

/// A number the message ties to a count of calls ("25 calls/day", "200 tool calls per day").
fn parse_limit(t: &str) -> Option<u32> {
    let b = t.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i].is_ascii_digit() {
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let rest = t[i..].trim_start();
            let tied = ["calls", "call", "tool", "request", "/day", "/ day", "per day", "a day"].iter().any(|k| rest.starts_with(k));
            if let (true, Ok(n)) = (tied, t[start..i].parse::<u32>()) {
                if (1..=100_000).contains(&n) {
                    return Some(n);
                }
            }
        } else {
            i += 1;
        }
    }
    None
}

// ---------------------------------------------------------------- persistence

/// `None` when nothing valid is stored.
pub async fn load_budgets_opt(p: &SqlitePool) -> Option<Budgets> {
    let raw = db::setting_get(p, BUDGETS_SETTING).await.ok().flatten()?;
    let b: Budgets = serde_json::from_str(&raw).ok()?;
    Budgets::validate(b.per_min, b.per_day).ok()
}

pub async fn load_budgets(p: &SqlitePool) -> Budgets {
    load_budgets_opt(p).await.unwrap_or_default()
}

pub async fn save_budgets(p: &SqlitePool, b: &Budgets) -> Result<(), AppError> {
    let json = serde_json::to_string(b).map_err(|e| AppError::Invalid(e.to_string()))?;
    db::setting_set(p, BUDGETS_SETTING, &json).await
}

pub async fn load_day(p: &SqlitePool, day: &str) -> Result<Option<DayRow>, AppError> {
    let row = sqlx::query("SELECT used, limit_seen, paused FROM tm_quota WHERE day = ?1").bind(day).fetch_optional(p).await?;
    Ok(row.map(|r| {
        let used: i64 = r.get("used");
        let seen: Option<i64> = r.get("limit_seen");
        let paused: i64 = r.get("paused");
        DayRow { day: day.to_string(), used: u32::try_from(used.max(0)).unwrap_or(u32::MAX), limit_seen: seen.and_then(|n| u32::try_from(n).ok()), paused: paused != 0 }
    }))
}

pub async fn save_day(p: &SqlitePool, r: &DayRow) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO tm_quota (day, used, limit_seen, paused) VALUES (?1, ?2, ?3, ?4) \
         ON CONFLICT(day) DO UPDATE SET used = excluded.used, limit_seen = excluded.limit_seen, paused = excluded.paused",
    )
    .bind(&r.day)
    .bind(i64::from(r.used))
    .bind(r.limit_seen.map(i64::from))
    .bind(i64::from(r.paused))
    .execute(p)
    .await?;
    Ok(())
}
