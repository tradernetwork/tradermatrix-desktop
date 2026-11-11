//! TM client tests against the in-crate mock MCP server. Only the fake key `td_live_TESTKEY` is ever used.
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};

use super::client::{TmState, TmStatus, VaultKeyProvider, TM_ENDPOINT, TM_KEY_SLOT};
use super::reads;
use crate::rh::testutil::{Mock, Req, Resp};
use crate::rh::RhError;
use crate::secrets::{MemoryStore, SecretStore};
use crate::vault::Vault;

const KEY: &str = "td_live_TESTKEY";

fn fx(name: &str) -> String {
    let p = format!("{}/tests/fixtures/tm/{name}.json", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(p).expect("fixture")
}

fn rpc_ok(req: &Req, result: Value) -> Resp {
    Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":result}))
}

/// TM style: the bare object as the text of content[0]; no structuredContent.
fn tool_text(req: &Req, text: &str) -> Resp {
    rpc_ok(req, json!({"content":[{"type":"text","text":text}]}))
}

fn tool_for(name: &str) -> Option<&'static str> {
    match name {
        "get_apex_levels" => Some("apex_levels"),
        "get_expected_move" => Some("expected_move"),
        "get_iv_rank" => Some("iv_rank"),
        "get_ticker_snapshot" => Some("ticker_snapshot"),
        _ => None,
    }
}

/// Serves the real fixtures per tool; handles the MCP handshake.
fn ok_handler(req: &Req) -> Option<Resp> {
    match req.rpc_method().as_str() {
        "initialize" => Some(rpc_ok(req, json!({"protocolVersion":"2025-06-18","serverInfo":{"name":"tm","version":"1"},"capabilities":{}}))),
        "notifications/initialized" => Some(Resp::status(202)),
        "tools/call" => {
            let j = req.json();
            let name = j["params"]["name"].as_str().unwrap_or_default().to_string();
            match tool_for(&name) {
                Some(f) => Some(tool_text(req, &fx(f))),
                None => Some(rpc_ok(req, json!({"isError": true, "content":[{"type":"text","text":"unknown tool"}]}))),
            }
        }
        _ => Some(Resp::status(400)),
    }
}

fn store_with(key: &str) -> Arc<dyn SecretStore> {
    let s = MemoryStore::new();
    s.set(TM_KEY_SLOT, key).unwrap();
    Arc::new(s)
}

fn state(m: &Mock, store: Arc<dyn SecretStore>) -> TmState {
    TmState::for_test(m.url("/api/v1/mcp"), store)
}

fn calls(m: &Mock) -> Vec<Req> {
    m.requests().into_iter().filter(|r| r.rpc_method() == "tools/call").collect()
}

fn all_authed(m: &Mock) {
    for r in m.requests() {
        assert_eq!(r.header("authorization"), Some("Bearer td_live_TESTKEY"), "{}", r.rpc_method());
    }
}

#[test]
fn endpoint_constant_is_the_traderdaddy_mcp_url() {
    assert_eq!(TM_ENDPOINT, "https://api.traderdaddy.pro/api/v1/mcp");
    assert_eq!(TM_KEY_SLOT, "tm_api_key");
}

#[tokio::test]
async fn apex_levels_sends_bearer_on_every_call_and_maps_the_fixture() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, store_with(KEY));
    let a = tm.apex_levels("AAPL", None).await.unwrap();
    assert_eq!(a.levels.len(), 8);
    assert_eq!(a.gamma_flip, Some(343.59));
    let methods: Vec<String> = m.requests().iter().map(|r| r.rpc_method()).collect();
    assert_eq!(methods, ["initialize", "notifications/initialized", "tools/call"]);
    all_authed(&m);
    let c = calls(&m);
    assert_eq!(c[0].json()["params"]["name"], "get_apex_levels");
    assert_eq!(c[0].json()["params"]["arguments"], json!({"symbol": "AAPL"}));
}

#[tokio::test]
async fn apex_levels_passes_expiration_only_when_given() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, store_with(KEY));
    tm.apex_levels("aapl", Some("2026-11-20")).await.unwrap();
    assert_eq!(calls(&m)[0].json()["params"]["arguments"], json!({"symbol": "AAPL", "expiration": "2026-11-20"}));
}

#[tokio::test]
async fn each_read_calls_exactly_its_tool_with_only_the_symbol() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, store_with(KEY));
    let em = tm.expected_move("AAPL").await.unwrap();
    assert_eq!(em.horizons.len(), 5);
    assert_eq!(em.horizons[1].expected_move_pct, Some(0.036));
    let iv = tm.iv_rank("AAPL").await.unwrap();
    assert!((iv.iv_rank.unwrap() - 37.868).abs() < 0.01);
    let s = tm.snapshot("AAPL").await.unwrap();
    assert_eq!(s.gamma.unwrap().regime.as_deref(), Some("positive_gamma"));
    let names: Vec<(String, Value)> = calls(&m)
        .iter()
        .map(|r| (r.json()["params"]["name"].as_str().unwrap().to_string(), r.json()["params"]["arguments"].clone()))
        .collect();
    assert_eq!(
        names,
        vec![
            ("get_expected_move".to_string(), json!({"symbol": "AAPL"})),
            ("get_iv_rank".to_string(), json!({"symbol": "AAPL"})),
            ("get_ticker_snapshot".to_string(), json!({"symbol": "AAPL"})),
        ]
    );
    all_authed(&m);
}

#[tokio::test]
async fn bare_object_in_structured_content_also_works() {
    let m = Mock::start(|r, _| match r.rpc_method().as_str() {
        "tools/call" => Some(rpc_ok(r, json!({"content":[{"type":"text","text":"ignored summary"}], "structuredContent": serde_json::from_str::<Value>(&fx("iv_rank")).unwrap()}))),
        _ => ok_handler(r),
    })
    .await;
    let tm = state(&m, store_with(KEY));
    assert!(tm.iv_rank("AAPL").await.unwrap().iv_rank.is_some());
}

#[tokio::test]
async fn data_wrapper_is_unwrapped_too() {
    let m = Mock::start(|r, _| match r.rpc_method().as_str() {
        "tools/call" => Some(rpc_ok(r, json!({"content":[], "structuredContent": {"data": serde_json::from_str::<Value>(&fx("iv_rank")).unwrap(), "guide": "x"}}))),
        _ => ok_handler(r),
    })
    .await;
    let tm = state(&m, store_with(KEY));
    assert_eq!(tm.iv_rank("AAPL").await.unwrap().zone.as_deref(), Some("mid"));
}

#[tokio::test]
async fn non_json_text_is_a_protocol_error() {
    let m = Mock::start(|r, _| match r.rpc_method().as_str() {
        "tools/call" => Some(tool_text(r, "hello, not json")),
        _ => ok_handler(r),
    })
    .await;
    let tm = state(&m, store_with(KEY));
    assert!(matches!(tm.iv_rank("AAPL").await, Err(RhError::Protocol(_))));
}

