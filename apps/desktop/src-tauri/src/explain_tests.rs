//! M16 B2 (cost meter + budgets) and B3 (per-symbol threads) tests: the in-memory SQLite database, the local mock server and fake keys ONLY.
use std::os::unix::fs::PermissionsExt;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use sqlx::{Column, Row, SqlitePool};

use crate::db;
use crate::error::AppError;
use crate::explain_run::{self, summary};
use crate::explain_threads::{self as th, NewMessage};
use crate::explain_usage::{self as eu, cost_usd, price_for};
use crate::llm::client::{ChatEvent, Emit, LlmError, LlmState, StreamParams};
use crate::llm::config;
use crate::rh::testutil::{Mock, Resp};
use crate::secrets::{MemoryStore, SecretStore};

const KEY: &str = "sk-test-KEY";
const OR_KEY: &str = "sk-or-TESTKEY";
const MODEL: &str = "deepseek/deepseek-v4-flash";
const DIGEST_LINE: &str = "CHART: symbol=ZZZ tf=15m bars=834 last=87.38 unique-digest-line-9f3a";
const DIGEST: &str = "CHART: symbol=ZZZ tf=15m bars=834 last=87.38 unique-digest-line-9f3a\nIV: rank=72";
const DAY: &str = "2026-11-12";

