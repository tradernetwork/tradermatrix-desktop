//! Typed order arguments and local validation. The webview can only send these structs
//! (`deny_unknown_fields`), so it cannot smuggle `ref_id`, `tax_lots` or any other tool parameter.
//! Rust is authoritative: every rule is checked before any request is made.
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::rh::error::RhError;

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EquityOrderArgs {
    pub account_number: String,
    pub symbol: String,
    /// buy|sell
    pub side: String,
    /// market|limit|stop_market|stop_limit
    pub r#type: String,
    pub quantity: Option<String>,
    pub dollar_amount: Option<String>,
    pub limit_price: Option<String>,
    pub stop_price: Option<String>,
    /// gfd|gtc, default gfd
    pub time_in_force: Option<String>,
    /// regular_hours|extended_hours|all_day_hours, default regular_hours
    pub market_hours: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OptionLeg {
    pub option_id: String,
    /// buy|sell
    pub side: String,
    /// open|close
    pub position_effect: String,
    pub ratio_quantity: u32,
}

#[derive(Deserialize, Serialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OptionOrderArgs {
    pub account_number: String,
    pub legs: Vec<OptionLeg>,
    /// positive integer
    pub quantity: String,
    /// limit (default) | market | stop_limit | stop_market
    pub r#type: Option<String>,
    pub price: Option<String>,
    pub stop_price: Option<String>,
    /// gfd|gtc
    pub time_in_force: Option<String>,
    /// regular_hours (default) | regular_curb_hours | regular_curb_overnight_hours
    pub market_hours: Option<String>,
    /// debit|credit, required when legs >= 2
    pub direction: Option<String>,
}

#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum OrderKind {
    Equity,
    Option,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ReviewOut {
    pub review_id: String,
    pub kind: OrderKind,
    /// The whole `data` object of the review tool (echoed order, quote_data / option_quotes,
    /// market_data_disclosure, fees, collateral). Nothing is dropped.
    pub echoed: Value,
    /// `{}` when clean.
    pub order_checks: Value,
    pub customer_approval_required: Option<bool>,
    pub customer_approval_reason: Option<String>,
    pub account_masked: String,
    pub expires_in_secs: u32,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PlaceOutcome {
    Placed { order: Value },
    /// The order was NOT placed: it waits for the customer in the Robinhood app.
    AwaitingApproval { approval: Value },
    /// Sent, but the result is unknown (transport failure, 5xx, expired session, unreadable reply).
    /// `retry_until`: unix seconds after which an explicit retry is refused (check Orders, then review again).
    Unknown { message: String, retry_until: Option<u64> },
    /// The server answered with an error: the order was NOT placed.
    Rejected { message: String },
}

fn bad<T>(what: impl Into<String>) -> Result<T, RhError> {
    Err(RhError::Invalid(what.into()))
}

/// `^[0-9]+(\.[0-9]{1,8})?$` and strictly positive. No sign, exponent, spaces, NaN or inf.
pub fn is_decimal(s: &str) -> bool {
    let (int, frac) = match s.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (s, None),
    };
    if int.is_empty() || !int.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    if let Some(f) = frac {
        if f.is_empty() || f.len() > 8 || !f.bytes().all(|b| b.is_ascii_digit()) {
            return false;
        }
    }
    s.bytes().any(|b| (b'1'..=b'9').contains(&b))
}

/// `^[A-Z][A-Z0-9.\-]{0,9}$`
pub fn is_symbol(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 10
        && b[0].is_ascii_uppercase()
        && b[1..].iter().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'.' || *c == b'-')
}

pub(crate) fn is_account(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.bytes().all(|b| b.is_ascii_alphanumeric())
}

/// 8-4-4-4-12 hex, either case, nothing else (no braces, URL, or dashless form).
pub(crate) fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36 && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// Shown everywhere instead of the full account number: bullets plus the last four characters.
pub fn mask_account(a: &str) -> String {
    let chars: Vec<char> = a.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    format!("\u{2022}\u{2022}\u{2022}\u{2022}{tail}")
}

