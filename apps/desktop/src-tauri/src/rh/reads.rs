//! Read-only typed wrappers over `McpClient::call_tool`. Only `get_*` tools are called here; there is no
//! generic call entry point and no write tool anywhere in this module.
use serde::Deserialize;
use serde_json::{json, Value};

use crate::rh::error::RhError;
use crate::rh::mcp::{McpClient, ToolResult};
use crate::rh::types::*;

pub const QUOTE_CHUNK: usize = 20;
pub const HISTORICAL_CHUNK: usize = 10;
pub const OPTION_QUOTE_CHUNK: usize = 20;
/// Instrument-id chunk for the option-positions join (get_option_instruments `ids`).
pub const OPTION_POSITION_CHUNK: usize = 20;
pub const MAX_SYMBOLS: usize = 400;

const MAX_POSITION_PAGES: usize = 20;
const MAX_ORDER_PAGES: usize = 3;
const MAX_INSTRUMENT_PAGES: usize = 10;
const INTERVALS: [&str; 18] = [
    "15second", "30second", "minute", "5minute", "10minute", "30minute", "hour", "4hour", "day", "week", "month",
    "3month", "6month", "year", "5year", "10year", "20year", "50year",
];
/// From the `state` parameter of get_equity_orders (the Robinhood MCP tool schemas).
const EQUITY_ORDER_STATES: [&str; 10] =
    ["new", "queued", "confirmed", "unconfirmed", "partially_filled", "filled", "cancelled", "rejected", "failed", "voided"];
/// From the `state` parameter of get_option_orders.
const OPTION_ORDER_STATES: [&str; 9] =
    ["queued", "confirmed", "partially_filled", "filled", "rejected", "cancelled", "failed", "voided", "pending_cancelled"];
/// get_portfolio fields we read; a payload with none of them is not a portfolio.
const PORTFOLIO_FIELDS: [&str; 6] = ["total_value", "equity_value", "options_value", "cash", "buying_power", "currency"];

fn bad(what: &str) -> RhError {
    RhError::Protocol(format!("invalid argument: {what}"))
}

fn id_ok(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn check_account(a: &str) -> Result<(), RhError> {
    if id_ok(a) { Ok(()) } else { Err(bad("account")) }
}

fn check_symbols(symbols: &[String]) -> Result<(), RhError> {
    if symbols.len() > MAX_SYMBOLS {
        return Err(bad("too many symbols"));
    }
    for s in symbols {
        let ok = !s.is_empty() && s.len() <= 12 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-');
        if !ok {
            return Err(bad("symbol"));
        }
    }
    Ok(())
}

fn check_date(d: &str) -> bool {
    let b = d.as_bytes();
    b.len() == 10 && b.iter().enumerate().all(|(i, c)| if i == 4 || i == 7 { *c == b'-' } else { c.is_ascii_digit() })
}

/// RFC 3339-ish: digits, `-`, `:`, `T`, `Z`, `.`, `+`.
fn check_start(s: &str) -> bool {
    s.len() >= 10 && s.len() <= 40 && s.as_bytes()[..4].iter().all(u8::is_ascii_digit) && s.chars().all(|c| c.is_ascii_digit() || "-:TZ.+".contains(c))
}

fn data_of(r: &ToolResult) -> Result<&Value, RhError> {
    r.data().ok_or_else(|| RhError::Protocol("tool response carried no JSON data".into()))
}

/// Cursor paging: `next` is an opaque cursor ("" on the last page). Stops at `max_pages` or a repeated cursor.
async fn paged<T: for<'a> Deserialize<'a>>(
    c: &McpClient,
    tool: &str,
    base: Value,
    key: &str,
    max_pages: usize,
) -> Result<Vec<T>, RhError> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..max_pages {
        let mut args = base.clone();
        if let Some(cu) = &cursor {
            args["cursor"] = json!(cu);
        }
        let r = c.call_tool(tool, args).await?;
        let d = data_of(&r)?;
        out.extend(rows_required::<T>(d, key)?);
        match d.get("next").and_then(Value::as_str) {
            Some(n) if !n.is_empty() && cursor.as_deref() != Some(n) => cursor = Some(n.to_string()),
            _ => break,
        }
    }
    Ok(out)
}

pub async fn accounts(c: &McpClient) -> Result<Vec<Account>, RhError> {
    let r = c.call_tool("get_accounts", json!({})).await?;
    rows_required(data_of(&r)?, "accounts")
}

pub async fn portfolio(c: &McpClient, account: &str) -> Result<Portfolio, RhError> {
    check_account(account)?;
    let r = c.call_tool("get_portfolio", json!({"account_number": account})).await?;
    let d = data_of(&r)?;
    if !PORTFOLIO_FIELDS.iter().any(|k| d.get(k).is_some()) {
        return Err(RhError::Protocol("unexpected response shape (no portfolio fields)".into()));
    }
    serde_json::from_value(d.clone()).map_err(|_| RhError::Protocol("unreadable portfolio payload".into()))
}

pub async fn positions(c: &McpClient, account: &str) -> Result<Vec<EquityPosition>, RhError> {
    check_account(account)?;
    paged(c, "get_equity_positions", json!({"account_number": account}), "positions", MAX_POSITION_PAGES).await
}

/// Equity and option orders, newest first. A `state` filter must be valid for at least one of the two tools;
/// each tool gets it only if its own schema lists it, and a tool whose list lacks it is not called (no order of
/// that kind can be in that state, e.g. an option order is never "new").
pub async fn orders(c: &McpClient, account: &str, state: Option<&str>) -> Result<Vec<Order>, RhError> {
    check_account(account)?;
    let state = state.filter(|s| !s.is_empty());
    if let Some(s) = state {
        if !EQUITY_ORDER_STATES.contains(&s) && !OPTION_ORDER_STATES.contains(&s) {
            return Err(bad("order state"));
        }
    }
    let mut all: Vec<Order> = Vec::new();
    for (tool, asset, valid) in [("get_equity_orders", "equity", &EQUITY_ORDER_STATES[..]), ("get_option_orders", "option", &OPTION_ORDER_STATES[..])] {
        let mut base = json!({"account_number": account});
        if let Some(s) = state {
            if !valid.contains(&s) {
                continue;
            }
            base["state"] = json!(s);
        }
        let mut part: Vec<Order> = paged(c, tool, base, "orders", MAX_ORDER_PAGES).await?;
        for o in &mut part {
            o.asset = asset.to_string();
        }
        all.extend(part);
    }
    all.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(all)
}

pub async fn quotes(c: &McpClient, symbols: &[String]) -> Result<Vec<Quote>, RhError> {
    check_symbols(symbols)?;
    let mut out = Vec::new();
    for chunk in symbols.chunks(QUOTE_CHUNK) {
        let r = c.call_tool("get_equity_quotes", json!({"symbols": chunk})).await?;
        for item in rows_required::<Value>(data_of(&r)?, "results")? {
            if let Ok(q) = serde_json::from_value::<Quote>(item.get("quote").cloned().unwrap_or(Value::Null)) {
                out.push(q);
            }
        }
    }
    Ok(out)
}

pub async fn historicals(
    c: &McpClient,
    symbols: &[String],
    start: &str,
    interval: Option<&str>,
) -> Result<Vec<Historical>, RhError> {
    check_symbols(symbols)?;
    if !check_start(start) {
        return Err(bad("start time"));
    }
    if let Some(i) = interval {
        if !INTERVALS.contains(&i) {
            return Err(bad("interval"));
        }
    }
    let mut out = Vec::new();
    for chunk in symbols.chunks(HISTORICAL_CHUNK) {
        let mut args = json!({"symbols": chunk, "start_time": start});
        if let Some(i) = interval {
            args["interval"] = json!(i);
        }
        let r = c.call_tool("get_equity_historicals", args).await?;
        out.extend(rows_required::<Historical>(data_of(&r)?, "results")?);
    }
    Ok(out)
}

