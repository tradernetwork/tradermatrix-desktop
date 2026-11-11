//! Streaming tests (M16 B1) against a hand-rolled slow SSE server on 127.0.0.1 ONLY. The only keys are the fake `sk-test-KEY` / `sk-or-TESTKEY`.
use std::net::SocketAddr;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

use super::client::{ChatEvent, Emit, End, LlmError, LlmState, StreamOutcome, StreamParams, Turn, MAX_REPLY_CHARS};
use super::config;
use crate::rh::testutil::{Mock, Req, Resp};
use crate::secrets::{MemoryStore, SecretStore};

const OR_KEY: &str = "sk-or-TESTKEY";
const MODEL: &str = "deepseek/deepseek-v4-flash";
const DIGEST: &str = "CHART: symbol=AAPL tf=15m bars=834 last=87.38\nIV: rank=72";

fn store(provider: &str, key: Option<&str>) -> Arc<dyn SecretStore> {
    let s: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    config::set_config(&*s, provider, None, key, (provider != "claude_cli").then_some(MODEL), None).unwrap();
    s
}

fn data(v: serde_json::Value) -> String {
    format!("data: {v}\n\n")
}
fn delta(t: &str) -> String {
    data(json!({"choices":[{"index":0,"delta":{"content":t}}]}))
}
fn finish(usage: bool) -> String {
    let mut v = json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    if usage {
        v["usage"] = json!({"prompt_tokens":111,"completion_tokens":22});
    }
    data(v)
}
const DONE: &str = "data: [DONE]\n\n";

/// One scripted streaming response: `(delay before the write in ms, bytes)`; `hold` keeps the connection open and silent at the end.
struct Slow {
    addr: SocketAddr,
    reqs: Arc<Mutex<Vec<Req>>>,
    write_failed: Arc<AtomicBool>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for Slow {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Slow {
    fn url(&self) -> Url {
        Url::parse(&format!("http://{}/api/v1", self.addr)).unwrap()
    }
    fn count(&self) -> usize {
        self.reqs.lock().unwrap().len()
    }
}

async fn slow(content_type: &'static str, steps: Vec<(u64, String)>, hold: bool) -> Slow {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let reqs: Arc<Mutex<Vec<Req>>> = Arc::new(Mutex::new(vec![]));
    let write_failed = Arc::new(AtomicBool::new(false));
    let (r2, wf) = (reqs.clone(), write_failed.clone());
    let task = tokio::spawn(async move {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else { return };
            let (reqs, wf, steps) = (r2.clone(), wf.clone(), steps.clone());
            tokio::spawn(async move {
                let mut buf = Vec::new();
                let mut tmp = [0u8; 4096];
                let head_end = loop {
                    if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                        break i;
                    }
                    match sock.read(&mut tmp).await {
                        Ok(0) | Err(_) => return,
                        Ok(n) => buf.extend_from_slice(&tmp[..n]),
                    }
                };
                let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                let mut lines = head.split("\r\n");
                let first = lines.next().unwrap_or("").to_string();
                let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
                let len: usize = headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
                let mut body = buf[head_end + 4..].to_vec();
                while body.len() < len {
                    match sock.read(&mut tmp).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => body.extend_from_slice(&tmp[..n]),
                    }
                }
                let mut parts = first.split(' ');
                let (method, path) = (parts.next().unwrap_or("").to_string(), parts.next().unwrap_or("").to_string());
                reqs.lock().unwrap().push(Req { method, path, headers, body: String::from_utf8_lossy(&body).to_string() });
                let head = format!("HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nConnection: close\r\n\r\n");
                if sock.write_all(head.as_bytes()).await.is_err() {
                    wf.store(true, Ordering::SeqCst);
                    return;
                }
                for (ms, bytes) in steps {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    if sock.write_all(bytes.as_bytes()).await.is_err() || sock.flush().await.is_err() {
                        wf.store(true, Ordering::SeqCst);
                        return;
                    }
                }
                if hold {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                }
                let _ = sock.shutdown().await;
            });
        }
    });
    Slow { addr, reqs, write_failed, task }
}

