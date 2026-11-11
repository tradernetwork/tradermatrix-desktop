//! Order flow end to end against a loopback mock MCP server with fake tokens. NO traffic leaves 127.0.0.1.
//! The mock records a violation (and answers 500) for any tool a test did not allow, and for the tools that
//! are never allowed at all (advanced/crypto orders, exercise, replace). Every test ends with `clean()`.
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::rh::orders::{EquityOrderArgs, OptionLeg, OptionOrderArgs, PlaceOutcome};
use crate::rh::testutil::{Mock, Req, Resp};
use crate::rh::RhError;
use crate::rh_commands::RhState;

macro_rules! fx {
    ($n:literal) => {
        serde_json::from_str::<Value>(include_str!(concat!("../../tests/fixtures/rh/", $n))).unwrap()
    };
}

const NEVER: [&str; 5] = ["place_advanced_order", "place_crypto_order", "exercise_option", "replace_equity_order", "replace_option_order"];
const OPT_ID: &str = "11111111-2222-4333-8444-555555555555";
const ORDER_ID: &str = "22222222-3333-4444-8555-666666666666";

fn structured(req: &Req, sc: Value) -> Resp {
    Resp::json(
        200,
        &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"content":[{"type":"text","text":sc.to_string()}],"structuredContent":sc}}),
    )
}

fn tool_error(req: &Req, text: &str) -> Resp {
    Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"isError":true,"content":[{"type":"text","text":text}]}}))
}

type WriteFn = dyn Fn(&str, usize, &Value, &Req) -> Option<Resp> + Send + Sync;

struct H {
    m: Mock,
    rh: RhState,
    clock: Arc<AtomicU64>,
    violations: Arc<Mutex<Vec<String>>>,
}

/// `allow`: tool names this test expects. `w` answers place_*/cancel_* (index counts write calls only);
/// returning None drops the connection (transport failure after the request was read).
async fn harness(allow: &[&'static str], w: impl Fn(&str, usize, &Value, &Req) -> Option<Resp> + Send + Sync + 'static) -> H {
    let allow: Vec<&'static str> = allow.to_vec();
    let violations = Arc::new(Mutex::new(Vec::<String>::new()));
    let v2 = violations.clone();
    let writes = Arc::new(AtomicUsize::new(0));
    let w: Arc<WriteFn> = Arc::new(w);
    let m = Mock::start(move |req, _| match req.rpc_method().as_str() {
        "initialize" => Some(
            Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"mock","version":"1"}}}))
                .header("Mcp-Session-Id", "sess-order"),
        ),
        "notifications/initialized" => Some(Resp::status(202)),
        "tools/call" => {
            let j = req.json();
            let name = j["params"]["name"].as_str().unwrap_or("").to_string();
            let args = j["params"]["arguments"].clone();
            if NEVER.contains(&name.as_str()) || !allow.contains(&name.as_str()) {
                v2.lock().unwrap().push(name);
                return Some(Resp::text(500, "unexpected tool"));
            }
            match name.as_str() {
                "get_accounts" => Some(structured(req, fx!("accounts.json"))),
                "review_equity_order" => Some(structured(req, fx!("review_equity.json"))),
                "review_option_order" => Some(structured(req, fx!("review_option.json"))),
                "get_trade_approval_setting" => Some(structured(req, fx!("approval_setting.json"))),
                "get_trade_approvals" => Some(structured(req, fx!("approvals.json"))),
                n if n.starts_with("place_") || n.starts_with("cancel_") || n == "decline_trade_approval" => w(n, writes.fetch_add(1, Ordering::SeqCst), &args, req),
                other => {
                    v2.lock().unwrap().push(other.to_string());
                    Some(Resp::text(500, "unexpected tool"))
                }
            }
        }
        _ => Some(Resp::status(400)),
    })
    .await;
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let c2 = clock.clone();
    let rh = RhState::for_test(m.url("/mcp/trading"), Arc::new(move || c2.load(Ordering::SeqCst)));
    H { m, rh, clock, violations }
}

