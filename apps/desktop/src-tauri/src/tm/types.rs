//! Lenient mirrors of the four TraderMatrix read tools. Input is camelCase (the real fixtures in
//! `tests/fixtures/tm/` are the contract), output to the webview is snake_case. Every number may arrive as a
//! number, a numeric string or null; unknown fields are ignored; a malformed or null leg becomes `None`.
//! Units: `iv_rank` is 0..100 (never x100), `expected_move_pct` is a decimal fraction (0.036 = 3.6%),
//! `atm_iv`-style values are decimals, `conviction` is 0..1.
use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::rh::RhError;

// ---- lenient field helpers (all Value-based, so a wrong type yields None/empty instead of an error) ----

fn de_f64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<f64>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|f| f.is_finite()))
}

fn de_i64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64)),
        Value::String(s) => {
            let t = s.trim();
            t.parse::<i64>().ok().or_else(|| t.parse::<f64>().ok().filter(|f| f.is_finite()).map(|f| f.round() as i64))
        }
        _ => None,
    })
}

fn de_bool<'de, D: Deserializer<'de>>(d: D) -> Result<Option<bool>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Bool(b) => Some(b),
        Value::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        },
        _ => None,
    })
}

/// `clamped`: the band the raw value was clamped from ("below_band" | "above_band"), else None (null, bool, junk).
fn de_band<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => None,
    })
}

fn val_str(v: &Value) -> Option<String> {
    match v {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        Value::Bool(b) => Some(b.to_string()),
        _ => None,
    }
}

fn de_str<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(val_str(&Value::deserialize(d)?))
}

fn de_string<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    Ok(val_str(&Value::deserialize(d)?).unwrap_or_default())
}

/// Array of strings; non-array is empty, non-string items are stringified (objects/null dropped).
fn de_strings<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Array(a) => a.iter().filter_map(val_str).collect(),
        _ => vec![],
    })
}

/// An optional nested object: null, absent or malformed all become None.
fn de_leg<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    let v = Value::deserialize(d)?;
    if !v.is_object() {
        return Ok(None);
    }
    Ok(serde_json::from_value::<T>(v).ok())
}

/// A list of objects; entries that are not objects are dropped (non-array is empty).
fn de_list<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: DeserializeOwned,
{
    Ok(match Value::deserialize(d)? {
        Value::Array(a) => a.into_iter().filter(Value::is_object).filter_map(|v| serde_json::from_value::<T>(v).ok()).collect(),
        _ => vec![],
    })
}

/// The `openInTraderMatrix.url` of a response.
fn de_open_url<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::Object(o) => o.get("url").and_then(val_str),
        _ => None,
    })
}

