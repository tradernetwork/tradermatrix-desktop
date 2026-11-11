//! Typed TraderMatrix calls. Four read tools plus three watchlist tools (list, add, create) exist here; there is
//! no generic call entry point, so nothing outside this list can be reached, whatever the webview sends. The
//! watchlist writes only ever ADD (membership or an empty list) and never send notes.
use serde_json::{json, Value};

use crate::rh::{McpClient, RhError};
use crate::tm::types::*;

pub const TOOL_APEX_LEVELS: &str = "get_apex_levels";
pub const TOOL_EXPECTED_MOVE: &str = "get_expected_move";
pub const TOOL_IV_RANK: &str = "get_iv_rank";
pub const TOOL_TICKER_SNAPSHOT: &str = "get_ticker_snapshot";
pub const TOOL_LIST_WATCHLISTS: &str = "list_watchlists";
pub const TOOL_ADD_TO_WATCHLIST: &str = "add_to_watchlist";
pub const TOOL_CREATE_WATCHLIST: &str = "create_watchlist";

fn bad(what: &str) -> RhError {
    RhError::Invalid(what.to_string())
}

/// `^[A-Z]{1,6}(\.[A-Z])?$` after uppercasing. Returns the canonical symbol; nothing is sent on failure.
pub fn valid_symbol(raw: &str) -> Result<String, RhError> {
    let s = raw.to_ascii_uppercase();
    let (base, class) = match s.split_once('.') {
        Some((b, c)) => (b, Some(c)),
        None => (s.as_str(), None),
    };
    let base_ok = (1..=6).contains(&base.len()) && base.bytes().all(|c| c.is_ascii_uppercase());
    let class_ok = class.is_none_or(|c| c.len() == 1 && c.bytes().all(|b| b.is_ascii_uppercase()));
    if base_ok && class_ok {
        Ok(s)
    } else {
        Err(bad("symbol must be 1-6 letters, optionally .X (for example AAPL or BRK.B)"))
    }
}

/// `^\d{4}-\d{2}-\d{2}$`
pub fn valid_expiration(d: &str) -> Result<String, RhError> {
    let b = d.as_bytes();
    let ok = b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() });
    if ok {
        Ok(d.to_string())
    } else {
        Err(bad("expiration must look like YYYY-MM-DD"))
    }
}

/// The tool arguments. `symbol` must already be canonical.
pub fn apex_args(symbol: &str, expiration: Option<&str>) -> Value {
    match expiration {
        Some(e) => json!({"symbol": symbol, "expiration": e}),
        None => json!({"symbol": symbol}),
    }
}

/// Calls a TM tool and returns its payload. TM returns the bare object (as `content[0].text` JSON, or as
/// `structuredContent`); `ToolResult::data()` handles both, and unwraps a `{data: ...}` wrapper if one appears.
async fn fetch(c: &McpClient, tool: &str, args: Value) -> Result<Value, RhError> {
    let r = c.call_tool(tool, args).await?;
    r.data().cloned().ok_or_else(|| RhError::Protocol("TraderMatrix response carried no JSON data".into()))
}

pub async fn fetch_apex_levels(c: &McpClient, symbol: &str, expiration: Option<&str>) -> Result<ApexLevels, RhError> {
    parse_apex_levels(&fetch(c, TOOL_APEX_LEVELS, apex_args(symbol, expiration)).await?)
}

pub async fn fetch_expected_move(c: &McpClient, symbol: &str) -> Result<ExpectedMove, RhError> {
    parse_expected_move(&fetch(c, TOOL_EXPECTED_MOVE, json!({"symbol": symbol})).await?)
}

pub async fn fetch_iv_rank(c: &McpClient, symbol: &str) -> Result<IvRank, RhError> {
    parse_iv_rank(&fetch(c, TOOL_IV_RANK, json!({"symbol": symbol})).await?)
}

pub async fn fetch_snapshot(c: &McpClient, symbol: &str) -> Result<Snapshot, RhError> {
    parse_snapshot(&fetch(c, TOOL_TICKER_SNAPSHOT, json!({"symbol": symbol})).await?)
}

/// A list name or a numeric id: trimmed, 1 to 60 chars, no control characters.
pub fn valid_list_ref(raw: &str) -> Result<String, RhError> {
    let s = raw.trim();
    if s.is_empty() || s.chars().count() > 60 || s.chars().any(char::is_control) {
        return Err(bad("list name must be 1 to 60 printable characters"));
    }
    Ok(s.to_string())
}

pub async fn fetch_watchlists(c: &McpClient) -> Result<TmWatchlists, RhError> {
    parse_watchlists(&fetch(c, TOOL_LIST_WATCHLISTS, json!({})).await?)
}

/// Arguments are exactly `{ticker, list}`: never `notes`.
pub async fn add_to_watchlist(c: &McpClient, list: &str, ticker: &str) -> Result<TmAddOutcome, RhError> {
    parse_add_outcome(&fetch(c, TOOL_ADD_TO_WATCHLIST, json!({"ticker": ticker, "list": list})).await?)
}

/// Arguments are exactly `{name}`.
pub async fn create_watchlist(c: &McpClient, name: &str) -> Result<TmWatchlistMeta, RhError> {
    parse_create_outcome(&fetch(c, TOOL_CREATE_WATCHLIST, json!({"name": name})).await?)
}
