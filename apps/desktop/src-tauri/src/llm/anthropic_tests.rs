//! M19 Anthropic provider tests against local mock servers ONLY (127.0.0.1). The only key ever used is the fake `sk-ant-TESTKEY`. Facts under test were
//! read from the CURRENT Anthropic docs on 2026-11-11 (platform.claude.com: Messages, streaming, errors, versioning, models overview): `POST /v1/messages`,
//! headers `x-api-key` + `anthropic-version: 2026-10-21`, body `{model, max_tokens, system (top level), messages, stream?}`, response `content[]` blocks
//! + `usage.input_tokens/output_tokens`, SSE events named by `type`, unknown event types must be tolerated.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use url::Url;

use super::client::{ChatEvent, Emit, End, LlmError, LlmState, StreamOutcome, StreamParams, Turn, LLM_CONFIG_SLOT, LLM_KEY_SLOT, SYSTEM_PROMPT};
use super::config;
use super::provider::{effective_base_url, preset, Kind, Profile};
use super::stream_tests::slow;
use crate::rh::testutil::{Mock, Resp};
use crate::secrets::{MemoryStore, SecretStore};

const KEY: &str = "sk-ant-TESTKEY";
const DIGEST: &str = "CHART: symbol=AAPL tf=15m bars=834 last=87.38\nIV: rank=72";
const DEFAULT_MODEL: &str = "claude-haiku-5-5";

fn store(model: Option<&str>) -> Arc<dyn SecretStore> {
    let s: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    config::set_config(&*s, "anthropic", None, Some(KEY), model, None).unwrap();
    s
}
fn hosted(m: &Mock, st: Arc<dyn SecretStore>) -> LlmState {
    LlmState::for_test(st, Duration::from_secs(5)).with_base_override(m.url("/"))
}
fn ok_body(blocks: Value) -> Value {
    json!({"id":"msg_1","type":"message","role":"assistant","model":"claude-haiku-5-5","content":blocks,"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":21,"output_tokens":9}})
}
fn text_body(t: &str) -> Value {
    ok_body(json!([{"type":"text","text":t}]))
}
fn turn(role: &str, text: &str) -> Turn {
    Turn { role: role.into(), text: text.into() }
}
fn sorted_keys(b: &Value) -> Vec<String> {
    let mut k: Vec<String> = b.as_object().unwrap().keys().cloned().collect();
    k.sort();
    k
}

#[test]
fn the_preset_is_a_fixed_https_hosted_anthropic_card_with_a_docs_model() {
    let p = preset("anthropic").expect("anthropic preset");
    assert_eq!((p.kind, p.profile, p.needs_key, p.base_url, p.default_model), (Kind::Http, Profile::Anthropic, true, "https://api.anthropic.com", DEFAULT_MODEL));
    assert_eq!(p.label, "Anthropic");
    assert_eq!(p.key_help_url, "https://console.anthropic.com");
    assert!(!p.url_editable() && !p.is_local_preset());
    assert_eq!(effective_base_url(p, None).unwrap().as_str(), "https://api.anthropic.com/");
}

#[test]
fn key_shape_is_the_sk_ant_prefix_plus_the_generic_rules() {
    let p = preset("anthropic").unwrap();
    for bad in ["", "sk-ant-", "sk-test-KEY", "sk-or-TESTKEY", "has space", "ANTHROPIC", "sk-ant- x"] {
        assert!(!config::valid_key(p, bad), "{bad:?}");
    }
    assert!(config::valid_key(p, KEY));
    assert!(config::valid_key(p, "sk-ant-api03-abcDEF_123-xyz"));
    assert!(!config::valid_key(p, &format!("sk-ant-{}", "k".repeat(300))));
    let s = MemoryStore::new();
    assert_eq!(config::set_config(&s, "anthropic", None, Some("sk-test-KEY"), None, None), Err("bad_request".into()));
    assert!(s.get(LLM_CONFIG_SLOT).unwrap().is_none() && s.get(LLM_KEY_SLOT).unwrap().is_none());
}