// ---- apex levels ----

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct ApexLevel {
    #[serde(default, deserialize_with = "de_f64")]
    pub strike: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub score: Option<f64>,
    #[serde(default, deserialize_with = "de_i64")]
    pub rank: Option<i64>,
    #[serde(default, rename(deserialize = "netGEX"), deserialize_with = "de_f64")]
    pub net_gex: Option<f64>,
    #[serde(default, rename(deserialize = "totalOI"), deserialize_with = "de_i64")]
    pub total_oi: Option<i64>,
    #[serde(default, deserialize_with = "de_bool")]
    pub is_above_spot: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct ApexLevels {
    #[serde(default, deserialize_with = "de_string")]
    pub symbol: String,
    #[serde(default, rename(deserialize = "spotPrice"), alias = "spot", deserialize_with = "de_f64")]
    pub spot: Option<f64>,
    #[serde(default, deserialize_with = "de_str")]
    pub snapshot_time: Option<String>,
    #[serde(default, deserialize_with = "de_f64")]
    pub gamma_flip: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub net_gex: Option<f64>,
    /// Levels without a numeric strike are dropped (nothing to draw).
    #[serde(default, deserialize_with = "de_levels")]
    pub levels: Vec<ApexLevel>,
    #[serde(default, deserialize_with = "de_strings")]
    pub expirations_used: Vec<String>,
    #[serde(default, deserialize_with = "de_strings")]
    pub available_expirations: Vec<String>,
    #[serde(default, rename(deserialize = "openInTraderMatrix"), deserialize_with = "de_open_url")]
    pub open_url: Option<String>,
}

fn de_levels<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<ApexLevel>, D::Error> {
    let mut v: Vec<ApexLevel> = de_list(d)?;
    v.retain(|l| l.strike.is_some());
    Ok(v)
}

// ---- expected move ----

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Band {
    #[serde(default, deserialize_with = "de_f64")]
    pub low: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub high: Option<f64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct Horizon {
    #[serde(default, deserialize_with = "de_string")]
    pub label: String,
    #[serde(default, deserialize_with = "de_i64")]
    pub calendar_days: Option<i64>,
    #[serde(default, deserialize_with = "de_str")]
    pub through_date: Option<String>,
    #[serde(default, deserialize_with = "de_i64")]
    pub trading_days: Option<i64>,
    /// Decimal fraction of spot: 0.036 means 3.6%.
    #[serde(default, deserialize_with = "de_f64")]
    pub expected_move_pct: Option<f64>,
    #[serde(default, deserialize_with = "de_leg")]
    pub band68: Option<Band>,
    #[serde(default, deserialize_with = "de_leg")]
    pub band95: Option<Band>,
    /// Decimal 0..1.
    #[serde(default, rename(deserialize = "held68Pct"), deserialize_with = "de_f64")]
    pub held68_pct: Option<f64>,
    #[serde(default, rename(deserialize = "held95Pct"), deserialize_with = "de_f64")]
    pub held95_pct: Option<f64>,
    #[serde(default, deserialize_with = "de_i64")]
    pub sample_days: Option<i64>,
    #[serde(default, deserialize_with = "de_bool")]
    pub extrapolated: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct ExpectedMove {
    #[serde(default, deserialize_with = "de_string")]
    pub symbol: String,
    #[serde(default, deserialize_with = "de_f64")]
    pub spot: Option<f64>,
    #[serde(default, deserialize_with = "de_str")]
    pub as_of: Option<String>,
    #[serde(default, deserialize_with = "de_list")]
    pub horizons: Vec<Horizon>,
    #[serde(default, deserialize_with = "de_str")]
    pub interpretation: Option<String>,
    #[serde(default, rename(deserialize = "openInTraderMatrix"), deserialize_with = "de_open_url")]
    pub open_url: Option<String>,
}

// ---- IV rank ----

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct IvChange {
    #[serde(default, deserialize_with = "de_str")]
    pub direction: Option<String>,
    #[serde(default, deserialize_with = "de_f64")]
    pub points_change: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub percent_change: Option<f64>,
    #[serde(default, deserialize_with = "de_i64")]
    pub sessions: Option<i64>,
    /// Decimal (0.2443 = 24.43% IV).
    #[serde(default, deserialize_with = "de_f64")]
    pub from_iv: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub to_iv: Option<f64>,
    #[serde(default, deserialize_with = "de_str")]
    pub from_date: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub to_date: Option<String>,
    #[serde(default, deserialize_with = "de_bool")]
    pub comparable_to_atm_iv: Option<bool>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct IvRank {
    #[serde(default, deserialize_with = "de_string")]
    pub symbol: String,
    #[serde(default, deserialize_with = "de_str")]
    pub source: Option<String>,
    /// 0..100. Never multiply by 100.
    #[serde(default, deserialize_with = "de_f64")]
    pub iv_rank: Option<f64>,
    #[serde(default, rename(deserialize = "ivRankZone"), alias = "zone", deserialize_with = "de_str")]
    pub zone: Option<String>,
    /// "below_band" | "above_band" | null.
    #[serde(default, rename(deserialize = "ivRankClamped"), alias = "clamped", deserialize_with = "de_band")]
    pub clamped: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub as_of: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub freshness: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub interpretation: Option<String>,
    #[serde(default, deserialize_with = "de_leg")]
    pub recent_change: Option<IvChange>,
    /// Why `iv_rank` is null, when the server says so (`reason` key).
    #[serde(default, deserialize_with = "de_str")]
    pub reason: Option<String>,
    #[serde(default, rename(deserialize = "openInTraderMatrix"), deserialize_with = "de_open_url")]
    pub open_url: Option<String>,
}

// ---- ticker snapshot ----

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct QualityLeg {
    #[serde(default, deserialize_with = "de_f64")]
    pub quality_score: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub quality_score_out_of: Option<f64>,
    #[serde(default, deserialize_with = "de_str")]
    pub quality_label: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub sector: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct GammaLeg {
    #[serde(default, deserialize_with = "de_str")]
    pub regime: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub regime_summary: Option<String>,
    #[serde(default, deserialize_with = "de_f64")]
    pub gamma_flip_level: Option<f64>,
    #[serde(default, deserialize_with = "de_str")]
    pub spot_vs_flip: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub spot_vs_flip_distance: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub gamma_pocket: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct NearestApex {
    #[serde(default, deserialize_with = "de_f64")]
    pub strike: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub score: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub score_out_of: Option<f64>,
    #[serde(default, deserialize_with = "de_str")]
    pub side: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub distance_from_spot: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct ApexLeg {
    #[serde(default, deserialize_with = "de_leg")]
    pub nearest_level: Option<NearestApex>,
    #[serde(default, deserialize_with = "de_f64")]
    pub dominant_level_strike: Option<f64>,
    #[serde(default, deserialize_with = "de_i64")]
    pub level_count: Option<i64>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct FlowLeg {
    #[serde(default, deserialize_with = "de_str")]
    pub bias: Option<String>,
    /// 0..1.
    #[serde(default, deserialize_with = "de_f64")]
    pub conviction: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub conviction_out_of: Option<f64>,
    #[serde(default, deserialize_with = "de_str")]
    pub basis: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct IvRankLeg {
    /// 0..100. Never multiply by 100.
    #[serde(default, deserialize_with = "de_f64")]
    pub iv_rank: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub iv_rank_out_of: Option<f64>,
    #[serde(default, deserialize_with = "de_str")]
    pub iv_rank_zone: Option<String>,
    /// "below_band" | "above_band" | null.
    #[serde(default, alias = "ivRankClamped", deserialize_with = "de_band")]
    pub clamped: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub interpretation: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub source: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub as_of: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(deserialize = "camelCase"))]
pub struct MarketHealthLeg {
    #[serde(default, deserialize_with = "de_f64")]
    pub composite_score: Option<f64>,
    #[serde(default, deserialize_with = "de_f64")]
    pub composite_score_max: Option<f64>,
    #[serde(default, deserialize_with = "de_str")]
    pub composite_unit: Option<String>,
    #[serde(default, deserialize_with = "de_str")]
    pub label: Option<String>,
    #[serde(default, deserialize_with = "de_i64")]
    pub alert_count: Option<i64>,
    #[serde(default, deserialize_with = "de_i64")]
    pub watch_count: Option<i64>,
    #[serde(default, deserialize_with = "de_str")]
    pub as_of: Option<String>,
}

/// Flattened from the wire shape `{symbol, legs: {quality, gamma, ...}, missing, openInTraderMatrix}`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Snapshot {
    pub symbol: String,
    pub quality: Option<QualityLeg>,
    pub gamma: Option<GammaLeg>,
    pub apex: Option<ApexLeg>,
    pub flow: Option<FlowLeg>,
    pub iv_rank: Option<IvRankLeg>,
    pub market_health: Option<MarketHealthLeg>,
    pub missing: Vec<String>,
    pub open_url: Option<String>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct Legs {
    #[serde(default, deserialize_with = "de_leg")]
    quality: Option<QualityLeg>,
    #[serde(default, deserialize_with = "de_leg")]
    gamma: Option<GammaLeg>,
    #[serde(default, deserialize_with = "de_leg")]
    apex: Option<ApexLeg>,
    #[serde(default, deserialize_with = "de_leg")]
    flow: Option<FlowLeg>,
    #[serde(default, deserialize_with = "de_leg")]
    iv_rank: Option<IvRankLeg>,
    #[serde(default, deserialize_with = "de_leg")]
    market_health: Option<MarketHealthLeg>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotWire {
    #[serde(default, deserialize_with = "de_string")]
    symbol: String,
    #[serde(default, deserialize_with = "de_leg")]
    legs: Option<Legs>,
    #[serde(default, deserialize_with = "de_strings")]
    missing: Vec<String>,
    #[serde(default, rename = "openInTraderMatrix", deserialize_with = "de_open_url")]
    open_url: Option<String>,
}

// ---- entry points: the payload must be a JSON object, everything inside it is best-effort ----

fn object(v: &Value, what: &str) -> Result<(), RhError> {
    if v.is_object() {
        Ok(())
    } else {
        Err(RhError::Protocol(format!("TraderMatrix {what} response is not a JSON object")))
    }
}

fn from<T: DeserializeOwned>(v: &Value, what: &str) -> Result<T, RhError> {
    object(v, what)?;
    serde_json::from_value(v.clone()).map_err(|_| RhError::Protocol(format!("TraderMatrix {what} response could not be read")))
}

pub fn parse_apex_levels(v: &Value) -> Result<ApexLevels, RhError> {
    from(v, "apex levels")
}

pub fn parse_expected_move(v: &Value) -> Result<ExpectedMove, RhError> {
    from(v, "expected move")
}

pub fn parse_iv_rank(v: &Value) -> Result<IvRank, RhError> {
    from(v, "IV rank")
}

pub fn parse_snapshot(v: &Value) -> Result<Snapshot, RhError> {
    let w: SnapshotWire = from(v, "snapshot")?;
    let l = w.legs.unwrap_or_default();
    Ok(Snapshot {
        symbol: w.symbol,
        quality: l.quality,
        gamma: l.gamma,
        apex: l.apex,
        flow: l.flow,
        iv_rank: l.iv_rank,
        market_health: l.market_health,
        missing: w.missing,
        open_url: w.open_url,
    })
}

// ---- watchlists (M8) ----
// Hand-mapped from the raw JSON on purpose: `notes` and `addedAt` are never deserialized, so they cannot reach the webview.

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TmWatchlist {
    pub id: i64,
    pub name: String,
    pub category: Option<String>,
    pub is_default: bool,
    pub ticker_count: usize,
    /// Uppercased symbols only.
    pub tickers: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TmWatchlists {
    pub lists: Vec<TmWatchlist>,
    pub tickers_per_list: Option<u32>,
    pub tickers_across_all_lists: Option<u32>,
    pub max_lists: Option<u32>,
    /// The response is a free-tier PREVIEW or otherwise cut short (a `preview` marker, a list holding fewer rows than its own count, fewer lists
    /// than the server says exist). A truncated read must never be treated as the whole list: the sync refuses to diff it.
    pub truncated: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TmAddOutcome {
    /// false = the symbol was already on the list (success, nothing changed).
    pub added: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct TmWatchlistMeta {
    pub id: i64,
    pub name: String,
    pub category: Option<String>,
    pub is_default: bool,
}

fn v_i64(v: &Value) -> Option<i64> {
    match v {
        Value::Number(n) => n.as_i64().or_else(|| n.as_f64().filter(|f| f.is_finite()).map(|f| f.round() as i64)),
        Value::String(s) => s.trim().parse::<i64>().ok(),
        _ => None,
    }
}

fn v_u32(v: &Value) -> Option<u32> {
    v_i64(v).and_then(|n| u32::try_from(n).ok())
}

fn v_bool(v: &Value) -> bool {
    match v {
        Value::Bool(b) => *b,
        Value::String(s) => s.trim().eq_ignore_ascii_case("true"),
        _ => false,
    }
}

fn v_text(v: &Value) -> Option<String> {
    val_str(v).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// A marker field counts when it is present and not null, false, 0, "" or "false".
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.trim().is_empty() && !s.trim().eq_ignore_ascii_case("false"),
        Some(_) => true,
    }
}

pub fn parse_watchlists(v: &Value) -> Result<TmWatchlists, RhError> {
    let o = v.as_object().ok_or_else(|| RhError::Protocol("TraderMatrix watchlists response was not an object".into()))?;
    let mut lists = Vec::new();
    let mut truncated = truthy(o.get("preview")) || truthy(o.get("truncated"));
    for l in o.get("lists").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
        let Some(l) = l.as_object() else { continue };
        let Some(id) = l.get("id").and_then(v_i64) else { continue };
        let tickers: Vec<String> = l
            .get("tickers")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or_default()
            .iter()
            .filter_map(|t| match t {
                Value::Object(t) => t.get("ticker").and_then(v_text),
                other => v_text(other),
            })
            .map(|t| t.to_ascii_uppercase())
            .collect();
        let count = l.get("tickerCount").and_then(v_i64).and_then(|n| usize::try_from(n).ok());
        if truthy(l.get("preview")) || truthy(l.get("truncated")) || count.is_some_and(|c| c > tickers.len()) {
            truncated = true;
        }
        lists.push(TmWatchlist {
            id,
            name: l.get("name").and_then(v_text).unwrap_or_default(),
            category: l.get("category").and_then(v_text),
            is_default: l.get("isDefault").is_some_and(v_bool),
            ticker_count: l.get("tickerCount").and_then(v_i64).and_then(|n| usize::try_from(n).ok()).unwrap_or(tickers.len()),
            tickers,
        });
    }
    let total = ["totalLists", "total_lists", "listCount"].iter().find_map(|k| o.get(*k).and_then(v_i64)).and_then(|n| usize::try_from(n).ok());
    if total.is_some_and(|t| t > lists.len()) {
        truncated = true;
    }
    let lim = o.get("limits").and_then(Value::as_object);
    let limit = |k: &str| lim.and_then(|m| m.get(k)).and_then(v_u32);
    Ok(TmWatchlists { lists, tickers_per_list: limit("tickersPerList"), tickers_across_all_lists: limit("tickersAcrossAllLists"), max_lists: limit("lists"), truncated })
}

/// `{ok:false, error, availableLists?}` becomes a tool error carrying the text; anything else passes through.
fn refusal(v: &Value) -> Result<&serde_json::Map<String, Value>, RhError> {
    let o = v.as_object().ok_or_else(|| RhError::Protocol("TraderMatrix watchlist response was not an object".into()))?;
    let failed = o.get("ok").is_some_and(|k| !v_bool(k)) || (!o.contains_key("ok") && o.get("error").is_some_and(|e| !e.is_null()));
    if failed {
        let mut msg = o.get("error").and_then(v_text).unwrap_or_else(|| "TraderMatrix refused the watchlist change".into());
        if let Some(a) = o.get("availableLists").and_then(Value::as_array) {
            let names: Vec<String> = a.iter().filter_map(v_text).collect();
            if !names.is_empty() {
                msg.push_str(&format!(" (available lists: {})", names.join(", ")));
            }
        }
        return Err(RhError::Tool(msg));
    }
    Ok(o)
}

pub fn parse_add_outcome(v: &Value) -> Result<TmAddOutcome, RhError> {
    let o = refusal(v)?;
    Ok(TmAddOutcome { added: o.get("added").map(v_bool).unwrap_or(true) })
}

pub fn parse_create_outcome(v: &Value) -> Result<TmWatchlistMeta, RhError> {
    let o = refusal(v)?;
    let l = o.get("list").and_then(Value::as_object).ok_or_else(|| RhError::Protocol("TraderMatrix create_watchlist returned no list".into()))?;
    let id = l.get("id").and_then(v_i64).ok_or_else(|| RhError::Protocol("TraderMatrix create_watchlist returned no list id".into()))?;
    Ok(TmWatchlistMeta {
        id,
        name: l.get("name").and_then(v_text).unwrap_or_default(),
        category: l.get("category").and_then(v_text),
        is_default: l.get("isDefault").is_some_and(v_bool),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fx(name: &str) -> Value {
        let p = format!("{}/tests/fixtures/tm/{name}.json", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(p).expect("fixture")).expect("fixture json")
    }

    #[test]
    fn real_apex_fixture_maps() {
        let a = parse_apex_levels(&fx("apex_levels")).unwrap();
        assert_eq!(a.symbol, "AAPL");
        assert_eq!(a.spot, Some(348.51));
        assert_eq!(a.levels.len(), 8);
        let top = &a.levels[0];
        assert_eq!((top.strike, top.score, top.rank), (Some(355.0), Some(100.0), Some(1)));
        assert_eq!(top.is_above_spot, Some(true));
        assert_eq!(top.total_oi, Some(72181));
        assert!(top.net_gex.unwrap() > 2.3e8);
        assert_eq!(a.levels[4].is_above_spot, Some(false));
        assert_eq!(a.levels[7].strike, Some(362.5));
        assert_eq!(a.gamma_flip, Some(343.59));
        assert_eq!(a.expirations_used.len(), 5);
        assert_eq!(a.available_expirations.len(), 10);
        assert!(a.open_url.unwrap().starts_with("https://www.tradermatrix.pro/ticker-search/AAPL/gex"));
        assert_eq!(a.snapshot_time.as_deref(), Some("2026-11-11T13:11:18.780Z"));
    }

    #[test]
    fn real_expected_move_fixture_maps() {
        let m = parse_expected_move(&fx("expected_move")).unwrap();
        assert_eq!(m.horizons.len(), 5);
        let w = m.horizons.iter().find(|h| h.label == "1 week").unwrap();
        assert_eq!(w.expected_move_pct, Some(0.036));
        assert_eq!(w.band68.as_ref().unwrap().low, Some(336.0));
        assert_eq!(w.band68.as_ref().unwrap().high, Some(362.0));
        assert_eq!(w.band95.as_ref().unwrap().low, Some(324.0));
        assert_eq!(w.held68_pct, Some(0.66));
        assert_eq!(w.held95_pct, Some(0.94));
        assert_eq!((w.calendar_days, w.trading_days, w.sample_days), (Some(7), Some(5), Some(1253)));
        assert_eq!(w.through_date.as_deref(), Some("2026-11-18"));
        assert_eq!(w.extrapolated, Some(false));
        assert!(m.interpretation.unwrap().contains("one-sigma"));
        assert!(m.open_url.unwrap().contains("/volatility"));
    }

    #[test]
    fn real_snapshot_fixture_maps() {
        let s = parse_snapshot(&fx("ticker_snapshot")).unwrap();
        assert_eq!(s.symbol, "AAPL");
        assert_eq!(s.gamma.as_ref().unwrap().regime.as_deref(), Some("positive_gamma"));
        assert_eq!(s.gamma.as_ref().unwrap().gamma_flip_level, Some(342.18));
        assert_eq!(s.gamma.as_ref().unwrap().spot_vs_flip.as_deref(), Some("above_flip"));
        let n = s.apex.as_ref().unwrap().nearest_level.as_ref().unwrap();
        assert_eq!((n.strike, n.score, n.side.as_deref()), (Some(350.0), Some(73.0), Some("above_spot")));
        assert_eq!(s.apex.as_ref().unwrap().dominant_level_strike, Some(355.0));
        assert_eq!(s.apex.as_ref().unwrap().level_count, Some(8));
        let iv = s.iv_rank.as_ref().unwrap();
        assert_eq!((iv.iv_rank.unwrap() * 100.0).round(), 3787.0);
        assert_eq!(iv.iv_rank_out_of, Some(100.0));
        assert_eq!(iv.iv_rank_zone.as_deref(), Some("mid"));
        assert_eq!(s.quality.as_ref().unwrap().quality_score, Some(82.0));
        assert_eq!(s.quality.as_ref().unwrap().sector.as_deref(), Some("Technology"));
        assert_eq!(s.flow.as_ref().unwrap().conviction, Some(0.04));
        assert_eq!(s.flow.as_ref().unwrap().bias.as_deref(), Some("balanced"));
        let h = s.market_health.as_ref().unwrap();
        assert_eq!((h.composite_score, h.composite_score_max, h.label.as_deref()), (Some(3.5), Some(5.0), Some("HIGH")));
        assert_eq!((h.alert_count, h.watch_count), (Some(3), Some(1)));
        assert!(s.missing.is_empty());
        assert!(s.open_url.unwrap().contains("/overview"));
    }

    #[test]
    fn real_iv_rank_fixture_maps() {
        let r = parse_iv_rank(&fx("iv_rank")).unwrap();
        let v = r.iv_rank.unwrap();
        assert!((v - 37.868).abs() < 0.001, "{v}");
        assert_eq!(r.zone.as_deref(), Some("mid"));
        assert_eq!(r.source.as_deref(), Some("cboe"));
        assert_eq!(r.clamped, None);
        assert_eq!(r.as_of.as_deref(), Some("2026-11-10"));
        assert_eq!(r.freshness.as_deref(), Some("last_session"));
        let c = r.recent_change.unwrap();
        assert_eq!(c.direction.as_deref(), Some("down"));
        assert_eq!((c.sessions, c.from_iv, c.to_iv), (Some(5), Some(0.2443), Some(0.2236)));
        assert_eq!(c.comparable_to_atm_iv, Some(false));
        assert_eq!(c.from_date.as_deref(), Some("2026-11-03"));
        assert_eq!(r.reason, None);
    }

    #[test]
    fn output_is_snake_case_and_never_camel() {
        let a = serde_json::to_value(parse_apex_levels(&fx("apex_levels")).unwrap()).unwrap();
        for k in ["symbol", "spot", "snapshot_time", "gamma_flip", "net_gex", "levels", "expirations_used", "available_expirations", "open_url"] {
            assert!(a.get(k).is_some(), "missing {k}");
        }
        assert!(a.get("spotPrice").is_none() && a.get("gammaFlip").is_none());
        let l = &a["levels"][0];
        for k in ["strike", "score", "rank", "net_gex", "total_oi", "is_above_spot"] {
            assert!(l.get(k).is_some(), "level missing {k}");
        }
        let m = serde_json::to_value(parse_expected_move(&fx("expected_move")).unwrap()).unwrap();
        let h = &m["horizons"][1];
        for k in ["label", "calendar_days", "through_date", "trading_days", "expected_move_pct", "band68", "band95", "held68_pct", "held95_pct", "sample_days", "extrapolated"] {
            assert!(h.get(k).is_some(), "horizon missing {k}");
        }
        assert_eq!(h["band68"], json!({"low": 336.0, "high": 362.0}));
        let s = serde_json::to_value(parse_snapshot(&fx("ticker_snapshot")).unwrap()).unwrap();
        for k in ["symbol", "quality", "gamma", "apex", "flow", "iv_rank", "market_health", "missing", "open_url"] {
            assert!(s.get(k).is_some(), "snapshot missing {k}");
        }
        assert!(s.get("legs").is_none());
        assert_eq!(s["apex"]["nearest_level"]["distance_from_spot"], "within_1pct");
        assert_eq!(s["iv_rank"]["iv_rank_zone"], "mid");
    }

    #[test]
    fn null_leg_with_missing_list_is_tolerated() {
        let mut v = fx("ticker_snapshot");
        v["legs"]["gamma"] = Value::Null;
        v["legs"]["flow"] = json!("garbage");
        v["legs"].as_object_mut().unwrap().remove("apex");
        v["missing"] = json!(["gamma", "flow", "apex"]);
        let s = parse_snapshot(&v).unwrap();
        assert!(s.gamma.is_none() && s.flow.is_none() && s.apex.is_none());
        assert!(s.quality.is_some() && s.iv_rank.is_some() && s.market_health.is_some());
        assert_eq!(s.missing, vec!["gamma", "flow", "apex"]);
        // No legs object at all.
        let s = parse_snapshot(&json!({"symbol": "AAPL"})).unwrap();
        assert!(s.quality.is_none() && s.missing.is_empty());
        let s = parse_snapshot(&json!({"symbol": "AAPL", "legs": null})).unwrap();
        assert_eq!(s.symbol, "AAPL");
    }

    #[test]
    fn missing_levels_and_junk_levels_are_tolerated() {
        let a = parse_apex_levels(&json!({"symbol": "AAPL", "spotPrice": 100})).unwrap();
        assert!(a.levels.is_empty() && a.gamma_flip.is_none() && a.expirations_used.is_empty());
        let a = parse_apex_levels(&json!({"symbol": "X", "levels": [{"strike": 10, "score": 5}, {"score": 9}, 7, null, {"strike": "abc"}], "gammaFlip": null})).unwrap();
        assert_eq!(a.levels.len(), 1);
        assert_eq!(a.levels[0].strike, Some(10.0));
        let a = parse_apex_levels(&json!({"levels": "nope", "expirationsUsed": 5})).unwrap();
        assert!(a.levels.is_empty() && a.expirations_used.is_empty());
        let m = parse_expected_move(&json!({"symbol": "AAPL"})).unwrap();
        assert!(m.horizons.is_empty());
        let m = parse_expected_move(&json!({"horizons": [{"label": "x", "band68": null, "expectedMovePct": null}, 3]})).unwrap();
        assert_eq!(m.horizons.len(), 1);
        assert!(m.horizons[0].band68.is_none() && m.horizons[0].expected_move_pct.is_none());
    }

    #[test]
    fn numbers_as_strings_parse() {
        let a = parse_apex_levels(&json!({
            "symbol": "AAPL", "spotPrice": "348.51", "gammaFlip": " 343.59 ", "netGex": "5e8",
            "levels": [{"strike": "355", "score": "100", "rank": "1", "netGEX": "2.3e8", "totalOI": "72181", "isAboveSpot": "true"}]
        }))
        .unwrap();
        assert_eq!(a.spot, Some(348.51));
        assert_eq!(a.gamma_flip, Some(343.59));
        assert_eq!(a.net_gex, Some(5e8));
        let l = &a.levels[0];
        assert_eq!((l.strike, l.score, l.rank, l.total_oi, l.is_above_spot), (Some(355.0), Some(100.0), Some(1), Some(72181), Some(true)));
        let m = parse_expected_move(&json!({"horizons": [{"label": "1 week", "expectedMovePct": "0.036", "band68": {"low": "336", "high": "362"}, "held68Pct": "0.66", "calendarDays": "7"}]})).unwrap();
        let h = &m.horizons[0];
        assert_eq!((h.expected_move_pct, h.held68_pct, h.calendar_days), (Some(0.036), Some(0.66), Some(7)));
        assert_eq!(h.band68.as_ref().unwrap().high, Some(362.0));
        let r = parse_iv_rank(&json!({"symbol": "AAPL", "ivRank": "37.9"})).unwrap();
        assert_eq!(r.iv_rank, Some(37.9));
    }

    #[test]
    fn extra_unknown_keys_are_ignored() {
        let mut v = fx("expected_move");
        v["somethingNew"] = json!({"a": 1});
        v["horizons"][0]["extraField"] = json!([1, 2, 3]);
        assert_eq!(parse_expected_move(&v).unwrap().horizons.len(), 5);
        let mut v = fx("ticker_snapshot");
        v["legs"]["newLeg"] = json!({"x": 1});
        v["legs"]["gamma"]["newField"] = json!("y");
        assert!(parse_snapshot(&v).unwrap().gamma.is_some());
        let mut v = fx("iv_rank");
        v["brandNew"] = json!(true);
        assert!(parse_iv_rank(&v).unwrap().iv_rank.is_some());
    }

    #[test]
    fn iv_rank_null_with_reason() {
        let r = parse_iv_rank(&json!({"symbol": "AAPL", "ivRank": null, "reason": "insufficient_history"})).unwrap();
        assert_eq!(r.iv_rank, None);
        assert_eq!(r.reason.as_deref(), Some("insufficient_history"));
        // The real fixture's percentile note is not the "why is the rank null" reason.
        assert_eq!(parse_iv_rank(&fx("iv_rank")).unwrap().reason, None);
    }

    /// R10g: `clamped` is a band name ("below_band" | "above_band") or null, on IvRank and on the snapshot's iv_rank leg.
    #[test]
    fn clamped_is_a_band_string_or_null() {
        let j = |v: Value| serde_json::to_value(parse_iv_rank(&v).unwrap()).unwrap()["clamped"].clone();
        assert_eq!(j(json!({"ivRankClamped": "below_band"})), json!("below_band"));
        assert_eq!(j(json!({"clamped": "above_band"})), json!("above_band"));
        assert_eq!(j(json!({"ivRankClamped": null})), Value::Null);
        assert_eq!(j(json!({"ivRankClamped": true})), Value::Null, "a bool is not a band");
        let s = serde_json::to_value(parse_snapshot(&json!({"symbol":"AAPL","legs":{"ivRank":{"ivRank": 2, "clamped": "below_band"}}})).unwrap()).unwrap();
        assert_eq!(s["iv_rank"]["clamped"], "below_band");
        let s = serde_json::to_value(parse_snapshot(&fx("ticker_snapshot")).unwrap()).unwrap();
        assert!(s["iv_rank"].get("clamped").is_some_and(Value::is_null), "the key is always present for the webview");
    }

    #[test]
    fn non_object_payloads_are_protocol_errors() {
        for v in [json!(null), json!([1]), json!("x"), json!(3)] {
            assert!(matches!(parse_apex_levels(&v), Err(RhError::Protocol(_))));
            assert!(matches!(parse_expected_move(&v), Err(RhError::Protocol(_))));
            assert!(matches!(parse_iv_rank(&v), Err(RhError::Protocol(_))));
            assert!(matches!(parse_snapshot(&v), Err(RhError::Protocol(_))));
        }
    }
}