impl H {
    fn calls(&self) -> Vec<(String, Value)> {
        self.m
            .requests()
            .iter()
            .filter(|r| r.rpc_method() == "tools/call")
            .map(|r| (r.json()["params"]["name"].as_str().unwrap().to_string(), r.json()["params"]["arguments"].clone()))
            .collect()
    }
    fn names(&self) -> Vec<String> {
        self.calls().into_iter().map(|c| c.0).collect()
    }
    fn count(&self, name: &str) -> usize {
        self.names().iter().filter(|n| *n == name).count()
    }
    fn clean(&self) {
        assert!(self.violations.lock().unwrap().is_empty(), "unexpected tools reached the server: {:?}", self.violations.lock().unwrap());
        for n in NEVER {
            assert_eq!(self.count(n), 0, "{n} must never be sent");
        }
        assert!(self.m.requests().iter().all(|r| r.method == "POST" && r.header("authorization") == Some("Bearer fake-access-token")));
    }
}

const ALL: [&str; 10] = [
    "get_accounts", "review_equity_order", "review_option_order", "place_equity_order", "place_option_order",
    "cancel_equity_order", "cancel_option_order", "get_trade_approval_setting", "get_trade_approvals", "decline_trade_approval",
];

fn placed(req: &Req) -> Option<Resp> {
    Some(structured(req, fx!("place_order.json")))
}

fn eq_args() -> EquityOrderArgs {
    EquityOrderArgs {
        account_number: "SYN00000002".into(),
        symbol: "AAA".into(),
        side: "buy".into(),
        r#type: "limit".into(),
        quantity: Some("1".into()),
        dollar_amount: None,
        limit_price: Some("90.00".into()),
        stop_price: None,
        time_in_force: None,
        market_hours: None,
    }
}

fn opt_args() -> OptionOrderArgs {
    OptionOrderArgs {
        account_number: "SYN00000002".into(),
        legs: vec![OptionLeg { option_id: OPT_ID.into(), side: "buy".into(), position_effect: "open".into(), ratio_quantity: 1 }],
        quantity: "1".into(),
        r#type: None,
        price: Some("1.50".into()),
        stop_price: None,
        time_in_force: None,
        market_hours: None,
        direction: None,
    }
}

#[tokio::test]
async fn review_then_place_is_placed_with_the_reviewed_args_and_a_ref_id() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    assert_eq!(rv.account_masked, "••••0002");
    assert_eq!(rv.expires_in_secs, 300);
    assert_eq!(rv.customer_approval_required, Some(true));
    assert_eq!(rv.customer_approval_reason.as_deref(), Some("account_setting"));
    assert_eq!(rv.order_checks, json!({}));
    assert!(rv.echoed["quote_data"]["ask_price"].is_string() && rv.echoed["market_data_disclosure"].is_string());
    assert!(!serde_json::to_string(&rv).unwrap().contains("SYN00000002"), "no full account number to the webview");

    let out = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(&out, PlaceOutcome::Placed { order } if order["id"] == ORDER_ID), "{out:?}");
    let calls = h.calls();
    assert_eq!(h.names(), ["get_accounts", "review_equity_order", "place_equity_order"]);
    assert!(calls[1].1.get("ref_id").is_none(), "review takes no ref_id");
    assert_eq!(calls[1].1, eq_args().to_tool_args(None));
    let ref_id = calls[2].1["ref_id"].as_str().unwrap().to_string();
    assert_eq!(ref_id.len(), 36);
    let mut sent = calls[2].1.clone();
    sent.as_object_mut().unwrap().remove("ref_id");
    assert_eq!(sent, eq_args().to_tool_args(None), "place sends exactly the reviewed parameters");
    assert_eq!(serde_json::to_value(&out).unwrap()["kind"], "placed");
    h.clean();
}

#[tokio::test]
async fn option_review_surfaces_alerts_and_place_stays_possible() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let rv = h.rh.review_option(opt_args()).await.unwrap();
    assert_eq!(rv.order_checks["alert_type"], "BUYING_POWER_ALERT");
    assert_eq!(rv.customer_approval_required, Some(false));
    assert_eq!(rv.customer_approval_reason, None, "empty reason is None");
    assert_eq!(rv.echoed["collateral"]["cash"]["direction"], "debit");
    let out = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(out, PlaceOutcome::Placed { .. }));
    let calls = h.calls();
    assert_eq!(h.names(), ["get_accounts", "review_option_order", "place_option_order"]);
    assert!(calls[2].1["ref_id"].is_string() && calls[1].1.get("ref_id").is_none());
    assert!(calls[2].1.get("direction").is_none(), "single leg: direction omitted");
    h.clean();
}