#[tokio::test]
async fn review_focus_1_the_request_is_the_native_messages_shape_with_a_top_level_system() {
    let m = Mock::start(|_, _| Some(Resp::json(200, &text_body("It looks like a pullback.")))).await;
    let s = hosted(&m, store(None));
    let r = s.explain("", DIGEST, "What is this?", vec![turn("user", "hi"), turn("assistant", "hello")]).await.unwrap();
    assert_eq!(r, "It looks like a pullback.");
    assert_eq!(m.count(), 1);
    let req = &m.requests()[0];
    assert_eq!((req.method.as_str(), req.path.as_str()), ("POST", "/v1/messages"));
    // headers: the key in x-api-key, the docs' version, JSON; never a Bearer header
    assert_eq!(req.header("x-api-key"), Some(KEY));
    assert_eq!(req.header("anthropic-version"), Some("2026-10-21"));
    assert!(req.header("content-type").unwrap().starts_with("application/json"));
    assert_eq!(req.header("authorization"), None);
    assert_eq!(req.header("anthropic-beta"), None);
    // body: exactly these four fields (non-stream carries no `stream`)
    let b = req.json();
    assert_eq!(sorted_keys(&b), ["max_tokens", "messages", "model", "system"]);
    assert_eq!(b["model"], DEFAULT_MODEL);
    assert_eq!(b["max_tokens"], 1500, "headroom: thinking tokens count toward max_tokens");
    let sys = b["system"].as_str().expect("system is a top-level string");
    assert!(sys.starts_with(SYSTEM_PROMPT) && sys.contains("CHART: symbol=AAPL"));
    let msgs = b["messages"].as_array().unwrap();
    assert_eq!(msgs.len(), 3);
    assert_eq!(msgs[0], json!({"role":"user","content":"hi"}));
    assert_eq!(msgs[1], json!({"role":"assistant","content":"hello"}));
    assert_eq!(msgs[2], json!({"role":"user","content":"What is this?"}));
    assert!(msgs.iter().all(|x| x["role"] != "system"), "no system message inside messages");
    // no OpenAI-style field and none of the optional features v1 leaves out
    for bad in ["temperature", "top_p", "top_k", "stream", "thinking", "tools", "tool_choice", "reasoning", "max_completion_tokens", "stream_options", "response_format", "cache_control"] {
        assert!(b.get(bad).is_none() && !req.body.contains(&format!("\"{bad}\"")), "{bad}");
    }
    assert!(!req.body.contains(KEY), "the key is a header, never in the body");
}

#[tokio::test]
async fn a_configured_model_is_used_and_compat_mode_changes_nothing() {
    let m = Mock::start(|_, _| Some(Resp::json(200, &text_body("ok")))).await;
    let st: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    config::set_config(&*st, "anthropic", None, Some(KEY), Some("claude-sonnet-5-5"), Some(true)).unwrap();
    hosted(&m, st).explain("", DIGEST, "q", vec![]).await.unwrap();
    let b = m.requests()[0].json();
    assert_eq!(b["model"], "claude-sonnet-5-5");
    assert_eq!(sorted_keys(&b), ["max_tokens", "messages", "model", "system"]);
}

#[tokio::test]
async fn the_connectivity_test_sends_no_digest_and_a_tiny_fixed_message() {
    let m = Mock::start(|_, _| Some(Resp::json(200, &text_body("OK")))).await;
    hosted(&m, store(None)).ping().await.unwrap();
    let b = m.requests()[0].json();
    assert_eq!(b["system"], "Connectivity check. Reply with the single word OK.");
    assert_eq!(b["messages"], json!([{"role":"user","content":"ping"}]));
    assert!(!m.requests()[0].body.contains("CHART"));
}

#[tokio::test]
async fn the_reply_is_the_text_blocks_only_thinking_and_unknown_blocks_are_skipped() {
    let blocks = json!([
        {"type":"thinking","thinking":"secret reasoning","signature":"x"},
        {"type":"text","text":"Part one. "},
        {"type":"future_block","text":"NOPE"},
        {"type":"text","text":"Part two."}
    ]);
    let m = Mock::start(move |_, _| Some(Resp::json(200, &ok_body(blocks.clone())))).await;
    let r = hosted(&m, store(None)).explain("", DIGEST, "q", vec![]).await.unwrap();
    assert_eq!(r, "Part one. Part two.");
    // no text at all, or an empty one, is a bad reply (never an empty answer)
    for body in [ok_body(json!([])), ok_body(json!([{"type":"thinking","thinking":"hm"}])), ok_body(json!([{"type":"text","text":"  "}])), json!({"nonsense":true})] {
        let m = Mock::start(move |_, _| Some(Resp::json(200, &body.clone()))).await;
        assert_eq!(hosted(&m, store(None)).explain("", DIGEST, "q", vec![]).await, Err(LlmError::BadReply));
    }
}