#[tokio::test]
async fn missing_key_means_zero_requests() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, Arc::new(MemoryStore::new()));
    let e = tm.snapshot("AAPL").await.unwrap_err();
    assert_eq!(e, RhError::TmKeyMissing);
    assert_eq!(e.to_string(), "TraderMatrix key not set");
    assert_eq!(m.count(), 0);
    assert_eq!(tm.status(), TmStatus { key_present: false, last_error: Some("TraderMatrix key not set".into()) });
}

#[tokio::test]
async fn locked_vault_means_zero_requests_and_says_so() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    // A vault that was never unlocked: every read fails with "vault locked".
    let vault: Arc<dyn SecretStore> = Arc::new(Vault::new(std::env::temp_dir().join("rebull-tm-locked-unused.rbv")));
    let tm = state(&m, vault);
    let e = tm.expected_move("AAPL").await.unwrap_err();
    assert!(e.to_string().contains("vault locked"), "{e}");
    assert_eq!(m.count(), 0);
    let st = tm.status();
    assert!(!st.key_present);
    assert!(st.last_error.unwrap().contains("vault locked"));
}

#[tokio::test]
async fn malformed_stored_key_is_refused_before_any_request() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    for bad in ["sk_live_notours1234567890", "td_live_TESTKEY x", "td_live_TESTKEY\nx", "td_live_"] {
        let tm = state(&m, store_with(bad));
        let e = tm.iv_rank("AAPL").await.unwrap_err();
        assert!(matches!(e, RhError::Invalid(_) | RhError::TmKeyMissing), "{bad:?}: {e:?}");
        assert!(!e.to_string().contains(bad), "error echoed the stored value");
    }
    assert_eq!(m.count(), 0);
}

#[tokio::test]
async fn stored_key_is_trimmed() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, store_with("  td_live_TESTKEY\n"));
    tm.iv_rank("AAPL").await.unwrap();
    all_authed(&m);
}

#[tokio::test]
async fn rejected_key_maps_to_tm_key_rejected_without_a_retry_loop() {
    let m = Mock::start(|_, _| Some(Resp::text(401, "Invalid or revoked API key"))).await;
    let tm = state(&m, store_with(KEY));
    let e = tm.apex_levels("AAPL", None).await.unwrap_err();
    assert_eq!(e, RhError::TmKeyRejected);
    assert!(e.to_string().contains("rejected the key"), "{e}");
    assert_eq!(m.count(), 1, "a 401 must not be retried");
    assert!(tm.status().last_error.unwrap().contains("rejected the key"));
    // And a second call also costs exactly one request (no caching of failures).
    let _ = tm.apex_levels("AAPL", None).await.unwrap_err();
    assert_eq!(m.count(), 2);
}

#[tokio::test]
async fn recovers_after_a_rejected_key_when_a_good_key_arrives() {
    let good = Arc::new(AtomicBool::new(false));
    let g2 = good.clone();
    let m = Mock::start(move |r, _| if g2.load(Ordering::SeqCst) { ok_handler(r) } else { Some(Resp::text(401, "nope")) }).await;
    let tm = state(&m, store_with(KEY));
    assert_eq!(tm.iv_rank("AAPL").await.unwrap_err(), RhError::TmKeyRejected);
    good.store(true, Ordering::SeqCst);
    assert!(tm.iv_rank("AAPL").await.is_ok());
    assert_eq!(tm.status().last_error, None);
}

#[tokio::test]
async fn tier_limit_text_from_tm_is_passed_through_plainly() {
    let text = "Tier limit reached: get_expected_move requires a Pro plan. Upgrade at the TraderMatrix site.";
    let m = Mock::start(move |r, _| match r.rpc_method().as_str() {
        "tools/call" => Some(rpc_ok(r, json!({"isError": true, "content":[{"type":"text","text": text}]}))),
        _ => ok_handler(r),
    })
    .await;
    let tm = state(&m, store_with(KEY));
    let e = tm.expected_move("AAPL").await.unwrap_err();
    assert!(matches!(&e, RhError::Tool(t) if t == text), "{e:?}");
    assert!(e.to_string().contains("Tier limit reached"));
    assert_eq!(tm.status().last_error.as_deref(), Some(e.to_string().as_str()));
}

#[tokio::test]
async fn failed_calls_are_not_cached() {
    let n = Arc::new(AtomicUsize::new(0));
    let n2 = n.clone();
    let m = Mock::start(move |r, _| match r.rpc_method().as_str() {
        "tools/call" if n2.fetch_add(1, Ordering::SeqCst) == 0 => Some(rpc_ok(r, json!({"isError": true, "content":[{"type":"text","text":"boom"}]}))),
        _ => ok_handler(r),
    })
    .await;
    let tm = state(&m, store_with(KEY));
    assert!(tm.iv_rank("AAPL").await.is_err());
    assert!(tm.iv_rank("AAPL").await.is_ok());
    assert_eq!(calls(&m).len(), 2);
}

#[tokio::test]
async fn cache_ttls_are_300s_for_everything_since_m20a() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, store_with(KEY));
    tm.apex_levels("AAPL", None).await.unwrap();
    tm.expected_move("AAPL").await.unwrap();
    assert_eq!(calls(&m).len(), 2);
    // Immediately again: zero requests.
    tm.apex_levels("AAPL", None).await.unwrap();
    tm.expected_move("AAPL").await.unwrap();
    assert_eq!(calls(&m).len(), 2);
    // 61 s: Apex levels used to expire here (60 s); they move slowly, so they are now cached for 300 s too.
    tm.advance_clock(Duration::from_secs(61));
    tm.apex_levels("AAPL", None).await.unwrap();
    tm.expected_move("AAPL").await.unwrap();
    assert_eq!(calls(&m).len(), 2);
    // 299 s: still cached.
    tm.advance_clock(Duration::from_secs(238));
    tm.apex_levels("AAPL", None).await.unwrap();
    assert_eq!(calls(&m).len(), 2);
    // 301 s: both refetched.
    tm.advance_clock(Duration::from_secs(2));
    tm.apex_levels("AAPL", None).await.unwrap();
    tm.expected_move("AAPL").await.unwrap();
    assert_eq!(calls(&m).len(), 4);
    // iv_rank and snapshot use 300 s as well.
    tm.iv_rank("AAPL").await.unwrap();
    tm.snapshot("AAPL").await.unwrap();
    assert_eq!(calls(&m).len(), 6);
    tm.advance_clock(Duration::from_secs(299));
    tm.iv_rank("AAPL").await.unwrap();
    tm.snapshot("AAPL").await.unwrap();
    assert_eq!(calls(&m).len(), 6);
    tm.advance_clock(Duration::from_secs(2));
    tm.iv_rank("AAPL").await.unwrap();
    assert_eq!(calls(&m).len(), 7);
}

#[tokio::test]
async fn cache_is_keyed_by_tool_symbol_and_args() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, store_with(KEY));
    tm.apex_levels("AAPL", None).await.unwrap();
    tm.apex_levels("MSFT", None).await.unwrap();
    tm.apex_levels("AAPL", Some("2026-11-20")).await.unwrap();
    tm.apex_levels("aapl", None).await.unwrap(); // same key after canonicalisation
    assert_eq!(calls(&m).len(), 3);
}