#[tokio::test]
async fn approval_required_is_awaiting_approval_never_placed_and_one_request() {
    let h = harness(&ALL, |_, _, _, req| Some(structured(req, fx!("place_approval.json")))).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    let out = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(&out, PlaceOutcome::AwaitingApproval { approval } if approval["approval_id"] == "appr-0001"), "{out:?}");
    assert!(!matches!(out, PlaceOutcome::Placed { .. }));
    let again = h.rh.place(&rv.review_id).await.unwrap();
    assert_eq!(again, out, "repeat replays, no resubmit while pending");
    assert_eq!(h.count("place_equity_order"), 1);
    let j = serde_json::to_value(&out).unwrap();
    assert_eq!(j["kind"], "awaiting_approval");
    assert_eq!(j["approval"]["state"], "APPROVAL_STATE_PENDING");
    h.clean();
}

#[tokio::test]
async fn sequential_double_place_sends_exactly_one_request() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    let a = h.rh.place(&rv.review_id).await.unwrap();
    let b = h.rh.place(&rv.review_id).await.unwrap();
    assert_eq!(a, b);
    assert_eq!(h.count("place_equity_order"), 1);
    h.clean();
}

#[tokio::test]
async fn concurrent_double_place_sends_exactly_one_request() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    let (a, b) = tokio::join!(h.rh.place(&rv.review_id), h.rh.place(&rv.review_id));
    let (a, b) = (a.unwrap(), b.unwrap());
    assert!(matches!(a, PlaceOutcome::Placed { .. }));
    assert_eq!(a, b);
    assert_eq!(h.count("place_equity_order"), 1);
    // Same for option orders and for three-way races.
    let rv = h.rh.review_option(opt_args()).await.unwrap();
    let (x, y, z) = tokio::join!(h.rh.place(&rv.review_id), h.rh.place(&rv.review_id), h.rh.place(&rv.review_id));
    assert!(x.is_ok() && x == y && y == z);
    assert_eq!(h.count("place_option_order"), 1);
    h.clean();
}

#[tokio::test]
async fn transport_failure_is_unknown_then_explicit_retry_resends_the_same_ref_id() {
    let h = harness(&ALL, |_, i, _, req| if i == 0 { None } else { placed(req) }).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    let first = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(&first, PlaceOutcome::Unknown { message, .. } if !message.is_empty() && !message.contains("fake-access-token")), "{first:?}");
    assert_eq!(h.count("place_equity_order"), 1, "no automatic retry after a transport failure");
    assert_eq!(serde_json::to_value(&first).unwrap()["kind"], "unknown");

    let second = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(second, PlaceOutcome::Placed { .. }), "{second:?}");
    let places: Vec<Value> = h.calls().into_iter().filter(|c| c.0 == "place_equity_order").map(|c| c.1).collect();
    assert_eq!(places.len(), 2);
    assert_eq!(places[0]["ref_id"], places[1]["ref_id"], "explicit retry re-sends the SAME ref_id");
    assert_eq!(places[0], places[1], "and the same parameters");
    // Now it is final: a third call only replays.
    assert_eq!(h.rh.place(&rv.review_id).await.unwrap(), second);
    assert_eq!(h.count("place_equity_order"), 2);
    h.clean();
}

#[tokio::test]
async fn concurrent_double_click_that_ends_unknown_does_not_resend() {
    let h = harness(&ALL, |_, _, _, _| None).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    let (a, b) = tokio::join!(h.rh.place(&rv.review_id), h.rh.place(&rv.review_id));
    assert!(matches!(a.unwrap(), PlaceOutcome::Unknown { .. }));
    assert!(matches!(b.unwrap(), PlaceOutcome::Unknown { .. }));
    assert_eq!(h.count("place_equity_order"), 1, "the waiter must not turn a double click into a retry");
    h.clean();
}

#[tokio::test]
async fn a_new_review_of_identical_args_gets_a_different_ref_id() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let r1 = h.rh.review_equity(eq_args()).await.unwrap();
    let r2 = h.rh.review_equity(eq_args()).await.unwrap();
    assert_ne!(r1.review_id, r2.review_id);
    h.rh.place(&r1.review_id).await.unwrap();
    h.rh.place(&r2.review_id).await.unwrap();
    let ids: Vec<String> = h.calls().into_iter().filter(|c| c.0 == "place_equity_order").map(|c| c.1["ref_id"].as_str().unwrap().to_string()).collect();
    assert_eq!(ids.len(), 2);
    assert_ne!(ids[0], ids[1]);
    h.clean();
}