#[tokio::test]
async fn http_statuses_and_error_bodies_map_to_the_fixed_codes_and_never_leak_text() {
    let cases = [(400, LlmError::BadRequest), (401, LlmError::BadKey), (402, LlmError::BadKey), (403, LlmError::BadKey), (404, LlmError::BadRequest), (413, LlmError::BadRequest), (429, LlmError::RateLimited), (500, LlmError::BadReply), (504, LlmError::Timeout), (529, LlmError::BadReply)];
    for (status, want) in cases {
        let m = Mock::start(move |_, _| Some(Resp::json(status, &json!({"type":"error","error":{"type":"x","message":"sk-ant-TESTKEY leaked text"},"request_id":"req_1"})))).await;
        let e = hosted(&m, store(None)).explain("", DIGEST, "q", vec![]).await.unwrap_err();
        assert_eq!(e, want, "status {status}");
        assert!(!format!("{e:?} {}", e.code()).contains("sk-ant"));
    }
    // an error object inside a 200 body is mapped by its documented type
    for (ty, want) in [("authentication_error", LlmError::BadKey), ("permission_error", LlmError::BadKey), ("invalid_request_error", LlmError::BadRequest), ("rate_limit_error", LlmError::RateLimited), ("overloaded_error", LlmError::BadReply), ("api_error", LlmError::BadReply)] {
        let m = Mock::start(move |_, _| Some(Resp::json(200, &json!({"type":"error","error":{"type":ty,"message":"m"}})))).await;
        assert_eq!(hosted(&m, store(None)).explain("", DIGEST, "q", vec![]).await, Err(want), "{ty}");
    }
}

#[tokio::test]
async fn redirects_are_never_followed_so_the_key_cannot_travel() {
    let sink = Mock::start(|_, _| Some(Resp::json(200, &text_body("LEAK")))).await;
    let target = sink.url("/v1/messages").to_string();
    let m = Mock::start(move |_, _| Some(Resp::status(307).header("Location", &target))).await;
    let e = hosted(&m, store(None)).explain("", DIGEST, "q", vec![]).await;
    assert!(e.is_err());
    assert_eq!(sink.count(), 0, "the redirect target saw nothing");
}

#[tokio::test]
async fn local_validation_failures_send_nothing() {
    let m = Mock::start(|_, _| Some(Resp::json(200, &text_body("ok")))).await;
    let s = hosted(&m, store(None));
    assert_eq!(s.explain("bad model!", DIGEST, "q", vec![]).await, Err(LlmError::BadRequest));
    assert_eq!(s.explain("", DIGEST, "   ", vec![]).await, Err(LlmError::BadRequest));
    assert_eq!(m.count(), 0);
}

