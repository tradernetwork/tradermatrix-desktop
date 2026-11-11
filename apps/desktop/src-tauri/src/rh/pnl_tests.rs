//! M7 P&L reads against the loopback mock. Reuses the watchlist harness (same guard: any unexpected tool is a violation).
use serde_json::{json, Value};

use crate::rh::pnl::{self, MAX_TRADE_PAGES};
use crate::rh::watch_tests::{harness, Mode};
use crate::rh::RhError;

macro_rules! fx {
    ($n:literal) => {
        serde_json::from_str::<Value>(include_str!(concat!("../../tests/fixtures/rh/", $n))).unwrap()
    };
}

const ALLOW: [&str; 3] = ["get_accounts", "get_realized_pnl", "get_pnl_trade_history"];

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[tokio::test]
async fn realized_pnl_maps_the_account_to_rhs_and_parses_the_fixture() {
    let h = harness(&ALLOW, Mode::Ok, fx!("accounts.json"), |_, _| fx!("realized_pnl.json")).await;
    let p = h.rh.realized_pnl("SYN00000001", "month", &[]).await.unwrap();
    assert_eq!(p.window.as_deref(), Some("month"));
    assert_eq!(p.total_returns, Some(12.5));
    assert_eq!(p.total_rate_of_return, Some(0.0012));
    assert_eq!(p.data_points.len(), 1);
    assert_eq!(p.data_points[0].realized_gain, Some(12.5));
    assert_eq!(p.data_points[0].rate_of_realized_gain, None);
    assert_eq!(p.data_points[0].number_of_trades, Some(3.0));
    assert_eq!(h.calls(), [("get_accounts".to_string(), json!({})), ("get_realized_pnl".to_string(), json!({"account_number":"900000001","span":"month"}))]);
    h.clean();
}

#[tokio::test]
async fn realized_pnl_passes_deduped_asset_classes() {
    let h = harness(&ALLOW, Mode::Ok, fx!("accounts.json"), |_, _| fx!("realized_pnl.json")).await;
    h.rh.realized_pnl("SYN00000002", "ytd", &s(&["option", "equity", "option"])).await.unwrap();
    assert_eq!(h.calls()[1].1, json!({"account_number":"900000002","span":"ytd","asset_classes":["option","equity"]}));
    h.clean();
}

#[tokio::test]
async fn empty_null_missing_and_unknown_fields_never_break_the_mapper() {
    for payload in [
        json!({"data":{"account_number":"900000001","window":"week","display_currency":"USD","data_points":[],"total_returns":"0","total_rate_of_return":"0"}}),
        json!({"data":{"data_points":null,"total_returns":null,"total_rate_of_return":null,"window":null}}),
        json!({"data":{}}),
        json!({"data":{"brand_new":{"a":1},"data_points":[null,{"realized_gain":null,"number_of_trades":"4","zzz":1},{"start_time":5}],"total_returns":12}}),
    ] {
        let p2 = payload.clone();
        let h = harness(&ALLOW, Mode::Ok, fx!("accounts.json"), move |_, _| p2.clone()).await;
        let p = h.rh.realized_pnl("SYN00000001", "week", &[]).await.unwrap_or_else(|e| panic!("{payload}: {e:?}"));
        if payload["data"]["data_points"].is_array() && payload["data"]["data_points"].as_array().unwrap().len() == 3 {
            assert_eq!(p.data_points.len(), 2, "null element dropped");
            assert_eq!(p.data_points[0].number_of_trades, Some(4.0));
            assert_eq!(p.data_points[0].realized_gain, None);
            assert_eq!(p.total_returns, Some(12.0));
        } else {
            assert!(p.data_points.is_empty());
        }
        h.clean();
    }
}

#[tokio::test]
async fn trades_fixture_parses_with_nulls_strings_and_unknown_fields() {
    let h = harness(&ALLOW, Mode::Ok, fx!("accounts.json"), |_, _| {
        let mut f = fx!("pnl_trades.json");
        f["data"]["next_cursor"] = json!("");
        f
    })
    .await;
    let t = h.rh.pnl_trades("SYN00000001", "month", None, None).await.unwrap();
    assert_eq!(t.next_cursor, None, "empty cursor means no more");
    assert_eq!(t.trades.len(), 3, "null element dropped");
    assert_eq!(t.trades[0].symbol, "AAA");
    assert_eq!(t.trades[0].side.as_deref(), Some("sell"));
    assert_eq!((t.trades[0].quantity, t.trades[0].price, t.trades[0].realized_gain), (Some(10.0), Some(101.5), Some(15.0)));
    assert_eq!(t.trades[1].quantity, Some(2.5), "bare number quantity");
    assert_eq!(t.trades[1].realized_gain, Some(-3.25));
    assert_eq!(t.trades[2].symbol, "CCC");
    assert_eq!((t.trades[2].side.clone(), t.trades[2].quantity, t.trades[2].price, t.trades[2].realized_gain, t.trades[2].timestamp.clone()), (None, None, None, None, None));
    assert!(t.trades.iter().all(|x| !x.trade_key.is_empty()));
    assert_eq!(h.calls()[1], ("get_pnl_trade_history".to_string(), json!({"account_number":"900000001","span":"month"})));
    h.clean();
}

