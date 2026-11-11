//! Realized P&L reads for the journal (M7): `get_realized_pnl` (bucketed totals) and `get_pnl_trade_history`
//! (per-trade, cursor-paged). Read-only. Both tools take the `rhs_account_number`, so the account the UI selected is
//! mapped through a fresh `get_accounts` read; an account without one is refused before any P&L request.
//!
//! Numbers arrive as strings, numbers or null and fields may be missing or unknown: nothing here can fail on shape.
use std::collections::HashMap;

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::rh::error::RhError;
use crate::rh::mcp::McpClient;
use crate::rh::orders::mask_account;
use crate::rh::reads;
use crate::rh::types::{de_f64_opt_value, rows, RealizedPnl};

pub const MAX_TRADE_PAGES: usize = 5;
const REALIZED_SPANS: [&str; 7] = ["day", "week", "month", "3month", "ytd", "year", "all"];
const TRADE_SPANS: [&str; 5] = ["week", "month", "3month", "ytd", "all"];
const ASSET_CLASSES: [&str; 3] = ["equity", "option", "crypto"];
const MAX_CURSOR: usize = 512;

/// One closing trade. `trade_key` is the stable link between a trade and a journal note, see `trade_key()`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PnlTrade {
    pub trade_key: String,
    pub symbol: String,
    pub side: Option<String>,
    pub quantity: Option<f64>,
    pub price: Option<f64>,
    pub realized_gain: Option<f64>,
    pub timestamp: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct PnlTrades {
    pub trades: Vec<PnlTrade>,
    /// Non-empty only when more trades exist beyond the pages read (pass it back as `cursor` to resume).
    pub next_cursor: Option<String>,
}

fn bad<T>(what: &str) -> Result<T, RhError> {
    Err(RhError::Invalid(what.into()))
}

/// Span must be one of the schema's presets; asset classes are de-duplicated and checked. Returns the cleaned classes.
pub fn validate_realized(span: &str, asset_classes: &[String]) -> Result<Vec<String>, RhError> {
    if !REALIZED_SPANS.contains(&span) {
        return bad("span must be day, week, month, 3month, ytd, year or all");
    }
    let mut out: Vec<String> = Vec::new();
    for a in asset_classes {
        if !ASSET_CLASSES.contains(&a.as_str()) {
            return bad("asset class must be equity, option or crypto");
        }
        if !out.contains(a) {
            out.push(a.clone());
        }
    }
    Ok(out)
}

/// Trade history spans exclude day and year. Symbol is trimmed + uppercased; empty symbol/cursor mean absent.
pub fn validate_trades(span: &str, symbol: Option<&str>, cursor: Option<&str>) -> Result<(Option<String>, Option<String>), RhError> {
    if !TRADE_SPANS.contains(&span) {
        return bad("span must be week, month, 3month, ytd or all");
    }
    let symbol = match symbol.map(str::trim).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => {
            let u = s.to_ascii_uppercase();
            let b = u.as_bytes();
            let ok = b.len() <= 10 && b[0].is_ascii_uppercase() && b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'.' || *c == b'-');
            if !ok {
                return bad("symbol must be 1 to 10 characters: A-Z, 0-9, '.' or '-', starting with a letter");
            }
            Some(u)
        }
    };
    let cursor = match cursor.filter(|s| !s.is_empty()) {
        None => None,
        Some(c) if c.len() > MAX_CURSOR || c.chars().any(|ch| ch.is_control() || ch.is_whitespace()) => return bad("cursor is not valid"),
        Some(c) => Some(c.to_string()),
    };
    Ok((symbol, cursor))
}