/// Today as `YYYY-MM-DD` (UTC), from the system clock. Civil-from-days (Howard Hinnant), no date crate.
pub(crate) fn today_utc() -> String {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    civil_date((secs / 86_400) as i64)
}

pub(crate) fn civil_date(days_since_epoch: i64) -> String {
    let z = days_since_epoch + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Pure mapper for get_earnings_results `data`. `results` must be a list (or null); rows with no `report` or no date
/// are skipped. `next` = earliest date >= today (ties: first in the response), `last` = latest date < today.
pub fn earnings_from(data: &Value, today: &str) -> Result<EarningsInfo, RhError> {
    let mut next: Option<EarningsEvent> = None;
    let mut last: Option<EarningsEvent> = None;
    for item in rows_required::<Value>(data, "results")? {
        let Some(rep) = item.get("report").filter(|r| r.is_object()) else { continue };
        let Some(date) = rep.get("date").and_then(Value::as_str).filter(|d| check_date(d)) else { continue };
        let ev = EarningsEvent {
            date: date.to_string(),
            timing: rep.get("timing").and_then(Value::as_str).filter(|t| matches!(*t, "am" | "pm")).map(str::to_string),
            verified: rep.get("verified").and_then(Value::as_bool).unwrap_or(false),
        };
        if date >= today {
            if next.as_ref().is_none_or(|n| date < n.date.as_str()) {
                next = Some(ev);
            }
        } else if last.as_ref().is_none_or(|l| date > l.date.as_str()) {
            last = Some(ev);
        }
    }
    Ok(EarningsInfo { next, last })
}

/// get_earnings_results for ONE symbol. Read-only; the symbol is validated before any call.
pub async fn earnings(c: &McpClient, symbol: &str) -> Result<EarningsInfo, RhError> {
    earnings_at(c, symbol, &today_utc()).await
}

pub(crate) async fn earnings_at(c: &McpClient, symbol: &str, today: &str) -> Result<EarningsInfo, RhError> {
    check_symbols(&[symbol.to_string()])?;
    let r = c.call_tool("get_earnings_results", json!({"symbol": symbol})).await?;
    earnings_from(data_of(&r)?, today)
}

const OPTION_BOUNDS: [&str; 3] = ["regular", "24_5", "24_7"];

/// get_option_historicals for ONE contract (uuid). Read-only; bars carry OHLC only (no volume exists for options) and
/// interpolated (synthesized, forward-filled) bars are dropped. Unknown, expired or restricted ids are an error.
pub async fn option_historicals(
    c: &McpClient,
    option_id: &str,
    start: &str,
    interval: Option<&str>,
    bounds: Option<&str>,
) -> Result<Historical, RhError> {
    if !uuid_ok(option_id) {
        return Err(bad("option id"));
    }
    if !check_start(start) {
        return Err(bad("start time"));
    }
    if let Some(i) = interval {
        if !INTERVALS.contains(&i) {
            return Err(bad("interval"));
        }
    }
    if let Some(b) = bounds {
        if !OPTION_BOUNDS.contains(&b) {
            return Err(bad("bounds"));
        }
    }
    let mut args = json!({"instrument_ids": [option_id], "start_time": start});
    if let Some(i) = interval {
        args["interval"] = json!(i);
    }
    if let Some(b) = bounds {
        args["bounds"] = json!(b);
    }
    let r = c.call_tool("get_option_historicals", args).await?;
    let d = data_of(&r)?;
    let results = rows_required::<OptionBars>(d, "results")?;
    let found = results.into_iter().find(|x| x.instrument_id.eq_ignore_ascii_case(option_id));
    let Some(found) = found else {
        return Err(RhError::Protocol("option contract not found (expired, unknown or not licensed for history)".into()));
    };
    let bars = found
        .bars
        .into_iter()
        .filter(|b| !b.interpolated)
        .map(|b| Bar { begins_at: b.begins_at, open_price: b.open_price, high_price: b.high_price, low_price: b.low_price, close_price: b.close_price, volume: None })
        .collect();
    Ok(Historical { symbol: if found.occ_symbol.is_empty() { found.symbol } else { found.occ_symbol }, interval: found.interval, bounds: found.bounds, bars })
}

fn uuid_ok(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// get_option_chains -> get_option_instruments -> get_option_quotes, joined by instrument id.
/// With `expiration` None only the chain (and its expiration list) is fetched. With an expiration, EVERY chain the
/// underlying returned that lists the date is queried and the rows merged (index underlyings such as SPX carry
/// more than one chain); `chain` stays the primary one, and each row's `instrument.chain_symbol` says which chain
/// it came from (adjusted chains show a different symbol, so the ticket can show it).
pub async fn option_chain_with_greeks(
    c: &McpClient,
    symbol: &str,
    expiration: Option<&str>,
) -> Result<OptionChainWithGreeks, RhError> {
    check_symbols(&[symbol.to_string()])?;
    if let Some(e) = expiration {
        if !check_date(e) {
            return Err(bad("expiration"));
        }
    }
    let r = c.call_tool("get_option_chains", json!({"underlying_symbol": symbol})).await?;
    let chains: Vec<OptionChain> = rows_required(data_of(&r)?, "chains")?;
    let chain = chains
        .iter()
        .find(|ch| ch.symbol.eq_ignore_ascii_case(symbol))
        .or(chains.first())
        .cloned()
        .ok_or_else(|| RhError::Tool(format!("no option chain for {symbol}")))?;
    let Some(exp) = expiration else {
        return Ok(OptionChainWithGreeks { chain, rows: vec![] });
    };
    // Primary first, then the others in server order.
    let mut with_exp: Vec<&OptionChain> = Vec::new();
    for ch in std::iter::once(&chain).chain(chains.iter().filter(|c| c.id != chain.id)) {
        if ch.expiration_dates.iter().any(|d| d == exp) && !with_exp.iter().any(|w| w.id == ch.id) {
            with_exp.push(ch);
        }
    }
    if with_exp.is_empty() {
        return Err(RhError::Tool(format!("{symbol} has no expiration {exp}")));
    }
    let mut instruments: Vec<OptionInstrument> = Vec::new();
    for ch in with_exp {
        let part: Vec<OptionInstrument> = paged(
            c,
            "get_option_instruments",
            json!({"chain_id": ch.id, "expiration_dates": exp, "state": "active", "tradability": "tradable"}),
            "instruments",
            MAX_INSTRUMENT_PAGES,
        )
        .await?;
        instruments.extend(part);
    }
    let ids: Vec<&str> = instruments.iter().map(|i| i.id.as_str()).collect();
    let mut quotes_by_id = std::collections::HashMap::new();
    for chunk in ids.chunks(OPTION_QUOTE_CHUNK) {
        let r = c.call_tool("get_option_quotes", json!({"instrument_ids": chunk})).await?;
        for item in rows_required::<Value>(data_of(&r)?, "results")? {
            if let Ok(q) = serde_json::from_value::<OptionQuote>(item.get("quote").cloned().unwrap_or(Value::Null)) {
                quotes_by_id.insert(q.instrument_id.clone(), q);
            }
        }
    }
    let rows = instruments
        .into_iter()
        .map(|instrument| {
            let quote = quotes_by_id.remove(&instrument.id);
            OptionRow { instrument, quote }
        })
        .collect();
    Ok(OptionChainWithGreeks { chain, rows })
}

/// Open option positions joined with contract and quote data (M10). Read tools only:
/// get_option_positions (nonzero, paged) -> get_option_instruments (`ids`, chunks of 20) -> get_option_quotes
/// (chunks of 20). No positions => no further calls. A missing instrument or quote leaves its fields None.
pub async fn option_positions(c: &McpClient, account: &str) -> Result<Vec<OptionPositionRow>, RhError> {
    check_account(account)?;
    let raw: Vec<RawOptionPosition> =
        paged(c, "get_option_positions", json!({"account_number": account, "nonzero": true}), "positions", MAX_POSITION_PAGES).await?;
    // Closed (zero or unreadable quantity) and id-less rows carry nothing we can show or close.
    let raw: Vec<RawOptionPosition> =
        raw.into_iter().filter(|p| !p.option_id.is_empty() && p.quantity.is_some_and(|q| q != 0.0)).collect();
    if raw.is_empty() {
        return Ok(vec![]);
    }
    let mut ids: Vec<&str> = Vec::new();
    for p in &raw {
        if !ids.contains(&p.option_id.as_str()) {
            ids.push(p.option_id.as_str());
        }
    }
    let mut instruments: std::collections::HashMap<String, OptionInstrument> = std::collections::HashMap::new();
    for chunk in ids.chunks(OPTION_POSITION_CHUNK) {
        let part: Vec<OptionInstrument> =
            paged(c, "get_option_instruments", json!({"ids": chunk.join(",")}), "instruments", MAX_INSTRUMENT_PAGES).await?;
        for i in part {
            instruments.insert(i.id.clone(), i);
        }
    }
    // Quotes are best effort: a failed or short chunk leaves the market fields None, never fails the list.
    let mut quotes_by_id: std::collections::HashMap<String, OptionQuote> = std::collections::HashMap::new();
    for chunk in ids.chunks(OPTION_QUOTE_CHUNK) {
        let Ok(r) = c.call_tool("get_option_quotes", json!({"instrument_ids": chunk})).await else { continue };
        let Some(d) = r.data() else { continue };
        for item in rows::<Value>(d, "results") {
            if let Ok(q) = serde_json::from_value::<OptionQuote>(item.get("quote").cloned().unwrap_or(Value::Null)) {
                quotes_by_id.insert(q.instrument_id.clone(), q);
            }
        }
    }
    Ok(raw
        .into_iter()
        .map(|p| {
            let ins = instruments.get(&p.option_id);
            let q = quotes_by_id.get(&p.option_id);
            let qty = p.quantity.unwrap_or(0.0);
            let side = match p.kind.as_deref() {
                Some("long") => "long",
                Some("short") => "short",
                // No type: a negative quantity or a negative (credit) average price means short.
                _ if qty < 0.0 || p.average_price.is_some_and(|a| a < 0.0) => "short",
                _ => "long",
            };
            OptionPositionRow {
                chain_symbol: ins.and_then(|i| i.chain_symbol.clone()).filter(|s| !s.is_empty()).unwrap_or_else(|| p.chain_symbol.clone()),
                expiration_date: ins.and_then(|i| i.expiration_date.clone()).or(p.expiration_date.clone()),
                strike_price: ins.and_then(|i| i.strike_price),
                option_type: ins.and_then(|i| i.option_type.clone()),
                side: side.to_string(),
                quantity: qty.abs(),
                average_price: p.average_price,
                multiplier: p.trade_value_multiplier.filter(|m| *m > 0.0).unwrap_or(100.0),
                bid: q.and_then(|q| q.bid),
                ask: q.and_then(|q| q.ask),
                mark: q.and_then(|q| q.mark),
                delta: q.and_then(|q| q.delta),
                theta: q.and_then(|q| q.theta),
                iv: q.and_then(|q| q.implied_volatility),
                min_ticks: ins.and_then(|i| i.min_ticks.clone()),
                pending_buy: p.pending_buy_quantity,
                pending_sell: p.pending_sell_quantity,
                option_id: p.option_id,
            }
        })
        .collect())
}

pub async fn watchlists(c: &McpClient) -> Result<Vec<Watchlist>, RhError> {
    let r = c.call_tool("get_watchlists", json!({})).await?;
    rows_required(data_of(&r)?, "watchlists")
}

pub async fn watchlist_items(c: &McpClient, list_id: &str) -> Result<WatchlistContents, RhError> {
    if !id_ok(list_id) {
        return Err(bad("watchlist id"));
    }
    let r = match c.call_tool("get_watchlist_items", json!({"list_id": list_id})).await {
        Err(RhError::Tool(t)) if t.contains("options watchlist") => {
            return Err(RhError::Tool(
                "this is an options watchlist: it must be read through get_option_watchlist, not get_watchlist_items".into(),
            ))
        }
        other => other?,
    };
    let d = data_of(&r)?;
    Ok(WatchlistContents {
        display_name: d.get("display_name").and_then(Value::as_str).unwrap_or_default().to_string(),
        items: rows_required(d, "items")?,
    })
}

pub async fn option_watchlist(c: &McpClient) -> Result<OptionWatchlist, RhError> {
    let r = c.call_tool("get_option_watchlist", json!({})).await?;
    let d = data_of(&r)?;
    Ok(OptionWatchlist {
        list_id: d.get("list_id").and_then(Value::as_str).unwrap_or_default().to_string(),
        items: rows_required(d, "items")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rh::limiter::Limiter;
    use crate::rh::testutil::{Mock, Resp, StaticTokens};
    use std::sync::Arc;

    macro_rules! fx {
        ($n:literal) => {
            serde_json::from_str::<Value>(include_str!(concat!("../../tests/fixtures/rh/", $n))).unwrap()
        };
    }

    /// Mock resource server: `f(tool, args)` returns the structuredContent for that call.
    async fn tools<F>(f: F) -> Mock
    where
        F: Fn(&str, &Value) -> Value + Send + Sync + 'static,
    {
        Mock::start(move |req, _| {
            let j = req.json();
            let name = j["params"]["name"].as_str().unwrap_or("").to_string();
            let sc = f(&name, &j["params"]["arguments"]);
            Some(Resp::json(
                200,
                &json!({"jsonrpc":"2.0","id":j["id"],"result":{"content":[{"type":"text","text":sc.to_string()}],"structuredContent":sc}}),
            ))
        })
        .await
    }

    fn client(m: &Mock) -> McpClient {
        McpClient::new(m.url("/mcp"), Arc::new(StaticTokens), Arc::new(Limiter::new(1000, 1000)))
    }

    fn calls(m: &Mock) -> Vec<(String, Value)> {
        m.requests()
            .iter()
            .map(|r| {
                let j = r.json();
                (j["params"]["name"].as_str().unwrap_or("").to_string(), j["params"]["arguments"].clone())
            })
            .collect()
    }

    fn syms(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("S{i}")).collect()
    }

    #[tokio::test]
    async fn accounts_parse_with_nulls_and_extras() {
        let m = tools(|_, _| fx!("accounts.json")).await;
        let a = accounts(&client(&m)).await.unwrap();
        assert_eq!(a.len(), 2, "null element dropped");
        assert_eq!(a[0].account_number, "SYN00000001");
        assert_eq!(a[0].kind.as_deref(), Some("margin"));
        assert_eq!(a[0].unsettled_funds, Some(0.0));
        assert!(a[0].is_default && !a[0].agentic_allowed);
        assert!(a[1].agentic_allowed);
        assert_eq!(a[1].unsettled_funds, None);
        assert_eq!(a[1].option_level, None);
        assert_eq!(a[1].rhc_account_number.as_deref(), Some("RHC0000002"));
        assert_eq!(calls(&m)[0].0, "get_accounts");
    }

    #[tokio::test]
    async fn portfolio_flattens_buying_power_and_passes_account() {
        let m = tools(|_, _| fx!("portfolio.json")).await;
        let p = portfolio(&client(&m), "SYN00000001").await.unwrap();
        assert_eq!(p.total_value, Some(12345.67));
        assert_eq!(p.equity_value, Some(10000.5));
        assert_eq!(p.cash, Some(2000.0));
        assert_eq!(p.buying_power, Some(4000.25));
        assert_eq!(p.currency.as_deref(), Some("USD"));
        assert_eq!(calls(&m)[0], ("get_portfolio".to_string(), json!({"account_number":"SYN00000001"})));
    }

    #[tokio::test]
    async fn empty_and_null_payloads_do_not_break_mappers() {
        let m = tools(|_, _| json!({"data":{"accounts":null,"positions":null,"orders":null,"results":null,"watchlists":null}})).await;
        let c = client(&m);
        assert!(accounts(&c).await.unwrap().is_empty());
        assert!(positions(&c, "A1").await.unwrap().is_empty());
        assert!(quotes(&c, &["AAA".to_string()]).await.unwrap().is_empty());
        assert!(watchlists(&c).await.unwrap().is_empty());
        // Changed 2026-11-11 (R10c): `{}` is now a shape error; known fields that are null still map to None.
        let m2 = tools(|_, _| json!({"data":{"total_value":null}})).await;
        let p = portfolio(&client(&m2), "A1").await.unwrap();
        assert_eq!(p, Portfolio::default());
    }

    #[tokio::test]
    async fn non_json_text_is_a_protocol_error() {
        let m = Mock::start(|req, _| {
            Some(Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"content":[{"type":"text","text":"hello there"}]}})))
        })
        .await;
        let e = accounts(&client(&m)).await.unwrap_err();
        assert!(matches!(e, RhError::Protocol(_)), "{e:?}");
    }

    #[tokio::test]
    async fn positions_merge_two_pages_via_opaque_cursor() {
        let m = tools(|_, args| if args.get("cursor").is_none() { fx!("positions_page1.json") } else { fx!("positions_page2.json") }).await;
        let p = positions(&client(&m), "SYN00000001").await.unwrap();
        assert_eq!(p.iter().map(|x| x.symbol.as_str()).collect::<Vec<_>>(), ["AAA", "BBB", "CCC"]);
        assert_eq!(p[0].quantity, Some(10.0));
        assert_eq!(p[0].average_buy_price, Some(100.5));
        assert_eq!(p[1].quantity, Some(2.5));
        assert_eq!(p[1].average_buy_price, None);
        assert_eq!(p[2].shares_held_for_sells, Some(20.0));
        let cs = calls(&m);
        assert_eq!(cs.len(), 2);
        assert_eq!(cs[0].1, json!({"account_number":"SYN00000001"}));
        assert_eq!(cs[1].1, json!({"account_number":"SYN00000001","cursor":"cursor-page-2"}));
    }

    #[tokio::test]
    async fn a_repeating_cursor_cannot_loop_forever() {
        let m = tools(|_, _| json!({"data":{"positions":[{"symbol":"X"}],"next":"same"}})).await;
        let p = positions(&client(&m), "A1").await.unwrap();
        assert!(p.len() <= 2 && m.count() <= 2, "{} calls", m.count());
    }

    #[tokio::test]
    async fn orders_merge_equity_and_option_newest_first_with_state_filter() {
        let m = tools(|name, _| if name == "get_equity_orders" { fx!("equity_orders.json") } else { fx!("option_orders.json") }).await;
        let o = orders(&client(&m), "SYN00000001", Some("filled")).await.unwrap();
        assert_eq!(o.iter().map(|x| x.id.as_str()).collect::<Vec<_>>(), ["oo-1", "eo-2", "eo-1"]);
        assert_eq!(o[0].asset, "option");
        assert_eq!(o[0].symbol.as_deref(), Some("AAA"));
        assert_eq!(o[0].side.as_deref(), Some("credit"));
        assert_eq!(o[0].legs.len(), 1);
        assert_eq!(o[0].legs[0].strike_price, Some(95.0));
        assert_eq!(o[0].legs[0].option_type.as_deref(), Some("put"));
        assert_eq!(o[1].asset, "equity");
        assert_eq!(o[1].dollar_based_amount, Some(250.0));
        assert_eq!(o[1].quantity, None);
        assert_eq!(o[2].order_type.as_deref(), Some("limit"));
        assert_eq!(o[2].average_price, Some(100.45));
        let cs = calls(&m);
        assert!(cs.iter().all(|(_, a)| a["state"] == "filled" && a["account_number"] == "SYN00000001"));
        let m2 = tools(|_, _| json!({"data":{"orders":[]}})).await;
        orders(&client(&m2), "A1", None).await.unwrap();
        assert!(calls(&m2).iter().all(|(_, a)| a.get("state").is_none()));
    }

    #[tokio::test]
    async fn quotes_chunk_45_symbols_into_3_calls() {
        let m = tools(|_, args| {
            let results: Vec<Value> = args["symbols"].as_array().unwrap().iter().map(|s| json!({"quote":{"symbol":s,"last_trade_price":"1.5"}})).collect();
            json!({"data":{"results":results}})
        })
        .await;
        let q = quotes(&client(&m), &syms(45)).await.unwrap();
        assert_eq!(q.len(), 45);
        let sizes: Vec<usize> = calls(&m).iter().map(|(_, a)| a["symbols"].as_array().unwrap().len()).collect();
        assert_eq!(sizes, [20, 20, 5]);
        assert!(calls(&m).iter().all(|(n, _)| n == "get_equity_quotes"));
        assert_eq!(q[0].last_trade_price, Some(1.5));
        let m0 = tools(|_, _| json!({"data":{}})).await;
        assert!(quotes(&client(&m0), &[]).await.unwrap().is_empty());
        assert_eq!(m0.count(), 0, "no symbols, no calls");
    }

    #[tokio::test]
    async fn quote_fixture_handles_blank_null_and_string_numbers() {
        let m = tools(|_, _| fx!("quotes.json")).await;
        let q = quotes(&client(&m), &["AAA".into(), "BBB".into()]).await.unwrap();
        assert_eq!(q[0].last_trade_price, Some(101.25));
        assert_eq!(q[0].previous_close, Some(100.0));
        assert_eq!(q[0].bid_price, Some(101.2));
        assert_eq!(q[1].last_trade_price, None);
        assert_eq!(q[1].previous_close, Some(20.5));
        assert_eq!(q[1].bid_price, None, "empty string is not a number");
    }

    #[tokio::test]
    async fn historicals_chunk_25_symbols_into_3_calls_and_send_start_time() {
        let m = tools(|_, args| {
            let r: Vec<Value> = args["symbols"].as_array().unwrap().iter().map(|s| json!({"symbol":s,"bars":[]})).collect();
            json!({"data":{"results":r}})
        })
        .await;
        let h = historicals(&client(&m), &syms(25), "2026-01-01T00:00:00Z", Some("day")).await.unwrap();
        assert_eq!(h.len(), 25);
        let cs = calls(&m);
        assert_eq!(cs.iter().map(|(_, a)| a["symbols"].as_array().unwrap().len()).collect::<Vec<_>>(), [10, 10, 5]);
        assert!(cs.iter().all(|(n, a)| n == "get_equity_historicals" && a["start_time"] == "2026-01-01T00:00:00Z" && a["interval"] == "day"));
    }

    #[tokio::test]
    async fn historical_bars_parse() {
        let m = tools(|_, _| fx!("historicals.json")).await;
        let h = historicals(&client(&m), &["AAA".into()], "2026-01-01T00:00:00Z", None).await.unwrap();
        assert_eq!(h[0].bars.len(), 2);
        assert_eq!(h[0].bars[0].close_price, Some(101.0));
        assert_eq!(h[0].bars[0].volume, Some(123456.0));
        assert_eq!(h[0].bars[1].volume, Some(98765.0), "string volume");
        assert!(calls(&m)[0].1.get("interval").is_none());
    }

    #[test]
    fn civil_date_known_days() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(20_453), "2025-12-31");
        assert_eq!(civil_date(20_576), "2026-05-03");
    }

    fn er(rows: Value) -> Value {
        json!({"data":{"results":rows},"guide":"g"}).get("data").cloned().unwrap()
    }

    #[tokio::test]
    async fn earnings_picks_the_nearest_future_row_as_next_and_the_latest_past_as_last() {
        let m = tools(|_, _| json!({"data":{"results":[
            {"symbol":"AAA","year":2026,"quarter":1,"eps":{"estimate":"1","actual":"1.1"},"report":{"date":"2026-02-01","timing":"pm","verified":true}},
            {"symbol":"AAA","year":2026,"quarter":3,"eps":{"estimate":"1","actual":"1.2"},"report":{"date":"2026-08-01","timing":"am","verified":true}},
            null,
            {"symbol":"AAA","year":2026,"quarter":4,"eps":{"estimate":"1","actual":null},"report":{"date":"2026-12-10","timing":"pm","verified":false}},
            {"symbol":"AAA","year":2027,"quarter":1,"eps":{"estimate":null,"actual":null},"report":{"date":"2027-02-10","timing":null,"verified":false}},
            {"symbol":"AAA","year":2027,"quarter":2,"eps":{"estimate":null,"actual":null},"report":null}
        ]},"guide":"g"})).await;
        let e = earnings_at(&client(&m), "AAA", "2026-11-11").await.unwrap();
        assert_eq!(e.next, Some(EarningsEvent { date: "2026-12-10".into(), timing: Some("pm".into()), verified: false }));
        assert_eq!(e.last, Some(EarningsEvent { date: "2026-08-01".into(), timing: Some("am".into()), verified: true }));
        let cs = calls(&m);
        assert_eq!(cs, vec![("get_earnings_results".to_string(), json!({"symbol":"AAA"}))], "only get_earnings_results is called");
    }

    #[test]
    fn earnings_today_counts_as_next_ties_keep_response_order_and_past_only_is_none() {
        let d = er(json!([
            {"report":{"date":"2026-11-11","timing":"am","verified":true}},
            {"report":{"date":"2026-11-11","timing":"pm","verified":true}}
        ]));
        let e = earnings_from(&d, "2026-11-11").unwrap();
        assert_eq!(e.next.unwrap().timing.as_deref(), Some("am"), "tie goes to the first row");
        let past = er(json!([{"report":{"date":"2026-08-01","timing":"am","verified":true}}]));
        let e = earnings_from(&past, "2026-11-11").unwrap();
        assert_eq!(e.next, None);
        assert_eq!(e.last.unwrap().date, "2026-08-01");
        let e = earnings_from(&er(json!([])), "2026-11-11").unwrap();
        assert_eq!((e.next, e.last), (None, None));
        let e = earnings_from(&er(Value::Null), "2026-11-11").unwrap();
        assert_eq!((e.next, e.last), (None, None));
    }

    #[test]
    fn earnings_odd_shapes_are_protocol_errors_not_panics() {
        for d in [json!({}), json!({"results":"nope"}), json!({"results":{"a":1}}), json!(null), json!([1, 2])] {
            let e = earnings_from(&d, "2026-11-11").unwrap_err();
            assert!(matches!(e, RhError::Protocol(_)), "{d}: {e:?}");
        }
        // Odd rows inside a valid list are skipped.
        let d = er(json!([1, "x", {"report":"soon"}, {"report":{"date":"tomorrow"}}, {"report":{"date":null}}, {"report":{"date":"2026-12-01","timing":"noon"}}]));
        let e = earnings_from(&d, "2026-11-11").unwrap();
        let n = e.next.unwrap();
        assert_eq!((n.date.as_str(), n.timing, n.verified), ("2026-12-01", None, false));
    }

    #[tokio::test]
    async fn earnings_invalid_symbol_is_rejected_before_any_call() {
        let m = tools(|_, _| json!({"data":{"results":[]}})).await;
        let c = client(&m);
        for s in ["", "AAPL; DROP", "A B", "WAYTOOLONGSYMBOL1", "AA\nPL"] {
            assert!(earnings(&c, s).await.is_err(), "{s:?}");
        }
        assert_eq!(m.count(), 0, "nothing was sent");
        assert!(earnings(&c, "BRK.B").await.is_ok());
        assert_eq!(m.count(), 1);
    }

    #[tokio::test]
    async fn option_historicals_parse_drop_interpolated_and_send_one_id() {
        let id = "0f3c2a1e-5b7d-4c9a-8e21-3a4b5c6d7e8f";
        let m = tools(|_, _| fx!("option_historicals.json")).await;
        let h = option_historicals(&client(&m), id, "2026-11-01T00:00:00Z", Some("day"), Some("regular")).await.unwrap();
        assert_eq!(h.bars.len(), 2, "interpolated bar and null element dropped");
        assert_eq!(h.bars[0].close_price, Some(1.25));
        assert_eq!(h.bars[0].volume, None, "options carry no volume");
        assert_eq!(h.bars[1].high_price, Some(1.6));
        assert_eq!(h.interval.as_deref(), Some("day"));
        let cs = calls(&m);
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].0, "get_option_historicals");
        assert_eq!(cs[0].1["instrument_ids"], json!([id]));
        assert_eq!(cs[0].1["start_time"], "2026-11-01T00:00:00Z");
        assert_eq!(cs[0].1["interval"], "day");
        assert_eq!(cs[0].1["bounds"], "regular");
        let m2 = tools(|_, _| fx!("option_historicals.json")).await;
        option_historicals(&client(&m2), id, "2026-11-01T00:00:00Z", None, None).await.unwrap();
        let a = &calls(&m2)[0].1;
        assert!(a.get("interval").is_none() && a.get("bounds").is_none());
    }

    #[tokio::test]
    async fn option_historicals_unknown_contract_is_an_error() {
        let id = "0f3c2a1e-5b7d-4c9a-8e21-3a4b5c6d7e8f";
        let m = tools(move |_, _| json!({"data":{"results":[],"not_found":[id]}})).await;
        let e = option_historicals(&client(&m), id, "2026-11-01T00:00:00Z", Some("day"), None).await.unwrap_err();
        assert!(e.to_string().contains("not found"), "{e}");
        let m2 = tools(|_, _| json!({"data":{"results":[{"instrument_id":"11111111-1111-4111-8111-111111111111","bars":[]}]}})).await;
        assert!(option_historicals(&client(&m2), id, "2026-11-01T00:00:00Z", None, None).await.is_err(), "result for another contract");
    }

    #[tokio::test]
    async fn option_historicals_validate_before_any_call() {
        let m = tools(|_, _| fx!("option_historicals.json")).await;
        let c = client(&m);
        let id = "0f3c2a1e-5b7d-4c9a-8e21-3a4b5c6d7e8f";
        for bad_id in ["", "nope", "0f3c2a1e-5b7d-4c9a-8e21-3a4b5c6d7e8", "0f3c2a1e-5b7d-4c9a-8e21-3a4b5c6d7e8g", "AAPL", "0f3c2a1e5b7d4c9a8e213a4b5c6d7e8f"] {
            assert!(option_historicals(&c, bad_id, "2026-11-01T00:00:00Z", None, None).await.is_err(), "{bad_id}");
        }
        assert!(option_historicals(&c, id, "yesterday", None, None).await.is_err());
        assert!(option_historicals(&c, id, "2026-11-01T00:00:00Z", Some("bogus"), None).await.is_err());
        assert!(option_historicals(&c, id, "2026-11-01T00:00:00Z", None, Some("extended")).await.is_err(), "options only allow regular, 24_5, 24_7");
        assert_eq!(m.count(), 0, "nothing was sent");
    }

    #[tokio::test]
    async fn option_chain_calls_in_order_and_joins_greeks_by_instrument_id() {
        let m = tools(|name, _| match name {
            "get_option_chains" => fx!("option_chains.json"),
            "get_option_instruments" => fx!("option_instruments.json"),
            "get_option_quotes" => fx!("option_quotes.json"),
            _ => json!({}),
        })
        .await;
        let r = option_chain_with_greeks(&client(&m), "AAA", Some("2026-02-20")).await.unwrap();
        let cs = calls(&m);
        assert_eq!(cs.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["get_option_chains", "get_option_instruments", "get_option_quotes"]);
        assert_eq!(cs[0].1, json!({"underlying_symbol":"AAA"}));
        assert_eq!(cs[1].1["chain_id"], "chain-1");
        assert_eq!(cs[1].1["expiration_dates"], "2026-02-20");
        assert_eq!(cs[2].1["instrument_ids"], json!(["opt-1", "opt-2"]));
        assert_eq!(r.chain.expiration_dates, ["2026-02-20", "2026-03-20"]);
        assert_eq!(r.rows.len(), 2);
        let put = &r.rows[0];
        assert_eq!(put.instrument.strike_price, Some(95.0));
        assert_eq!(put.instrument.option_type.as_deref(), Some("put"));
        let q = put.quote.as_ref().unwrap();
        assert_eq!((q.bid, q.ask, q.mark), (Some(1.2), Some(1.3), Some(1.25)));
        assert_eq!((q.delta, q.gamma, q.theta, q.vega, q.rho), (Some(-0.22), Some(0.03), Some(-0.04), Some(0.09), Some(-0.01)));
        assert_eq!(q.implied_volatility, Some(0.31));
        assert_eq!(q.open_interest, Some(1200.0));
        let call = r.rows[1].quote.as_ref().unwrap();
        assert_eq!(call.instrument_id, "opt-2");
        assert_eq!(call.delta, Some(0.51));
        assert_eq!(call.implied_volatility, None);
        assert_eq!(call.open_interest, Some(800.0));
    }

    #[tokio::test]
    async fn option_chain_unknown_expiration_errors_and_none_returns_chain_only() {
        let m = tools(|_, _| fx!("option_chains.json")).await;
        let e = option_chain_with_greeks(&client(&m), "AAA", Some("2030-01-01")).await.unwrap_err();
        assert!(matches!(e, RhError::Tool(_)), "{e:?}");
        let m2 = tools(|_, _| fx!("option_chains.json")).await;
        let r = option_chain_with_greeks(&client(&m2), "AAA", None).await.unwrap();
        assert!(r.rows.is_empty());
        assert_eq!(m2.count(), 1);
    }

    /// Synthetic mock for the option-positions chain: `n` positions p0..; instruments and quotes joined by id.
    fn opt_pos_mock(n: usize, skip_instrument: Option<&'static str>, skip_quote: Option<&'static str>) -> impl Fn(&str, &Value) -> Value + Send + Sync + 'static {
        move |name, args| match name {
            "get_option_positions" => {
                let ps: Vec<Value> = (0..n)
                    .map(|i| {
                        json!({"option_id": format!("p{i}"), "chain_symbol": "AAA", "expiration_date": "2026-11-20",
                               "quantity": if i % 2 == 0 { "2.0000" } else { "1" }, "type": if i % 2 == 0 { "long" } else { "short" },
                               "average_price": if i % 2 == 0 { "150.0000" } else { "-80.0000" },
                               "trade_value_multiplier": "100.0000", "pending_buy_quantity": "0", "pending_sell_quantity": "1"})
                    })
                    .collect();
                json!({"data":{"positions":ps,"next":""}})
            }
            "get_option_instruments" => {
                let ids: Vec<&str> = args["ids"].as_str().unwrap().split(',').collect();
                let ins: Vec<Value> = ids
                    .iter()
                    .filter(|id| Some(**id) != skip_instrument)
                    .map(|id| json!({"id":id,"chain_id":"c1","chain_symbol":"AAA","expiration_date":"2026-11-20","strike_price":"150.0000","type":"call","min_ticks":{"above_tick":"0.05","below_tick":"0.01","cutoff_price":"3.00"}}))
                    .collect();
                json!({"data":{"instruments":ins,"next":""}})
            }
            "get_option_quotes" => {
                let ids = args["instrument_ids"].as_array().unwrap();
                let rs: Vec<Value> = ids
                    .iter()
                    .filter(|id| id.as_str() != skip_quote)
                    .map(|id| json!({"quote":{"instrument_id":id,"bid_price":"1.20","ask_price":"1.30","mark_price":"1.25","delta":"0.45","theta":"-0.03","implied_volatility":"0.40"}}))
                    .collect();
                json!({"data":{"results":rs}})
            }
            _ => json!({}),
        }
    }

    #[tokio::test]
    async fn option_positions_join_by_option_id_with_units_rule() {
        let m = tools(opt_pos_mock(2, None, None)).await;
        let r = option_positions(&client(&m), "SYN00000001").await.unwrap();
        let cs = calls(&m);
        assert_eq!(cs.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>(), ["get_option_positions", "get_option_instruments", "get_option_quotes"]);
        assert_eq!(cs[0].1, json!({"account_number":"SYN00000001","nonzero":true}));
        assert_eq!(cs[1].1, json!({"ids":"p0,p1"}));
        assert_eq!(cs[2].1, json!({"instrument_ids":["p0","p1"]}));
        assert_eq!(r.len(), 2);
        let l = &r[0];
        assert_eq!((l.option_id.as_str(), l.chain_symbol.as_str(), l.side.as_str()), ("p0", "AAA", "long"));
        assert_eq!((l.strike_price, l.option_type.as_deref(), l.expiration_date.as_deref()), (Some(150.0), Some("call"), Some("2026-11-20")));
        // Units: quantity = contracts (positive); average_price = signed DOLLARS PER CONTRACT; multiplier 100.
        assert_eq!((l.quantity, l.average_price, l.multiplier), (2.0, Some(150.0), 100.0));
        assert_eq!((l.bid, l.ask, l.mark), (Some(1.2), Some(1.3), Some(1.25)));
        assert_eq!((l.delta, l.theta, l.iv), (Some(0.45), Some(-0.03), Some(0.4)));
        assert_eq!(l.min_ticks.as_ref().and_then(|t| t.above_tick), Some(0.05));
        assert_eq!((l.pending_buy, l.pending_sell), (Some(0.0), Some(1.0)));
        let s = &r[1];
        assert_eq!((s.side.as_str(), s.quantity, s.average_price), ("short", 1.0, Some(-80.0)));
    }

    #[tokio::test]
    async fn option_positions_chunk_45_into_3_instrument_and_3_quote_calls() {
        let m = tools(opt_pos_mock(45, None, None)).await;
        let r = option_positions(&client(&m), "A1").await.unwrap();
        assert_eq!(r.len(), 45);
        let cs = calls(&m);
        let inst: Vec<usize> = cs.iter().filter(|(n, _)| n == "get_option_instruments").map(|(_, a)| a["ids"].as_str().unwrap().split(',').count()).collect();
        let quo: Vec<usize> = cs.iter().filter(|(n, _)| n == "get_option_quotes").map(|(_, a)| a["instrument_ids"].as_array().unwrap().len()).collect();
        assert_eq!(inst, [20, 20, 5]);
        assert_eq!(quo, [20, 20, 5]);
        assert!(r.iter().all(|x| x.mark == Some(1.25)));
    }

    #[tokio::test]
    async fn option_positions_tolerate_a_missing_instrument_or_quote() {
        let m = tools(opt_pos_mock(3, Some("p1"), Some("p2"))).await;
        let r = option_positions(&client(&m), "A1").await.unwrap();
        assert_eq!(r.len(), 3, "a missing join never drops the position");
        assert_eq!((r[1].strike_price, r[1].option_type.clone(), r[1].min_ticks.clone()), (None, None, None));
        assert_eq!(r[1].mark, Some(1.25), "quote still joined");
        assert_eq!((r[2].bid, r[2].ask, r[2].mark, r[2].delta, r[2].theta, r[2].iv), (None, None, None, None, None, None));
        assert_eq!(r[2].strike_price, Some(150.0));
        assert_eq!(r[2].expiration_date.as_deref(), Some("2026-11-20"), "falls back to the position's own expiry");
    }

    #[tokio::test]
    async fn option_positions_null_or_empty_positions_make_no_further_calls() {
        for payload in [json!({"data":{"positions":null}}), json!({"data":{"positions":[],"next":""}})] {
            let m = tools(move |_, _| payload.clone()).await;
            assert!(option_positions(&client(&m), "A1").await.unwrap().is_empty());
            assert_eq!(m.count(), 1);
        }
        let m = tools(|_, _| json!({"data":{}})).await;
        assert!(matches!(option_positions(&client(&m), "A1").await, Err(RhError::Protocol(_))), "missing key is a shape error");
        assert!(option_positions(&client(&m), "bad account!").await.is_err());
    }

    #[tokio::test]
    async fn option_positions_page_and_drop_zero_or_unlabelled_rows() {
        let m = tools(|name, args| match name {
            "get_option_positions" if args.get("cursor").is_none() => json!({"data":{"positions":[
                {"option_id":"a","chain_symbol":"AAA","quantity":"1","type":"long","average_price":"10","trade_value_multiplier":"100"},
                {"option_id":"z","chain_symbol":"AAA","quantity":"0","type":"long"}],"next":"c2"}}),
            "get_option_positions" => json!({"data":{"positions":[
                {"option_id":"b","chain_symbol":"BBB","quantity":"3","average_price":"-5"},
                {"chain_symbol":"NOID","quantity":"1"}],"next":""}}),
            "get_option_instruments" => json!({"data":{"instruments":[]}}),
            _ => json!({"data":{"results":[]}}),
        })
        .await;
        let r = option_positions(&client(&m), "A1").await.unwrap();
        assert_eq!(r.iter().map(|x| x.option_id.as_str()).collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(r[1].multiplier, 100.0, "multiplier defaults to 100 when absent");
        assert_eq!(r[1].side, "short", "side falls back to the sign of average_price when type is missing");
        let cs = calls(&m);
        assert_eq!(cs[1].1, json!({"account_number":"A1","nonzero":true,"cursor":"c2"}));
        assert_eq!(cs[2].1, json!({"ids":"a,b"}));
    }

    #[test]
    fn chain_and_instrument_min_ticks_parse_and_tolerate_null() {
        let c: OptionChain = serde_json::from_value(json!({"id":"c","min_ticks":{"above_tick":"0.05","below_tick":0.01,"cutoff_price":"3.00"}})).unwrap();
        assert_eq!(c.min_ticks, Some(MinTicks { above_tick: Some(0.05), below_tick: Some(0.01), cutoff_price: Some(3.0) }));
        for v in [json!({"id":"c"}), json!({"id":"c","min_ticks":null}), json!({"id":"c","min_ticks":"x"})] {
            assert_eq!(serde_json::from_value::<OptionChain>(v).unwrap().min_ticks, None);
        }
    }

    /// The read is typed and read-only: only the three get_ tools it needs appear in its source.
    #[test]
    fn option_positions_uses_only_read_tools() {
        let src = include_str!("reads.rs");
        let body = &src[src.find("pub async fn option_positions").unwrap()..src.find("pub async fn watchlists").unwrap()];
        for t in ["get_option_positions", "get_option_instruments", "get_option_quotes"] {
            assert!(body.contains(t), "{t}");
        }
        for bad in ["place_", "cancel_", "review_", "create_", "update_", "add_", "remove_", "delete_"] {
            assert!(!body.contains(&format!("\"{bad}")), "{bad}");
        }
    }

    #[tokio::test]
    async fn watchlists_and_items() {
        let m = tools(|n, _| match n {
            "get_watchlists" => fx!("watchlists.json"),
            "get_watchlist_items" => fx!("watchlist_items.json"),
            _ => fx!("realized_pnl.json"),
        })
        .await;
        let c = client(&m);
        let w = watchlists(&c).await.unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!(w[0].item_count, Some(3.0));
        assert_eq!(w[1].item_count, Some(0.0), "string integer");
        let i = watchlist_items(&c, "wl-1").await.unwrap();
        assert_eq!(i.display_name, "Synthetic list");
        assert_eq!(i.items.iter().map(|x| x.symbol.as_str()).collect::<Vec<_>>(), ["AAA", "BBB", "BTC-USD"]);
        assert_eq!(calls(&m)[1], ("get_watchlist_items".to_string(), json!({"list_id":"wl-1"})));
    }

    #[tokio::test]
    async fn watchlists_flag_options_lists_leniently() {
        let m = tools(|_, _| fx!("watchlists_with_options.json")).await;
        let w = watchlists(&client(&m)).await.unwrap();
        assert_eq!(w.len(), 3);
        assert!(!w[0].is_options());
        assert!(w[1].is_options());
        assert_eq!(w[1].allowed_object_types, ["option_strategy"]);
        assert!(w[2].allowed_object_types.is_empty() && !w[2].is_options(), "null => empty");
    }

    #[tokio::test]
    async fn option_watchlist_calls_dedicated_tool_with_empty_args() {
        let m = tools(|_, _| fx!("option_watchlist.json")).await;
        let o = option_watchlist(&client(&m)).await.unwrap();
        assert_eq!(calls(&m), [("get_option_watchlist".to_string(), json!({}))]);
        assert_eq!(o.list_id, "wl-opt");
        assert_eq!(o.items.len(), 3);
        assert_eq!(o.items[0].chain_symbol, "AAA");
        assert_eq!(o.items[0].strike_price, Some(150.0));
        assert_eq!(o.items[0].contract_type.as_deref(), Some("call"));
        assert_eq!(o.items[0].option_ids, ["opt-1"]);
        assert_eq!(o.items[1].strike_price, Some(42.5));
        assert_eq!(o.items[1].expiration_date, None);
        assert!(o.items[1].option_ids.is_empty());
        assert_eq!(o.items[2].name, "");
    }

    #[tokio::test]
    async fn option_watchlist_empty_payload_is_empty() {
        // Changed 2026-11-11 (R10c): a missing `items` key is a shape error; an empty or null list is empty.
        let m = tools(|_, _| json!({"data":{"items":null}})).await;
        let o = option_watchlist(&client(&m)).await.unwrap();
        assert!(o.items.is_empty());
    }

    #[tokio::test]
    async fn watchlist_items_options_400_gets_a_clear_message() {
        let m = Mock::start(|req, _| {
            Some(Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"isError":true,"content":[{"type":"text","text":"API error 400: {\"non_field_errors\":[\"load_all_attributes is not supported for options watchlist\"]}"}]}})))
        })
        .await;
        let e = watchlist_items(&client(&m), "wl-opt").await.unwrap_err();
        match e {
            RhError::Tool(t) => assert!(t.contains("get_option_watchlist"), "{t}"),
            other => panic!("{other:?}"),
        }
    }

    #[tokio::test]
    async fn watchlist_items_other_tool_errors_pass_through() {
        let m = Mock::start(|req, _| {
            Some(Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"isError":true,"content":[{"type":"text","text":"boom"}]}})))
        })
        .await;
        let e = watchlist_items(&client(&m), "wl-1").await.unwrap_err();
        assert_eq!(e, RhError::Tool("boom".into()));
    }

    #[tokio::test]
    async fn bad_arguments_are_rejected_before_any_request() {
        let m = tools(|_, _| json!({"data":{}})).await;
        let c = client(&m);
        assert!(quotes(&c, &["a b".to_string()]).await.is_err());
        assert!(quotes(&c, &["X".repeat(40)]).await.is_err());
        assert!(quotes(&c, &syms(MAX_SYMBOLS + 1)).await.is_err());
        assert!(positions(&c, "").await.is_err());
        assert!(positions(&c, "bad account!").await.is_err());
        assert!(historicals(&c, &["AAA".into()], "yesterday", None).await.is_err());
        assert!(historicals(&c, &["AAA".into()], "2026-01-01T00:00:00Z", Some("bogus")).await.is_err());
        assert!(option_chain_with_greeks(&c, "AAA", Some("02/20/2026")).await.is_err());
        assert!(watchlist_items(&c, "x y").await.is_err());
        assert!(orders(&c, "A1", Some("filled; drop")).await.is_err());
        assert_eq!(m.count(), 0);
    }

    /// R10b: each orders tool gets only a state from ITS schema list; a tool whose list lacks the state is skipped.
    #[tokio::test]
    async fn order_state_filter_is_per_tool() {
        let m = tools(|_, _| json!({"data":{"orders":[]}})).await;
        let c = client(&m);
        orders(&c, "A1", Some("new")).await.unwrap();
        orders(&c, "A1", Some("pending_cancelled")).await.unwrap();
        orders(&c, "A1", Some("filled")).await.unwrap();
        let cs = calls(&m);
        let got: Vec<(&str, &str)> = cs.iter().map(|(n, a)| (n.as_str(), a["state"].as_str().unwrap_or(""))).collect();
        assert_eq!(
            got,
            [("get_equity_orders", "new"), ("get_option_orders", "pending_cancelled"), ("get_equity_orders", "filled"), ("get_option_orders", "filled")]
        );
        let before = m.count();
        for bad in ["locating", "partially_filled_rest_cancelled", "bogus"] {
            assert!(orders(&c, "A1", Some(bad)).await.is_err(), "{bad}");
        }
        assert_eq!(m.count(), before);
    }

    /// R10c: a MISSING list key is a shape error; JSON null stays an empty list.
    #[tokio::test]
    async fn missing_list_keys_are_errors_but_null_is_empty() {
        let m = tools(|_, _| json!({"data":{}})).await;
        let c = client(&m);
        for r in [
            accounts(&c).await.map(|_| ()),
            positions(&c, "A1").await.map(|_| ()),
            orders(&c, "A1", None).await.map(|_| ()),
            quotes(&c, &["AAA".to_string()]).await.map(|_| ()),
            historicals(&c, &["AAA".to_string()], "2026-01-01T00:00:00Z", None).await.map(|_| ()),
            watchlists(&c).await.map(|_| ()),
            watchlist_items(&c, "wl-1").await.map(|_| ()),
            option_watchlist(&c).await.map(|_| ()),
            option_chain_with_greeks(&c, "AAA", None).await.map(|_| ()),
        ] {
            assert!(matches!(&r, Err(RhError::Protocol(t)) if t.contains("unexpected response shape")), "{r:?}");
        }
        let m2 = tools(|_, _| json!({"data":{"accounts":null,"items":null,"list_id":"x"}})).await;
        assert!(accounts(&client(&m2)).await.unwrap().is_empty());
        assert!(option_watchlist(&client(&m2)).await.unwrap().items.is_empty());
    }

    /// R10c: a portfolio payload with none of the expected fields is not a zero-valued portfolio.
    #[tokio::test]
    async fn portfolio_needs_at_least_one_expected_field() {
        let m = tools(|_, _| json!({"data":{"unexpected":1}})).await;
        assert!(matches!(portfolio(&client(&m), "A1").await, Err(RhError::Protocol(t)) if t.contains("unexpected response shape")));
        let m2 = tools(|_, _| json!({"data":{"cash":"12.5"}})).await;
        assert_eq!(portfolio(&client(&m2), "A1").await.unwrap().cash, Some(12.5));
    }

    /// R10d: every chain listing the expiration is queried (merged), with tradability=tradable.
    #[tokio::test]
    async fn option_chain_queries_every_chain_with_the_expiration() {
        let m = tools(|name, args| match name {
            "get_option_chains" => json!({"data":{"chains":[
                {"id":"chain-1","symbol":"SPX","expiration_dates":["2026-02-20"]},
                {"id":"chain-2","symbol":"SPXW","expiration_dates":["2026-02-19","2026-02-20"]},
                {"id":"chain-3","symbol":"SPX1","expiration_dates":["2026-03-20"]}
            ]}}),
            "get_option_instruments" => {
                let id = if args["chain_id"] == "chain-1" { "opt-a" } else { "opt-b" };
                json!({"data":{"instruments":[{"id":id,"chain_id":args["chain_id"],"strike_price":"100","type":"call"}],"next":""}})
            }
            _ => json!({"data":{"results":[]}}),
        })
        .await;
        let r = option_chain_with_greeks(&client(&m), "SPX", Some("2026-02-20")).await.unwrap();
        assert_eq!(r.chain.id, "chain-1");
        assert_eq!(r.rows.iter().map(|x| x.instrument.id.as_str()).collect::<Vec<_>>(), ["opt-a", "opt-b"]);
        let inst: Vec<Value> = calls(&m).into_iter().filter(|(n, _)| n == "get_option_instruments").map(|(_, a)| a).collect();
        assert_eq!(inst.len(), 2);
        assert_eq!(inst[0]["chain_id"], "chain-1");
        assert_eq!(inst[1]["chain_id"], "chain-2");
        assert!(inst.iter().all(|a| a["tradability"] == "tradable" && a["state"] == "active" && a["expiration_dates"] == "2026-02-20"));
    }

    /// R10e: the dead realized-P&L read (it sent the plain account number) is gone; `pnl` owns that tool.
    #[test]
    fn reads_no_longer_calls_realized_pnl() {
        let src = include_str!("reads.rs");
        let needle = concat!("\"get_realized", "_pnl\"");
        assert!(!src.contains(needle));
    }

    /// R10a: orders carry `trigger` and `stop_price` (the frontend derives stop_limit / stop_market from them).
    #[test]
    fn orders_carry_trigger_and_stop_price() {
        let o: Order = serde_json::from_value(json!({"id":"x","type":"limit","trigger":"stop","stop_price":"9.50","price":"9.40"})).unwrap();
        assert_eq!((o.order_type.as_deref(), o.trigger.as_deref(), o.stop_price), (Some("limit"), Some("stop"), Some(9.5)));
        let j = serde_json::to_value(&o).unwrap();
        assert_eq!((j["order_type"].clone(), j["trigger"].clone(), j["stop_price"].clone()), (json!("limit"), json!("stop"), json!(9.5)));
    }

    #[test]
    fn lenient_numbers() {
        #[derive(Deserialize)]
        struct T {
            #[serde(default, deserialize_with = "de_f64_opt")]
            n: Option<f64>,
        }
        let p = |s: &str| serde_json::from_str::<T>(s).unwrap().n;
        assert_eq!(p(r#"{"n":"1.5"}"#), Some(1.5));
        assert_eq!(p(r#"{"n":2}"#), Some(2.0));
        assert_eq!(p(r#"{"n":null}"#), None);
        assert_eq!(p(r#"{}"#), None);
        assert_eq!(p(r#"{"n":"abc"}"#), None);
        assert_eq!(p(r#"{"n":{"a":1}}"#), None);
        assert_eq!(p(r#"{"n":"NaN"}"#), None);
    }
}
