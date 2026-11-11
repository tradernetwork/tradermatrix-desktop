//! M7 watchlist writes end to end against a loopback mock MCP server with fake tokens. NO traffic leaves 127.0.0.1.
//! The mock records a violation (and answers 500) for any tool a test did not allow, and for every order tool
//! and `delete_watchlist` (which does not exist upstream). Every test ends with `clean()`.
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::rh::mcp::is_read_tool;
use crate::rh::testutil::{Mock, Req, Resp};
use crate::rh::watch_writes as ww;
use crate::rh::RhError;
use crate::rh_commands::RhState;

macro_rules! fx {
    ($n:literal) => {
        serde_json::from_str::<Value>(include_str!(concat!("../../tests/fixtures/rh/", $n))).unwrap()
    };
}

pub(super) const CUSTOM: &str = "aaaaaaaa-0000-4000-8000-0000000000a1";
pub(super) const CURATED: &str = "aaaaaaaa-0000-4000-8000-0000000000b1";
pub(super) const OPTIONS: &str = "aaaaaaaa-0000-4000-8000-0000000000e1";
const OPT_A: &str = "aaaaaaaa-2222-4333-8444-555555555555";
const OPT_B: &str = "bbbbbbbb-2222-4333-8444-666666666666";
const FORBIDDEN: [&str; 8] = ["place", "cancel", "review", "decline", "replace", "exercise", "delete_watchlist", "advanced"];
const WRITES: [&str; 6] = ["create_watchlist", "update_watchlist", "add_to_watchlist", "remove_from_watchlist", "add_option_to_watchlist", "remove_option_from_watchlist"];

fn structured(req: &Req, sc: Value) -> Resp {
    Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"content":[{"type":"text","text":sc.to_string()}],"structuredContent":sc}}))
}

fn tool_error(req: &Req, text: &str) -> Resp {
    Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"isError":true,"content":[{"type":"text","text":text}]}}))
}

fn lists() -> Value {
    json!({"data":{"watchlists":[
        {"id":CUSTOM,"display_name":"Mine","owner_type":"custom","item_count":1,"allowed_object_types":["instrument"]},
        {"id":CURATED,"display_name":"Top Movers","owner_type":"robinhood","item_count":5,"allowed_object_types":["instrument"]},
        {"id":OPTIONS,"display_name":"My Options","owner_type":"custom","item_count":0,"allowed_object_types":["option_strategy"]},
        null
    ]}})
}

#[derive(Clone, Copy, PartialEq)]
pub(super) enum Mode {
    Ok,
    ToolErr,
    Drop,
}

pub(super) struct H {
    pub m: Mock,
    pub rh: RhState,
    violations: Arc<Mutex<Vec<String>>>,
}

/// `allow`: tools this test expects. `pnl` answers get_realized_pnl / get_pnl_trade_history (arguments in, structured out).
pub(super) async fn harness(allow: &[&'static str], mode: Mode, accounts: Value, pnl: impl Fn(&str, &Value) -> Value + Send + Sync + 'static) -> H {
    let allow: Vec<&'static str> = allow.to_vec();
    let violations = Arc::new(Mutex::new(Vec::<String>::new()));
    let v2 = violations.clone();
    let m = Mock::start(move |req, _| match req.rpc_method().as_str() {
        "initialize" => Some(
            Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"mock","version":"1"}}}))
                .header("Mcp-Session-Id", "sess-m7"),
        ),
        "notifications/initialized" => Some(Resp::status(202)),
        "tools/call" => {
            let j = req.json();
            let name = j["params"]["name"].as_str().unwrap_or("").to_string();
            let args = j["params"]["arguments"].clone();
            if FORBIDDEN.iter().any(|f| name.contains(f)) || !allow.contains(&name.as_str()) {
                v2.lock().unwrap().push(name);
                return Some(Resp::text(500, "unexpected tool"));
            }
            if WRITES.contains(&name.as_str()) {
                return match mode {
                    Mode::Drop => None,
                    Mode::ToolErr => Some(tool_error(req, "API error 400: synthetic failure for the test")),
                    Mode::Ok => {
                        let key = match name.as_str() {
                            "create_watchlist" => "create",
                            "update_watchlist" => "update",
                            "add_to_watchlist" => "add",
                            "remove_from_watchlist" => "remove",
                            "add_option_to_watchlist" => "option_add",
                            _ => "option_remove",
                        };
                        Some(structured(req, fx!("watchlist_write_ok.json")[key].clone()))
                    }
                };
            }
            match name.as_str() {
                "get_watchlists" => Some(structured(req, lists())),
                "get_accounts" => Some(structured(req, accounts.clone())),
                other => Some(structured(req, pnl(other, &args))),
            }
        }
        _ => Some(Resp::status(400)),
    })
    .await;
    let rh = RhState::for_test(m.url("/mcp/trading"), Arc::new(|| 1_000_000));
    H { m, rh, violations }
}