#[test]
fn review_focus_4_a_hostile_base_url_or_provider_swap_cannot_move_the_anthropic_key() {
    let s = MemoryStore::new();
    // an explicit different base URL is refused outright, not ignored
    for u in ["https://evil.example.com", "https://api.anthropic.com.evil.example.com", "http://api.anthropic.com", "https://api.anthropic.com/v1/", "http://127.0.0.1:9999"] {
        assert_eq!(config::set_config(&s, "anthropic", Some(u), Some(KEY), None, None), Err("bad_request".into()), "{u}");
    }
    assert!(s.get(LLM_CONFIG_SLOT).unwrap().is_none() && s.get(LLM_KEY_SLOT).unwrap().is_none());
    // the exact fixed URL (with or without a trailing slash) is accepted
    config::set_config(&s, "anthropic", Some("https://api.anthropic.com/"), Some(KEY), None, None).unwrap();
    let before = (s.get(LLM_CONFIG_SLOT).unwrap(), s.get(LLM_KEY_SLOT).unwrap());
    // re-pointing the saved key through another provider without supplying a key is the swap the seal refuses
    for (prov, url) in [("custom", Some("https://evil.example.com/v1")), ("openai", None), ("openrouter", None), ("venice", None), ("hermes", Some("https://evil.example.com"))] {
        assert_eq!(config::set_config(&s, prov, url, None, None, None), Err("bad_request".into()), "{prov}");
    }
    assert_eq!(before, (s.get(LLM_CONFIG_SLOT).unwrap(), s.get(LLM_KEY_SLOT).unwrap()));
    // a tampered stored config that names another host is ignored: a hosted preset always resolves to the fixed URL
    s.set(LLM_CONFIG_SLOT, r#"{"provider":"anthropic","base_url":"https://evil.example.com"}"#).unwrap();
    assert_eq!(config::status(&s).base_url.as_deref(), Some("https://api.anthropic.com"));
    let p = preset("anthropic").unwrap();
    assert_eq!(effective_base_url(p, Some("https://evil.example.com")).unwrap().host_str(), Some("api.anthropic.com"));
    // the other direction: another provider's key shape is not accepted for Anthropic
    let s2 = MemoryStore::new();
    assert_eq!(config::set_config(&s2, "anthropic", None, Some("sk-or-TESTKEY"), None, None), Err("bad_request".into()));
}

// ---------- streaming ----------

fn ev(name: &str, v: Value) -> String {
    format!("event: {name}\ndata: {v}\n\n")
}
fn start(input: u64) -> String {
    ev("message_start", json!({"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","content":[],"model":"claude-haiku-5-5","stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":input,"output_tokens":1}}}))
}
fn block_start() -> String {
    ev("content_block_start", json!({"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}))
}
fn text(t: &str) -> String {
    ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":t}}))
}
fn block_stop() -> String {
    ev("content_block_stop", json!({"type":"content_block_stop","index":0}))
}
fn msg_delta(out: u64) -> String {
    ev("message_delta", json!({"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":out}}))
}
fn stop() -> String {
    ev("message_stop", json!({"type":"message_stop"}))
}
fn ping() -> String {
    ev("ping", json!({"type":"ping"}))
}

type Log = Arc<Mutex<Vec<ChatEvent>>>;
fn collector() -> (Emit, Log) {
    let log: Log = Arc::new(Mutex::new(vec![]));
    let l2 = log.clone();
    (Arc::new(move |e| l2.lock().unwrap().push(e)), log)
}
fn deltas(log: &Log) -> String {
    log.lock().unwrap().iter().filter_map(|e| if let ChatEvent::Delta { text, .. } = e { Some(text.clone()) } else { None }).collect()
}
fn state(url: Url, first: u64, idle: u64) -> Arc<LlmState> {
    Arc::new(LlmState::for_test(store(None), Duration::from_secs(5)).with_base_override(url).with_idle(Duration::from_millis(first), Duration::from_millis(idle)))
}
fn base(m: &super::stream_tests::Slow) -> Url {
    Url::parse(&format!("http://{}/", m.addr)).unwrap()
}
async fn run(s: &Arc<LlmState>, id: &str) -> (StreamOutcome, Log) {
    let (emit, log) = collector();
    let p = StreamParams { model: String::new(), digest: DIGEST.into(), question: "What is this?".into(), history: vec![], mode: "beginner".into(), lenses: vec![] };
    (s.explain_stream(id, p, emit).await, log)
}

#[tokio::test]
async fn review_focus_2_streaming_sends_stream_true_ignores_unknown_events_and_takes_usage_from_the_final_events() {
    let steps = vec![
        (0, start(25)),
        (0, block_start()),
        (0, ping()),
        (0, ev("future_event", json!({"type":"future_event","payload":{"x":1}}))),
        (0, ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"HIDDEN"}}))),
        (0, ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"abc"}}))),
        (0, text("Hel")),
        (0, "event: mystery\ndata: not json at all\n\n".into()),
        (0, text("lo ")),
        (0, ev("content_block_delta", json!({"type":"content_block_delta","index":0,"delta":{"type":"citations_delta","citation":{}}}))),
        (0, text("there.")),
        (0, block_stop()),
        (0, msg_delta(15)),
        (0, stop()),
    ];
    let m = slow("text/event-stream", steps, false).await;
    let s = state(base(&m), 2000, 2000);
    let (out, log) = run(&s, "req-a1").await;
    assert_eq!(out.end, End::Done);
    assert_eq!(out.text, "Hello there.");
    assert_eq!(deltas(&log), "Hello there.");
    assert!(!out.text.contains("HIDDEN"));
    assert_eq!((out.usage.prompt, out.usage.completion, out.usage.estimated), (25, 15, false));
    assert_eq!((out.provider.as_str(), out.model.as_str()), ("anthropic", DEFAULT_MODEL));
    // one request: native path, native headers, `stream: true`, otherwise the same four fields
    assert_eq!(m.count(), 1);
    let r = m.reqs.lock().unwrap()[0].clone();
    assert_eq!(r.path, "/v1/messages");
    assert_eq!(r.header("x-api-key"), Some(KEY));
    assert_eq!(r.header("anthropic-version"), Some("2026-10-21"));
    assert_eq!(r.header("authorization"), None);
    let b = r.json();
    assert_eq!(sorted_keys(&b), ["max_tokens", "messages", "model", "stream", "system"]);
    assert_eq!(b["stream"], json!(true));
    assert_eq!(b["max_tokens"], 1500);
    assert!(b["system"].as_str().unwrap().starts_with(SYSTEM_PROMPT));
    assert_eq!(b["messages"], json!([{"role":"user","content":"What is this?"}]));
    assert!(b.get("stream_options").is_none() && !r.body.contains(KEY));
}