#[tokio::test]
async fn concurrent_identical_calls_share_one_request() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, store_with(KEY));
    let (a, b, c) = tokio::join!(tm.apex_levels("AAPL", None), tm.apex_levels("AAPL", None), tm.apex_levels("aapl", None));
    assert_eq!(a.unwrap(), b.unwrap());
    assert!(c.is_ok());
    assert_eq!(calls(&m).len(), 1);
    // The MCP handshake also happens once, even for concurrent different calls.
    let (x, y) = tokio::join!(tm.iv_rank("AAPL"), tm.snapshot("AAPL"));
    assert!(x.is_ok() && y.is_ok());
    assert_eq!(m.requests().iter().filter(|r| r.rpc_method() == "initialize").count(), 1);
}

#[tokio::test]
async fn invalid_symbol_or_expiration_makes_zero_requests() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, store_with(KEY));
    for s in ["", " ", "TOOLONGX", "AAPL;", "A1", "BRK.BB", "BRK.", ".B", "../x", "AA PL", "AAPL\n", "$AAPL", "AAPL.b1", "ÄAPL"] {
        for e in [
            tm.apex_levels(s, None).await.unwrap_err(),
            tm.expected_move(s).await.unwrap_err(),
            tm.iv_rank(s).await.unwrap_err(),
            tm.snapshot(s).await.unwrap_err(),
        ] {
            assert!(matches!(e, RhError::Invalid(_)), "{s:?}: {e:?}");
        }
    }
    for d in ["2026-1-1", "tomorrow", "2026-11-11T00:00", "20261111", "2026-11-1a", "", "2026-11-111"] {
        let e = tm.apex_levels("AAPL", Some(d)).await.unwrap_err();
        assert!(matches!(e, RhError::Invalid(_)), "{d:?}: {e:?}");
    }
    assert_eq!(m.count(), 0);
    // Valid shapes are accepted (uppercased; class suffix allowed).
    assert_eq!(reads::valid_symbol("brk.b").unwrap(), "BRK.B");
    assert_eq!(reads::valid_symbol("a").unwrap(), "A");
    assert_eq!(reads::valid_symbol("GOOGLE").unwrap(), "GOOGLE");
}

#[tokio::test]
async fn the_key_never_appears_in_errors_status_or_debug_output() {
    // Tool error that echoes the key.
    let m = Mock::start(|r, _| match r.rpc_method().as_str() {
        "tools/call" => Some(rpc_ok(r, json!({"isError": true, "content":[{"type":"text","text":"bad request, auth was Bearer td_live_TESTKEY for user"}]}))),
        _ => ok_handler(r),
    })
    .await;
    let tm = state(&m, store_with(KEY));
    let e = tm.iv_rank("AAPL").await.unwrap_err();
    for s in [e.to_string(), format!("{e:?}")] {
        assert!(!s.contains("td_live_TESTKEY") && !s.contains("TESTKEY"), "{s}");
    }
    assert!(e.to_string().contains("[redacted]"), "{e}");
    let st = tm.status();
    assert!(!format!("{st:?}").contains("TESTKEY"));
    assert!(!serde_json::to_string(&st).unwrap().contains("TESTKEY"));
    assert!(!format!("{tm:?}").contains("TESTKEY"));
    assert!(!format!("{:?}", VaultKeyProvider::new(store_with(KEY))).contains("TESTKEY"));

    // HTTP error whose body echoes the key.
    let m2 = Mock::start(|_, _| Some(Resp::text(500, "internal error for td_live_TESTKEY"))).await;
    let tm2 = state(&m2, store_with(KEY));
    let e2 = tm2.snapshot("AAPL").await.unwrap_err();
    assert!(!e2.to_string().contains("TESTKEY") && !format!("{e2:?}").contains("TESTKEY"), "{e2}");
    assert!(!format!("{:?}", tm2.status()).contains("TESTKEY"));

    // Transport failure (connection dropped).
    let m3 = Mock::start(|_, _| None).await;
    let tm3 = state(&m3, store_with(KEY));
    let e3 = tm3.snapshot("AAPL").await.unwrap_err();
    assert!(!e3.to_string().contains("TESTKEY") && !format!("{e3:?}").contains("TESTKEY"), "{e3}");

    // Key present in the mock's own request log only in the Authorization header.
    for r in m.requests() {
        assert!(!r.body.contains("TESTKEY"), "key leaked into a request body");
        assert!(!r.path.contains("TESTKEY"), "key leaked into the URL");
    }
}

#[tokio::test]
async fn provider_reads_the_slot_each_call_and_force_refresh_is_a_rejection() {
    use crate::rh::TokenProvider;
    let store = Arc::new(MemoryStore::new());
    let p = VaultKeyProvider::new(store.clone());
    assert_eq!(p.access_token().await.unwrap_err(), RhError::TmKeyMissing);
    store.set(TM_KEY_SLOT, " td_live_TESTKEY ").unwrap();
    assert_eq!(p.access_token().await.unwrap(), "td_live_TESTKEY");
    store.set(TM_KEY_SLOT, "td_live_TESTKEY2").unwrap();
    assert_eq!(p.access_token().await.unwrap(), "td_live_TESTKEY2");
    assert_eq!(p.force_refresh().await.unwrap_err(), RhError::TmKeyRejected);
}

#[tokio::test]
async fn status_reports_presence_only() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let store = Arc::new(MemoryStore::new());
    let tm = state(&m, store.clone());
    assert_eq!(tm.status(), TmStatus { key_present: false, last_error: None });
    store.set(TM_KEY_SLOT, KEY).unwrap();
    assert_eq!(tm.status(), TmStatus { key_present: true, last_error: None });
    assert_eq!(m.count(), 0, "status never calls the network");
}

/// R3: TmState shares the init gate: a failed initialize is not re-run by every queued caller.
#[tokio::test]
async fn tm_failed_initialize_fails_queued_callers_fast() {
    let m = Mock::start(|_, _| None).await;
    let tm = state(&m, store_with(KEY));
    let (a, b, c) = tokio::join!(tm.iv_rank("AAPL"), tm.iv_rank("MSFT"), tm.expected_move("AAPL"));
    assert!(a.is_err() && b.is_err() && c.is_err());
    assert_eq!(m.requests().iter().filter(|r| r.rpc_method() == "initialize").count(), 1);
}

// ---- M8: watchlist list/add/create ----

type Violations = Arc<std::sync::Mutex<Vec<String>>>;