fn opt_in(name: &str, v: &Option<String>, allowed: &[&str]) -> Result<(), RhError> {
    match v {
        Some(x) if !allowed.contains(&x.as_str()) => bad(format!("{name} must be one of {}", allowed.join("|"))),
        _ => Ok(()),
    }
}

fn opt_decimal(name: &str, v: &Option<String>) -> Result<(), RhError> {
    match v {
        Some(x) if !is_decimal(x) => bad(format!("{name} must be a positive decimal like 12.5 (no sign, exponent or spaces; up to 8 decimals)")),
        _ => Ok(()),
    }
}

fn strip_nulls(v: Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.into_iter().filter(|(_, v)| !v.is_null()).map(|(k, v)| (k, strip_nulls(v))).collect()),
        Value::Array(a) => Value::Array(a.into_iter().map(strip_nulls).collect()),
        o => o,
    }
}

impl EquityOrderArgs {
    pub fn validate(&self) -> Result<(), RhError> {
        if !is_account(&self.account_number) {
            return bad("account_number must be alphanumeric");
        }
        if !is_symbol(&self.symbol) {
            return bad("symbol must be upper case letters, digits, '.' or '-' (max 10), starting with a letter");
        }
        if !["buy", "sell"].contains(&self.side.as_str()) {
            return bad("side must be buy or sell");
        }
        let ty = self.r#type.as_str();
        if !["market", "limit", "stop_market", "stop_limit"].contains(&ty) {
            return bad("type must be market, limit, stop_market or stop_limit");
        }
        opt_in("time_in_force", &self.time_in_force, &["gfd", "gtc"])?;
        opt_in("market_hours", &self.market_hours, &["regular_hours", "extended_hours", "all_day_hours"])?;
        opt_decimal("quantity", &self.quantity)?;
        opt_decimal("dollar_amount", &self.dollar_amount)?;
        opt_decimal("limit_price", &self.limit_price)?;
        opt_decimal("stop_price", &self.stop_price)?;
        let regular = matches!(self.market_hours.as_deref(), None | Some("regular_hours"));
        match (&self.quantity, &self.dollar_amount) {
            (Some(_), Some(_)) => return bad("give either quantity or dollar_amount, not both"),
            (None, None) => return bad("give quantity or dollar_amount"),
            (None, Some(_)) => {
                if ty != "market" || !regular {
                    return bad("dollar_amount is only valid for a market order in regular hours");
                }
            }
            (Some(q), None) => {
                if q.contains('.') && (ty != "market" || !regular) {
                    return bad("fractional quantity is only valid for a market order in regular hours");
                }
                // place_equity_order: fractional shares "up to 6 decimal places" (dollar_amount keeps the 8 of is_decimal).
                if q.split_once('.').is_some_and(|(_, f)| f.len() > 6) {
                    return bad("fractional quantity allows at most 6 decimal places");
                }
            }
        }
        let needs_limit = matches!(ty, "limit" | "stop_limit");
        let needs_stop = matches!(ty, "stop_market" | "stop_limit");
        if needs_limit != self.limit_price.is_some() {
            return bad(if needs_limit { "limit_price is required for limit and stop_limit orders" } else { "limit_price is only valid for limit and stop_limit orders" });
        }
        if needs_stop != self.stop_price.is_some() {
            return bad(if needs_stop { "stop_price is required for stop_market and stop_limit orders" } else { "stop_price is only valid for stop_market and stop_limit orders" });
        }
        if ty != "limit" && !regular {
            return bad("market and stop orders are regular hours only; use a limit order for extended or all-day sessions");
        }
        Ok(())
    }

    /// Tool arguments with `None` fields omitted. `ref_id` is added only when given (place calls).
    pub fn to_tool_args(&self, ref_id: Option<&str>) -> Value {
        let mut v = strip_nulls(serde_json::to_value(self).unwrap_or(Value::Null));
        if let (Some(id), Some(m)) = (ref_id, v.as_object_mut()) {
            m.insert("ref_id".into(), Value::String(id.to_string()));
        }
        v
    }
}