fn state(url: Url, st: Arc<dyn SecretStore>, first: u64, idle: u64) -> Arc<LlmState> {
    Arc::new(LlmState::for_test(st, Duration::from_secs(5)).with_base_override(url).with_idle(Duration::from_millis(first), Duration::from_millis(idle)))
}

type Log = Arc<Mutex<Vec<ChatEvent>>>;
fn collector() -> (Emit, Log) {
    let log: Log = Arc::new(Mutex::new(vec![]));
    let l2 = log.clone();
    let emit: Emit = Arc::new(move |e| l2.lock().unwrap().push(e));
    (emit, log)
}
fn params(q: &str) -> StreamParams {
    StreamParams { model: MODEL.into(), digest: DIGEST.into(), question: q.into(), history: vec![], mode: "beginner".into() }
}
fn deltas(log: &Log) -> Vec<String> {
    log.lock().unwrap().iter().filter_map(|e| if let ChatEvent::Delta { text, .. } = e { Some(text.clone()) } else { None }).collect()
}
fn kinds(log: &Log) -> Vec<&'static str> {
    log.lock().unwrap().iter().map(|e| match e { ChatEvent::Delta { .. } => "delta", ChatEvent::Done { .. } => "done", ChatEvent::Error { .. } => "error" }).collect()
}

async fn run(s: &Arc<LlmState>, id: &str, q: &str) -> (StreamOutcome, Log) {
    let (emit, log) = collector();
    let out = s.explain_stream(id, params(q), emit).await;
    (out, log)
}

#[tokio::test]
async fn sse_chunks_accumulate_into_the_reply_and_usage_comes_from_the_provider() {
    let m = slow("text/event-stream", vec![(0, ": OPENROUTER PROCESSING\n\n".into()), (0, delta("Hel")), (0, delta("lo ")), (0, delta("there.")), (0, finish(true)), (0, DONE.into())], false).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let (out, log) = run(&s, "req-1", "What is this?").await;
    assert_eq!(out.end, End::Done);
    assert_eq!(out.text, "Hello there.");
    assert_eq!((out.usage.prompt, out.usage.completion, out.usage.estimated), (111, 22, false));
    assert_eq!(out.model, MODEL);
    assert_eq!(deltas(&log).concat(), "Hello there.");
    assert_eq!(kinds(&log).last(), Some(&"done"));
    assert_eq!(kinds(&log).iter().filter(|k| **k == "done").count(), 1);
    // exactly one request, a streaming one, with the key only in the header
    assert_eq!(m.count(), 1);
    let r = m.reqs.lock().unwrap()[0].clone();
    assert_eq!(r.path, "/api/v1/chat/completions");
    assert_eq!(r.header("authorization"), Some("Bearer sk-or-TESTKEY"));
    let b = r.json();
    assert_eq!(b["stream"], json!(true));
    assert_eq!(b["reasoning"], json!({"enabled": false}));
    assert!(!r.body.contains("sk-or-TESTKEY"));
}

#[tokio::test]
async fn stream_bodies_per_profile_only_flip_stream_and_ask_for_usage_where_documented() {
    for (provider, want_opts) in [("openai", true), ("ollama", false)] {
        let m = slow("text/event-stream", vec![(0, delta("ok")), (0, finish(false)), (0, DONE.into())], false).await;
        let st: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        if provider == "openai" {
            config::set_config(&*st, "openai", None, Some("sk-test-KEY"), Some("gpt-4.1-mini"), None).unwrap();
        } else {
            config::set_config(&*st, "ollama", Some(m.url().as_ref()), None, Some("llama3.2"), None).unwrap();
        }
        let s = state(m.url(), st, 2000, 2000);
        let (out, _) = run(&s, "req-p", "q").await;
        assert_eq!(out.end, End::Done, "{provider}");
        let b = m.reqs.lock().unwrap()[0].json();
        assert_eq!(b["stream"], json!(true), "{provider}");
        assert_eq!(b.get("stream_options").is_some(), want_opts, "{provider}: {b}");
        if want_opts {
            assert_eq!(b["stream_options"], json!({"include_usage": true}));
        }
        if provider == "ollama" {
            let mut k: Vec<&String> = b.as_object().unwrap().keys().collect();
            k.sort();
            assert_eq!(k, ["max_tokens", "messages", "model", "stream"]);
        }
    }
}