#[tokio::test]
async fn non_agentic_or_missing_account_is_refused_without_review_or_place() {
    let h = harness(&["get_accounts"], |_, _, _, req| placed(req)).await;
    let mut a = eq_args();
    a.account_number = "SYN00000001".into();
    let e = h.rh.review_equity(a).await.unwrap_err();
    assert!(matches!(&e, RhError::Invalid(m) if m.contains("••••0001") && m.contains("agentic") && !m.contains("SYN00000001")), "{e:?}");
    let mut b = opt_args();
    b.account_number = "SYN00000001".into();
    assert!(matches!(h.rh.review_option(b).await, Err(RhError::Invalid(_))));
    let mut c = eq_args();
    c.account_number = "NOSUCH9999".into();
    assert!(matches!(h.rh.review_equity(c).await, Err(RhError::Invalid(m)) if m.contains("not found")));
    assert!(h.names().iter().all(|n| n == "get_accounts"), "{:?}", h.names());
    h.clean();
}

#[tokio::test]
async fn unknown_or_expired_review_id_is_refused_with_no_server_call() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let before = h.m.count();
    for id in ["", "nope", "11111111-2222-4333-8444-555555555555"] {
        assert!(matches!(h.rh.place(id).await, Err(RhError::Invalid(_))), "{id}");
    }
    assert_eq!(h.m.count(), before, "unknown id: zero requests");

    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    h.clock.fetch_add(301, Ordering::SeqCst);
    let after_review = h.m.count();
    let e = h.rh.place(&rv.review_id).await.unwrap_err();
    assert!(matches!(&e, RhError::Invalid(m) if m.contains("expired")), "{e:?}");
    assert_eq!(h.m.count(), after_review, "expired review: zero requests");
    assert_eq!(h.count("place_equity_order"), 0);
    h.clean();
}

#[tokio::test]
async fn review_just_inside_the_ttl_can_still_be_placed() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    h.clock.fetch_add(300, Ordering::SeqCst);
    assert!(matches!(h.rh.place(&rv.review_id).await.unwrap(), PlaceOutcome::Placed { .. }));
    h.clean();
}

#[tokio::test]
async fn validation_failures_make_zero_requests() {
    let h = harness(&[], |_, _, _, req| placed(req)).await;
    let mut a = eq_args();
    a.symbol = "aapl".into();
    assert!(matches!(h.rh.review_equity(a).await, Err(RhError::Invalid(_))));
    let mut a = eq_args();
    a.quantity = None;
    assert!(matches!(h.rh.review_equity(a).await, Err(RhError::Invalid(_))));
    let mut o = opt_args();
    o.legs.clear();
    assert!(matches!(h.rh.review_option(o).await, Err(RhError::Invalid(_))));
    let mut o = opt_args();
    o.quantity = "1.5".into();
    assert!(matches!(h.rh.review_option(o).await, Err(RhError::Invalid(_))));
    assert_eq!(h.m.count(), 0, "not even an initialize");
    h.clean();
}

#[tokio::test]
async fn server_error_is_rejected_not_placed_and_is_not_resent() {
    let h = harness(&ALL, |_, _, _, req| Some(tool_error(req, "insufficient buying power"))).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    let out = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(&out, PlaceOutcome::Rejected { message } if message.contains("insufficient buying power")), "{out:?}");
    assert_eq!(h.rh.place(&rv.review_id).await.unwrap(), out);
    assert_eq!(h.count("place_equity_order"), 1);
    assert_eq!(serde_json::to_value(&out).unwrap()["kind"], "rejected");
    h.clean();
}

#[tokio::test]
async fn ambiguous_answers_are_unknown_never_placed() {
    // HTTP 500, and a 200 that carries neither `order` nor `approval`.
    for case in 0..2 {
        let h = harness(&ALL, move |_, _, _, req| {
            if case == 0 { Some(Resp::text(500, "boom")) } else { Some(structured(req, json!({"data":{},"guide":"?"}))) }
        })
        .await;
        let rv = h.rh.review_equity(eq_args()).await.unwrap();
        let out = h.rh.place(&rv.review_id).await.unwrap();
        assert!(matches!(out, PlaceOutcome::Unknown { .. }), "case {case}: {out:?}");
        assert_eq!(h.count("place_equity_order"), 1, "case {case}");
        h.clean();
    }
}