impl OptionOrderArgs {
    pub fn validate(&self) -> Result<(), RhError> {
        if !is_account(&self.account_number) {
            return bad("account_number must be alphanumeric");
        }
        if self.legs.is_empty() || self.legs.len() > 4 {
            return bad("an option order needs 1 to 4 legs");
        }
        let mut seen: Vec<String> = Vec::new();
        for l in &self.legs {
            if !is_uuid(&l.option_id) {
                return bad("option_id must be an option instrument UUID");
            }
            let id = l.option_id.to_ascii_lowercase();
            if seen.contains(&id) {
                return bad("each leg must be a different contract");
            }
            seen.push(id);
            if !["buy", "sell"].contains(&l.side.as_str()) {
                return bad("leg side must be buy or sell");
            }
            if !["open", "close"].contains(&l.position_effect.as_str()) {
                return bad("leg position_effect must be open or close");
            }
            if l.ratio_quantity < 1 {
                return bad("leg ratio_quantity must be at least 1");
            }
        }
        if !is_decimal(&self.quantity) || self.quantity.contains('.') {
            return bad("quantity must be a positive whole number of contracts");
        }
        let ty = self.r#type.as_deref().unwrap_or("limit");
        if !["limit", "market", "stop_limit", "stop_market"].contains(&ty) {
            return bad("type must be limit, market, stop_limit or stop_market");
        }
        if self.legs.len() > 1 && ty != "limit" {
            return bad("multi-leg orders support limit only");
        }
        opt_in("time_in_force", &self.time_in_force, &["gfd", "gtc"])?;
        opt_in("market_hours", &self.market_hours, &["regular_hours", "regular_curb_hours", "regular_curb_overnight_hours"])?;
        opt_in("direction", &self.direction, &["debit", "credit"])?;
        opt_decimal("price", &self.price)?;
        opt_decimal("stop_price", &self.stop_price)?;
        if ty == "market" && self.time_in_force.as_deref().unwrap_or("gfd") != "gfd" {
            return bad("market option orders must be gfd");
        }
        if ty != "limit" && !matches!(self.market_hours.as_deref(), None | Some("regular_hours")) {
            return bad("only limit option orders can use an extended or curb session");
        }
        let needs_price = matches!(ty, "limit" | "stop_limit");
        let needs_stop = matches!(ty, "stop_limit" | "stop_market");
        if needs_price != self.price.is_some() {
            return bad(if needs_price { "price is required for limit and stop_limit orders" } else { "price must be omitted for market and stop_market orders" });
        }
        if needs_stop != self.stop_price.is_some() {
            return bad(if needs_stop { "stop_price is required for stop_limit and stop_market orders" } else { "stop_price must be omitted for limit and market orders" });
        }
        if self.legs.len() >= 2 {
            if self.direction.is_none() {
                return bad("direction (debit or credit) is required for multi-leg orders");
            }
        } else if let Some(d) = &self.direction {
            let want = if self.legs[0].side == "buy" { "debit" } else { "credit" };
            if d != want {
                return bad(format!("direction {d} contradicts a single {} leg", self.legs[0].side));
            }
        }
        Ok(())
    }