/// Serves the watchlist fixtures. Any tool outside list/add/create is recorded as a violation and refused, so a
/// remove_*, delete_* or update_watchlist call anywhere in M8 fails the test that ends with `clean(&v)`.
fn wl_mock_handler(v: Violations) -> impl Fn(&Req, usize) -> Option<Resp> + Send + Sync + 'static {
    move |r, _| {
        if r.rpc_method() != "tools/call" {
            return ok_handler(r);
        }
        let j = r.json();
        let name = j["params"]["name"].as_str().unwrap_or_default().to_string();
        let a = &j["params"]["arguments"];
        match name.as_str() {
            "list_watchlists" => Some(tool_text(r, &fx("list_watchlists"))),
            "add_to_watchlist" => Some(tool_text(
                r,
                &fx(match (a["list"].as_str().unwrap_or_default(), a["ticker"].as_str().unwrap_or_default()) {
                    ("Nope", _) => "watchlist_add_unknown_list",
                    ("Desk CSP", _) => "watchlist_add_list_full",
                    (_, "AAAA") => "watchlist_add_duplicate",
                    _ => "watchlist_add_ok",
                }),
            )),
            "create_watchlist" => Some(tool_text(r, &fx(if a["name"] == "Cap" { "watchlist_create_cap" } else { "watchlist_create_ok" }))),
            other => {
                v.lock().unwrap().push(other.to_string());
                Some(rpc_ok(r, json!({"isError": true, "content":[{"type":"text","text":"forbidden in M8"}]})))
            }
        }
    }
}

fn violations() -> Violations {
    Arc::new(std::sync::Mutex::new(vec![]))
}

fn clean(v: &Violations) {
    assert!(v.lock().unwrap().is_empty(), "forbidden tools reached the server: {:?}", v.lock().unwrap());
}

fn tool_calls(m: &Mock, tool: &str) -> Vec<Value> {
    calls(m).iter().filter(|r| r.json()["params"]["name"] == tool).map(|r| r.json()["params"]["arguments"].clone()).collect()
}

#[tokio::test]
async fn watchlists_fixture_maps_and_drops_notes_and_added_at() {
    let v = violations();
    let m = Mock::start(wl_mock_handler(v.clone())).await;
    let tm = state(&m, store_with(KEY));
    let w = tm.watchlists().await.unwrap();
    assert_eq!(w.lists.len(), 3);
    assert_eq!(w.lists[0].id, 101);
    assert_eq!(w.lists[0].name, "My Watchlist");
    assert_eq!(w.lists[0].category.as_deref(), Some("swing"));
    assert!(w.lists[0].is_default && !w.lists[1].is_default);
    assert_eq!(w.lists[1].tickers, ["CCCC", "DDDD", "BRK.B"]);
    assert_eq!(w.lists[1].ticker_count, 3);
    assert!(w.lists[2].tickers.is_empty());
    assert_eq!((w.tickers_per_list, w.tickers_across_all_lists, w.max_lists), (Some(150), Some(500), Some(12)));
    let json = serde_json::to_string(&w).unwrap();
    for banned in ["notes", "private thesis", "SELLING", "WATCHING", "addedAt", "added_at", "2026-11-11T01", "openInTraderMatrix", "tradermatrix.pro"] {
        assert!(!json.contains(banned), "serialized output leaks {banned}: {json}");
    }
    let t = tool_calls(&m, "list_watchlists");
    assert_eq!(t, vec![json!({})]);
    all_authed(&m);
    clean(&v);
}

#[tokio::test]
async fn watchlist_tickers_are_uppercased_and_junk_entries_dropped() {
    let m = Mock::start(|r, _| match r.rpc_method().as_str() {
        "tools/call" => Some(tool_text(
            r,
            r#"{"lists":[{"id":"7","name":"x","tickers":[{"ticker":"aapl","notes":"n"},{"ticker":" brk.b "},"msft",{"nope":1},null,{"ticker":""}]},{"name":"no id"},"junk"],"limits":{"lists":"12"}}"#,
        )),
        _ => ok_handler(r),
    })
    .await;
    let tm = state(&m, store_with(KEY));
    let w = tm.watchlists().await.unwrap();
    assert_eq!(w.lists.len(), 1, "a list without an id is dropped");
    assert_eq!(w.lists[0].id, 7);
    assert_eq!(w.lists[0].tickers, ["AAPL", "BRK.B", "MSFT"]);
    assert_eq!(w.lists[0].ticker_count, 3, "falls back to the mapped count when tickerCount is absent");
    assert_eq!((w.max_lists, w.tickers_per_list), (Some(12), None));
    assert!(!serde_json::to_string(&w).unwrap().contains("notes"));
}

#[tokio::test]
async fn watchlist_add_sends_exactly_ticker_and_list_never_notes() {
    let v = violations();
    let m = Mock::start(wl_mock_handler(v.clone())).await;
    let tm = state(&m, store_with(KEY));
    assert!(tm.watchlist_add("My Watchlist", "eeee").await.unwrap().added);
    assert!(!tm.watchlist_add("My Watchlist", "AAAA").await.unwrap().added, "added:false is a success");
    assert!(tm.watchlist_add("101", "brk.b").await.unwrap().added);
    let a = tool_calls(&m, "add_to_watchlist");
    assert_eq!(a, vec![json!({"ticker": "EEEE", "list": "My Watchlist"}), json!({"ticker": "AAAA", "list": "My Watchlist"}), json!({"ticker": "BRK.B", "list": "101"})]);
    for x in &a {
        assert!(x.get("notes").is_none());
        assert_eq!(x.as_object().unwrap().len(), 2);
    }
    clean(&v);
}

#[tokio::test]
async fn watchlist_add_refusals_become_tool_errors_with_the_text() {
    let v = violations();
    let m = Mock::start(wl_mock_handler(v.clone())).await;
    let tm = state(&m, store_with(KEY));
    let e = tm.watchlist_add("Desk CSP", "ZZZZ").await.unwrap_err();
    assert!(matches!(&e, RhError::Tool(t) if t.contains("full (150 tickers per list)")), "{e:?}");
    let e = tm.watchlist_add("Nope", "ZZZZ").await.unwrap_err();
    let RhError::Tool(t) = &e else { panic!("{e:?}") };
    assert!(t.contains("Unknown list 'Nope'") && t.contains("My Watchlist") && t.contains("Desk CSP") && t.contains("Empty list"), "{t}");
    clean(&v);
}

#[tokio::test]
async fn watchlist_create_sends_exactly_name_and_maps_ok_and_cap() {
    let v = violations();
    let m = Mock::start(wl_mock_handler(v.clone())).await;
    let tm = state(&m, store_with(KEY));
    let c = tm.watchlist_create("New list").await.unwrap();
    assert_eq!((c.id, c.name.as_str(), c.category.as_deref(), c.is_default), (104, "New list", Some("swing"), false));
    let e = tm.watchlist_create("Cap").await.unwrap_err();
    assert!(matches!(&e, RhError::Tool(t) if t.contains("List cap reached")), "{e:?}");
    assert_eq!(tool_calls(&m, "create_watchlist"), vec![json!({"name": "New list"}), json!({"name": "Cap"})]);
    clean(&v);
}

