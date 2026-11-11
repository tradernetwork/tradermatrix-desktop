//! Explain chat cost meter and budgets (M16 B2). Counters only: tokens per (UTC day, model) and an estimated dollar figure. No text, no key,
//! no digest. Price comes from a small model table; a model with no known price is "price unknown" (never $0), and its tokens can never
//! trip the dollar cap (only the session token cap covers them).
use serde::Serialize;
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::llm::Usage;

pub const SETTING_SESSION_TOKENS: &str = "chat.budget.session_tokens";
pub const SETTING_MONTH_USD: &str = "chat.budget.month_usd";
pub const DEFAULT_SESSION_TOKENS: u64 = 60_000;
pub const DEFAULT_MONTH_USD: f64 = 2.00;
const MIN_SESSION_TOKENS: u64 = 1_000;
const MAX_SESSION_TOKENS: u64 = 10_000_000;
const MAX_MONTH_USD: f64 = 10_000.0;

/// US dollars per million tokens.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Price {
    pub in_per_m: f64,
    pub out_per_m: f64,
}

/// Prices checked against the OpenRouter catalog on 2026-11-11 (`models show`): v4-flash $0.09 in / $0.18 out, v4.1-flash $0.051 in / $0.57 out.
/// Models that run on this computer cost nothing per token. Everything else (OpenAI, Venice, custom endpoints, the Claude CLI, other
/// OpenRouter models) is unknown on purpose: the meter says "price unknown" instead of guessing.
pub fn price_for(provider: &str, model: &str) -> Option<Price> {
    match (provider, model) {
        ("openrouter", "deepseek/deepseek-v4-flash") => Some(Price { in_per_m: 0.09, out_per_m: 0.18 }),
        ("openrouter", "deepseek/deepseek-v4.1-flash") => Some(Price { in_per_m: 0.051, out_per_m: 0.57 }),
        ("ollama" | "lmstudio", _) => Some(Price { in_per_m: 0.0, out_per_m: 0.0 }),
        _ => None,
    }
}

pub fn cost_usd(p: &Price, prompt: u64, completion: u64) -> f64 {
    (prompt as f64 * p.in_per_m + completion as f64 * p.out_per_m) / 1_000_000.0
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Budgets {
    pub session_tokens: u64,
    pub month_usd: f64,
}

/// The two settings are JSON numbers; anything missing, garbled or out of range is the default.
pub async fn budgets(p: &SqlitePool) -> Budgets {
    let get = |k: &'static str| async move { crate::db::setting_get(p, k).await.ok().flatten().and_then(|v| serde_json::from_str::<serde_json::Value>(v.trim()).ok()) };
    let session_tokens = get(SETTING_SESSION_TOKENS).await.and_then(|v| v.as_u64()).filter(|n| (MIN_SESSION_TOKENS..=MAX_SESSION_TOKENS).contains(n)).unwrap_or(DEFAULT_SESSION_TOKENS);
    let month_usd = get(SETTING_MONTH_USD).await.and_then(|v| v.as_f64()).filter(|x| x.is_finite() && *x > 0.0 && *x <= MAX_MONTH_USD).unwrap_or(DEFAULT_MONTH_USD);
    Budgets { session_tokens, month_usd }
}

/// `YYYY-MM` of a `YYYY-MM-DD` day.
pub fn month_of(day: &str) -> &str {
    day.get(..7).unwrap_or(day)
}

/// Today in UTC as `YYYY-MM-DD`.
pub fn today_utc() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    crate::rh_commands::ymd_utc(secs)
}

fn valid_day(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}
fn valid_month(m: &str) -> bool {
    let b = m.as_bytes();
    b.len() == 7 && b.iter().enumerate().all(|(i, c)| if i == 4 { *c == b'-' } else { c.is_ascii_digit() })
}

/// Adds one call to the (day, model) row. `cost` None = the model has no known price.
pub async fn record(p: &SqlitePool, day: &str, model: &str, usage: &Usage, cost: Option<f64>) -> Result<(), AppError> {
    if !valid_day(day) || model.is_empty() || model.len() > 100 {
        return Err(AppError::Invalid("bad usage row".into()));
    }
    let est = if usage.estimated { (usage.prompt + usage.completion) as i64 } else { 0 };
    sqlx::query(
        "INSERT INTO explain_usage (day, model, prompt, completion, est_usd, est_tokens, priced, calls) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 1) \
         ON CONFLICT(day, model) DO UPDATE SET prompt = prompt + excluded.prompt, completion = completion + excluded.completion, \
           est_usd = est_usd + excluded.est_usd, est_tokens = est_tokens + excluded.est_tokens, priced = excluded.priced, calls = calls + 1",
    )
    .bind(day)
    .bind(model)
    .bind(usage.prompt as i64)
    .bind(usage.completion as i64)
    .bind(cost.unwrap_or(0.0))
    .bind(est)
    .bind(i64::from(cost.is_some()))
    .execute(p)
    .await?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct MonthUsage {
    pub tokens: u64,
    /// Dollars of PRICED usage only.
    pub usd: f64,
    /// Tokens that were estimated (chars / 4).
    pub est_tokens: u64,
    /// Tokens used on models with no known price (their dollars are unknown, not zero).
    pub unpriced_tokens: u64,
}

pub async fn month(p: &SqlitePool, month: &str) -> Result<MonthUsage, AppError> {
    if !valid_month(month) {
        return Err(AppError::Invalid("bad month".into()));
    }
    let r: (i64, f64, i64, i64) = sqlx::query_as(
        "SELECT COALESCE(SUM(prompt + completion), 0), CAST(COALESCE(SUM(CASE WHEN priced = 1 THEN est_usd ELSE 0.0 END), 0.0) AS REAL), \
                COALESCE(SUM(est_tokens), 0), COALESCE(SUM(CASE WHEN priced = 0 THEN prompt + completion ELSE 0 END), 0) \
         FROM explain_usage WHERE day >= ?1 AND day < ?2",
    )
    .bind(format!("{month}-01"))
    .bind(format!("{month}-32"))
    .fetch_one(p)
    .await?;
    Ok(MonthUsage { tokens: r.0.max(0) as u64, usd: r.1, est_tokens: r.2.max(0) as u64, unpriced_tokens: r.3.max(0) as u64 })
}

/// What the header meter shows.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct UsageSummary {
    pub session_tokens: u64,
    pub session_cap: u64,
    /// Some of this session's tokens were estimated, not reported by the provider.
    pub session_estimated: bool,
    pub month_usd: f64,
    pub month_cap: f64,
    pub month_tokens: u64,
    pub month_estimated: bool,
    /// Some of this month's tokens were used on a model with no known price.
    pub month_unpriced: bool,
    /// The CURRENT model has a known price.
    pub price_known: bool,
}