    /// For one leg the server derives `direction`, so it is dropped here.
    pub fn to_tool_args(&self, ref_id: Option<&str>) -> Value {
        let mut v = strip_nulls(serde_json::to_value(self).unwrap_or(Value::Null));
        if let Some(m) = v.as_object_mut() {
            if self.legs.len() == 1 {
                m.remove("direction");
            }
            if let Some(id) = ref_id {
                m.insert("ref_id".into(), Value::String(id.to_string()));
            }
        }
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn eq() -> EquityOrderArgs {
        EquityOrderArgs {
            account_number: "SYN00000002".into(),
            symbol: "AAPL".into(),
            side: "buy".into(),
            r#type: "limit".into(),
            quantity: Some("1".into()),
            dollar_amount: None,
            limit_price: Some("100.50".into()),
            stop_price: None,
            time_in_force: None,
            market_hours: None,
        }
    }
    const UUID_A: &str = "11111111-2222-4333-8444-555555555555";
    const UUID_B: &str = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    fn leg(id: &str, side: &str, eff: &str) -> OptionLeg {
        OptionLeg { option_id: id.into(), side: side.into(), position_effect: eff.into(), ratio_quantity: 1 }
    }
    fn op() -> OptionOrderArgs {
        OptionOrderArgs {
            account_number: "SYN00000002".into(),
            legs: vec![leg(UUID_A, "buy", "open")],
            quantity: "1".into(),
            r#type: None,
            price: Some("1.50".into()),
            stop_price: None,
            time_in_force: None,
            market_hours: None,
            direction: None,
        }
    }

    #[test]
    fn decimals_follow_the_exact_grammar() {
        for ok in ["1", "0.5", "100", "100.50", "0.00000001", "007", "12345.12345678"] {
            assert!(is_decimal(ok), "{ok}");
        }
        for bad in [
            "", "-1", "+1", "1e3", "1E3", "0", "0.0", "0.00000000", " 5", "5 ", "NaN", "inf", "Infinity",
            "1.123456789", ".5", "5.", "1,5", "0x10", "１", "1_0", "--1", "1.2.3",
        ] {
            assert!(!is_decimal(bad), "{bad:?}");
        }
    }

    #[test]
    fn symbols_follow_the_exact_grammar() {
        for ok in ["A", "AAPL", "BRK.B", "BF-B", "A1", "ABCDEFGHIJ"] {
            assert!(is_symbol(ok), "{ok}");
        }
        for bad in ["", "aapl", "Aapl", "A B", "1ABC", ".A", "-A", "ABCDEFGHIJK", "AA PL", "AAPL\n", "A;B", "A/B", "ÅB"] {
            assert!(!is_symbol(bad), "{bad:?}");
        }
    }

    #[test]
    fn masking_shows_only_the_last_four() {
        assert_eq!(mask_account("SYN00000002"), "••••0002");
        assert_eq!(mask_account("1234"), "••••1234");
        assert_eq!(mask_account("12"), "••••12");
        assert_eq!(mask_account(""), "••••");
        assert!(!mask_account("SYN00000002").contains("SYN"));
    }

    fn eq_with(f: impl FnOnce(&mut EquityOrderArgs)) -> EquityOrderArgs {
        let mut a = eq();
        f(&mut a);
        a
    }

    #[test]
    fn equity_valid_cases() {
        let cases: Vec<(&str, EquityOrderArgs)> = vec![
            ("plain limit", eq()),
            ("gtc extended limit", eq_with(|a| { a.time_in_force = Some("gtc".into()); a.market_hours = Some("extended_hours".into()); })),
            ("all day limit", eq_with(|a| a.market_hours = Some("all_day_hours".into()))),
            ("sell", eq_with(|a| a.side = "sell".into())),
            ("BRK.B", eq_with(|a| a.symbol = "BRK.B".into())),
            ("market qty", eq_with(|a| { a.r#type = "market".into(); a.limit_price = None; })),
            ("fractional market regular", eq_with(|a| { a.r#type = "market".into(); a.limit_price = None; a.quantity = Some("0.5".into()); })),
            ("dollar market", eq_with(|a| { a.r#type = "market".into(); a.limit_price = None; a.quantity = None; a.dollar_amount = Some("100.00".into()); })),
            ("dollar market explicit regular", eq_with(|a| { a.r#type = "market".into(); a.limit_price = None; a.quantity = None; a.dollar_amount = Some("5".into()); a.market_hours = Some("regular_hours".into()); })),
            ("stop_market", eq_with(|a| { a.r#type = "stop_market".into(); a.limit_price = None; a.stop_price = Some("90".into()); })),
            ("stop_limit", eq_with(|a| { a.r#type = "stop_limit".into(); a.stop_price = Some("90".into()); })),
            ("limit fractional extended is NOT ok but integer is", eq_with(|a| { a.market_hours = Some("extended_hours".into()); a.quantity = Some("3".into()); })),
        ];
        for (name, a) in cases {
            assert_eq!(a.validate(), Ok(()), "{name}");
        }
    }

    #[test]
    fn equity_invalid_cases_are_all_rejected() {
        let cases: Vec<(&str, EquityOrderArgs)> = vec![
            ("empty account", eq_with(|a| a.account_number = "".into())),
            ("account with space", eq_with(|a| a.account_number = "SYN 1".into())),
            ("account with dash", eq_with(|a| a.account_number = "SYN-1".into())),
            ("lowercase symbol", eq_with(|a| a.symbol = "aapl".into())),
            ("symbol with space", eq_with(|a| a.symbol = "A B".into())),
            ("empty symbol", eq_with(|a| a.symbol = "".into())),
            ("bad side", eq_with(|a| a.side = "BUY".into())),
            ("bad type", eq_with(|a| a.r#type = "trailing_stop".into())),
            ("neither qty nor dollars", eq_with(|a| a.quantity = None)),
            ("both qty and dollars", eq_with(|a| { a.r#type = "market".into(); a.limit_price = None; a.dollar_amount = Some("10".into()); })),
            ("dollar with limit", eq_with(|a| { a.quantity = None; a.dollar_amount = Some("10".into()); })),
            ("dollar with stop_market", eq_with(|a| { a.r#type = "stop_market".into(); a.limit_price = None; a.stop_price = Some("9".into()); a.quantity = None; a.dollar_amount = Some("10".into()); })),
            ("dollar market extended", eq_with(|a| { a.r#type = "market".into(); a.limit_price = None; a.quantity = None; a.dollar_amount = Some("10".into()); a.market_hours = Some("extended_hours".into()); })),
            ("limit without price", eq_with(|a| a.limit_price = None)),
            ("stop_limit without limit", eq_with(|a| { a.r#type = "stop_limit".into(); a.limit_price = None; a.stop_price = Some("9".into()); })),
            ("stop_limit without stop", eq_with(|a| a.r#type = "stop_limit".into())),
            ("stop_market without stop", eq_with(|a| { a.r#type = "stop_market".into(); a.limit_price = None; })),
            ("limit with stop price", eq_with(|a| a.stop_price = Some("9".into()))),
            ("market with limit price", eq_with(|a| a.r#type = "market".into())),
            ("market extended", eq_with(|a| { a.r#type = "market".into(); a.limit_price = None; a.market_hours = Some("extended_hours".into()); })),
            ("stop_market all day", eq_with(|a| { a.r#type = "stop_market".into(); a.limit_price = None; a.stop_price = Some("9".into()); a.market_hours = Some("all_day_hours".into()); })),
            ("stop_limit extended", eq_with(|a| { a.r#type = "stop_limit".into(); a.stop_price = Some("9".into()); a.market_hours = Some("extended_hours".into()); })),
            ("fractional limit", eq_with(|a| a.quantity = Some("0.5".into()))),
            ("fractional market extended", eq_with(|a| { a.r#type = "market".into(); a.limit_price = None; a.quantity = Some("0.5".into()); a.market_hours = Some("extended_hours".into()); })),
            ("bad tif", eq_with(|a| a.time_in_force = Some("ioc".into()))),
            ("bad session", eq_with(|a| a.market_hours = Some("overnight".into()))),
            ("qty empty", eq_with(|a| a.quantity = Some("".into()))),
            ("qty negative", eq_with(|a| a.quantity = Some("-1".into()))),
            ("qty zero", eq_with(|a| a.quantity = Some("0".into()))),
            ("qty exponent", eq_with(|a| a.quantity = Some("1e3".into()))),
            ("qty leading space", eq_with(|a| a.quantity = Some(" 5".into()))),
            ("qty NaN", eq_with(|a| a.quantity = Some("NaN".into()))),
            ("qty too many decimals", eq_with(|a| a.quantity = Some("1.123456789".into()))),
            ("limit price zero", eq_with(|a| a.limit_price = Some("0".into()))),
            ("limit price negative", eq_with(|a| a.limit_price = Some("-1".into()))),
            ("limit price exponent", eq_with(|a| a.limit_price = Some("1e2".into()))),
            ("stop price NaN", eq_with(|a| { a.r#type = "stop_limit".into(); a.stop_price = Some("NaN".into()); })),
        ];
        for (name, a) in cases {
            let e = a.validate().expect_err(name);
            assert!(matches!(e, RhError::Invalid(_)), "{name}: {e:?}");
        }
    }

    fn op_with(f: impl FnOnce(&mut OptionOrderArgs)) -> OptionOrderArgs {
        let mut a = op();
        f(&mut a);
        a
    }

    fn two_legs() -> Vec<OptionLeg> {
        vec![leg(UUID_A, "buy", "open"), leg(UUID_B, "sell", "open")]
    }

    #[test]
    fn option_valid_cases() {
        let cases: Vec<(&str, OptionOrderArgs)> = vec![
            ("single limit", op()),
            ("single limit gtc", op_with(|a| a.time_in_force = Some("gtc".into()))),
            ("single sell to close", op_with(|a| a.legs = vec![leg(UUID_A, "sell", "close")])),
            ("single with consistent debit", op_with(|a| a.direction = Some("debit".into()))),
            ("single sell with credit", op_with(|a| { a.legs = vec![leg(UUID_A, "sell", "open")]; a.direction = Some("credit".into()); })),
            ("uppercase uuid", op_with(|a| a.legs = vec![leg("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "buy", "open")])),
            ("explicit limit type", op_with(|a| a.r#type = Some("limit".into()))),
            ("market gfd", op_with(|a| { a.r#type = Some("market".into()); a.price = None; })),
            ("stop_limit", op_with(|a| { a.r#type = Some("stop_limit".into()); a.stop_price = Some("1.00".into()); })),
            ("stop_market", op_with(|a| { a.r#type = Some("stop_market".into()); a.price = None; a.stop_price = Some("1".into()); })),
            ("two-leg debit", op_with(|a| { a.legs = two_legs(); a.direction = Some("debit".into()); })),
            ("four legs credit", op_with(|a| {
                a.legs = vec![
                    leg("00000000-0000-4000-8000-000000000001", "buy", "open"),
                    leg("00000000-0000-4000-8000-000000000002", "sell", "open"),
                    leg("00000000-0000-4000-8000-000000000003", "sell", "open"),
                    leg("00000000-0000-4000-8000-000000000004", "buy", "open"),
                ];
                a.direction = Some("credit".into());
            })),
            ("ratio 2", op_with(|a| a.legs[0].ratio_quantity = 2)),
            ("curb session on limit", op_with(|a| a.market_hours = Some("regular_curb_hours".into()))),
            ("quantity 10", op_with(|a| a.quantity = "10".into())),
        ];
        for (name, a) in cases {
            assert_eq!(a.validate(), Ok(()), "{name}");
        }
    }

    #[test]
    fn option_invalid_cases_are_all_rejected() {
        let cases: Vec<(&str, OptionOrderArgs)> = vec![
            ("empty account", op_with(|a| a.account_number = "".into())),
            ("zero legs", op_with(|a| a.legs = vec![])),
            ("five legs", op_with(|a| {
                a.direction = Some("debit".into());
                a.legs = (1..=5).map(|i| leg(&format!("00000000-0000-4000-8000-00000000000{i}"), "buy", "open")).collect();
            })),
            ("duplicate legs", op_with(|a| { a.legs = vec![leg(UUID_A, "buy", "open"), leg(UUID_A, "sell", "open")]; a.direction = Some("debit".into()); })),
            ("duplicate legs differing in case", op_with(|a| {
                a.legs = vec![leg("AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", "buy", "open"), leg(UUID_B, "sell", "open")];
                a.direction = Some("debit".into());
            })),
            ("option id not a uuid", op_with(|a| a.legs = vec![leg("12345", "buy", "open")])),
            ("option id url", op_with(|a| a.legs = vec![leg("https://api.robinhood.com/options/instruments/11111111-2222-4333-8444-555555555555/", "buy", "open")])),
            ("option id braces", op_with(|a| a.legs = vec![leg("{11111111-2222-4333-8444-555555555555}", "buy", "open")])),
            ("option id no dashes", op_with(|a| a.legs = vec![leg("11111111222243338444555555555555", "buy", "open")])),
            ("option id non-hex", op_with(|a| a.legs = vec![leg("g1111111-2222-4333-8444-555555555555", "buy", "open")])),
            ("bad leg side", op_with(|a| a.legs = vec![leg(UUID_A, "BUY", "open")])),
            ("bad position effect", op_with(|a| a.legs = vec![leg(UUID_A, "buy", "opening")])),
            ("ratio zero", op_with(|a| a.legs[0].ratio_quantity = 0)),
            ("quantity empty", op_with(|a| a.quantity = "".into())),
            ("quantity fractional", op_with(|a| a.quantity = "1.5".into())),
            ("quantity 1.0", op_with(|a| a.quantity = "1.0".into())),
            ("quantity zero", op_with(|a| a.quantity = "0".into())),
            ("quantity negative", op_with(|a| a.quantity = "-1".into())),
            ("quantity exponent", op_with(|a| a.quantity = "1e1".into())),
            ("quantity space", op_with(|a| a.quantity = " 1".into())),
            ("bad type", op_with(|a| a.r#type = Some("trailing".into()))),
            ("limit without price", op_with(|a| a.price = None)),
            ("limit price zero", op_with(|a| a.price = Some("0".into()))),
            ("limit price exponent", op_with(|a| a.price = Some("1e0".into()))),
            ("limit with stop price", op_with(|a| a.stop_price = Some("1".into()))),
            ("market with price", op_with(|a| a.r#type = Some("market".into()))),
            ("market gtc", op_with(|a| { a.r#type = Some("market".into()); a.price = None; a.time_in_force = Some("gtc".into()); })),
            ("market curb", op_with(|a| { a.r#type = Some("market".into()); a.price = None; a.market_hours = Some("regular_curb_hours".into()); })),
            ("stop_limit without stop", op_with(|a| a.r#type = Some("stop_limit".into()))),
            ("stop_limit without price", op_with(|a| { a.r#type = Some("stop_limit".into()); a.price = None; a.stop_price = Some("1".into()); })),
            ("stop_market without stop", op_with(|a| { a.r#type = Some("stop_market".into()); a.price = None; })),
            ("stop_market with price", op_with(|a| { a.r#type = Some("stop_market".into()); a.stop_price = Some("1".into()); })),
            ("multi-leg market", op_with(|a| { a.legs = two_legs(); a.direction = Some("debit".into()); a.r#type = Some("market".into()); a.price = None; })),
            ("multi-leg stop_limit", op_with(|a| { a.legs = two_legs(); a.direction = Some("debit".into()); a.r#type = Some("stop_limit".into()); a.stop_price = Some("1".into()); })),
            ("multi-leg without direction", op_with(|a| a.legs = two_legs())),
            ("multi-leg bad direction", op_with(|a| { a.legs = two_legs(); a.direction = Some("net".into()); })),
            ("single leg inconsistent direction", op_with(|a| a.direction = Some("credit".into()))),
            ("bad tif", op_with(|a| a.time_in_force = Some("day".into()))),
            ("bad session", op_with(|a| a.market_hours = Some("extended_hours".into()))),
            ("stop_limit in curb", op_with(|a| { a.r#type = Some("stop_limit".into()); a.stop_price = Some("1".into()); a.market_hours = Some("regular_curb_hours".into()); })),
        ];
        for (name, a) in cases {
            let e = a.validate().expect_err(name);
            assert!(matches!(e, RhError::Invalid(_)), "{name}: {e:?}");
        }
    }

    /// R10h: place_equity_order allows fractional shares "up to 6 decimal places"; dollar amounts keep 8.
    #[test]
    fn fractional_equity_quantity_is_capped_at_6_decimals() {
        let mkt = |q: Option<&str>, d: Option<&str>| eq_with(|a| { a.r#type = "market".into(); a.limit_price = None; a.quantity = q.map(String::from); a.dollar_amount = d.map(String::from); });
        assert_eq!(mkt(Some("0.123456"), None).validate(), Ok(()));
        assert!(matches!(mkt(Some("0.1234567"), None).validate(), Err(RhError::Invalid(m)) if m.contains("6")));
        assert!(mkt(Some("1.12345678"), None).validate().is_err());
        assert_eq!(mkt(None, Some("10.12345678")).validate(), Ok(()), "dollar_amount keeps 8 decimals");
    }

    #[test]
    fn equity_to_tool_args_omits_none_and_adds_ref_id_only_when_given() {
        let a = eq();
        let v = a.to_tool_args(None);
        assert_eq!(
            v,
            json!({"account_number":"SYN00000002","symbol":"AAPL","side":"buy","type":"limit","quantity":"1","limit_price":"100.50"})
        );
        assert!(v.get("ref_id").is_none());
        let v = a.to_tool_args(Some("rid-1"));
        assert_eq!(v["ref_id"], "rid-1");
        assert!(v.get("dollar_amount").is_none() && v.get("stop_price").is_none() && v.get("time_in_force").is_none());
        let mut b = eq();
        b.time_in_force = Some("gtc".into());
        b.market_hours = Some("extended_hours".into());
        assert_eq!(b.to_tool_args(None)["time_in_force"], "gtc");
        assert_eq!(b.to_tool_args(None)["market_hours"], "extended_hours");
    }

    #[test]
    fn option_to_tool_args_omits_none_and_drops_direction_for_one_leg() {
        let a = op();
        let v = a.to_tool_args(None);
        assert_eq!(
            v,
            json!({"account_number":"SYN00000002","legs":[{"option_id":UUID_A,"side":"buy","position_effect":"open","ratio_quantity":1}],"quantity":"1","price":"1.50"})
        );
        let v = a.to_tool_args(Some("rid-2"));
        assert_eq!(v["ref_id"], "rid-2");
        assert!(v.get("type").is_none() && v.get("direction").is_none() && v.get("stop_price").is_none());

        let mut c = op();
        c.direction = Some("debit".into());
        assert!(c.to_tool_args(None).get("direction").is_none(), "one leg: server derives direction, omit it");

        let mut m = op();
        m.legs = two_legs();
        m.direction = Some("debit".into());
        let v = m.to_tool_args(None);
        assert_eq!(v["direction"], "debit");
        assert_eq!(v["legs"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn unknown_fields_are_rejected_so_the_webview_cannot_smuggle_params() {
        let eq_ok = json!({"account_number":"A1","symbol":"AAPL","side":"buy","type":"limit","quantity":"1","limit_price":"1",
            "dollar_amount":null,"stop_price":null,"time_in_force":null,"market_hours":null});
        assert!(serde_json::from_value::<EquityOrderArgs>(eq_ok.clone()).is_ok());
        for extra in [("ref_id", json!("x")), ("tax_lots", json!([])), ("chain_symbol", json!("AAPL")), ("review_id", json!("r")), ("raw", json!({}))] {
            let mut v = eq_ok.clone();
            v[extra.0] = extra.1;
            assert!(serde_json::from_value::<EquityOrderArgs>(v).is_err(), "{}", extra.0);
        }
        let op_ok = json!({"account_number":"A1","legs":[{"option_id":UUID_A,"side":"buy","position_effect":"open","ratio_quantity":1}],"quantity":"1","price":"1"});
        assert!(serde_json::from_value::<OptionOrderArgs>(op_ok.clone()).is_ok());
        let mut v = op_ok.clone();
        v["ref_id"] = json!("x");
        assert!(serde_json::from_value::<OptionOrderArgs>(v).is_err());
        let mut v = op_ok.clone();
        v["legs"][0]["extra"] = json!(1);
        assert!(serde_json::from_value::<OptionOrderArgs>(v).is_err(), "leg objects are strict too");
        let mut v = op_ok;
        v["chain_symbol"] = json!("AAPL");
        assert!(serde_json::from_value::<OptionOrderArgs>(v).is_err());
    }
}