fn sse(text: &str, usage: Option<(u64, u64)>) -> String {
    let mut s = format!("data: {}\n\n", json!({"choices":[{"index":0,"delta":{"content":text}}]}));
    let mut fin = json!({"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
    if let Some((p, c)) = usage {
        fin["usage"] = json!({"prompt_tokens":p,"completion_tokens":c});
    }
    s.push_str(&format!("data: {fin}\n\ndata: [DONE]\n\n"));
    s
}

fn store(provider: &str, key: Option<&str>, model: Option<&str>) -> Arc<dyn SecretStore> {
    let s: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    config::set_config(&*s, provider, None, key, model, None).unwrap();
    s
}
async fn mock(usage: Option<(u64, u64)>) -> Mock {
    Mock::start(move |_, _| Some(Resp::sse(&sse("The price sits near the middle of its range.", usage)))).await
}
fn llm(m: &Mock, st: Arc<dyn SecretStore>) -> LlmState {
    LlmState::for_test(st, Duration::from_secs(5)).with_base_override(m.url("/api/v1"))
}
fn params(q: &str) -> StreamParams {
    StreamParams { model: String::new(), digest: DIGEST.into(), question: q.into(), history: vec![], mode: "beginner".into() }
}
fn quiet() -> (Emit, Arc<Mutex<Vec<ChatEvent>>>) {
    let log: Arc<Mutex<Vec<ChatEvent>>> = Arc::new(Mutex::new(vec![]));
    let l2 = log.clone();
    (Arc::new(move |e| l2.lock().unwrap().push(e)), log)
}
async fn ask(s: &LlmState, pool: &SqlitePool, day: &str, id: &str) -> Result<explain_run::AskOut, LlmError> {
    let (emit, _) = quiet();
    explain_run::run(s, pool, day, id, params("What is this?"), emit).await
}

/// Every cell of every row of the given tables, as text (to scan for secrets).
async fn dump(pool: &SqlitePool, tables: &[&str]) -> String {
    let mut out = String::new();
    for t in tables {
        let rows = sqlx::query(&format!("SELECT * FROM {t}")).fetch_all(pool).await.unwrap();
        for r in rows {
            for (i, c) in r.columns().iter().enumerate() {
                let v = r
                    .try_get::<Option<String>, _>(i)
                    .map(|v| v.unwrap_or_default())
                    .or_else(|_| r.try_get::<Option<i64>, _>(i).map(|v| v.map(|x| x.to_string()).unwrap_or_default()))
                    .or_else(|_| r.try_get::<Option<f64>, _>(i).map(|v| v.map(|x| x.to_string()).unwrap_or_default()))
                    .or_else(|_| r.try_get::<Option<Vec<u8>>, _>(i).map(|v| String::from_utf8_lossy(&v.unwrap_or_default()).to_string()))
                    .unwrap_or_default();
                out.push_str(&format!("{t}.{}={v}\n", c.name()));
            }
        }
    }
    out
}
const ALL: [&str; 3] = ["explain_usage", "explain_threads", "explain_messages"];

fn msg(role: &str, text: &str) -> NewMessage {
    NewMessage { role: role.into(), text: text.into(), prompt_tok: None, completion_tok: None, model: None, digest_hash: None, had_positions: false, prompt_version: None, flagged_json: None }
}

// ---------------------------------------------------------------- B2: cost meter + budgets

#[test]
fn price_math_matches_the_plan_example_and_unknown_is_never_zero() {
    let p = price_for("openrouter", MODEL).unwrap();
    assert_eq!((p.in_per_m, p.out_per_m), (0.09, 0.18));
    assert!((cost_usd(&p, 0, 700) - 0.000126).abs() < 1e-12, "$0.18/M out x 700 tokens");
    assert!((cost_usd(&p, 1_000_000, 0) - 0.09).abs() < 1e-12);
    assert!(price_for("openrouter", "deepseek/deepseek-v4.1-flash").is_some());
    // unknown model or provider: no price (None), never a zero price
    assert!(price_for("openrouter", "some/unknown-model").is_none());
    assert!(price_for("openai", "gpt-4.1-mini").is_none());
    assert!(price_for("venice", "llama-3.3-70b").is_none());
    assert!(price_for("claude_cli", "").is_none());
    assert!(price_for("custom", "x").is_none());
    assert!(price_for("hermes", "tm-explain").is_none(), "a self-hosted agent is never priced");
    // a model on this computer genuinely costs nothing per token
    let local = price_for("ollama", "llama3.2").unwrap();
    assert_eq!(cost_usd(&local, 5000, 700), 0.0);
}

#[tokio::test]
async fn budgets_default_when_missing_garbled_or_out_of_range() {
    let p = db::open_memory().await.unwrap();
    let b = eu::budgets(&p).await;
    assert_eq!((b.session_tokens, b.month_usd), (60_000, 2.00));
    db::setting_set(&p, "chat.budget.session_tokens", "25000").await.unwrap();
    db::setting_set(&p, "chat.budget.month_usd", "0.5").await.unwrap();
    let b = eu::budgets(&p).await;
    assert_eq!((b.session_tokens, b.month_usd), (25_000, 0.5));
    for bad in ["", "abc", "-5", "0", "1e99", "\"60000\"", "null", "99999999999"] {
        db::setting_set(&p, "chat.budget.session_tokens", bad).await.unwrap();
        db::setting_set(&p, "chat.budget.month_usd", bad).await.unwrap();
        let b = eu::budgets(&p).await;
        assert_eq!((b.session_tokens, b.month_usd), (60_000, 2.00), "{bad:?}");
    }
}

#[tokio::test]
async fn provider_usage_is_recorded_and_the_cost_is_priced_from_the_model_table() {
    let p = db::open_memory().await.unwrap();
    let m = mock(Some((1000, 700))).await;
    let s = llm(&m, store("openrouter", Some(OR_KEY), Some(MODEL)));
    let out = ask(&s, &p, DAY, "r1").await.unwrap();
    assert_eq!((out.usage.prompt, out.usage.completion, out.usage.estimated), (1000, 700, false));
    assert_eq!(out.model, MODEL);
    let want = 1000.0 * 0.09 / 1e6 + 700.0 * 0.18 / 1e6;
    assert!((out.cost_usd.unwrap() - want).abs() < 1e-12);
    assert_eq!(out.digest_hash.len(), 64);
    assert!(out.digest_hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    let u = eu::month(&p, "2026-11").await.unwrap();
    assert_eq!((u.tokens, u.est_tokens, u.unpriced_tokens), (1700, 0, 0));
    assert!((u.usd - want).abs() < 1e-12);
    // a second call the same day adds to the same (day, model) row
    ask(&s, &p, DAY, "r2").await.unwrap();
    let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM explain_usage").fetch_one(&p).await.unwrap();
    assert_eq!(rows, 1);
    assert_eq!(eu::month(&p, "2026-11").await.unwrap().tokens, 3400);
}

#[tokio::test]
async fn a_provider_that_reports_no_usage_gets_the_chars_over_four_estimate_flagged() {
    let p = db::open_memory().await.unwrap();
    let m = mock(None).await;
    let s = llm(&m, store("openrouter", Some(OR_KEY), Some(MODEL)));
    let out = ask(&s, &p, DAY, "r1").await.unwrap();
    assert!(out.usage.estimated && out.usage.prompt > 0 && out.usage.completion > 0);
    let u = eu::month(&p, "2026-11").await.unwrap();
    assert_eq!(u.est_tokens, u.tokens, "all tokens of this call were estimated");
    let sm = summary(&s, &p, DAY, "openrouter", MODEL, false).await;
    assert!(sm.session_estimated && sm.month_estimated);
}

#[tokio::test]
async fn an_unknown_model_price_is_unknown_never_zero_dollars() {
    let p = db::open_memory().await.unwrap();
    let m = mock(Some((500, 100))).await;
    let s = llm(&m, store("openrouter", Some(OR_KEY), Some("some/unknown-model")));
    let out = ask(&s, &p, DAY, "r1").await.unwrap();
    assert_eq!(out.cost_usd, None);
    let sm = summary(&s, &p, DAY, "openrouter", "some/unknown-model", false).await;
    assert!(!sm.price_known);
    assert!(sm.month_unpriced, "tokens were used that no price covers");
    assert_eq!(sm.month_tokens, 600);
    let known = summary(&s, &p, DAY, "openrouter", MODEL, false).await;
    assert!(known.price_known);
}

#[tokio::test]
async fn the_session_token_cap_blocks_with_the_budget_code_and_sends_nothing() {
    let p = db::open_memory().await.unwrap();
    db::setting_set(&p, "chat.budget.session_tokens", "1000").await.unwrap();
    let m = mock(Some((600, 500))).await;
    let s = llm(&m, store("openrouter", Some(OR_KEY), Some(MODEL)));
    ask(&s, &p, DAY, "r1").await.unwrap();
    assert_eq!(s.session_snapshot(), (1100, false));
    assert_eq!(ask(&s, &p, DAY, "r2").await.unwrap_err(), LlmError::Budget);
    assert_eq!(m.count(), 1, "the blocked call never reached the provider");
    // the cap is checked before sending: exactly at the cap is blocked too
    let sm = summary(&s, &p, DAY, "openrouter", MODEL, false).await;
    assert_eq!((sm.session_tokens, sm.session_cap), (1100, 1000));
    // a session wipe resets the count and the next call goes through
    let sm = summary(&s, &p, DAY, "openrouter", MODEL, true).await;
    assert_eq!(sm.session_tokens, 0);
    ask(&s, &p, DAY, "r3").await.unwrap();
    assert_eq!(m.count(), 2);
}

#[tokio::test]
async fn the_month_dollar_cap_blocks_and_a_new_month_starts_clean() {
    let p = db::open_memory().await.unwrap();
    db::setting_set(&p, "chat.budget.month_usd", "0.0002").await.unwrap();
    let m = mock(Some((1000, 700))).await; // ~$0.000216 per call
    let s = llm(&m, store("openrouter", Some(OR_KEY), Some(MODEL)));
    ask(&s, &p, "2026-10-31", "r1").await.unwrap();
    assert_eq!(ask(&s, &p, "2026-10-31", "r2").await.unwrap_err(), LlmError::Budget);
    assert_eq!(m.count(), 1);
    // November: October's spend does not count (rollover), the call is allowed
    let out = ask(&s, &p, "2026-11-01", "r3").await.unwrap();
    assert!(out.cost_usd.is_some());
    assert_eq!(m.count(), 2);
    let sm = summary(&s, &p, "2026-11-01", "openrouter", MODEL, false).await;
    assert!((sm.month_usd - 0.000216).abs() < 1e-9, "{}", sm.month_usd);
    assert_eq!(eu::month(&p, "2026-10").await.unwrap().tokens, 1700);
    assert_eq!(eu::month(&p, "2026-11").await.unwrap().tokens, 1700);
    assert_eq!(sm.month_cap, 0.0002);
}

#[tokio::test]
async fn unpriced_usage_cannot_trip_the_dollar_cap_and_a_failed_ask_records_nothing() {
    let p = db::open_memory().await.unwrap();
    db::setting_set(&p, "chat.budget.month_usd", "0.01").await.unwrap();
    let m = mock(Some((5_000_000, 5_000_000))).await;
    let s = llm(&m, store("openrouter", Some(OR_KEY), Some("some/unknown-model")));
    ask(&s, &p, DAY, "r1").await.unwrap();
    // a huge unpriced call is not dollars: the cap compares priced spend only (the session cap still applies)
    assert_eq!(eu::month(&p, "2026-11").await.unwrap().usd, 0.0);
    let dead = Mock::start(|_, _| Some(Resp::text(500, "boom"))).await;
    let s2 = llm(&dead, store("openrouter", Some(OR_KEY), Some(MODEL)));
    let before = dump(&p, &["explain_usage"]).await;
    assert_eq!(ask(&s2, &p, DAY, "r2").await.unwrap_err(), LlmError::BadReply);
    assert_eq!(dump(&p, &["explain_usage"]).await, before);
}

// ---------------------------------------------------------------- B2/B3: the migration

#[tokio::test]
async fn migration_0004_is_purely_additive_and_existing_data_survives() {
    let sql = include_str!("../migrations/0004_explain.sql").to_uppercase();
    for banned in ["DROP ", "ALTER ", "DELETE FROM", "UPDATE ", "INSERT "] {
        assert!(!sql.contains(banned), "0004 must be additive only: {banned}");
    }
    // an app database that already has migrations 0001-0003 applied (and data in them) gets 0004 on the next launch
    let dir = std::env::temp_dir().join(format!("rebull-mig-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("old.db");
    let _ = std::fs::remove_file(&path);
    let opts = sqlx::sqlite::SqliteConnectOptions::new().filename(&path).create_if_missing(true);
    let pool = sqlx::sqlite::SqlitePoolOptions::new().max_connections(1).connect_with(opts).await.unwrap();
    let mut old = sqlx::migrate!("./migrations");
    old.migrations = std::borrow::Cow::Owned(old.migrations.iter().filter(|m| m.version <= 3).cloned().collect());
    old.run(&pool).await.unwrap();
    db::layout_save(&pool, "Main", r#"{"a":1}"#).await.unwrap();
    db::setting_set(&pool, "chat.mode", "\"trader\"").await.unwrap();
    sqlx::query("INSERT INTO candles (source, instrument, interval, ts, open, high, low, close, volume, fetched_at) VALUES ('rh','AAPL','15m',1700000000000,1,2,0.5,1.5,10,1)").execute(&pool).await.unwrap();
    let has: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sqlite_master WHERE name = 'explain_threads'").fetch_one(&pool).await.unwrap();
    assert_eq!(has, 0);
    drop(pool);
    let pool = db::open(&path).await.unwrap();
    assert_eq!(db::layout_load(&pool, "Main").await.unwrap().as_deref(), Some(r#"{"a":1}"#));
    assert_eq!(db::setting_get(&pool, "chat.mode").await.unwrap().as_deref(), Some("\"trader\""));
    let c: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM candles").fetch_one(&pool).await.unwrap();
    assert_eq!(c, 1);
    for t in ALL {
        let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t}")).fetch_one(&pool).await.unwrap();
        assert_eq!(n, 0, "{t}");
    }
    // running it again is a no-op
    drop(pool);
    db::open(&path).await.unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

// ---------------------------------------------------------------- B3: threads

#[tokio::test]
async fn append_and_load_round_trip_every_field() {
    let p = db::open_memory().await.unwrap();
    let hash = "a".repeat(64);
    let user = NewMessage { role: "user".into(), text: "What is the gamma flip?".into(), prompt_tok: None, completion_tok: None, model: None, digest_hash: Some(hash.clone()), had_positions: true, prompt_version: Some("m16a-1".into()), flagged_json: None };
    let bot = NewMessage { role: "assistant".into(), text: "It is a level.".into(), prompt_tok: Some(120), completion_tok: Some(30), model: Some(MODEL.into()), digest_hash: Some(hash.clone()), had_positions: true, prompt_version: Some("m16a-1".into()), flagged_json: Some(r#"[{"text":"$412.50","start":3,"end":10}]"#.into()) };
    let out = th::append(&p, 1_000, None, "aapl", &[user, bot]).await.unwrap().unwrap();
    assert_eq!(out.message_ids.len(), 2);
    assert!(out.message_ids[0] < out.message_ids[1]);
    let list = th::list(&p, Some("AAPL")).await.unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].id, list[0].symbol.as_str(), list[0].messages, list[0].updated_at, list[0].created_at), (out.thread_id, "AAPL", 2, 1_000, 1_000));
    assert_eq!(list[0].title, "What is the gamma flip?");
    let msgs = th::load(&p, out.thread_id).await.unwrap();
    assert_eq!(msgs.len(), 2);
    assert_eq!((msgs[0].role.as_str(), msgs[0].text.as_str(), msgs[0].had_positions), ("user", "What is the gamma flip?", true));
    assert_eq!(msgs[0].digest_hash.as_deref(), Some(hash.as_str()));
    assert_eq!((msgs[1].prompt_tok, msgs[1].completion_tok, msgs[1].model.as_deref(), msgs[1].prompt_version.as_deref()), (Some(120), Some(30), Some(MODEL), Some("m16a-1")));
    assert_eq!(msgs[1].flagged_json.as_deref(), Some(r#"[{"text":"$412.50","start":3,"end":10}]"#));
    assert_eq!(msgs[1].ts, 1_000);
    // appending to the thread keeps one thread; no thread id starts a NEW thread (the "New thread" button)
    th::append(&p, 2_000, Some(out.thread_id), "AAPL", &[msg("user", "again")]).await.unwrap();
    assert_eq!(th::list(&p, Some("AAPL")).await.unwrap().len(), 1);
    assert_eq!(th::load(&p, out.thread_id).await.unwrap().len(), 3);
    let fresh = th::append(&p, 3_000, None, "AAPL", &[msg("user", "new topic")]).await.unwrap().unwrap();
    assert_ne!(fresh.thread_id, out.thread_id);
    let list = th::list(&p, Some("AAPL")).await.unwrap();
    assert_eq!(list.iter().map(|t| t.id).collect::<Vec<_>>(), vec![fresh.thread_id, out.thread_id], "newest first: the active thread is the first one");
    th::append(&p, 4_000, None, "MSFT", &[msg("user", "other symbol")]).await.unwrap();
    assert_eq!(th::list(&p, Some("MSFT")).await.unwrap().len(), 1);
    assert_eq!(th::list(&p, None).await.unwrap().len(), 3);
}

#[tokio::test]
async fn titles_are_one_clean_short_line() {
    let p = db::open_memory().await.unwrap();
    let long = format!("  line one\nline two\t\u{7}{}", "x".repeat(200));
    let o = th::append(&p, 1, None, "AAPL", &[msg("user", &long)]).await.unwrap().unwrap();
    let t = &th::list(&p, Some("AAPL")).await.unwrap()[0];
    assert_eq!(t.id, o.thread_id);
    assert!(t.title.chars().count() <= 60 && !t.title.contains(['\n', '\t', '\u{7}']), "{:?}", t.title);
    assert!(t.title.starts_with("line one line two"));
}

#[tokio::test]
async fn validation_refuses_bad_input_and_a_wrong_symbol_for_the_thread() {
    let p = db::open_memory().await.unwrap();
    let ok = th::append(&p, 1, None, "AAPL", &[msg("user", "hi")]).await.unwrap().unwrap();
    for (sym, m) in [
        ("", msg("user", "x")),
        ("AA PL", msg("user", "x")),
        ("WAYTOOLONGSYMBOL", msg("user", "x")),
        ("AAPL", msg("system", "x")),
        ("AAPL", msg("user", "")),
        ("AAPL", msg("user", &"x".repeat(8001))),
    ] {
        assert!(matches!(th::append(&p, 2, None, sym, &[m]).await, Err(AppError::Invalid(_))), "{sym:?}");
    }
    let mut bad = msg("user", "x");
    bad.digest_hash = Some("not-a-hash".into());
    assert!(matches!(th::append(&p, 2, None, "AAPL", &[bad]).await, Err(AppError::Invalid(_))));
    let mut bad = msg("user", "x");
    bad.flagged_json = Some("{not json".into());
    assert!(matches!(th::append(&p, 2, None, "AAPL", &[bad]).await, Err(AppError::Invalid(_))));
    let mut bad = msg("assistant", "x");
    bad.model = Some("bad model!".into());
    assert!(matches!(th::append(&p, 2, None, "AAPL", &[bad]).await, Err(AppError::Invalid(_))));
    assert!(matches!(th::append(&p, 2, Some(ok.thread_id), "MSFT", &[msg("user", "x")]).await, Err(AppError::Invalid(_))));
    assert!(matches!(th::append(&p, 2, Some(9999), "AAPL", &[msg("user", "x")]).await, Err(AppError::NotFound(_))));
    assert!(matches!(th::append(&p, 2, None, "AAPL", &[]).await, Err(AppError::Invalid(_))));
    // a bad message in a batch stores nothing, not even the thread
    let n_before = th::list(&p, None).await.unwrap().len();
    assert!(th::append(&p, 3, None, "NVDA", &[msg("user", "fine"), msg("user", "")]).await.is_err());
    assert_eq!(th::list(&p, None).await.unwrap().len(), n_before);
    // unknown JSON fields are refused at the command boundary (no digest body can ride along)
    assert!(serde_json::from_value::<NewMessage>(json!({"role":"user","text":"x","digest":"CHART: ..."})).is_err());
}

#[tokio::test]
async fn limits_evict_the_oldest_messages_threads_and_bytes() {
    let p = db::open_memory().await.unwrap();
    // 200 messages per thread: the oldest go first
    let first = th::append(&p, 1, None, "AAPL", &[msg("user", "m0")]).await.unwrap().unwrap();
    for i in 1..230 {
        th::append(&p, 1 + i, Some(first.thread_id), "AAPL", &[msg(if i % 2 == 0 { "user" } else { "assistant" }, &format!("m{i}"))]).await.unwrap();
    }
    let msgs = th::load(&p, first.thread_id).await.unwrap();
    assert_eq!(msgs.len(), 200);
    assert_eq!(msgs[0].text, "m30");
    assert_eq!(msgs[199].text, "m229");
    // 50 threads: the oldest-updated thread is evicted, its messages with it
    let p2 = db::open_memory().await.unwrap();
    let mut ids = vec![];
    for i in 0..51 {
        ids.push(th::append(&p2, 100 + i, None, &format!("S{i}"), &[msg("user", "q")]).await.unwrap().unwrap().thread_id);
    }
    let list = th::list(&p2, None).await.unwrap();
    assert_eq!(list.len(), 50);
    assert!(!list.iter().any(|t| t.id == ids[0]));
    assert!(th::load(&p2, ids[0]).await.unwrap().is_empty());
    let orphans: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM explain_messages WHERE thread_id NOT IN (SELECT id FROM explain_threads)").fetch_one(&p2).await.unwrap();
    assert_eq!(orphans, 0);
    // 2 MB total: whole oldest threads are evicted, the thread being written is never the one dropped
    let p3 = db::open_memory().await.unwrap();
    let big = "y".repeat(8000);
    let mut last = 0;
    for t in 0..30 {
        let mut tid = None;
        for _ in 0..5 {
            let batch: Vec<NewMessage> = (0..8).map(|_| msg("assistant", &big)).collect();
            let o = th::append(&p3, 1000 + t, tid, &format!("T{t}"), &batch).await.unwrap().unwrap();
            tid = Some(o.thread_id);
            last = o.thread_id;
        }
    }
    let bytes: i64 = sqlx::query_scalar("SELECT COALESCE(SUM(LENGTH(CAST(text AS BLOB))), 0) FROM explain_messages").fetch_one(&p3).await.unwrap();
    assert!(bytes <= 2 * 1024 * 1024, "{bytes}");
    assert!(!th::load(&p3, last).await.unwrap().is_empty(), "the newest thread survives");
    assert_eq!(th::list(&p3, Some("T0")).await.unwrap().len(), 0, "the oldest thread went first");
}

#[tokio::test]
async fn deleting_a_thread_cascades_a_message_takes_its_pair_and_delete_all_spares_usage() {
    let p = db::open_memory().await.unwrap();
    let a = th::append(&p, 1, None, "AAPL", &[msg("user", "q1"), msg("assistant", "a1"), msg("user", "q2"), msg("assistant", "a2")]).await.unwrap().unwrap();
    let b = th::append(&p, 2, None, "MSFT", &[msg("user", "q"), msg("assistant", "a")]).await.unwrap().unwrap();
    // deleting the assistant message also removes the question it answered, and vice versa
    th::delete(&p, a.thread_id, Some(a.message_ids[3])).await.unwrap();
    let left: Vec<String> = th::load(&p, a.thread_id).await.unwrap().into_iter().map(|m| m.text).collect();
    assert_eq!(left, ["q1", "a1"]);
    th::delete(&p, a.thread_id, Some(a.message_ids[0])).await.unwrap();
    assert!(th::load(&p, a.thread_id).await.unwrap().is_empty());
    // a message id from another thread is not deleted through this one
    th::delete(&p, a.thread_id, Some(b.message_ids[0])).await.unwrap();
    assert_eq!(th::load(&p, b.thread_id).await.unwrap().len(), 2);
    // a thread whose last message was deleted is gone too
    assert!(th::list(&p, Some("AAPL")).await.unwrap().is_empty());
    th::delete(&p, b.thread_id, None).await.unwrap();
    assert!(th::load(&p, b.thread_id).await.unwrap().is_empty());
    let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM explain_threads WHERE id = ?1").bind(b.thread_id).fetch_one(&p).await.unwrap();
    assert_eq!(n, 0);
    eu::record(&p, DAY, MODEL, &crate::llm::Usage { prompt: 10, completion: 5, estimated: false }, Some(0.001)).await.unwrap();
    th::delete_all(&p).await.unwrap();
    for t in ["explain_threads", "explain_messages"] {
        let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {t}")).fetch_one(&p).await.unwrap();
        assert_eq!(n, 0, "{t}");
    }
    assert_eq!(eu::month(&p, "2026-11").await.unwrap().tokens, 15, "usage counters are not chat history");
    assert!(th::list(&p, None).await.unwrap().is_empty());
}

#[tokio::test]
async fn privacy_no_row_of_the_new_tables_holds_the_key_or_a_digest_line() {
    let p = db::open_memory().await.unwrap();
    let m = mock(Some((111, 22))).await;
    let s = llm(&m, store("openrouter", Some(OR_KEY), Some(MODEL)));
    let fake_key = OR_KEY;
    let out = ask(&s, &p, DAY, "r1").await.unwrap();
    // the webview persists the turn exactly as the pane does: texts + the hash Rust returned
    let (q, a) = (msg_with("user", "What is this?", &out.digest_hash, None), msg_with("assistant", &out.text, &out.digest_hash, Some(&out.model)));
    th::append(&p, 5, None, "ZZZ", &[q, a]).await.unwrap().unwrap();
    // the request did carry the digest to the provider, so the scan below is meaningful
    assert!(m.requests()[0].body.contains(DIGEST_LINE));
    let all = dump(&p, &ALL).await;
    assert!(!all.contains(fake_key) && !all.contains(KEY) && !all.contains("sk-"), "key text found:\n{all}");
    assert!(!all.contains(DIGEST_LINE) && !all.contains("unique-digest-line") && !all.contains("CHART:"), "digest text found:\n{all}");
    assert!(all.contains(&out.digest_hash), "only the SHA-256 is kept");
    use sha2::{Digest, Sha256};
    let want: String = Sha256::digest(DIGEST.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(out.digest_hash, want);
}
fn msg_with(role: &str, text: &str, hash: &str, model: Option<&str>) -> NewMessage {
    NewMessage { digest_hash: Some(hash.into()), model: model.map(str::to_string), prompt_version: Some("m16a-1".into()), ..msg(role, text) }
}

#[tokio::test]
async fn save_history_off_writes_nothing_default_is_on() {
    let p = db::open_memory().await.unwrap();
    assert!(th::append(&p, 1, None, "AAPL", &[msg("user", "kept by default")]).await.unwrap().is_some());
    th::delete_all(&p).await.unwrap();
    for off in ["false", " false "] {
        db::setting_set(&p, "chat.saveHistory", off).await.unwrap();
        assert_eq!(th::append(&p, 1, None, "AAPL", &[msg("user", "secret thought")]).await.unwrap(), None, "{off:?}");
        assert_eq!(dump(&p, &["explain_threads", "explain_messages"]).await, "", "nothing written");
    }
    // appending to a thread that exists also writes nothing while off
    db::setting_set(&p, "chat.saveHistory", "true").await.unwrap();
    let o = th::append(&p, 1, None, "AAPL", &[msg("user", "x")]).await.unwrap().unwrap();
    db::setting_set(&p, "chat.saveHistory", "false").await.unwrap();
    assert_eq!(th::append(&p, 2, Some(o.thread_id), "AAPL", &[msg("user", "y")]).await.unwrap(), None);
    assert_eq!(th::load(&p, o.thread_id).await.unwrap().len(), 1);
    // garbage in the setting means the default (on), like every other setting
    for junk in ["maybe", "", "0", "{}"] {
        db::setting_set(&p, "chat.saveHistory", junk).await.unwrap();
        assert!(th::append(&p, 3, None, "AAPL", &[msg("user", "z")]).await.unwrap().is_some(), "{junk:?}");
    }
}

#[tokio::test]
async fn export_is_markdown_in_a_private_new_file_and_never_overwrites() {
    let p = db::open_memory().await.unwrap();
    let hash = "b".repeat(64);
    let o = th::append(&p, 1_700_000_000_000, None, "AAPL", &[msg_with("user", "Why is IV rank high?", &hash, None), msg_with("assistant", "It compares today with the past year.\nUsed: IV", &hash, Some(MODEL))]).await.unwrap().unwrap();
    let dir = std::env::temp_dir().join(format!("rebull-export-{}", std::process::id())).join("exports");
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    let f1 = th::export_to_dir(&p, &dir, Some(o.thread_id), 1_700_000_001_000).await.unwrap();
    let f2 = th::export_to_dir(&p, &dir, Some(o.thread_id), 1_700_000_001_000).await.unwrap();
    assert_ne!(f1, f2);
    assert!(f1.starts_with(&dir) && f1.extension().and_then(|e| e.to_str()) == Some("md"));
    assert_eq!(std::fs::metadata(&f1).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    let text = std::fs::read_to_string(&f1).unwrap();
    assert!(text.contains("AAPL") && text.contains("Why is IV rank high?") && text.contains("It compares today with the past year."));
    assert!(text.contains("You") && text.contains("Arya"));
    assert!(!text.contains(&hash) && !text.contains("sk-") && !text.contains("CHART:"), "no digest or key in an export");
    // all threads
    let all = th::export_to_dir(&p, &dir, None, 1_700_000_002_000).await.unwrap();
    assert!(std::fs::read_to_string(&all).unwrap().contains("Why is IV rank high?"));
    assert!(matches!(th::export_to_dir(&p, &dir, Some(777), 1).await, Err(AppError::NotFound(_))));
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}

// ---------------------------------------------------------------- B7: a key pasted into a question never reaches the database or an export

const PASTED: &str = "sk-or-v1-0123456789abcdef0123456789abcdef";

#[tokio::test]
async fn b7_append_redacts_keys_in_both_roles_the_title_and_the_flags() {
    let p = db::open_memory().await.unwrap();
    let mut a = msg("assistant", "You pasted Bearer abcdefghij0123456789xyz and td_live_AbCd1234. Price 187.32.\nUsed: CHART");
    a.flagged_json = Some(format!("[{{\"text\":\"{PASTED}\",\"start\":0,\"end\":4}}]"));
    let o = th::append(&p, 1_700_000_000_000, None, "AAPL", &[msg("user", &format!("is {PASTED} my key? what is IV rank")), a]).await.unwrap().unwrap();
    let rows = th::load(&p, o.thread_id).await.unwrap();
    assert_eq!(rows[0].text, "is [redacted] my key? what is IV rank");
    assert_eq!(rows[1].text, "You pasted [redacted] and [redacted]. Price 187.32.\nUsed: CHART");
    assert!(!rows[1].flagged_json.clone().unwrap().contains("sk-"));
    let meta = th::list(&p, Some("AAPL")).await.unwrap();
    assert!(meta[0].title.contains("[redacted]") && !meta[0].title.contains("sk-or"));
    let all = dump(&p, &ALL).await;
    for needle in [PASTED, "sk-or-v1", "abcdefghij0123456789xyz", "td_live_AbCd1234"] {
        assert!(!all.contains(needle), "{needle} reached the database");
    }
    // a message that is nothing but a key still saves (as the marker), it is not refused
    assert!(th::append(&p, 1_700_000_001_000, Some(o.thread_id), "AAPL", &[msg("user", PASTED), msg("assistant", "ok")]).await.unwrap().is_some());
}

#[tokio::test]
async fn b7_export_redacts_even_rows_stored_before_the_fix() {
    let p = db::open_memory().await.unwrap();
    let o = th::append(&p, 1_700_000_000_000, None, "AAPL", &[msg("user", "hello"), msg("assistant", "fine")]).await.unwrap().unwrap();
    // an old row written before redaction existed
    sqlx::query("UPDATE explain_messages SET text = ?1 WHERE thread_id = ?2 AND role = 'user'").bind(format!("my key {PASTED}")).bind(o.thread_id).execute(&p).await.unwrap();
    sqlx::query("UPDATE explain_threads SET title = ?1 WHERE id = ?2").bind(format!("my key {PASTED}")).bind(o.thread_id).execute(&p).await.unwrap();
    let dir = std::env::temp_dir().join(format!("rebull-export-b7-{}", std::process::id())).join("exports");
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    let f = th::export_to_dir(&p, &dir, Some(o.thread_id), 1_700_000_001_000).await.unwrap();
    let text = std::fs::read_to_string(&f).unwrap();
    assert!(text.contains("[redacted]") && !text.contains("sk-or-v1") && !text.contains("0123456789abcdef0123456789abcdef"));
    let _ = std::fs::remove_dir_all(dir.parent().unwrap());
}
