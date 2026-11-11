//! Hermes provider tests (M16 B5). A local mock server on 127.0.0.1 stands in for the Hermes host; the only key is the fake `sk-test-KEY`.
//! The real Hermes box is never contacted.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use url::Url;

use super::client::{probe_key_allowed, probe_outcome, ChatEvent, Emit, End, LlmError, LlmState, Probe, StreamParams};
use super::config;
use crate::rh::testutil::{Mock, Req, Resp};
use crate::secrets::{MemoryStore, SecretStore};

const KEY: &str = "sk-test-KEY";
const MODEL: &str = "tm-explain";
const DIGEST: &str = "CHART: symbol=AAPL tf=15m bars=834 last=87.38\nIV: rank=72";

fn store(url: &Url, key: Option<&str>) -> Arc<dyn SecretStore> {
    let s: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    // the mock is plain http on loopback: allowed without the LAN toggle
    config::set_config_ex(&*s, "hermes", Some(url.as_str().trim_end_matches('/')), key, Some(MODEL), None, None).unwrap();
    s
}
fn data(v: serde_json::Value) -> String {
    format!("data: {v}\n\n")
}
fn params(q: &str) -> StreamParams {
    StreamParams { model: String::new(), digest: DIGEST.into(), question: q.into(), history: vec![], mode: "beginner".into() }
}
fn collector() -> (Emit, Arc<Mutex<Vec<ChatEvent>>>) {
    let log: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(vec![]));
    let l2 = log.clone();
    (Arc::new(move |e| l2.lock().unwrap().push(e)), log)
}
fn all_paths(m: &Mock) -> Vec<(String, String)> {
    m.requests().into_iter().map(|r: Req| (r.method, r.path)).collect()
}

#[tokio::test]
async fn the_mock_hermes_gets_exactly_one_digest_bearing_chat_request_and_progress_events_are_ignored() {
    let body = format!(
        "event: hermes.tool.progress\ndata: {}\n\n{}event: hermes.tool.progress\ndata: {}\n\n{}{}data: [DONE]\n\n",
        json!({"tool":"terminal","label":"ls -la","choices":[{"delta":{"content":"LEAK-ONE"}}]}),
        data(json!({"choices":[{"index":0,"delta":{"content":"Price sits mid range."}}]})),
        json!({"tool":"browser","choices":[{"delta":{"content":"LEAK-TWO"}}]}),
        data(json!({"choices":[{"index":0,"delta":{"content":" Used: CHART"}}]})),
        data(json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":50,"completion_tokens":9}})),
    );
    let m = Mock::start(move |r, _| if r.method == "POST" && r.path == "/v1/chat/completions" { Some(Resp::sse(&body)) } else { Some(Resp::status(404)) }).await;
    let s = Arc::new(LlmState::for_test(store(&m.url(""), Some(KEY)), Duration::from_secs(5)));
    let (emit, log) = collector();
    let out = s.explain_stream("req-h1", params("What is this?"), emit).await;
    assert_eq!(out.end, End::Done);
    assert_eq!(out.text, "Price sits mid range. Used: CHART");
    assert!(!out.text.contains("LEAK") && !log.lock().unwrap().iter().any(|e| matches!(e, ChatEvent::Delta { text, .. } if text.contains("LEAK"))));
    assert_eq!((out.usage.prompt, out.usage.completion, out.usage.estimated), (50, 9, false));
    // ONE request, the stateless chat endpoint, never the responses API
    assert_eq!(all_paths(&m), vec![("POST".to_string(), "/v1/chat/completions".to_string())]);
    let r = &m.requests()[0];
    assert_eq!(r.header("authorization"), Some("Bearer sk-test-KEY"));
    let b = r.json();
    assert_eq!(b["stream"], json!(true));
    assert_eq!(b["model"], json!(MODEL));
    let mut keys: Vec<&String> = b.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["max_tokens", "messages", "model", "stream"], "the bare body only: no tools, no store, no previous_response_id");
    assert!(b["messages"][0]["content"].as_str().unwrap().contains("CHART: symbol=AAPL"), "this is the digest-bearing request");
    assert!(!r.body.contains(KEY));
}