#[tokio::test]
async fn a_provider_without_usage_falls_back_to_chars_over_four_flagged_estimated() {
    let m = slow("text/event-stream", vec![(0, delta("abcdefghij")), (0, finish(false)), (0, DONE.into())], false).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let mut p = params("0123456789");
    p.history = vec![Turn { role: "user".into(), text: "abcd".into() }, Turn { role: "assistant".into(), text: "efgh".into() }];
    let (emit, _log) = collector();
    let out = s.explain_stream("req-2", p, emit).await;
    assert_eq!(out.end, End::Done);
    assert!(out.usage.estimated);
    assert_eq!(out.usage.completion, 3); // ceil(10 / 4)
    let sys = super::client::build_system(DIGEST, super::client::Mode::Beginner);
    let chars = sys.chars().count() + 4 + 4 + 10;
    assert_eq!(out.usage.prompt, chars.div_ceil(4) as u64);
}

#[tokio::test]
async fn an_idle_gap_longer_than_the_watchdog_is_a_timeout_and_the_partial_is_kept() {
    let m = slow("text/event-stream", vec![(0, delta("Hel"))], true).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 200);
    let t = std::time::Instant::now();
    let (out, log) = run(&s, "req-3", "q").await;
    assert!(t.elapsed() < Duration::from_secs(3));
    assert_eq!(out.end, End::Failed(LlmError::Timeout));
    assert_eq!(out.text, "Hel");
    assert!(out.usage.estimated);
    let ev = log.lock().unwrap().clone();
    assert!(matches!(ev.last(), Some(ChatEvent::Error { code, partial, .. }) if code == "timeout" && partial == "Hel"));
    assert_eq!(m.count(), 1, "no automatic retry");
}

#[tokio::test]
async fn silence_before_the_first_byte_is_a_timeout_with_nothing_kept() {
    let m = slow("text/event-stream", vec![], true).await;
    // headers arrive, then nothing: the first-chunk deadline applies
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 200, 5000);
    let (out, _) = run(&s, "req-3b", "q").await;
    assert_eq!(out.end, End::Failed(LlmError::Timeout));
    assert_eq!(out.text, "");
}

#[tokio::test]
async fn a_disconnect_mid_stream_keeps_the_partial_and_is_not_retried() {
    let m = slow("text/event-stream", vec![(0, delta("Par")), (0, delta("tial"))], false).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let (out, log) = run(&s, "req-4", "q").await;
    assert_eq!(out.end, End::Failed(LlmError::BadReply));
    assert_eq!(out.text, "Partial");
    assert!(matches!(log.lock().unwrap().last(), Some(ChatEvent::Error { code, partial, .. }) if code == "bad_reply" && partial == "Partial"));
    assert_eq!(m.count(), 1);
}