#[tokio::test]
async fn invalid_watchlist_inputs_make_zero_requests() {
    let v = violations();
    let m = Mock::start(wl_mock_handler(v.clone())).await;
    let tm = state(&m, store_with(KEY));
    for t in ["", "TOOLONGX", "A1", "BF-B", "AAPL;", "A B", "BRK.BB", "$X"] {
        assert!(matches!(tm.watchlist_add("My Watchlist", t).await.unwrap_err(), RhError::Invalid(_)), "{t:?}");
    }
    let long = "x".repeat(61);
    for l in ["", "   ", "bad\nname", "tab\tname", long.as_str()] {
        assert!(matches!(tm.watchlist_add(l, "AAPL").await.unwrap_err(), RhError::Invalid(_)), "{l:?}");
        assert!(matches!(tm.watchlist_create(l).await.unwrap_err(), RhError::Invalid(_)), "{l:?}");
    }
    assert_eq!(m.count(), 0);
    // 60 chars and unicode names are fine.
    let ok60 = "x".repeat(60);
    tm.watchlist_create(&ok60).await.unwrap();
    tm.watchlist_create("Swing \u{1F4C8} plays").await.unwrap();
    clean(&v);
}

#[tokio::test]
async fn watchlist_calls_without_a_key_or_with_a_locked_vault_say_so_and_send_nothing() {
    let m = Mock::start(|r, _| ok_handler(r)).await;
    let tm = state(&m, Arc::new(MemoryStore::new()));
    assert_eq!(tm.watchlists().await.unwrap_err(), RhError::TmKeyMissing);
    assert_eq!(tm.watchlist_add("L", "AAPL").await.unwrap_err(), RhError::TmKeyMissing);
    assert_eq!(tm.watchlist_create("L").await.unwrap_err(), RhError::TmKeyMissing);
    let vault: Arc<dyn SecretStore> = Arc::new(Vault::new(std::env::temp_dir().join("rebull-tm-locked-unused.rbv")));
    let tm = state(&m, vault);
    for e in [tm.watchlists().await.unwrap_err(), tm.watchlist_add("L", "AAPL").await.unwrap_err(), tm.watchlist_create("L").await.unwrap_err()] {
        assert!(e.to_string().contains("vault locked"), "{e}");
    }
    assert_eq!(m.count(), 0);
}

#[tokio::test]
async fn rejected_key_on_watchlist_calls_is_one_request_each() {
    let m = Mock::start(|_, _| Some(Resp::text(401, "nope"))).await;
    let tm = state(&m, store_with(KEY));
    assert_eq!(tm.watchlists().await.unwrap_err(), RhError::TmKeyRejected);
    assert_eq!(tm.watchlist_add("L", "AAPL").await.unwrap_err(), RhError::TmKeyRejected);
}

#[tokio::test]
async fn writes_are_never_retried_but_the_list_read_is() {
    let m = Mock::start(|r, _| match r.rpc_method().as_str() {
        "tools/call" => None, // transport failure on every tool call
        _ => ok_handler(r),
    })
    .await;
    let tm = state(&m, store_with(KEY));
    assert!(matches!(tm.watchlist_add("L", "AAPL").await.unwrap_err(), RhError::Transport(_)));
    assert_eq!(calls(&m).len(), 1, "add: exactly one attempt");
    assert!(matches!(tm.watchlist_create("L").await.unwrap_err(), RhError::Transport(_)));
    assert_eq!(calls(&m).len(), 2, "create: exactly one attempt");
    assert!(tm.watchlists().await.is_err());
    assert!(calls(&m).len() > 3, "list_watchlists is a read and may retry: {}", calls(&m).len());
}

#[tokio::test]
async fn watchlists_cache_20s_and_any_write_invalidates() {
    let v = violations();
    let m = Mock::start(wl_mock_handler(v.clone())).await;
    let tm = state(&m, store_with(KEY));
    tm.watchlists().await.unwrap();
    tm.watchlists().await.unwrap();
    assert_eq!(tool_calls(&m, "list_watchlists").len(), 1, "second read inside 20 s is free");
    tm.advance_clock(Duration::from_secs(19));
    tm.watchlists().await.unwrap();
    assert_eq!(tool_calls(&m, "list_watchlists").len(), 1);
    tm.advance_clock(Duration::from_secs(2));
    tm.watchlists().await.unwrap();
    assert_eq!(tool_calls(&m, "list_watchlists").len(), 2, "21 s: refetched");
    // A successful add invalidates.
    tm.watchlist_add("My Watchlist", "EEEE").await.unwrap();
    tm.watchlists().await.unwrap();
    assert_eq!(tool_calls(&m, "list_watchlists").len(), 3);
    // So does create.
    tm.watchlist_create("New list").await.unwrap();
    tm.watchlists().await.unwrap();
    assert_eq!(tool_calls(&m, "list_watchlists").len(), 4);
    // And a refused write (it may have partly landed, the cache must not be trusted).
    assert!(tm.watchlist_add("Nope", "EEEE").await.is_err());
    tm.watchlists().await.unwrap();
    assert_eq!(tool_calls(&m, "list_watchlists").len(), 5);
    clean(&v);
}

#[test]
fn tm_reads_source_names_no_removal_or_update_tool() {
    let src = include_str!("reads.rs");
    for bad in ["remove_", "delete_", "update_watchlist", "move_watchlist"] {
        assert!(!src.contains(bad), "reads.rs must not mention {bad}");
    }
    assert_eq!(reads::TOOL_LIST_WATCHLISTS, "list_watchlists");
    assert_eq!(reads::TOOL_ADD_TO_WATCHLIST, "add_to_watchlist");
    assert_eq!(reads::TOOL_CREATE_WATCHLIST, "create_watchlist");
}