async fn wl(allow: &[&'static str], mode: Mode) -> H {
    harness(allow, mode, fx!("accounts.json"), |_, _| json!({"data":{}})).await
}

impl H {
    pub(super) fn calls(&self) -> Vec<(String, Value)> {
        self.m
            .requests()
            .iter()
            .filter(|r| r.rpc_method() == "tools/call")
            .map(|r| (r.json()["params"]["name"].as_str().unwrap().to_string(), r.json()["params"]["arguments"].clone()))
            .collect()
    }
    pub(super) fn names(&self) -> Vec<String> {
        self.calls().into_iter().map(|c| c.0).collect()
    }
    pub(super) fn count(&self, name: &str) -> usize {
        self.names().iter().filter(|n| *n == name).count()
    }
    pub(super) fn clean(&self) {
        assert!(self.violations.lock().unwrap().is_empty(), "unexpected tools reached the server: {:?}", self.violations.lock().unwrap());
        assert!(self.m.requests().iter().all(|r| r.method == "POST" && r.header("authorization") == Some("Bearer fake-access-token")));
    }
}

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

#[test]
fn watchlist_write_tools_are_not_read_tools_so_they_are_never_auto_retried() {
    for w in WRITES {
        assert!(!is_read_tool(w), "{w} must not be in the read retry set");
    }
    assert!(is_read_tool("get_watchlists") && is_read_tool("get_pnl_trade_history") && is_read_tool("get_realized_pnl"));
}

#[test]
fn symbols_are_trimmed_uppercased_deduped_and_pattern_checked() {
    assert_eq!(ww::normalize_symbols(&s(&[" aapl", "AAPL", "brk.b", "BF-B", "msft "])).unwrap(), ["AAPL", "BRK.B", "BF-B", "MSFT"]);
    let too_many: Vec<String> = (0..51).map(|i| format!("S{i}")).collect();
    let fifty: Vec<String> = (0..50).map(|i| format!("S{i}")).collect();
    assert!(ww::normalize_symbols(&too_many).is_err());
    assert_eq!(ww::normalize_symbols(&fifty).unwrap().len(), 50);
    assert!(ww::normalize_symbols(&[]).is_err(), "empty list");
    assert!(ww::normalize_symbols(&s(&["  "])).is_err());
    for bad in ["1ABC", "A B", "AAPL!", "TOOLONGSYMB", "-X", ".X", "A\nB", "BTC/USD", "aaaaaaaa-0000-4000-8000-0000000000a1", "ÀB", ""] {
        assert!(ww::normalize_symbols(&s(&[bad])).is_err(), "{bad:?}");
    }
    assert_eq!(ww::normalize_symbols(&s(&["ABCDEFGHIJ"])).unwrap().len(), 1, "10 chars is the limit");
}

#[test]
fn option_ids_must_be_uuids_at_most_20_and_deduped() {
    assert_eq!(ww::normalize_option_ids(&s(&[OPT_A, &OPT_A.to_uppercase(), OPT_B])).unwrap(), [OPT_A, OPT_B]);
    let many: Vec<String> = (0..21).map(|i| format!("11111111-2222-4333-8444-{i:012}")).collect();
    assert!(ww::normalize_option_ids(&many).is_err());
    assert_eq!(ww::normalize_option_ids(&many[..20]).unwrap().len(), 20);
    assert!(ww::normalize_option_ids(&[]).is_err());
    for bad in ["", "AAPL", "11111111222243338444555555555555", "{11111111-2222-4333-8444-555555555555}", "11111111-2222-4333-8444-55555555555z"] {
        assert!(ww::normalize_option_ids(&s(&[bad])).is_err(), "{bad:?}");
    }
}

#[test]
fn name_emoji_description_rules() {
    assert_eq!(ww::prepare_create("  Tech  ", None, None).unwrap(), ("Tech".into(), None, None));
    assert_eq!(ww::prepare_create("T", Some(""), Some("")).unwrap(), ("T".into(), None, None), "empty optional = absent");
    assert!(ww::prepare_create(&"n".repeat(50), None, None).is_ok());
    for bad in ["", "   ", "a\nb", "a\tb", "a\u{0}b"] {
        assert!(ww::prepare_create(bad, None, None).is_err(), "{bad:?}");
    }
    assert!(ww::prepare_create(&"n".repeat(51), None, None).is_err());
    assert!(ww::prepare_create("T", Some("\u{1F680}"), None).is_ok(), "4-byte emoji");
    assert!(ww::prepare_create("T", Some("\u{1F680}\u{1F680}"), None).is_ok(), "8 bytes");
    assert!(ww::prepare_create("T", Some("\u{1F680}\u{1F680}x"), None).is_err(), "9 bytes");
    assert!(ww::prepare_create("T", Some("a\nb"), None).is_err());
    assert!(ww::prepare_create("T", None, Some(&"d".repeat(200))).is_ok());
    assert!(ww::prepare_create("T", None, Some(&"d".repeat(201))).is_err());
    assert!(ww::prepare_create("T", None, Some("a\u{7}b")).is_err());
    assert!(ww::prepare_update(CUSTOM, None, None, None).is_err(), "nothing to change");
    assert!(ww::prepare_update("a b", Some("x"), None, None).is_err());
    assert!(ww::prepare_update("", Some("x"), None, None).is_err());
    assert_eq!(ww::prepare_update(CUSTOM, Some(" New "), None, Some("d")).unwrap(), (CUSTOM.into(), Some("New".into()), None, Some("d".into())));
}

#[tokio::test]
async fn create_sends_exactly_create_watchlist_with_trimmed_args() {
    let h = wl(&["create_watchlist"], Mode::Ok).await;
    let d = h.rh.watchlist_create("  Tech ", Some("\u{1F680}"), Some("my picks")).await.unwrap();
    assert_eq!(d["watchlist"]["id"], "aaaaaaaa-0000-4000-8000-0000000000c1");
    assert_eq!(h.calls(), [("create_watchlist".to_string(), json!({"display_name":"Tech","icon_emoji":"\u{1F680}","display_description":"my picks"}))]);
    h.rh.watchlist_create("Bare", None, None).await.unwrap();
    assert_eq!(h.calls()[1].1, json!({"display_name":"Bare"}), "absent optionals are not sent");
    h.clean();
}

#[tokio::test]
async fn update_checks_the_list_then_sends_only_given_fields() {
    let h = wl(&["get_watchlists", "update_watchlist"], Mode::Ok).await;
    let d = h.rh.watchlist_update(CUSTOM, Some("Renamed"), None, None).await.unwrap();
    assert_eq!(d["watchlist"]["display_name"], "Renamed");
    assert_eq!(h.calls(), [("get_watchlists".to_string(), json!({})), ("update_watchlist".to_string(), json!({"list_id":CUSTOM,"display_name":"Renamed"}))]);
    h.clean();
}

#[tokio::test]
async fn add_and_remove_send_deduped_uppercase_symbols_after_a_fresh_list_read() {
    let h = wl(&["get_watchlists", "add_to_watchlist", "remove_from_watchlist"], Mode::Ok).await;
    let d = h.rh.watchlist_add(CUSTOM, &s(&[" aapl", "AAPL", "brk.b"])).await.unwrap();
    assert_eq!(d["status"], "ok");
    h.rh.watchlist_remove(CUSTOM, &s(&["aapl"])).await.unwrap();
    assert_eq!(
        h.calls(),
        [
            ("get_watchlists".to_string(), json!({})),
            ("add_to_watchlist".to_string(), json!({"list_id":CUSTOM,"symbols":["AAPL","BRK.B"]})),
            ("get_watchlists".to_string(), json!({})),
            ("remove_from_watchlist".to_string(), json!({"list_id":CUSTOM,"symbols":["AAPL"]})),
        ]
    );
    h.clean();
}

#[tokio::test]
async fn curated_options_and_unknown_lists_are_refused_with_only_the_list_read() {
    let h = wl(&["get_watchlists"], Mode::Ok).await;
    let e = h.rh.watchlist_add(CURATED, &s(&["AAPL"])).await.unwrap_err();
    assert!(matches!(&e, RhError::Invalid(m) if m.contains("Robinhood list")), "{e:?}");
    assert!(h.rh.watchlist_remove(CURATED, &s(&["AAPL"])).await.is_err());
    assert!(h.rh.watchlist_update(CURATED, Some("x"), None, None).await.is_err());
    let e = h.rh.watchlist_add(OPTIONS, &s(&["AAPL"])).await.unwrap_err();
    assert!(matches!(&e, RhError::Invalid(m) if m.contains("options")), "{e:?}");
    assert!(h.rh.watchlist_remove(OPTIONS, &s(&["AAPL"])).await.is_err());
    assert!(h.rh.watchlist_update(OPTIONS, Some("x"), None, None).await.is_err());
    let e = h.rh.watchlist_add("aaaaaaaa-0000-4000-8000-00000000ffff", &s(&["AAPL"])).await.unwrap_err();
    assert!(matches!(&e, RhError::Invalid(m) if m.contains("not found")), "{e:?}");
    assert!(h.names().iter().all(|n| n == "get_watchlists"), "{:?}", h.names());
    assert_eq!(h.names().len(), 7);
    h.clean();
}

#[tokio::test]
async fn invalid_input_costs_zero_requests() {
    let h = wl(&[], Mode::Ok).await;
    let r = &h.rh;
    let too_many: Vec<String> = (0..51).map(|i| format!("S{i}")).collect();
    assert!(r.watchlist_add(CUSTOM, &[]).await.is_err());
    assert!(r.watchlist_add(CUSTOM, &too_many).await.is_err());
    assert!(r.watchlist_add(CUSTOM, &s(&["AAPL!"])).await.is_err());
    assert!(r.watchlist_add(CUSTOM, &s(&["aaaaaaaa-0000-4000-8000-0000000000a1"])).await.is_err(), "crypto/index ids are not accepted");
    assert!(r.watchlist_remove(CUSTOM, &[]).await.is_err());
    assert!(r.watchlist_add("bad id", &s(&["AAPL"])).await.is_err());
    assert!(r.watchlist_add("", &s(&["AAPL"])).await.is_err());
    assert!(r.watchlist_create("", None, None).await.is_err());
    assert!(r.watchlist_create(&"n".repeat(51), None, None).await.is_err());
    assert!(r.watchlist_create("ok", Some("123456789"), None).await.is_err());
    assert!(r.watchlist_create("ok", None, Some(&"d".repeat(201))).await.is_err());
    assert!(r.watchlist_update(CUSTOM, None, None, None).await.is_err());
    assert!(r.option_watchlist_add(&s(&["AAPL"])).await.is_err());
    assert!(r.option_watchlist_add(&[]).await.is_err());
    let many: Vec<String> = (0..21).map(|i| format!("11111111-2222-4333-8444-{i:012}")).collect();
    assert!(r.option_watchlist_remove(&many).await.is_err());
    assert_eq!(h.m.count(), 0, "not even initialize");
    h.clean();
}

#[tokio::test]
async fn a_tool_error_is_a_plain_error_and_is_not_retried() {
    let h = wl(&["get_watchlists", "add_to_watchlist", "create_watchlist"], Mode::ToolErr).await;
    let e = h.rh.watchlist_add(CUSTOM, &s(&["AAPL"])).await.unwrap_err();
    assert!(matches!(&e, RhError::Tool(t) if t.contains("synthetic failure")), "{e:?}");
    assert!(!e.to_string().to_lowercase().contains("token"));
    assert_eq!(h.count("add_to_watchlist"), 1);
    assert!(h.rh.watchlist_create("x", None, None).await.is_err());
    assert_eq!(h.count("create_watchlist"), 1);
    assert!(h.rh.status().last_error.is_some());
    h.clean();
}

#[tokio::test]
async fn a_dropped_connection_on_a_write_is_not_retried() {
    let h = wl(&["get_watchlists", "add_to_watchlist"], Mode::Drop).await;
    let e = h.rh.watchlist_add(CUSTOM, &s(&["AAPL"])).await.unwrap_err();
    assert!(matches!(e, RhError::Transport(_)), "{e:?}");
    assert_eq!(h.count("add_to_watchlist"), 1, "writes are never auto-retried");
    h.clean();
}

#[tokio::test]
async fn option_contracts_go_through_the_option_tools_only() {
    let h = wl(&["add_option_to_watchlist", "remove_option_from_watchlist"], Mode::Ok).await;
    let d = h.rh.option_watchlist_add(&s(&[OPT_A, &OPT_A.to_uppercase(), OPT_B])).await.unwrap();
    assert_eq!(d["status"], "ok");
    h.rh.option_watchlist_remove(&s(&[OPT_A])).await.unwrap();
    assert_eq!(
        h.calls(),
        [
            ("add_option_to_watchlist".to_string(), json!({"option_ids":[OPT_A, OPT_B]})),
            ("remove_option_from_watchlist".to_string(), json!({"option_ids":[OPT_A]})),
        ]
    );
    h.clean();
}

#[tokio::test]
async fn the_mock_guard_catches_any_unexpected_tool() {
    // Proves the harness itself: a tool outside the allow list is recorded as a violation.
    let h = wl(&["get_watchlists"], Mode::Ok).await;
    let _ = h.rh.watchlist_create("x", None, None).await;
    assert_eq!(h.violations.lock().unwrap().as_slice(), ["create_watchlist"]);
}