#[tokio::test]
async fn stop_closes_the_connection_and_nothing_is_emitted_afterwards() {
    let steps: Vec<(u64, String)> = std::iter::once((0, delta("Hel"))).chain((0..8).map(|_| (150, delta("more")))).collect();
    let m = slow("text/event-stream", steps, false).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let (emit, log) = collector();
    let s2 = s.clone();
    let task = tokio::spawn(async move { s2.explain_stream("req-5", params("q"), emit).await });
    // wait for the first delta
    for _ in 0..100 {
        if !deltas(&log).is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(deltas(&log), vec!["Hel".to_string()]);
    s.stop_request("req-5");
    let out = task.await.unwrap();
    assert_eq!(out.end, End::Cancelled);
    assert_eq!(out.text, "Hel");
    let n = log.lock().unwrap().len();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert_eq!(log.lock().unwrap().len(), n, "no event after stop");
    assert!(!kinds(&log).contains(&"done") && !kinds(&log).contains(&"error"));
    assert!(m.write_failed.load(Ordering::SeqCst), "the connection was closed, the server could no longer write");
    // the slot is free again
    let m2 = slow("text/event-stream", vec![(0, delta("ok")), (0, finish(false)), (0, DONE.into())], false).await;
    let s3 = state(m2.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    assert_eq!(run(&s3, "req-6", "q").await.0.end, End::Done);
}

#[tokio::test]
async fn stop_before_any_byte_arrives_still_stops() {
    let m = slow("text/event-stream", vec![], true).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 5000, 5000);
    let (emit, log) = collector();
    let s2 = s.clone();
    let task = tokio::spawn(async move { s2.explain_stream("req-7", params("q"), emit).await });
    for _ in 0..100 {
        if m.count() > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    s.stop_request("req-7");
    let out = tokio::time::timeout(Duration::from_secs(2), task).await.expect("stop is prompt").unwrap();
    assert_eq!(out.end, End::Cancelled);
    assert_eq!(out.text, "");
    assert!(log.lock().unwrap().is_empty());
}

#[tokio::test]
async fn only_one_request_is_in_flight_and_stopping_an_unknown_id_does_nothing() {
    let m = slow("text/event-stream", vec![(0, delta("a"))], true).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 5000, 5000);
    let (emit, _l) = collector();
    let s2 = s.clone();
    let first = tokio::spawn(async move { s2.explain_stream("req-8", params("q"), emit).await });
    for _ in 0..100 {
        if m.count() > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let (second, l2) = run(&s, "req-9", "again").await;
    assert_eq!(second.end, End::Failed(LlmError::RateLimited));
    assert_eq!(m.count(), 1, "the second ask sent nothing");
    assert!(deltas(&l2).is_empty());
    s.stop_request("not-the-one"); // unknown id: no effect
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(!first.is_finished());
    s.stop_request("req-8");
    assert_eq!(first.await.unwrap().end, End::Cancelled);
}

#[tokio::test]
async fn an_error_event_inside_the_stream_is_mapped_and_the_partial_kept() {
    let m = slow("text/event-stream", vec![(0, delta("So far")), (0, data(json!({"error":{"code":429,"message":"sk-or-TESTKEY leaked?"},"choices":[{"finish_reason":"error"}]})))], false).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let (out, log) = run(&s, "req-10", "q").await;
    assert_eq!(out.end, End::Failed(LlmError::RateLimited));
    assert_eq!(out.text, "So far");
    assert!(!format!("{:?}", log.lock().unwrap()).contains("TESTKEY"));
}

#[tokio::test]
async fn a_provider_that_cannot_stream_answers_once_and_that_becomes_one_final_delta() {
    let body = json!({"choices":[{"message":{"role":"assistant","content":"Whole answer."}}],"usage":{"prompt_tokens":9,"completion_tokens":3}}).to_string();
    let m = slow("application/json", vec![(0, body)], false).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let (out, log) = run(&s, "req-11", "q").await;
    assert_eq!(out.end, End::Done);
    assert_eq!(out.text, "Whole answer.");
    assert_eq!((out.usage.prompt, out.usage.completion, out.usage.estimated), (9, 3, false));
    assert_eq!(deltas(&log), vec!["Whole answer.".to_string()]);
}

#[tokio::test]
async fn http_errors_before_the_stream_map_to_fixed_codes_and_send_no_delta() {
    for (status, want) in [(401u16, LlmError::BadKey), (429, LlmError::RateLimited), (400, LlmError::BadRequest), (500, LlmError::BadReply)] {
        let m = Mock::start(move |_, _| Some(Resp::text(status, "provider said sk-or-TESTKEY is bad"))).await;
        let s = Arc::new(LlmState::for_test(store("openrouter", Some(OR_KEY)), Duration::from_secs(5)).with_base_override(m.url("/api/v1")));
        let (out, log) = run(&s, "req-12", "q").await;
        assert_eq!(out.end, End::Failed(want), "{status}");
        assert!(deltas(&log).is_empty());
        assert!(!format!("{:?}", log.lock().unwrap()).contains("sk-or"));
        assert_eq!(m.count(), 1, "no automatic retry on {status}");
    }
}

#[tokio::test]
async fn redirects_are_never_followed_while_streaming() {
    let target = Mock::start(|_, _| Some(Resp::sse(&format!("{}{}", delta("evil"), DONE)))).await;
    let t = target.url("/steal").to_string();
    let m = Mock::start(move |_, _| Some(Resp::status(307).header("Location", &t))).await;
    let s = Arc::new(LlmState::for_test(store("openrouter", Some(OR_KEY)), Duration::from_secs(5)).with_base_override(m.url("/api/v1")));
    let (out, _) = run(&s, "req-13", "q").await;
    assert!(matches!(out.end, End::Failed(_)));
    assert_eq!(target.count(), 0);
}

#[tokio::test]
async fn the_reply_is_capped_and_an_endless_stream_is_stopped() {
    let big = "x".repeat(MAX_REPLY_CHARS + 500);
    let m = slow("text/event-stream", vec![(0, delta(&big)), (0, finish(false)), (0, DONE.into())], false).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let (out, log) = run(&s, "req-14", "q").await;
    assert_eq!(out.end, End::Done);
    assert_eq!(out.text.chars().count(), MAX_REPLY_CHARS);
    assert_eq!(deltas(&log).concat().chars().count(), MAX_REPLY_CHARS);
    // a stream bigger than the 1 MB body cap is refused outright
    let chunk = delta(&"y".repeat(60_000));
    let steps: Vec<(u64, String)> = (0..20).map(|_| (0, chunk.clone())).collect();
    let m2 = slow("text/event-stream", steps, false).await;
    let s2 = state(m2.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let (out2, _) = run(&s2, "req-15", "q").await;
    assert!(matches!(out2.end, End::Done | End::Failed(LlmError::BadReply)));
    assert!(out2.text.chars().count() <= MAX_REPLY_CHARS);
}

#[tokio::test]
async fn an_empty_stream_is_a_bad_reply() {
    let m = slow("text/event-stream", vec![(0, finish(false)), (0, DONE.into())], false).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let (out, _) = run(&s, "req-16", "q").await;
    assert_eq!(out.end, End::Failed(LlmError::BadReply));
}

#[tokio::test]
async fn local_validation_failures_send_nothing() {
    let m = slow("text/event-stream", vec![(0, delta("x")), (0, DONE.into())], false).await;
    let s = state(m.url(), store("openrouter", Some(OR_KEY)), 2000, 2000);
    let (emit, _) = collector();
    let mut p = params("q");
    p.mode = "wizard".into();
    assert_eq!(s.explain_stream("req-17", p, emit.clone()).await.end, End::Failed(LlmError::BadRequest));
    for bad in ["", "has space", "a/b", &"x".repeat(65)] {
        assert_eq!(s.explain_stream(bad, params("q"), emit.clone()).await.end, End::Failed(LlmError::BadRequest), "{bad:?}");
    }
    let mut p = params("q");
    p.digest = "d".repeat(6001);
    assert_eq!(s.explain_stream("req-18", p, emit.clone()).await.end, End::Failed(LlmError::BadRequest));
    let mut p = params(" ");
    p.history = vec![];
    assert_eq!(s.explain_stream("req-19", p, emit.clone()).await.end, End::Failed(LlmError::BadRequest));
    let unconfigured = Arc::new(LlmState::for_test(Arc::new(MemoryStore::new()), Duration::from_secs(5)).with_base_override(m.url()));
    assert_eq!(unconfigured.explain_stream("req-20", params("q"), emit).await.end, End::Failed(LlmError::NoKey));
    assert_eq!(m.count(), 0);
}

#[tokio::test]
async fn the_local_cli_cannot_stream_so_it_answers_once_with_an_estimated_usage() {
    static N: AtomicUsize = AtomicUsize::new(0);
    let d = std::env::temp_dir().join(format!("rebull-streamcli-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&d).unwrap();
    let f = d.join("claude");
    std::fs::write(&f, "#!/bin/sh\ncat >/dev/null\necho 'CLI answer here'\n").unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
    let st: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    config::set_config(&*st, "claude_cli", None, None, None, None).unwrap();
    let s = Arc::new(LlmState::for_test(st, Duration::from_secs(5)).with_cli(&d.to_string_lossy(), Duration::from_secs(10)));
    let (out, log) = run(&s, "req-21", "q").await;
    assert_eq!(out.end, End::Done);
    assert_eq!(out.text, "CLI answer here");
    assert_eq!(deltas(&log), vec!["CLI answer here".to_string()]);
    assert!(out.usage.estimated);
    assert_eq!(out.provider, "claude_cli");
    let _ = std::fs::remove_dir_all(&d);
}
