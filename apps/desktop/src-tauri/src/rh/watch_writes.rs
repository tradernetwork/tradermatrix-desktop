//! Typed watchlist write wrappers (M7). Tool names are fixed per function; there is no generic entry point.
//! These change the user's Robinhood watchlists but never move money. No order tool, and no delete tool (none exists
//! upstream), is reachable from here.
//!
//! Every call is validated locally first (zero requests on bad input). The equity-symbol tools additionally require a
//! fresh `get_watchlists` read that proves the list exists, is `owner_type == "custom"` and is not the options list.
//! None of these tools is in `McpClient`'s read-prefix set, so a failed write is never retried by the transport.
//! Crypto and index ids are not accepted in M7: only `symbols`, never `currency_pair_ids` or `index_ids`.
use serde_json::{json, Value};

use crate::rh::error::RhError;
use crate::rh::mcp::{McpClient, ToolResult};
use crate::rh::orders::is_uuid;
use crate::rh::reads;

pub const MAX_SYMBOLS_PER_CALL: usize = 50;
pub const MAX_OPTION_IDS: usize = 20;
const MAX_NAME_CHARS: usize = 50;
const MAX_EMOJI_BYTES: usize = 8;
const MAX_DESC_CHARS: usize = 200;

fn bad<T>(what: &str) -> Result<T, RhError> {
    Err(RhError::Invalid(what.into()))
}

fn no_control(s: &str) -> bool {
    !s.chars().any(char::is_control)
}

/// `^[A-Z][A-Z0-9.\-]{0,9}$`, applied after trim + uppercase.
pub(crate) fn symbol_ok(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=10).contains(&b.len()) && b[0].is_ascii_uppercase() && b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'.' || *c == b'-')
}

/// Trim, uppercase, validate, de-duplicate (first occurrence wins). At most 50 per call, never empty.
pub fn normalize_symbols(raw: &[String]) -> Result<Vec<String>, RhError> {
    if raw.is_empty() {
        return bad("no symbols given");
    }
    if raw.len() > MAX_SYMBOLS_PER_CALL {
        return bad("at most 50 symbols per call");
    }
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for r in raw {
        let s = r.trim().to_ascii_uppercase();
        if !symbol_ok(&s) {
            return bad("symbols must be 1 to 10 characters: A-Z, 0-9, '.' or '-', starting with a letter (crypto and index ids are not supported)");
        }
        if !out.contains(&s) {
            out.push(s);
        }
    }
    Ok(out)
}

/// UUID-shaped, lower-cased, de-duplicated, 1 to 20.
pub fn normalize_option_ids(raw: &[String]) -> Result<Vec<String>, RhError> {
    if raw.is_empty() {
        return bad("no option contracts given");
    }
    if raw.len() > MAX_OPTION_IDS {
        return bad("at most 20 option contracts per call");
    }
    let mut out: Vec<String> = Vec::with_capacity(raw.len());
    for r in raw {
        if !is_uuid(r) {
            return bad("option contract ids must be UUIDs");
        }
        let id = r.to_ascii_lowercase();
        if !out.contains(&id) {
            out.push(id);
        }
    }
    Ok(out)
}

fn clean_list_id(id: &str) -> Result<String, RhError> {
    if !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id.to_string())
    } else {
        bad("watchlist id is not valid")
    }
}

fn clean_name(name: &str) -> Result<String, RhError> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > MAX_NAME_CHARS || !no_control(n) {
        return bad("watchlist name must be 1 to 50 printable characters");
    }
    Ok(n.to_string())
}

/// Empty or absent = not sent. At most 8 bytes (one emoji incl. a variation selector), no control characters.
fn clean_emoji(e: Option<&str>) -> Result<Option<String>, RhError> {
    match e.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) if s.len() > MAX_EMOJI_BYTES || !no_control(s) => bad("emoji must be a single emoji (at most 8 bytes)"),
        Some(s) => Ok(Some(s.to_string())),
    }
}

fn clean_description(d: Option<&str>) -> Result<Option<String>, RhError> {
    match d.map(str::trim).filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(s) if s.chars().count() > MAX_DESC_CHARS || !no_control(s) => bad("description must be at most 200 printable characters"),
        Some(s) => Ok(Some(s.to_string())),
    }
}

pub fn prepare_create(name: &str, emoji: Option<&str>, desc: Option<&str>) -> Result<(String, Option<String>, Option<String>), RhError> {
    Ok((clean_name(name)?, clean_emoji(emoji)?, clean_description(desc)?))
}

/// (list id, name, emoji, description) of a validated update.
pub type UpdatePlan = (String, Option<String>, Option<String>, Option<String>);