#[tokio::test]
async fn the_test_button_is_one_bare_get_with_no_digest_and_no_body() {
    let m = Mock::start(|r, _| if r.method == "GET" && r.path == "/v1/models" { Some(Resp::json(200, &json!({"data":[{"id":"tm-explain"}]}))) } else { Some(Resp::status(500)) }).await;
    let s = LlmState::for_test(store(&m.url(""), Some(KEY)), Duration::from_secs(5));
    assert_eq!(s.ping().await, Ok(()));
    let reqs = m.requests();
    assert_eq!(reqs.len(), 1);
    assert_eq!((reqs[0].method.as_str(), reqs[0].path.as_str()), ("GET", "/v1/models"));
    assert!(reqs[0].body.is_empty(), "no body");
    assert!(!format!("{:?}", reqs[0]).contains("CHART") && !format!("{:?}", reqs[0]).contains("digest"));
    // a loopback host may be sent the key (it is this computer), and a wrong key shows as a rejected key
    assert_eq!(reqs[0].header("authorization"), Some("Bearer sk-test-KEY"));
}

#[tokio::test]
async fn the_test_button_falls_back_to_health_and_maps_failures() {
    let m = Mock::start(|r, _| match r.path.as_str() {
        "/v1/models" => Some(Resp::status(404)),
        "/health" => Some(Resp::json(200, &json!({"status":"ok"}))),
        _ => Some(Resp::status(500)),
    })
    .await;
    let s = LlmState::for_test(store(&m.url(""), None), Duration::from_secs(5));
    assert_eq!(s.ping().await, Ok(()));
    assert_eq!(all_paths(&m), vec![("GET".to_string(), "/v1/models".to_string()), ("GET".to_string(), "/health".to_string())]);
    assert!(m.requests().iter().all(|r| r.body.is_empty() && r.header("authorization").is_none()), "no key was saved, none is sent");
    // a rejected key on loopback
    let m2 = Mock::start(|_, _| Some(Resp::status(401))).await;
    let s2 = LlmState::for_test(store(&m2.url(""), Some(KEY)), Duration::from_secs(5));
    assert_eq!(s2.ping().await, Err(LlmError::BadKey));
    // nothing listening
    let dead = m2.url("");
    drop(m2);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let s3 = LlmState::for_test(store(&dead, None), Duration::from_secs(2));
    assert_eq!(s3.ping().await, Err(LlmError::Unreachable));
}

#[test]
fn the_key_only_goes_on_the_test_get_for_loopback_hosts() {
    for (u, want) in [
        ("http://127.0.0.1:8642/v1", true),
        ("http://[::1]:8642/v1", true),
        ("http://localhost:8642/v1", true),
        ("https://hermes.example.com/v1", false),
        ("https://203.0.113.5/v1", false),
        ("http://192.168.1.5:8642/v1", false),
        ("http://100.100.1.1:8642/v1", false),
    ] {
        assert_eq!(probe_key_allowed(&Url::parse(u).unwrap()), want, "{u}");
    }
}

#[test]
fn probe_status_mapping_is_fixed_and_a_keyless_401_means_reachable() {
    assert_eq!(probe_outcome(200, false), Probe::Up);
    assert_eq!(probe_outcome(204, true), Probe::Up);
    assert_eq!(probe_outcome(404, false), Probe::Missing);
    assert_eq!(probe_outcome(405, true), Probe::Missing);
    // no key was sent: a 401/403 shows the host is up (the key is checked by the first real question)
    assert_eq!(probe_outcome(401, false), Probe::Up);
    assert_eq!(probe_outcome(403, false), Probe::Up);
    assert_eq!(probe_outcome(401, true), Probe::Fail(LlmError::BadKey));
    assert_eq!(probe_outcome(429, false), Probe::Fail(LlmError::RateLimited));
    assert_eq!(probe_outcome(408, false), Probe::Fail(LlmError::Timeout));
    assert_eq!(probe_outcome(500, false), Probe::Fail(LlmError::BadReply));
}

#[tokio::test]
async fn a_redirect_from_the_chat_endpoint_is_never_followed() {
    let m = Mock::start(|r, _| if r.path == "/v1/chat/completions" { Some(Resp::status(302).header("Location", "/v1/responses")) } else { Some(Resp::status(200)) }).await;
    let s = Arc::new(LlmState::for_test(store(&m.url(""), Some(KEY)), Duration::from_secs(5)));
    let (emit, _) = collector();
    let out = s.explain_stream("req-h2", params("q"), emit).await;
    assert_eq!(out.end, End::Failed(LlmError::BadReply));
    assert_eq!(m.count(), 1, "no second request");
}

#[test]
fn the_client_source_never_names_the_responses_api() {
    for (name, src) in [("client.rs", include_str!("client.rs")), ("profiles.rs", include_str!("profiles.rs")), ("sse.rs", include_str!("sse.rs"))] {
        let code: String = src.lines().take_while(|l| !l.contains("#[cfg(test)]")).collect::<Vec<_>>().join("\n");
        assert!(!code.contains("/responses") && !code.contains("previous_response_id"), "{name}");
    }
}