#[tokio::test]
async fn expired_session_404_never_resends_a_place() {
    // First write gets 404 (session expired). The client re-initializes for later calls but does not resend.
    let h = harness(&ALL, |_, i, _, req| if i == 0 { Some(Resp::text(404, "session not found")) } else { placed(req) }).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    let out = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(out, PlaceOutcome::Unknown { .. }), "404 on a write is unknown, not rejected: {out:?}");
    assert_eq!(h.count("place_equity_order"), 1, "not resent on 404");
    // Only an explicit retry sends again, with the same ref_id.
    assert!(matches!(h.rh.place(&rv.review_id).await.unwrap(), PlaceOutcome::Placed { .. }));
    let ids: Vec<Value> = h.calls().into_iter().filter(|c| c.0 == "place_equity_order").map(|c| c.1["ref_id"].clone()).collect();
    assert_eq!(ids.len(), 2);
    assert_eq!(ids[0], ids[1]);
    h.clean();
}

#[tokio::test]
async fn cancel_404_is_an_error_and_sent_once() {
    for kind in ["equity", "option"] {
        let h = harness(&ALL, |_, i, _, req| if i == 0 { Some(Resp::text(404, "session not found")) } else { Some(structured(req, fx!("cancel_ok.json"))) }).await;
        let e = if kind == "equity" { h.rh.cancel_equity("SYN00000002", ORDER_ID).await } else { h.rh.cancel_option("SYN00000002", ORDER_ID).await }.unwrap_err();
        assert!(matches!(e, RhError::Http(404, _)), "{kind}: {e:?}");
        assert_eq!(h.count(&format!("cancel_{kind}_order")), 1, "{kind}: never auto-retried on session expiry");
        h.clean();
    }
}

#[tokio::test]
async fn cancel_sends_account_and_order_id_and_reports_acceptance() {
    let h = harness(&ALL, |_, _, _, req| Some(structured(req, fx!("cancel_ok.json")))).await;
    assert!(h.rh.cancel_equity("SYN00000002", ORDER_ID).await.unwrap());
    assert!(h.rh.cancel_option("SYN00000002", ORDER_ID).await.unwrap());
    assert_eq!(
        h.calls().into_iter().filter(|c| c.0.starts_with("cancel_")).collect::<Vec<_>>(),
        vec![
            ("cancel_equity_order".to_string(), json!({"account_number":"SYN00000002","order_id":ORDER_ID})),
            ("cancel_option_order".to_string(), json!({"account_number":"SYN00000002","order_id":ORDER_ID})),
        ]
    );
    h.clean();
}

#[tokio::test]
async fn cancel_transport_failure_is_not_retried_and_bad_ids_make_no_request() {
    let h = harness(&ALL, |_, _, _, _| None).await;
    let e = h.rh.cancel_option("SYN00000002", ORDER_ID).await.unwrap_err();
    assert!(matches!(e, RhError::Transport(_)), "{e:?}");
    assert!(!format!("{e:?}").contains("fake-access"));
    assert_eq!(h.count("cancel_option_order"), 1);
    let before = h.m.count();
    for (a, o) in [("", ORDER_ID), ("SYN 2", ORDER_ID), ("SYN00000002", ""), ("SYN00000002", "not-a-uuid"), ("SYN00000002", "../../x")] {
        assert!(matches!(h.rh.cancel_equity(a, o).await, Err(RhError::Invalid(_))), "{a:?} {o:?}");
        assert!(matches!(h.rh.cancel_option(a, o).await, Err(RhError::Invalid(_))));
    }
    assert_eq!(h.m.count(), before);
    h.clean();
}

#[tokio::test]
async fn approvals_setting_list_and_decline() {
    let h = harness(&ALL, |name, _, args, req| {
        assert_eq!(name, "decline_trade_approval");
        Some(structured(req, json!({"data":{"result":{"approval_id":args["approval_id"],"state":"APPROVAL_STATE_DECLINED"}},"guide":"synthetic"})))
    })
    .await;
    let s = h.rh.approval_setting("SYN00000002").await.unwrap();
    assert_eq!(s["setting"]["human_must_approve_trades"], true);
    let all = h.rh.approvals("SYN00000002", None).await.unwrap();
    assert_eq!(all["approvals"].as_array().unwrap().len(), 2);
    // Changed 2026-11-11 (R10f): no client-side state filter; the tool lists pending approvals only.
    let pending = h.rh.approvals("SYN00000002", Some("pending")).await.unwrap();
    assert_eq!(pending["approvals"].as_array().unwrap().len(), 2);
    assert_eq!(pending["approvals"][0]["approval_id"], "appr-0001");
    let d = h.rh.decline_approval("SYN00000002", "appr-0001").await.unwrap();
    assert_eq!(d["result"]["state"], "APPROVAL_STATE_DECLINED");
    let calls = h.calls();
    assert_eq!(calls[0], ("get_trade_approval_setting".to_string(), json!({"account_number":"SYN00000002"})));
    assert_eq!(calls[1], ("get_trade_approvals".to_string(), json!({"account_number":"SYN00000002"})));
    assert_eq!(calls.last().unwrap(), &("decline_trade_approval".to_string(), json!({"account_number":"SYN00000002","approval_id":"appr-0001"})));
    h.clean();
}