/// At least one of name, emoji, description must be given.
pub fn prepare_update(
    list_id: &str,
    name: Option<&str>,
    emoji: Option<&str>,
    desc: Option<&str>,
) -> Result<UpdatePlan, RhError> {
    let id = clean_list_id(list_id)?;
    let name = match name.map(str::trim).filter(|s| !s.is_empty()) {
        Some(n) => Some(clean_name(n)?),
        None => None,
    };
    let (emoji, desc) = (clean_emoji(emoji)?, clean_description(desc)?);
    if name.is_none() && emoji.is_none() && desc.is_none() {
        return bad("nothing to change: give a name, an emoji or a description");
    }
    Ok((id, name, emoji, desc))
}

pub fn prepare_symbol_op(list_id: &str, symbols: &[String]) -> Result<(String, Vec<String>), RhError> {
    Ok((clean_list_id(list_id)?, normalize_symbols(symbols)?))
}

fn data_of(r: &ToolResult) -> Value {
    r.data().cloned().unwrap_or_else(|| json!({"ok": true}))
}

#[derive(Clone, Copy, PartialEq)]
enum Need {
    /// custom, and not the options list (symbols go through the equity tools)
    EquityList,
    /// custom (rename / icon / description)
    CustomList,
}

/// One fresh `get_watchlists` read: the list must exist and be writable for the requested operation.
async fn require_list(c: &McpClient, list_id: &str, need: Need) -> Result<(), RhError> {
    let lists = reads::watchlists(c).await?;
    let Some(w) = lists.iter().find(|w| w.id == list_id) else {
        return bad("watchlist not found");
    };
    if w.owner_type.as_deref() != Some("custom") {
        return bad("this is a Robinhood list you follow (read-only); only lists you created can be changed");
    }
    if w.is_options() {
        return if need == Need::EquityList {
            bad("this is the options watchlist: stocks cannot be added to it, and contracts go through the option tools")
        } else {
            bad("the options watchlist cannot be renamed here")
        };
    }
    Ok(())
}

pub async fn create(c: &McpClient, name: &str, emoji: Option<&str>, desc: Option<&str>) -> Result<Value, RhError> {
    let (name, emoji, desc) = prepare_create(name, emoji, desc)?;
    let mut args = json!({"display_name": name});
    if let Some(e) = emoji {
        args["icon_emoji"] = json!(e);
    }
    if let Some(d) = desc {
        args["display_description"] = json!(d);
    }
    Ok(data_of(&c.call_tool("create_watchlist", args).await?))
}

pub async fn update(c: &McpClient, list_id: &str, name: Option<&str>, emoji: Option<&str>, desc: Option<&str>) -> Result<Value, RhError> {
    let (id, name, emoji, desc) = prepare_update(list_id, name, emoji, desc)?;
    require_list(c, &id, Need::CustomList).await?;
    let mut args = json!({"list_id": id});
    if let Some(n) = name {
        args["display_name"] = json!(n);
    }
    if let Some(e) = emoji {
        args["icon_emoji"] = json!(e);
    }
    if let Some(d) = desc {
        args["display_description"] = json!(d);
    }
    Ok(data_of(&c.call_tool("update_watchlist", args).await?))
}

pub async fn add_symbols(c: &McpClient, list_id: &str, symbols: &[String]) -> Result<Value, RhError> {
    let (id, syms) = prepare_symbol_op(list_id, symbols)?;
    require_list(c, &id, Need::EquityList).await?;
    Ok(data_of(&c.call_tool("add_to_watchlist", json!({"list_id": id, "symbols": syms})).await?))
}

pub async fn remove_symbols(c: &McpClient, list_id: &str, symbols: &[String]) -> Result<Value, RhError> {
    let (id, syms) = prepare_symbol_op(list_id, symbols)?;
    require_list(c, &id, Need::EquityList).await?;
    Ok(data_of(&c.call_tool("remove_from_watchlist", json!({"list_id": id, "symbols": syms})).await?))
}

/// Adds option contracts (single-leg, long) to the user's options watchlist. The tool resolves the list itself.
pub async fn add_options(c: &McpClient, ids: &[String]) -> Result<Value, RhError> {
    let ids = normalize_option_ids(ids)?;
    Ok(data_of(&c.call_tool("add_option_to_watchlist", json!({"option_ids": ids})).await?))
}

pub async fn remove_options(c: &McpClient, ids: &[String]) -> Result<Value, RhError> {
    let ids = normalize_option_ids(ids)?;
    Ok(data_of(&c.call_tool("remove_option_from_watchlist", json!({"option_ids": ids})).await?))
}