#[tokio::test]
async fn watchlist_key_is_scrubbed_from_refusal_text() {
    let m = Mock::start(|r, _| match r.rpc_method().as_str() {
        "tools/call" => Some(tool_text(r, r#"{"ok":false,"error":"denied for td_live_TESTKEY","availableLists":["A"]}"#)),
        _ => ok_handler(r),
    })
    .await;
    let tm = state(&m, store_with(KEY));
    let e = tm.watchlist_add("A", "AAPL").await.unwrap_err();
    assert!(!e.to_string().contains("TESTKEY") && e.to_string().contains("[redacted]"), "{e}");
}

// ---------------------------------------------------------------- M20a: the quota gate on the real client (mock TM MCP, fake clock)

mod quota_it {
    use super::*;
    use crate::db;
    use crate::tm::quota::{self, Budgets, Clock, DayRow, FakeClock, Priority};
    use std::sync::Mutex;

    fn t0() -> i64 {
        quota::utc_ms(2026, 11, 11, 15, 0, 0)
    }

    /// The exact strings TraderMatrix publishes for its limits.
    const DAILY: &str = "Daily limit reached";
    const SLOW: &str = "Slow down";
    const PREMIUM: &str = "Premium feature";
    const BUSY: &str = "TraderMatrix is busy";

    fn tool_err(r: &Req, text: &str) -> Resp {
        rpc_ok(r, json!({"isError": true, "content":[{"type":"text","text": text}]}))
    }

    fn tm_q(m: &Mock, clock: &Arc<FakeClock>, pool: Option<sqlx::SqlitePool>, per_min: u32, per_day: u32) -> Arc<TmState> {
        Arc::new(TmState::for_test_with(m.url("/api/v1/mcp"), store_with(KEY), clock.clone(), pool, Budgets { per_min, per_day }))
    }

    /// Serves fixtures and stamps every tool call with the FAKE clock.
    fn stamped(clock: Arc<FakeClock>, stamps: Arc<Mutex<Vec<i64>>>) -> impl Fn(&Req, usize) -> Option<Resp> + Send + Sync + 'static {
        move |r, _| {
            if r.rpc_method() == "tools/call" {
                stamps.lock().unwrap().push(clock.now_ms());
            }
            ok_handler(r)
        }
    }

    fn window_max(sent: &[i64]) -> usize {
        sent.iter().map(|&t| sent.iter().filter(|&&s| s > t - 60_000 && s <= t).count()).max().unwrap_or(0)
    }

    fn sym(i: usize) -> String {
        format!("{}{}", (b'A' + (i / 26) as u8) as char, (b'A' + (i % 26) as u8) as char)
    }

    // ---- Review Focus 1

    #[tokio::test]
    async fn a_burst_of_30_interactive_calls_never_sends_more_than_10_in_any_60s_window() {
        let clock = Arc::new(FakeClock::new(t0()));
        let stamps = Arc::new(Mutex::new(vec![]));
        let m = Mock::start(stamped(clock.clone(), stamps.clone())).await;
        let tm = tm_q(&m, &clock, None, 10, 200);
        for burst in 0..2 {
            let mut set = tokio::task::JoinSet::new();
            for i in 0..30 {
                let tm = tm.clone();
                set.spawn(async move { tm.iv_rank(&sym(i)).await });
            }
            let (mut ok, mut throttled) = (0, 0);
            while let Some(r) = set.join_next().await {
                match r.unwrap() {
                    Ok(_) => ok += 1,
                    Err(RhError::TmPaused(t)) => {
                        assert!(t.starts_with("TM throttled until "), "{t}");
                        throttled += 1;
                    }
                    Err(e) => panic!("{e:?}"),
                }
            }
            assert_eq!((ok, throttled), (10, 20), "burst {burst}");
            assert_eq!(calls(&m).len(), 10 * (burst + 1));
            // 301 s later: past the minute AND past the 300 s cache, so burst 2 really goes to the server again.
            tm.advance_clock(Duration::from_secs(301));
        }
        let s = stamps.lock().unwrap().clone();
        assert_eq!(s.len(), 20);
        assert!(window_max(&s) <= 10, "{}", window_max(&s));
        all_authed(&m);
    }

    #[tokio::test]
    async fn a_short_wait_really_waits_on_the_clock_and_then_sends() {
        let clock = Arc::new(FakeClock::new(t0()));
        let stamps = Arc::new(Mutex::new(vec![]));
        let m = Mock::start(stamped(clock.clone(), stamps.clone())).await;
        let tm = tm_q(&m, &clock, None, 2, 200);
        tm.iv_rank("AA").await.unwrap();
        clock.advance(50_000);
        tm.iv_rank("BB").await.unwrap();
        // the window still holds both; the oldest leaves 10 s from now
        tm.iv_rank("CC").await.unwrap();
        let s = stamps.lock().unwrap().clone();
        assert_eq!(s, [t0(), t0() + 50_000, t0() + 60_000]);
    }

    // ---- Review Focus 2

    #[tokio::test]
    async fn daily_limit_reached_stops_every_tm_call_until_the_day_rolls_over() {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let m = Mock::start(move |r, _| match r.rpc_method().as_str() {
            "tools/call" if n2.fetch_add(1, Ordering::SeqCst) == 0 => Some(tool_err(r, DAILY)),
            _ => ok_handler(r),
        })
        .await;
        let clock = Arc::new(FakeClock::new(t0()));
        let tm = tm_q(&m, &clock, None, 10, 200);
        // the server's own words pass through on the call that hit the wall
        let e = tm.iv_rank("AAPL").await.unwrap_err();
        assert!(matches!(&e, RhError::Tool(t) if t == DAILY), "{e:?}");
        let s = tm.quota_status().await;
        assert_eq!((s.used, s.limit, s.paused), (200, 200, true));
        assert_eq!(s.paused_until_ms, Some(quota::utc_ms(2026, 11, 12, 0, 0, 0)));
        // nothing else reaches the server: reads, the watchlist read, a write, every priority
        let before = m.count();
        for r in [
            tm.iv_rank("MSFT").await.map(|_| ()),
            tm.expected_move("AAPL").await.map(|_| ()),
            tm.snapshot("NVDA").await.map(|_| ()),
            tm.apex_levels("TSLA", None).await.map(|_| ()),
            tm.watchlists().await.map(|_| ()),
            tm.watchlist_add_with("L", "AAPL", Priority::Background).await.map(|_| ()),
            tm.iv_rank_with("AMD", Priority::Opportunistic).await.map(|_| ()),
        ] {
            match r {
                Err(RhError::TmPaused(t)) => assert!(t.starts_with("TM paused until 2026-11-12T00:00:00Z"), "{t}"),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(m.count(), before, "zero requests while paused (not even a handshake)");
        assert_eq!(calls(&m).len(), 1, "no retry loop");
        // the cached value for a symbol read before the wall would still be served (nothing to fetch); a rollover reopens the gate
        clock.set(quota::utc_ms(2026, 11, 12, 0, 0, 5));
        tm.iv_rank("MSFT").await.unwrap();
        assert_eq!(calls(&m).len(), 2);
        let s = tm.quota_status().await;
        assert_eq!((s.used, s.paused, s.day.as_str()), (1, false, "2026-11-12"));
    }

    #[tokio::test]
    async fn a_smaller_limit_in_the_message_is_learned() {
        let m = Mock::start(|r, _| match r.rpc_method().as_str() {
            "tools/call" => Some(tool_err(r, "Daily limit reached (25 calls/day on the free plan)")),
            _ => ok_handler(r),
        })
        .await;
        let clock = Arc::new(FakeClock::new(t0()));
        let tm = tm_q(&m, &clock, None, 10, 200);
        assert!(tm.iv_rank("AAPL").await.is_err());
        let s = tm.quota_status().await;
        assert_eq!((s.limit_seen, s.limit, s.used), (Some(25), 25, 25));
        assert_eq!(s.per_day, 200, "the user's own setting is untouched");
    }

    #[tokio::test]
    async fn slow_down_and_busy_back_off_without_a_retry_loop() {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let m = Mock::start(move |r, _| match r.rpc_method().as_str() {
            "tools/call" => match n2.fetch_add(1, Ordering::SeqCst) {
                0 => Some(tool_err(r, SLOW)),
                1 => Some(tool_err(r, BUSY)),
                _ => ok_handler(r),
            },
            _ => ok_handler(r),
        })
        .await;
        let clock = Arc::new(FakeClock::new(t0()));
        let tm = tm_q(&m, &clock, None, 10, 200);
        assert!(matches!(tm.iv_rank("AA").await.unwrap_err(), RhError::Tool(t) if t == SLOW));
        match tm.iv_rank("BB").await.unwrap_err() {
            RhError::TmPaused(t) => assert!(t.starts_with("TM throttled until 2026-11-11T15:01:00Z"), "{t}"),
            e => panic!("{e:?}"),
        }
        assert_eq!(calls(&m).len(), 1);
        assert_eq!(tm.quota_status().await.throttled_until_ms, Some(t0() + 60_000));
        // after the backoff: the busy reply (30 s backoff, an interactive call waits it out on the clock)
        clock.advance(61_000);
        assert!(matches!(tm.iv_rank("BB").await.unwrap_err(), RhError::Tool(t) if t == BUSY));
        match tm.iv_rank("CC").await.unwrap_err() {
            RhError::TmPaused(t) => assert!(t.starts_with("TM throttled until 2026-11-11T15:01:31Z"), "{t}"),
            e => panic!("{e:?}"),
        }
        assert_eq!(calls(&m).len(), 2);
        clock.advance(31_000);
        tm.iv_rank("CC").await.unwrap();
        assert_eq!(calls(&m).len(), 3);
    }

    #[tokio::test]
    async fn premium_feature_is_a_plain_tier_message_and_never_pauses_anything() {
        let n = Arc::new(AtomicUsize::new(0));
        let n2 = n.clone();
        let m = Mock::start(move |r, _| match r.rpc_method().as_str() {
            "tools/call" if n2.fetch_add(1, Ordering::SeqCst) == 0 => Some(tool_err(r, PREMIUM)),
            _ => ok_handler(r),
        })
        .await;
        let clock = Arc::new(FakeClock::new(t0()));
        let tm = tm_q(&m, &clock, None, 10, 200);
        assert!(matches!(tm.expected_move("AAPL").await.unwrap_err(), RhError::Tool(t) if t == PREMIUM));
        tm.iv_rank("AAPL").await.unwrap();
        let s = tm.quota_status().await;
        assert!(!s.paused && s.throttled_until_ms.is_none());
        assert_eq!(s.used, 2);
    }

    // ---- counting rules

    #[tokio::test]
    async fn only_requests_that_leave_the_machine_are_counted() {
        let m = Mock::start(|r, _| ok_handler(r)).await;
        let clock = Arc::new(FakeClock::new(t0()));
        let tm = tm_q(&m, &clock, None, 10, 200);
        tm.iv_rank("AAPL").await.unwrap();
        tm.iv_rank("AAPL").await.unwrap(); // cache hit
        let _ = tokio::join!(tm.iv_rank("MSFT"), tm.iv_rank("MSFT"), tm.iv_rank("msft")); // one request
        assert!(tm.iv_rank("not a symbol").await.is_err()); // refused locally
        assert_eq!(tm.quota_status().await.used, 2);
        assert_eq!(calls(&m).len(), 2);
        // a missing key sends nothing and costs nothing
        let m2 = Mock::start(|r, _| ok_handler(r)).await;
        let s = MemoryStore::new();
        let tm2 = TmState::for_test_with(m2.url("/api/v1/mcp"), Arc::new(s), clock.clone(), None, Budgets { per_min: 10, per_day: 200 });
        assert_eq!(tm2.iv_rank("AAPL").await.unwrap_err(), RhError::TmKeyMissing);
        assert_eq!((m2.count(), tm2.quota_status().await.used), (0, 0));
    }

    #[tokio::test]
    async fn background_and_opportunistic_calls_are_dropped_when_the_daily_budget_is_nearly_gone() {
        let m = Mock::start(|r, _| ok_handler(r)).await;
        let clock = Arc::new(FakeClock::new(t0()));
        let tm = tm_q(&m, &clock, None, 12, 10);
        for i in 0..9 {
            tm.iv_rank(&sym(i)).await.unwrap();
        }
        // 1 of 10 left = 10%: below 20%
        for r in [tm.watchlists_with(Priority::Background).await.map(|_| ()), tm.iv_rank_with("ZZ", Priority::Opportunistic).await.map(|_| ())] {
            match r {
                Err(RhError::TmPaused(t)) => assert!(t.contains("daily") || t.contains("budget"), "{t}"),
                other => panic!("{other:?}"),
            }
        }
        assert_eq!(calls(&m).len(), 9);
        tm.iv_rank("ZZ").await.unwrap(); // the symbol the user is looking at still gets the last call
        assert_eq!(calls(&m).len(), 10);
    }

    // ---- Review Focus 4 (backend half): the calls a symbol switch can cost

    #[tokio::test]
    async fn five_symbol_switches_never_exceed_the_per_minute_budget() {
        let clock = Arc::new(FakeClock::new(t0()));
        let stamps = Arc::new(Mutex::new(vec![]));
        let m = Mock::start(stamped(clock.clone(), stamps.clone())).await;
        let tm = tm_q(&m, &clock, None, 10, 200);
        // worst case: every switch loads all four legs of the new symbol, nothing is prefetched
        for s in ["AAPL", "MSFT", "NVDA", "TSLA", "AMD"] {
            let (a, b, c, d) = tokio::join!(tm.snapshot(s), tm.apex_levels(s, None), tm.expected_move(s), tm.iv_rank(s));
            let _ = (a, b, c, d);
            clock.advance(2_000);
        }
        let s = stamps.lock().unwrap().clone();
        assert_eq!(s.len(), 10, "the wall stops the rest: {s:?}");
        assert!(window_max(&s) <= 10);
        // the final symbol, asked for again after the minute, costs at most its four legs
        clock.advance(61_000);
        let before = calls(&m).len();
        let (a, b, c, d) = tokio::join!(tm.snapshot("AMD"), tm.apex_levels("AMD", None), tm.expected_move("AMD"), tm.iv_rank("AMD"));
        assert!(a.is_ok() && b.is_ok() && c.is_ok() && d.is_ok());
        assert!(calls(&m).len() - before <= 4);
    }

    // ---- persistence

    #[tokio::test]
    async fn the_daily_counter_survives_a_restart_and_so_does_the_pause() {
        let pool = db::open_memory().await.unwrap();
        let m = Mock::start(|r, _| ok_handler(r)).await;
        let clock = Arc::new(FakeClock::new(t0()));
        {
            let tm = tm_q(&m, &clock, Some(pool.clone()), 12, 200);
            for s in ["AAPL", "MSFT", "NVDA"] {
                tm.iv_rank(s).await.unwrap();
            }
            assert_eq!(quota::load_day(&pool, "2026-11-11").await.unwrap().map(|r| r.used), Some(3));
        }
        let tm = tm_q(&m, &clock, Some(pool.clone()), 12, 200);
        assert_eq!(tm.quota_status().await.used, 3, "a new process starts from the stored count");
        tm.iv_rank("TSLA").await.unwrap();
        assert_eq!(quota::load_day(&pool, "2026-11-11").await.unwrap().map(|r| r.used), Some(4));
        // a day that already hit the wall stays paused across a restart: zero requests
        let m2 = Mock::start(|r, _| match r.rpc_method().as_str() {
            "tools/call" => Some(tool_err(r, DAILY)),
            _ => ok_handler(r),
        })
        .await;
        let tm = tm_q(&m2, &clock, Some(pool.clone()), 12, 200);
        assert!(tm.iv_rank("AMD").await.is_err());
        let row = quota::load_day(&pool, "2026-11-11").await.unwrap().unwrap();
        assert_eq!((row.used, row.paused), (200, true));
        let m3 = Mock::start(|r, _| ok_handler(r)).await;
        let tm = tm_q(&m3, &clock, Some(pool.clone()), 12, 200);
        assert!(matches!(tm.iv_rank("QQQ").await.unwrap_err(), RhError::TmPaused(_)));
        assert_eq!(m3.count(), 0);
        // tomorrow it is open again
        clock.set(quota::utc_ms(2026, 11, 12, 0, 1, 0));
        tm.iv_rank("QQQ").await.unwrap();
        assert_eq!(quota::load_day(&pool, "2026-11-12").await.unwrap().map(|r| r.used), Some(1));
        // yesterday's row is kept as history
        assert!(quota::load_day(&pool, "2026-11-11").await.unwrap().is_some());
    }

    #[tokio::test]
    async fn the_budgets_are_validated_saved_and_applied_at_once() {
        let pool = db::open_memory().await.unwrap();
        let m = Mock::start(|r, _| ok_handler(r)).await;
        let clock = Arc::new(FakeClock::new(t0()));
        let tm = tm_q(&m, &clock, Some(pool.clone()), 10, 200);
        for (a, b) in [(0, 200), (13, 200), (10, 0), (10, 10_001)] {
            assert!(matches!(tm.quota_set(a, b).await.unwrap_err(), RhError::Invalid(_)), "{a} {b}");
        }
        let s = tm.quota_set(2, 80).await.unwrap();
        assert_eq!((s.per_min, s.per_day, s.limit), (2, 80, 80));
        assert_eq!(quota::load_budgets(&pool).await, Budgets { per_min: 2, per_day: 80 });
        tm.iv_rank("AA").await.unwrap();
        tm.iv_rank("BB").await.unwrap();
        assert!(matches!(tm.iv_rank("CC").await.unwrap_err(), RhError::TmPaused(_)));
        assert_eq!(calls(&m).len(), 2);
        // a fresh process reads the saved budgets, not the constructor's
        let tm2 = tm_q(&m, &clock, Some(pool.clone()), 10, 200);
        let s = tm2.quota_status().await;
        assert_eq!((s.per_min, s.per_day, s.used), (2, 80, 2));
    }

    #[tokio::test]
    async fn the_key_is_in_no_quota_status_row_or_error() {
        let pool = db::open_memory().await.unwrap();
        let m = Mock::start(|r, _| match r.rpc_method().as_str() {
            "tools/call" => Some(tool_err(r, "Daily limit reached for td_live_TESTKEY")),
            _ => ok_handler(r),
        })
        .await;
        let clock = Arc::new(FakeClock::new(t0()));
        let tm = tm_q(&m, &clock, Some(pool.clone()), 10, 200);
        let e1 = tm.iv_rank("AAPL").await.unwrap_err().to_string();
        let e2 = tm.iv_rank("MSFT").await.unwrap_err().to_string();
        let st = serde_json::to_string(&tm.quota_status().await).unwrap();
        let rows: Vec<String> = sqlx::query_scalar("SELECT day || ',' || used || ',' || COALESCE(limit_seen,'') || ',' || paused FROM tm_quota").fetch_all(&pool).await.unwrap();
        let settings: Vec<String> = sqlx::query_scalar("SELECT key || value FROM settings").fetch_all(&pool).await.unwrap();
        for t in [e1, e2, st, rows.join("|"), settings.join("|")] {
            assert!(!t.contains("TESTKEY") && !t.contains("td_live_"), "{t}");
        }
    }

    // ---- preview lists

    #[tokio::test]
    async fn a_preview_watchlist_response_is_marked_truncated_and_the_quota_says_preview() {
        let preview = r#"{"preview": true, "lists":[{"id":1,"name":"Big","tickerCount":5,"tickers":[{"ticker":"AAAA"},{"ticker":"BBBB"},{"ticker":"CCCC"}]}]}"#;
        let m = Mock::start(move |r, _| match r.rpc_method().as_str() {
            "tools/call" => Some(tool_text(r, preview)),
            _ => ok_handler(r),
        })
        .await;
        let clock = Arc::new(FakeClock::new(t0()));
        let tm = tm_q(&m, &clock, None, 10, 200);
        assert!(!tm.quota_status().await.preview);
        let w = tm.watchlists().await.unwrap();
        assert!(w.truncated, "{w:?}");
        assert!(tm.quota_status().await.preview);
        // a normal response is not truncated
        let m2 = Mock::start(wl_mock_handler(violations())).await;
        let tm2 = tm_q(&m2, &clock, None, 10, 200);
        let w = tm2.watchlists().await.unwrap();
        assert!(!w.truncated);
        assert!(!tm2.quota_status().await.preview);
    }

    #[test]
    fn truncation_is_detected_from_counts_or_flags_alone() {
        use crate::tm::types::parse_watchlists;
        let cut = parse_watchlists(&json!({"lists":[{"id":1,"name":"A","tickerCount":7,"tickers":[{"ticker":"AAAA"}]}]})).unwrap();
        assert!(cut.truncated, "count above the rows we got");
        let flag = parse_watchlists(&json!({"lists":[{"id":1,"name":"A","tickerCount":1,"tickers":[{"ticker":"AAAA"}],"truncated":true}]})).unwrap();
        assert!(flag.truncated);
        let more = parse_watchlists(&json!({"lists":[{"id":1,"name":"A","tickerCount":1,"tickers":[{"ticker":"AAAA"}]}],"totalLists":4})).unwrap();
        assert!(more.truncated, "fewer lists than the server says exist");
        let ok = parse_watchlists(&json!({"lists":[{"id":1,"name":"A","tickerCount":1,"tickers":[{"ticker":"AAAA"}]}],"preview":false})).unwrap();
        assert!(!ok.truncated);
    }

    #[test]
    fn priority_parses_only_its_three_names() {
        assert_eq!(Priority::parse(None).unwrap(), Priority::Interactive);
        assert_eq!(Priority::parse(Some("interactive")).unwrap(), Priority::Interactive);
        assert_eq!(Priority::parse(Some("background")).unwrap(), Priority::Background);
        assert_eq!(Priority::parse(Some("opportunistic")).unwrap(), Priority::Opportunistic);
        assert!(Priority::parse(Some("urgent")).is_err());
        assert!(Priority::parse(Some("")).is_err());
    }

    #[test]
    fn day_row_type_is_plain_data() {
        let r = DayRow { day: "2026-11-11".into(), used: 1, limit_seen: None, paused: false };
        assert_eq!(r.clone(), r);
    }
}