#[tokio::test]
async fn approval_inputs_are_validated_and_decline_is_never_retried() {
    let h = harness(&ALL, |_, _, _, _| None).await;
    let before = h.m.count();
    assert!(matches!(h.rh.approval_setting("").await, Err(RhError::Invalid(_))));
    assert!(matches!(h.rh.approvals("SYN 2", None).await, Err(RhError::Invalid(_))));
    assert!(matches!(h.rh.approvals("SYN00000002", Some("bogus")).await, Err(RhError::Invalid(_))));
    assert!(matches!(h.rh.decline_approval("SYN00000002", "").await, Err(RhError::Invalid(_))));
    assert!(matches!(h.rh.decline_approval("SYN00000002", "a b").await, Err(RhError::Invalid(_))));
    assert_eq!(h.m.count(), before);
    let e = h.rh.decline_approval("SYN00000002", "appr-0001").await.unwrap_err();
    assert!(matches!(e, RhError::Transport(_)), "{e:?}");
    assert_eq!(h.count("decline_trade_approval"), 1, "decline is a write: never auto-retried");
    h.clean();
}

#[tokio::test]
async fn the_mock_flags_tools_nobody_asked_for() {
    // Self-test of the harness: a tool outside `allow` is recorded as a violation and answered 500.
    let h = harness(&["get_accounts"], |_, _, _, req| placed(req)).await;
    let rv = h.rh.review_equity(eq_args()).await;
    assert!(rv.is_err());
    assert_eq!(h.violations.lock().unwrap().as_slice(), ["review_equity_order"]);
}

// ---- hardening (2026-11-11) ----

fn approval_with(state: Option<&str>, actual: Option<Value>) -> Value {
    let mut a = json!({"approval_id":"appr-9","account_number":"SYN00000002","asset_class":"ASSET_CLASS_EQUITY"});
    if let Some(s) = state {
        a["state"] = json!(s);
    }
    if let Some(o) = actual {
        a["actual_order"] = o;
    }
    json!({"data":{"approval":a},"guide":"synthetic"})
}

/// R2a: the approval state decides the outcome; only PENDING is "awaiting approval".
#[tokio::test]
async fn approval_states_map_to_the_right_outcome() {
    let cases: Vec<(Option<&'static str>, Option<Value>, &str)> = vec![
        (Some("APPROVAL_STATE_PENDING"), None, "awaiting_approval"),
        (Some("pending"), None, "awaiting_approval"),
        (Some("APPROVAL_STATE_AUTO_APPROVED"), Some(json!({"id": ORDER_ID, "state": "queued"})), "placed"),
        (Some("APPROVAL_STATE_APPROVED"), None, "placed"),
        (Some("approved"), None, "placed"),
        (Some("APPROVAL_STATE_DECLINED"), None, "rejected"),
        (Some("APPROVAL_STATE_EXPIRED"), None, "rejected"),
        (Some("APPROVAL_STATE_CANCELLED"), None, "rejected"),
        (Some("APPROVAL_STATE_SOMETHING_NEW"), None, "unknown"),
        (None, None, "unknown"),
    ];
    for (state, actual, want) in cases {
        let body = approval_with(state, actual.clone());
        let h = harness(&ALL, move |_, _, _, req| Some(structured(req, body.clone()))).await;
        let rv = h.rh.review_equity(eq_args()).await.unwrap();
        let out = h.rh.place(&rv.review_id).await.unwrap();
        let j = serde_json::to_value(&out).unwrap();
        assert_eq!(j["kind"], want, "{state:?}: {out:?}");
        match (&out, &actual) {
            (PlaceOutcome::Placed { order }, Some(a)) => assert_eq!(order, a, "auto-approved carries actual_order"),
            (PlaceOutcome::Placed { order }, None) => assert_eq!(order["approval_id"], "appr-9", "approved without actual_order carries the approval"),
            (PlaceOutcome::Rejected { message }, _) => assert!(message.contains("nothing placed") || message.contains("nothing was placed"), "{message}"),
            _ => {}
        }
        assert_eq!(h.count("place_equity_order"), 1);
        h.clean();
    }
}

