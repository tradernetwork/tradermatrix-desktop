//! Typed views of Robinhood read-tool payloads (the `data` object inside `structuredContent`).
//!
//! The API sends numbers as strings, sometimes as numbers, sometimes null, and omits optional fields.
//! Every numeric field goes through `de_f64_opt`; every string, bool and list is null-tolerant. Unknown
//! fields are ignored. Structs are also `Serialize` because they are handed to the webview as-is.
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

pub(crate) fn value_to_f64(v: &Value) -> Option<f64> {
    let n = match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    };
    n.filter(|f| f.is_finite())
}

/// string, number or null (or anything unparseable) -> Option<f64>. Pair with `#[serde(default)]`.
pub fn de_f64_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(value_to_f64(&Value::deserialize(d)?))
}

pub(crate) fn de_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) => s,
        Value::Number(n) => n.to_string(),
        _ => String::new(),
    })
}

pub(crate) fn de_string_opt<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) if !s.is_empty() => Some(s),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    })
}

fn de_bool<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Bool(b) => b,
        Value::String(s) => s.eq_ignore_ascii_case("true"),
        _ => false,
    })
}

/// null or missing list -> empty; null elements dropped.
fn de_vec<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: for<'a> Deserialize<'a>,
{
    let v = Value::deserialize(d)?;
    let Value::Array(items) = v else { return Ok(vec![]) };
    Ok(items
        .into_iter()
        .filter(|i| !i.is_null())
        .filter_map(|i| serde_json::from_value::<T>(i).ok())
        .collect())
}

/// `{amount, currency_code}` object, bare number or string -> amount.
/// A JSON value (string, number, null...) to a finite f64; anything else None.
pub(crate) fn de_f64_opt_value(v: &Value) -> Option<f64> {
    value_to_f64(v)
}

fn de_amount<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match &v {
        Value::Object(o) => o.get("amount").and_then(value_to_f64),
        other => value_to_f64(other),
    })
}