#[tokio::test]
async fn paging_merges_pages_through_the_opaque_cursor_and_sends_symbol() {
    let h = harness(&ALLOW, Mode::Ok, fx!("accounts.json"), |_, a| if a.get("cursor").is_none() { fx!("pnl_trades.json") } else { fx!("pnl_trades_page2.json") }).await;
    let t = h.rh.pnl_trades("SYN00000001", "month", Some("aaa"), None).await.unwrap();
    assert_eq!(t.trades.iter().map(|x| x.symbol.as_str()).collect::<Vec<_>>(), ["AAA", "BBB", "CCC", "AAA"]);
    assert_eq!(t.next_cursor, None);
    let c = h.calls();
    assert_eq!(c.len(), 3);
    assert_eq!(c[1].1, json!({"account_number":"900000001","span":"month","symbol":"AAA"}));
    assert_eq!(c[2].1, json!({"account_number":"900000001","span":"month","symbol":"AAA","cursor":"cursor-page-2"}));
    h.clean();
}

#[tokio::test]
async fn paging_stops_at_five_pages_and_returns_the_resume_cursor() {
    let h = harness(&ALLOW, Mode::Ok, fx!("accounts.json"), |_, a| {
        let n: usize = a.get("cursor").and_then(Value::as_str).map(|c| c.trim_start_matches('c').parse().unwrap()).unwrap_or(0);
        json!({"data":{"trades":[{"symbol":"AAA","side":"sell","quantity":"1","price":"1","realized_gain":"1","timestamp":format!("2026-01-{:02}T00:00:00Z", n + 1)}],"next_cursor":format!("c{}", n + 1)}})
    })
    .await;
    let t = h.rh.pnl_trades("SYN00000001", "all", None, None).await.unwrap();
    assert_eq!(h.count("get_pnl_trade_history"), MAX_TRADE_PAGES);
    assert_eq!(t.trades.len(), MAX_TRADE_PAGES);
    assert_eq!(t.next_cursor.as_deref(), Some("c5"), "the caller can resume from here");
    let keys: std::collections::HashSet<_> = t.trades.iter().map(|x| x.trade_key.clone()).collect();
    assert_eq!(keys.len(), MAX_TRADE_PAGES);
    // resume
    let t2 = h.rh.pnl_trades("SYN00000001", "all", None, Some("c5")).await.unwrap();
    assert_eq!(h.calls().iter().rev().nth(MAX_TRADE_PAGES - 1).unwrap().1["cursor"], "c5");
    assert_eq!(t2.trades.len(), MAX_TRADE_PAGES);
    h.clean();
}

#[tokio::test]
async fn a_repeating_cursor_cannot_loop() {
    let h = harness(&ALLOW, Mode::Ok, fx!("accounts.json"), |_, _| json!({"data":{"trades":[{"symbol":"X"}],"next_cursor":"same"}})).await;
    let t = h.rh.pnl_trades("SYN00000001", "week", None, None).await.unwrap();
    assert!(h.count("get_pnl_trade_history") <= 2, "{}", h.count("get_pnl_trade_history"));
    assert_eq!(t.next_cursor, None);
    h.clean();
}