/// M19 (Robinhood's own caveat): certain trades may still require approval even when the account's approvals are OFF, so `approval_id` handling must not
/// depend on the review's `customer_approval_required`. Both directions, against the existing outcome mapping (mock server only, never a real order).
#[tokio::test]
async fn approval_id_is_handled_whether_or_not_the_review_said_approval_is_required() {
    // review says NOT required (approvals off: the option review fixture), yet place answers with a pending approval: nothing is placed, the approval is surfaced
    let h = harness(&ALL, |_, _, _, req| Some(structured(req, fx!("place_approval.json")))).await;
    let rv = h.rh.review_option(opt_args()).await.unwrap();
    assert_eq!(rv.customer_approval_required, Some(false));
    let out = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(&out, PlaceOutcome::AwaitingApproval { approval } if approval["approval_id"] == "appr-0001"), "{out:?}");
    assert!(!matches!(out, PlaceOutcome::Placed { .. }));
    assert_eq!(h.count("place_option_order"), 1);
    h.clean();
    // review says required (approvals on, the equity review fixture), yet place answers with a plain order: it is placed and no approval is invented
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    assert_eq!(rv.customer_approval_required, Some(true));
    let out = h.rh.place(&rv.review_id).await.unwrap();
    let j = serde_json::to_value(&out).unwrap();
    assert_eq!(j["kind"], "placed");
    assert!(j.get("approval").is_none());
    h.clean();
}

/// R2b: server-side failures that may have acted are Unknown, never Rejected; validation-style errors stay Rejected.
#[tokio::test]
async fn ambiguous_place_tool_errors_are_unknown_and_clear_rejections_stay_rejected() {
    let unknown = [
        "API error 503: service unavailable",
        "API error 500: oops",
        "Gateway Timeout",
        "the request timed out",
        "upstream connect error",
        "Please try again later",
        "Internal Server Error",
        "duplicate ref_id",
        "an order with this reference already exists",
        "idempotency key conflict",
        "Idempotent replay in progress",
    ];
    for text in unknown {
        let h = harness(&ALL, move |_, _, _, req| Some(tool_error(req, text))).await;
        let rv = h.rh.review_equity(eq_args()).await.unwrap();
        let out = h.rh.place(&rv.review_id).await.unwrap();
        assert!(matches!(out, PlaceOutcome::Unknown { .. }), "{text}: {out:?}");
        h.clean();
    }
    for text in ["API error 400: quantity must be positive", "insufficient buying power", "API error 422: market closed"] {
        let h = harness(&ALL, move |_, _, _, req| Some(tool_error(req, text))).await;
        let rv = h.rh.review_equity(eq_args()).await.unwrap();
        let out = h.rh.place(&rv.review_id).await.unwrap();
        assert!(matches!(out, PlaceOutcome::Rejected { .. }), "{text}: {out:?}");
        h.clean();
    }
}

/// R2b: on a retry of an Unknown record, EVERY tool error is Unknown (the first send may have landed).
#[tokio::test]
async fn any_tool_error_on_a_retry_is_unknown() {
    let h = harness(&ALL, |_, i, _, req| if i == 0 { None } else { Some(tool_error(req, "insufficient buying power")) }).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    assert!(matches!(h.rh.place(&rv.review_id).await.unwrap(), PlaceOutcome::Unknown { .. }));
    let second = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(second, PlaceOutcome::Unknown { .. }), "{second:?}");
    assert_eq!(h.count("place_equity_order"), 2);
    h.clean();
}

/// Tokens that work for `n` calls and then fail the way a locked vault does.
struct FlakyTokens {
    left: AtomicUsize,
}
#[async_trait::async_trait]
impl crate::rh::TokenProvider for FlakyTokens {
    async fn access_token(&self) -> Result<String, RhError> {
        if self.left.load(Ordering::SeqCst) == 0 {
            return Err(RhError::Protocol("secret store: secret store error: vault locked".into()));
        }
        self.left.fetch_sub(1, Ordering::SeqCst);
        Ok("fake-access-token".into())
    }
    async fn force_refresh(&self) -> Result<String, RhError> {
        Err(RhError::Unauthorized)
    }
}