/// `get_portfolio.buying_power` is an object `{buying_power, ...}`; accept a bare number too.
fn de_buying_power<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(match &v {
        Value::Object(o) => o.get("buying_power").and_then(value_to_f64),
        other => value_to_f64(other),
    })
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Account {
    #[serde(deserialize_with = "de_string")]
    pub account_number: String,
    #[serde(deserialize_with = "de_string_opt")]
    pub rhs_account_number: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub rhc_account_number: Option<String>,
    #[serde(deserialize_with = "de_bool")]
    pub agentic_allowed: bool,
    #[serde(deserialize_with = "de_string_opt")]
    pub option_level: Option<String>,
    #[serde(alias = "type", deserialize_with = "de_string_opt")]
    pub kind: Option<String>,
    #[serde(deserialize_with = "de_bool")]
    pub is_default: bool,
    #[serde(deserialize_with = "de_f64_opt")]
    pub unsettled_funds: Option<f64>,
    #[serde(deserialize_with = "de_string_opt")]
    pub nickname: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub brokerage_account_type: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Portfolio {
    #[serde(deserialize_with = "de_f64_opt")]
    pub total_value: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub equity_value: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub options_value: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub cash: Option<f64>,
    #[serde(deserialize_with = "de_buying_power")]
    pub buying_power: Option<f64>,
    #[serde(deserialize_with = "de_string_opt")]
    pub currency: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct EquityPosition {
    #[serde(deserialize_with = "de_string")]
    pub symbol: String,
    #[serde(deserialize_with = "de_f64_opt")]
    pub quantity: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub average_buy_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub shares_available_for_sells: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub shares_held_for_sells: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OrderLeg {
    #[serde(deserialize_with = "de_string_opt")]
    pub option_id: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub side: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub position_effect: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub ratio_quantity: Option<f64>,
    #[serde(deserialize_with = "de_string_opt")]
    pub expiration_date: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub strike_price: Option<f64>,
    #[serde(deserialize_with = "de_string_opt")]
    pub option_type: Option<String>,
}

/// Equity and option orders share one shape. `asset` is stamped by `reads` ("equity" | "option").
/// Option orders map `chain_symbol` -> `symbol` and `direction` -> `side`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Order {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "de_string")]
    pub asset: String,
    #[serde(alias = "chain_symbol", deserialize_with = "de_string_opt")]
    pub symbol: Option<String>,
    #[serde(alias = "direction", deserialize_with = "de_string_opt")]
    pub side: Option<String>,
    #[serde(alias = "type", deserialize_with = "de_string_opt")]
    pub order_type: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub state: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub trigger: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub quantity: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub stop_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub average_price: Option<f64>,
    #[serde(deserialize_with = "de_amount")]
    pub dollar_based_amount: Option<f64>,
    #[serde(deserialize_with = "de_string_opt")]
    pub time_in_force: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub created_at: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub reject_reason: Option<String>,
    #[serde(deserialize_with = "de_vec")]
    pub legs: Vec<OrderLeg>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Quote {
    #[serde(deserialize_with = "de_string")]
    pub symbol: String,
    #[serde(deserialize_with = "de_f64_opt")]
    pub bid_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub ask_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub last_trade_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub previous_close: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Bar {
    #[serde(deserialize_with = "de_string")]
    pub begins_at: String,
    #[serde(deserialize_with = "de_f64_opt")]
    pub open_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub high_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub low_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub close_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub volume: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Historical {
    #[serde(deserialize_with = "de_string")]
    pub symbol: String,
    #[serde(deserialize_with = "de_string_opt")]
    pub interval: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub bounds: Option<String>,
    #[serde(deserialize_with = "de_vec")]
    pub bars: Vec<Bar>,
}

/// One bar of get_option_historicals: OHLC and the `interpolated` flag (no volume exists for options).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct OptionBar {
    #[serde(deserialize_with = "de_string")]
    pub begins_at: String,
    #[serde(deserialize_with = "de_f64_opt")]
    pub open_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub high_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub low_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub close_price: Option<f64>,
    #[serde(deserialize_with = "de_bool")]
    pub interpolated: bool,
}

/// One result of get_option_historicals (one contract).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct OptionBars {
    #[serde(deserialize_with = "de_string")]
    pub instrument_id: String,
    #[serde(deserialize_with = "de_string")]
    pub occ_symbol: String,
    #[serde(deserialize_with = "de_string")]
    pub symbol: String,
    #[serde(deserialize_with = "de_string_opt")]
    pub interval: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub bounds: Option<String>,
    #[serde(deserialize_with = "de_vec")]
    pub bars: Vec<OptionBar>,
}

/// Robinhood tick table: `below_tick` under `cutoff_price`, `above_tick` at or over it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct MinTicks {
    #[serde(deserialize_with = "de_f64_opt")]
    pub above_tick: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub below_tick: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub cutoff_price: Option<f64>,
}

/// An absent, null or non-object `min_ticks` is None (never an error).
fn de_min_ticks<'de, D: Deserializer<'de>>(d: D) -> Result<Option<MinTicks>, D::Error> {
    let v = Value::deserialize(d)?;
    Ok(if v.is_object() { serde_json::from_value(v).ok() } else { None })
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OptionChain {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "de_string")]
    pub symbol: String,
    #[serde(deserialize_with = "de_vec")]
    pub expiration_dates: Vec<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub trade_value_multiplier: Option<f64>,
    #[serde(deserialize_with = "de_bool")]
    pub can_open_position: bool,
    /// M10: the chain's tick table (the ticket steps prices by it); None when the server omits it.
    #[serde(deserialize_with = "de_min_ticks")]
    pub min_ticks: Option<MinTicks>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OptionInstrument {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "de_string")]
    pub chain_id: String,
    #[serde(deserialize_with = "de_string_opt")]
    pub chain_symbol: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub expiration_date: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub strike_price: Option<f64>,
    #[serde(alias = "type", deserialize_with = "de_string_opt")]
    pub option_type: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub state: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub tradability: Option<String>,
    #[serde(deserialize_with = "de_min_ticks")]
    pub min_ticks: Option<MinTicks>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OptionQuote {
    #[serde(deserialize_with = "de_string")]
    pub instrument_id: String,
    #[serde(alias = "bid_price", deserialize_with = "de_f64_opt")]
    pub bid: Option<f64>,
    #[serde(alias = "ask_price", deserialize_with = "de_f64_opt")]
    pub ask: Option<f64>,
    #[serde(alias = "mark_price", deserialize_with = "de_f64_opt")]
    pub mark: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub delta: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub gamma: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub theta: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub vega: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub rho: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub implied_volatility: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub open_interest: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub volume: Option<f64>,
}

/// One open option position joined with its contract (strike, call/put, tick table) and live quote (M10).
///
/// UNITS RULE (from get_option_positions / get_option_quotes / get_option_instruments schema descriptions,
/// the Robinhood MCP tool schemas): `quantity` is contracts (net; the side is in `type`, so we report
/// it as a positive count and put long/short in `side`). Quote prices (`bid`/`ask`/`mark`) are PER SHARE premium.
/// `average_price` is "signed cost basis per contract" = DOLLARS PER CONTRACT, i.e. per-share premium times
/// `multiplier` (e.g. 150.00 for a 1.50 premium), negative for a credit received on a short. Per-share average is
/// therefore `average_price.abs() / multiplier`. (The description is terse; this reading matches Robinhood's
/// public API and the `multiplier` text "price x quantity x multiplier = dollars". Verify against a real capture.)
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OptionPositionRow {
    pub option_id: String,
    pub chain_symbol: String,
    pub expiration_date: Option<String>,
    pub strike_price: Option<f64>,
    /// "call" | "put" | None when the instrument lookup missed.
    pub option_type: Option<String>,
    /// "long" | "short"
    pub side: String,
    /// Contracts, always positive.
    pub quantity: f64,
    /// Raw signed dollars per contract (see the units rule).
    pub average_price: Option<f64>,
    pub multiplier: f64,
    pub bid: Option<f64>,
    pub ask: Option<f64>,
    pub mark: Option<f64>,
    pub delta: Option<f64>,
    pub theta: Option<f64>,
    pub iv: Option<f64>,
    pub min_ticks: Option<MinTicks>,
    pub pending_buy: Option<f64>,
    pub pending_sell: Option<f64>,
}

/// Raw `get_option_positions` row (lenient).
#[derive(Debug, Clone, Default, PartialEq, Deserialize)]
#[serde(default)]
pub struct RawOptionPosition {
    #[serde(deserialize_with = "de_string")]
    pub option_id: String,
    #[serde(deserialize_with = "de_string")]
    pub chain_symbol: String,
    #[serde(deserialize_with = "de_string_opt")]
    pub expiration_date: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub quantity: Option<f64>,
    #[serde(rename = "type", deserialize_with = "de_string_opt")]
    pub kind: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub average_price: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub trade_value_multiplier: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub pending_buy_quantity: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub pending_sell_quantity: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OptionRow {
    pub instrument: OptionInstrument,
    pub quote: Option<OptionQuote>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OptionChainWithGreeks {
    pub chain: OptionChain,
    pub rows: Vec<OptionRow>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Watchlist {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "de_string")]
    pub display_name: String,
    #[serde(deserialize_with = "de_string_opt")]
    pub icon_emoji: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub item_count: Option<f64>,
    #[serde(deserialize_with = "de_string_opt")]
    pub owner_type: Option<String>,
    /// Nullable upstream; null or missing => empty.
    #[serde(deserialize_with = "de_vec")]
    pub allowed_object_types: Vec<String>,
}

impl Watchlist {
    /// Options watchlists must be read through `get_option_watchlist`; `get_watchlist_items` 400s for them.
    pub fn is_options(&self) -> bool {
        self.allowed_object_types.iter().any(|t| t == "option_strategy")
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct OptionWatchItem {
    #[serde(deserialize_with = "de_string")]
    pub id: String,
    #[serde(deserialize_with = "de_string")]
    pub name: String,
    #[serde(deserialize_with = "de_vec")]
    pub option_ids: Vec<String>,
    #[serde(deserialize_with = "de_string")]
    pub chain_symbol: String,
    #[serde(deserialize_with = "de_string_opt")]
    pub expiration_date: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub strike_price: Option<f64>,
    #[serde(deserialize_with = "de_string_opt")]
    pub contract_type: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct OptionWatchlist {
    pub list_id: String,
    pub items: Vec<OptionWatchItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct WatchlistItem {
    #[serde(deserialize_with = "de_string")]
    pub object_id: String,
    #[serde(deserialize_with = "de_string")]
    pub object_type: String,
    #[serde(deserialize_with = "de_string")]
    pub symbol: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct WatchlistContents {
    pub display_name: String,
    pub items: Vec<WatchlistItem>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RealizedPoint {
    #[serde(deserialize_with = "de_string_opt")]
    pub start_time: Option<String>,
    #[serde(deserialize_with = "de_string_opt")]
    pub end_time: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub realized_gain: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub rate_of_realized_gain: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub number_of_trades: Option<f64>,
}

/// One bucket of `get_realized_pnl.data_points` (plan name: PnlBucket).
pub type PnlBucket = RealizedPoint;

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct RealizedPnl {
    #[serde(deserialize_with = "de_string_opt")]
    pub window: Option<String>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub total_returns: Option<f64>,
    #[serde(deserialize_with = "de_f64_opt")]
    pub total_rate_of_return: Option<f64>,
    #[serde(deserialize_with = "de_vec")]
    pub data_points: Vec<RealizedPoint>,
}

/// Like `rows`, but for a list the tool's schema REQUIRES: a missing key (or a non-list) means the response is not
/// what we think it is, and is an error rather than a silent empty list. JSON null is still an empty list.
pub fn rows_required<T: for<'a> Deserialize<'a>>(data: &Value, key: &str) -> Result<Vec<T>, crate::rh::RhError> {
    match data.get(key) {
        Some(Value::Array(_)) => Ok(rows(data, key)),
        Some(Value::Null) => Ok(vec![]),
        _ => Err(crate::rh::RhError::Protocol(format!("unexpected response shape (no `{key}` list)"))),
    }
}

/// Parse a JSON list field of `data` into typed rows. Missing/null list -> empty; malformed elements are skipped.
pub fn rows<T: for<'a> Deserialize<'a>>(data: &Value, key: &str) -> Vec<T> {
    match data.get(key) {
        Some(Value::Array(items)) => items
            .iter()
            .filter(|i| !i.is_null())
            .filter_map(|i| serde_json::from_value::<T>(i.clone()).ok())
            .collect(),
        _ => vec![],
    }
}

/// One scheduled or past report date for a symbol (from get_earnings_results). `timing` is "am" or "pm" when known.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EarningsEvent {
    pub date: String,
    pub timing: Option<String>,
    pub verified: bool,
}

/// Nearest upcoming report (date >= today) and the most recent past one (date < today). Both optional.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct EarningsInfo {
    pub next: Option<EarningsEvent>,
    pub last: Option<EarningsEvent>,
}