fn raw_str(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Numbers compare by value, so `10` and `"10"` and `"10.0"` give the same key text.
fn canon_num(v: Option<&Value>) -> String {
    match v.and_then(de_f64_opt_value) {
        Some(f) => format!("{f}"),
        None => String::new(),
    }
}

/// Stable id of a trade, derived from `account | symbol | side | quantity | price | timestamp` (the only fields the
/// tool gives; it has no trade id). SHA-256, first 12 bytes as hex, prefixed `t_`: `t_` + 24 hex chars. `realized_gain`
/// and unknown fields are NOT part of the key, so a server that re-rounds the gain does not orphan journal notes.
/// Two otherwise identical trades collide by construction; the caller appends `_2`, `_3`... in server order.
pub fn trade_key(account: &str, v: &Value) -> String {
    let text = format!(
        "{}|{}|{}|{}|{}|{}",
        account,
        raw_str(v.get("symbol")).to_ascii_uppercase(),
        raw_str(v.get("side")).to_ascii_lowercase(),
        canon_num(v.get("quantity")),
        canon_num(v.get("price")),
        raw_str(v.get("timestamp")),
    );
    let digest = Sha256::digest(text.as_bytes());
    let mut hex = String::from("t_");
    for b in &digest[..12] {
        hex.push_str(&format!("{b:02x}"));
    }
    hex
}

fn opt_s(v: Option<&Value>) -> Option<String> {
    Some(raw_str(v)).filter(|s| !s.is_empty())
}

fn map_trade(account: &str, v: &Value) -> PnlTrade {
    PnlTrade {
        trade_key: trade_key(account, v),
        symbol: raw_str(v.get("symbol")),
        side: opt_s(v.get("side")),
        quantity: v.get("quantity").and_then(de_f64_opt_value),
        price: v.get("price").and_then(de_f64_opt_value),
        realized_gain: v.get("realized_gain").and_then(de_f64_opt_value),
        timestamp: opt_s(v.get("timestamp")),
    }
}

/// The selected account's `rhs_account_number`, from a fresh `get_accounts` read. Errors never contain the full number.
pub async fn rhs_account(c: &McpClient, account: &str) -> Result<String, RhError> {
    let accounts = reads::accounts(c).await?;
    let Some(a) = accounts.iter().find(|a| a.account_number == account) else {
        return Err(RhError::Invalid(format!("account {} was not found", mask_account(account))));
    };
    match a.rhs_account_number.as_deref().filter(|s| !s.is_empty()) {
        Some(r) => Ok(r.to_string()),
        None => Err(RhError::Invalid(format!(
            "account {} has no rhs_account_number, so realized P&L cannot be read for it",
            mask_account(account)
        ))),
    }
}

pub async fn realized_pnl(c: &McpClient, account: &str, span: &str, asset_classes: &[String]) -> Result<RealizedPnl, RhError> {
    let classes = validate_realized(span, asset_classes)?;
    let rhs = rhs_account(c, account).await?;
    let mut args = json!({"account_number": rhs, "span": span});
    if !classes.is_empty() {
        args["asset_classes"] = json!(classes);
    }
    let r = c.call_tool("get_realized_pnl", args).await?;
    let d = r.data().ok_or_else(|| RhError::Protocol("tool response carried no JSON data".into()))?;
    serde_json::from_value(d.clone()).map_err(|_| RhError::Protocol("unreadable realized pnl payload".into()))
}

/// Reads up to `MAX_TRADE_PAGES` pages starting at `cursor`. Most recent first. `next_cursor` is set only when more
/// remain after the last page read; a repeated cursor ends the loop without being reported.
pub async fn pnl_trades(c: &McpClient, account: &str, span: &str, symbol: Option<&str>, cursor: Option<&str>) -> Result<PnlTrades, RhError> {
    let (symbol, mut cursor) = validate_trades(span, symbol, cursor)?;
    let rhs = rhs_account(c, account).await?;
    let mut trades: Vec<PnlTrade> = Vec::new();
    let mut seen: HashMap<String, usize> = HashMap::new();
    let mut next: Option<String> = None;
    for _ in 0..MAX_TRADE_PAGES {
        let mut args = json!({"account_number": rhs, "span": span});
        if let Some(s) = &symbol {
            args["symbol"] = json!(s);
        }
        if let Some(cu) = &cursor {
            args["cursor"] = json!(cu);
        }
        let r = c.call_tool("get_pnl_trade_history", args).await?;
        let d = r.data().ok_or_else(|| RhError::Protocol("tool response carried no JSON data".into()))?;
        for v in rows::<Value>(d, "trades").into_iter().filter(Value::is_object) {
            let mut t = map_trade(&rhs, &v);
            let n = seen.entry(t.trade_key.clone()).or_insert(0);
            *n += 1;
            if *n > 1 {
                t.trade_key = format!("{}_{}", t.trade_key, n);
            }
            trades.push(t);
        }
        next = match d.get("next_cursor").and_then(Value::as_str) {
            Some(n) if !n.is_empty() && cursor.as_deref() != Some(n) => Some(n.to_string()),
            _ => None,
        };
        match &next {
            Some(n) => cursor = Some(n.clone()),
            None => break,
        }
    }
    Ok(PnlTrades { trades, next_cursor: next })
}