#[tokio::test]
async fn a_stream_ending_with_message_delta_but_no_message_stop_is_still_done() {
    let m = slow("text/event-stream", vec![(0, start(10)), (0, block_start()), (0, text("Fine.")), (0, block_stop()), (0, msg_delta(4))], false).await;
    let (out, _) = run(&state(base(&m), 2000, 2000), "req-a2").await;
    assert_eq!((out.end, out.text.as_str()), (End::Done, "Fine."));
    assert_eq!((out.usage.prompt, out.usage.completion, out.usage.estimated), (10, 4, false));
}

#[tokio::test]
async fn a_stream_with_no_final_usage_falls_back_to_the_chars_over_four_estimate() {
    let m = slow("text/event-stream", vec![(0, start(10)), (0, block_start()), (0, text("Twelve chars")), (0, block_stop()), (0, stop())], false).await;
    let (out, _) = run(&state(base(&m), 2000, 2000), "req-a3").await;
    assert_eq!(out.end, End::Done);
    assert!(out.usage.estimated && out.usage.completion == 3 && out.usage.prompt > 0, "{:?}", out.usage);
}

#[tokio::test]
async fn idle_timeout_mid_stream_keeps_the_partial_text_and_is_a_timeout() {
    let m = slow("text/event-stream", vec![(0, start(25)), (0, block_start()), (0, text("Partial ")), (0, text("answer"))], true).await;
    let s = state(base(&m), 2000, 150);
    let (out, log) = run(&s, "req-a4").await;
    assert_eq!(out.end, End::Failed(LlmError::Timeout));
    assert_eq!(out.text, "Partial answer");
    assert!(out.usage.estimated);
    let g = log.lock().unwrap();
    assert!(matches!(g.last(), Some(ChatEvent::Error { code, partial, .. }) if code == "timeout" && partial == "Partial answer"));
}

#[tokio::test]
async fn silence_before_the_first_byte_is_a_timeout_with_nothing_kept() {
    let m = slow("text/event-stream", vec![], true).await;
    let (out, _) = run(&state(base(&m), 200, 200), "req-a5").await;
    assert_eq!((out.end, out.text.as_str()), (End::Failed(LlmError::Timeout), ""));
}