#[test]
fn trade_key_is_stable_distinct_and_documented_inputs_only() {
    let t = |ts: &str| json!({"symbol":"AAA","side":"sell","quantity":"10","price":"101.50","realized_gain":"15.00","timestamp":ts});
    let a = pnl::trade_key("900000001", &t("2026-11-05T15:30:00Z"));
    assert_eq!(a, pnl::trade_key("900000001", &t("2026-11-05T15:30:00Z")), "stable");
    assert_ne!(a, pnl::trade_key("900000001", &t("2026-11-05T15:30:01Z")), "differs only by timestamp");
    assert_ne!(a, pnl::trade_key("900000002", &t("2026-11-05T15:30:00Z")), "account is part of the key");
    let mut other = t("2026-11-05T15:30:00Z");
    other["side"] = json!("buy");
    assert_ne!(a, pnl::trade_key("900000001", &other));
    other = t("2026-11-05T15:30:00Z");
    other["quantity"] = json!(10); // number vs string of the same value: same key
    assert_eq!(a, pnl::trade_key("900000001", &other));
    other["price"] = json!("101.51");
    assert_ne!(a, pnl::trade_key("900000001", &other));
    // realized_gain and unknown fields are not part of the key
    let mut g = t("2026-11-05T15:30:00Z");
    g["realized_gain"] = json!("999");
    g["junk"] = json!(1);
    assert_eq!(a, pnl::trade_key("900000001", &g));
    assert!(a.len() <= 64 && a.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'), "safe for the journal trade_key column: {a}");
}

#[tokio::test]
async fn identical_trades_get_distinct_ordinal_keys() {
    let one = json!({"symbol":"AAA","side":"sell","quantity":"1","price":"5","realized_gain":"1","timestamp":"2026-11-05T15:30:00Z"});
    let h = harness(&ALLOW, Mode::Ok, fx!("accounts.json"), move |_, _| json!({"data":{"trades":[one.clone(), one.clone()],"next_cursor":""}})).await;
    let t = h.rh.pnl_trades("SYN00000001", "week", None, None).await.unwrap();
    assert_eq!(t.trades.len(), 2);
    assert_ne!(t.trades[0].trade_key, t.trades[1].trade_key);
    assert!(t.trades[1].trade_key.ends_with("_2"), "{}", t.trades[1].trade_key);
    h.clean();
}

#[tokio::test]
async fn a_missing_rhs_account_number_or_unknown_account_is_refused_before_any_pnl_request() {
    let accounts = json!({"data":{"accounts":[{"account_number":"NORHS001","rhs_account_number":null},{"account_number":"EMPTY002","rhs_account_number":""}]}});
    let h = harness(&ALLOW, Mode::Ok, accounts, |_, _| json!({"data":{}})).await;
    for acct in ["NORHS001", "EMPTY002", "UNKNOWN9"] {
        let e = h.rh.realized_pnl(acct, "week", &[]).await.unwrap_err();
        assert!(matches!(&e, RhError::Invalid(m) if m.contains("rhs_account_number") || m.contains("not found")), "{e:?}");
        assert!(h.rh.pnl_trades(acct, "week", None, None).await.is_err());
    }
    assert!(h.names().iter().all(|n| n == "get_accounts"), "{:?}", h.names());
    assert!(!h.rh.realized_pnl("NORHS001", "week", &[]).await.unwrap_err().to_string().contains("NORHS001"), "account numbers are masked in errors");
    h.clean();
}

#[tokio::test]
async fn bad_arguments_cost_zero_requests() {
    let h = harness(&[], Mode::Ok, fx!("accounts.json"), |_, _| json!({"data":{}})).await;
    let r = &h.rh;
    assert!(r.realized_pnl("SYN00000001", "decade", &[]).await.is_err());
    assert!(r.realized_pnl("SYN00000001", "", &[]).await.is_err());
    assert!(r.realized_pnl("SYN00000001", "week; drop", &[]).await.is_err());
    assert!(r.realized_pnl("SYN00000001", "week", &s(&["futures"])).await.is_err());
    assert!(r.realized_pnl("bad acct", "week", &[]).await.is_err());
    assert!(r.pnl_trades("SYN00000001", "day", None, None).await.is_err(), "day is not a trade-history span");
    assert!(r.pnl_trades("SYN00000001", "year", None, None).await.is_err());
    assert!(r.pnl_trades("SYN00000001", "week", Some("bad sym!"), None).await.is_err());
    assert!(r.pnl_trades("SYN00000001", "week", Some("1ABC"), None).await.is_err());
    assert!(r.pnl_trades("SYN00000001", "week", None, Some("c\nx")).await.is_err());
    assert!(r.pnl_trades("SYN00000001", "week", None, Some(&"c".repeat(600))).await.is_err());
    assert_eq!(h.m.count(), 0, "not even initialize");
    h.clean();
}

#[test]
fn span_tables_match_the_tool_schemas() {
    for sp in ["day", "week", "month", "3month", "ytd", "year", "all"] {
        assert!(pnl::validate_realized(sp, &[]).is_ok(), "{sp}");
    }
    for sp in ["week", "month", "3month", "ytd", "all"] {
        assert!(pnl::validate_trades(sp, None, None).is_ok(), "{sp}");
    }
    assert_eq!(pnl::validate_trades("week", Some(" brk.b "), Some("abc")).unwrap(), (Some("BRK.B".into()), Some("abc".into())));
    assert_eq!(pnl::validate_trades("week", Some(""), Some("")).unwrap(), (None, None));
}