/// R2c: a failure before anything could be sent (here: the vault locked under us) is Rejected, never Unknown.
#[tokio::test]
async fn token_failure_before_sending_a_place_is_rejected_and_nothing_is_sent() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let clock = Arc::new(AtomicU64::new(1_000_000));
    let c2 = clock.clone();
    // initialize + notification + get_accounts + review = 4 token reads, then the vault "locks".
    let rh = RhState::for_test_with_tokens(h.m.url("/mcp/trading"), Arc::new(move || c2.load(Ordering::SeqCst)), Arc::new(FlakyTokens { left: AtomicUsize::new(4) }));
    let rv = rh.review_equity(eq_args()).await.unwrap();
    let out = rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(&out, PlaceOutcome::Rejected { message } if message.contains("vault locked")), "{out:?}");
    assert_eq!(h.count("place_equity_order"), 0, "nothing reached the server");
    h.clean();
}

/// R2d: an Unknown carries `retry_until` = first send + 600 s; after that an explicit retry is refused with no request.
#[tokio::test]
async fn unknown_retry_window_is_600s_from_the_first_send() {
    let h = harness(&ALL, |_, i, _, req| if i < 2 { None } else { placed(req) }).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    let t0 = h.clock.load(Ordering::SeqCst);
    let first = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(first, PlaceOutcome::Unknown { retry_until: Some(t), .. } if t == t0 + 600), "{first:?}");
    assert_eq!(serde_json::to_value(&first).unwrap()["retry_until"], json!(t0 + 600));
    // Inside the window a retry is sent; its Unknown keeps the window anchored at the FIRST send.
    h.clock.fetch_add(599, Ordering::SeqCst);
    let second = h.rh.place(&rv.review_id).await.unwrap();
    assert!(matches!(second, PlaceOutcome::Unknown { retry_until: Some(t), .. } if t == t0 + 600), "{second:?}");
    h.clock.fetch_add(2, Ordering::SeqCst);
    let e = h.rh.place(&rv.review_id).await.unwrap_err();
    assert!(matches!(&e, RhError::Invalid(m) if m.contains("Orders") && m.contains("review")), "{e:?}");
    assert_eq!(h.count("place_equity_order"), 2, "no send after the window closed");
    h.clean();
}

/// R2e: a clock stepped backwards does not keep a review alive.
#[tokio::test]
async fn review_is_expired_when_the_clock_went_backwards() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let rv = h.rh.review_equity(eq_args()).await.unwrap();
    h.clock.fetch_sub(5, Ordering::SeqCst);
    assert!(matches!(h.rh.place(&rv.review_id).await, Err(RhError::Invalid(m)) if m.contains("expired")));
    assert_eq!(h.count("place_equity_order"), 0);
    h.clean();
}

/// R9: a successful unrelated read must not wipe a recent place error; it clears after 60 s.
#[tokio::test]
async fn a_recent_place_error_survives_unrelated_successful_reads_for_60s() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    assert!(h.rh.place("nope").await.is_err());
    let err = h.rh.status().last_error.expect("place error recorded");
    h.rh.accounts().await.unwrap();
    assert_eq!(h.rh.status().last_error.as_deref(), Some(err.as_str()), "a poll must not clear the place error");
    h.clock.fetch_add(61, Ordering::SeqCst);
    h.rh.accounts().await.unwrap();
    assert_eq!(h.rh.status().last_error, None, "cleared after 60 s");
    h.clean();
}

/// R10f: get_trade_approvals only lists pending approvals; no client-side state filter, non-pending is refused.
#[tokio::test]
async fn approvals_list_is_pending_only_without_a_client_filter() {
    let h = harness(&ALL, |_, _, _, req| placed(req)).await;
    let a = h.rh.approvals("SYN00000002", Some("pending")).await.unwrap();
    assert_eq!(a["approvals"].as_array().unwrap().len(), 2, "what the tool lists is returned as is");
    let before = h.m.count();
    for s in ["approved", "declined", "expired", "auto_approved"] {
        assert!(matches!(h.rh.approvals("SYN00000002", Some(s)).await, Err(RhError::Invalid(m)) if m.contains("pending")), "{s}");
    }
    assert_eq!(h.m.count(), before);
    h.clean();
}