#[tokio::test]
async fn an_error_event_inside_the_stream_is_mapped_by_type_and_the_partial_kept() {
    for (ty, want) in [("overloaded_error", LlmError::BadReply), ("authentication_error", LlmError::BadKey), ("rate_limit_error", LlmError::RateLimited), ("invalid_request_error", LlmError::BadRequest), ("api_error", LlmError::BadReply)] {
        let steps = vec![(0, start(5)), (0, block_start()), (0, text("So far")), (0, ev("error", json!({"type":"error","error":{"type":ty,"message":"sk-ant-TESTKEY should never surface"}})))];
        let m = slow("text/event-stream", steps, false).await;
        let (out, log) = run(&state(base(&m), 2000, 2000), "req-a6").await;
        assert_eq!(out.end, End::Failed(want), "{ty}");
        assert_eq!(out.text, "So far");
        let dump = format!("{:?}", log.lock().unwrap());
        assert!(!dump.contains("should never surface") && !dump.contains("sk-ant"), "{dump}");
    }
}

#[tokio::test]
async fn an_empty_or_unfinished_stream_is_a_bad_reply() {
    let m = slow("text/event-stream", vec![(0, start(5)), (0, block_start()), (0, block_stop()), (0, msg_delta(1)), (0, stop())], false).await;
    let (out, _) = run(&state(base(&m), 2000, 2000), "req-a7").await;
    assert_eq!(out.end, End::Failed(LlmError::BadReply));
    let m = slow("text/event-stream", vec![(0, start(5)), (0, block_start()), (0, text("cut off"))], false).await;
    let (out, _) = run(&state(base(&m), 2000, 2000), "req-a8").await;
    assert_eq!((out.end, out.text.as_str()), (End::Failed(LlmError::BadReply), "cut off"));
}

#[tokio::test]
async fn http_errors_before_the_stream_send_no_delta_and_a_json_answer_becomes_one_final_delta() {
    let m = Mock::start(|_, _| Some(Resp::json(401, &json!({"type":"error","error":{"type":"authentication_error","message":"x"}})))).await;
    let s = Arc::new(LlmState::for_test(store(None), Duration::from_secs(5)).with_base_override(m.url("/")));
    let (emit, log) = collector();
    let p = StreamParams { model: String::new(), digest: DIGEST.into(), question: "q".into(), history: vec![], mode: "beginner".into(), lenses: vec![] };
    let out = s.explain_stream("req-a9", p, emit).await;
    assert_eq!(out.end, End::Failed(LlmError::BadKey));
    assert_eq!(deltas(&log), "");
    // a server that ignores `stream` and answers with one JSON body
    let m = Mock::start(|_, _| Some(Resp::json(200, &text_body("All at once.")))).await;
    let s = Arc::new(LlmState::for_test(store(None), Duration::from_secs(5)).with_base_override(m.url("/")));
    let (emit, log) = collector();
    let p = StreamParams { model: String::new(), digest: DIGEST.into(), question: "q".into(), history: vec![], mode: "beginner".into(), lenses: vec![] };
    let out = s.explain_stream("req-a10", p, emit).await;
    assert_eq!((out.end, out.text.as_str()), (End::Done, "All at once."));
    assert_eq!((out.usage.prompt, out.usage.completion, out.usage.estimated), (21, 9, false));
    assert_eq!(deltas(&log), "All at once.");
}

/// EXPLAIN ONLY: the provider module and its tests never reach order tooling.
#[test]
fn the_anthropic_files_never_touch_order_tooling_or_claude_credentials() {
    for (name, src) in [("anthropic.rs", include_str!("anthropic.rs")), ("anthropic_tests.rs", include_str!("anthropic_tests.rs"))] {
        for bad in ["rh::orders", "rh::writes", "rh::reviews", "rh::watch_writes", "McpClient", "place_", "review_", "cancel_", "decline_", "ticket", "rh_commands", "TmState"] {
            // this test file names the fragments it forbids, so only the implementation file is held to the literal check
            if name == "anthropic.rs" {
                assert!(!src.contains(bad), "{name} mentions {bad}");
            }
        }
        for bad in [".credentials", "CLAUDE_CODE_OAUTH_TOKEN", "setup-token", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "oauth", "Bearer"] {
            if name == "anthropic.rs" {
                assert!(!src.contains(bad), "{name} mentions {bad}");
            }
        }
    }
}
