//! M21 "Sign in with OpenRouter" tests. A mock key-exchange server on loopback plays openrouter.ai; a test opener plays the browser.
//! The minted key is the fake `sk-or-v1-MINTED...`; nothing here touches the network beyond 127.0.0.1.
use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::json;
use url::Url;

use super::client::{LLM_CONFIG_SLOT, LLM_KEY_SLOT};
use super::config;
use super::openrouter_login::{is_allowed_openrouter_url, LoginCfg, LoginStatus, OrLogin};
use crate::rh::oauth::{challenge_for, UrlOpener};
use crate::rh::testutil::{Mock, Resp};
use crate::rh::RhError;
use crate::secrets::{MemoryStore, SecretStore};

const MINTED: &str = "sk-or-v1-MINTED0123456789abcdef";
const CODE: &str = "code-abc-123";

#[derive(Clone, Default)]
struct Seen {
    challenge: Arc<Mutex<Option<String>>>,
    used: Arc<Mutex<HashSet<String>>>,
}

/// Plays openrouter.ai: `/api/v1/auth/keys` checks the PKCE pair against the challenge the "browser" saw, and each code works once.
async fn mock_or(seen: Seen, mode: &'static str) -> Mock {
    Mock::start(move |r, _| {
        if r.method != "POST" || r.path != "/api/v1/auth/keys" {
            return Some(Resp::status(404));
        }
        let b = r.json();
        let code = b["code"].as_str().unwrap_or("").to_string();
        if b["code_challenge_method"] != "S256" {
            return Some(Resp::json(400, &json!({"error":"bad method"})));
        }
        match mode {
            "403" => return Some(Resp::json(403, &json!({"error":{"message":"expired"}}))),
            "garbage" => return Some(Resp::text(200, "<html>not json</html>")),
            "badkey" => return Some(Resp::json(200, &json!({"key":"not-an-openrouter-key"}))),
            "nokey" => return Some(Resp::json(200, &json!({"ok":true}))),
            _ => {}
        }
        let ver = b["code_verifier"].as_str().unwrap_or("");
        let ok_pkce = seen.challenge.lock().unwrap().as_deref() == Some(challenge_for(ver).as_str());
        let first_use = seen.used.lock().unwrap().insert(code);
        if !ok_pkce || !first_use {
            return Some(Resp::json(403, &json!({"error":{"message":"Invalid code or code_verifier"}})));
        }
        Some(Resp::json(200, &json!({"key": MINTED})))
    })
    .await
}

fn cfg(m: &Mock, expiry: Duration) -> LoginCfg {
    LoginCfg::for_test(m.url("/api/v1/auth/keys"), expiry)
}

type Browser = Box<dyn Fn(&Url) + Send + Sync>;
struct FnOpener(Browser);
impl UrlOpener for FnOpener {
    fn open(&self, url: &Url) -> Result<(), RhError> {
        (self.0)(url);
        Ok(())
    }
}
struct Refusing;
impl UrlOpener for Refusing {
    fn open(&self, _u: &Url) -> Result<(), RhError> {
        Err(RhError::Transport("could not open the system browser".into()))
    }
}

fn q(u: &Url, k: &str) -> String {
    u.query_pairs().find(|(a, _)| a == k).map(|(_, v)| v.into_owned()).unwrap_or_default()
}
fn port_of(auth: &Url) -> u16 {
    Url::parse(&q(auth, "callback_url")).unwrap().port().unwrap()
}

/// A browser that records the challenge then visits the callback on 127.0.0.1 (the listener binds IPv4 only) with the given code and state.
fn browser(seen: &Seen, code: &'static str, state_override: Option<&'static str>, after: Option<&'static str>) -> Browser {
    let seen = seen.clone();
    Box::new(move |auth: &Url| {
        *seen.challenge.lock().unwrap() = Some(q(auth, "code_challenge"));
        let port = port_of(auth);
        let state = state_override.map(String::from).unwrap_or_else(|| q(auth, "state"));
        let real = q(auth, "state");
        tokio::spawn(async move {
            let c = reqwest::Client::new();
            let _ = c.get(format!("http://127.0.0.1:{port}/callback?code={code}&state={state}")).send().await;
            if let Some(_second) = after {
                // a correct redirect after the wrong one
                let _ = c.get(format!("http://127.0.0.1:{port}/callback?code={code}&state={real}")).send().await;
            }
        });
    })
}

async fn settle(l: &OrLogin, id: &str) -> LoginStatus {
    for _ in 0..100 {
        let s = l.status(id);
        if s != LoginStatus::Pending {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    l.status(id)
}

async fn port_free(port: u16) -> bool {
    for _ in 0..40 {
        if tokio::net::TcpListener::bind(("127.0.0.1", port)).await.is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    false
}

fn store() -> Arc<dyn SecretStore> {
    Arc::new(MemoryStore::new())
}

#[tokio::test]
async fn full_login_mints_a_key_through_the_sealed_path_and_the_key_appears_nowhere_else() {
    let seen = Seen::default();
    let m = mock_or(seen.clone(), "ok").await;
    let st = store();
    // an earlier paste-key setup for another provider: the login replaces provider and key together
    config::set_config(&*st, "openai", None, Some("sk-test-KEY"), None, None).unwrap();
    let l = OrLogin::new(cfg(&m, Duration::from_secs(600)));
    let started = l.start(&FnOpener(browser(&seen, CODE, None, None)), st.clone()).await.unwrap();
    // what the webview gets: the URL and a pending id, nothing else
    let auth = Url::parse(&started.url).unwrap();
    assert_eq!((auth.scheme(), auth.host_str(), auth.path()), ("https", Some("openrouter.ai"), "/auth"));
    let cb = Url::parse(&q(&auth, "callback_url")).unwrap();
    assert_eq!((cb.scheme(), cb.host_str(), cb.path()), ("http", Some("localhost"), "/callback"));
    assert!(cb.port().unwrap() > 1023);
    assert_eq!((q(&auth, "code_challenge_method"), q(&auth, "key_label")), ("S256".into(), "TraderMatrix Desktop".into()));
    assert_eq!(q(&auth, "code_challenge").len(), 43);
    assert!(q(&auth, "state").len() >= 32);
    assert!(!started.url.contains("client_id") && !started.url.contains("verifier"));
    assert_eq!(started.pending_id.len(), 32);

    assert_eq!(settle(&l, &started.pending_id).await, LoginStatus::Done);
    // the mock saw exactly one POST with exactly the documented body (the verifier matched the challenge, checked inside the mock)
    let reqs = m.requests();
    assert_eq!(reqs.len(), 1);
    let b = reqs[0].json();
    assert_eq!(b["code"], CODE);
    assert_eq!(b["code_challenge_method"], "S256");
    assert_eq!(b["code_verifier"].as_str().unwrap().len(), 43);
    assert_eq!(b.as_object().unwrap().len(), 3);
    assert_eq!(reqs[0].header("content-type"), Some("application/json"));
    // the sealed write: provider openrouter + the minted key, one config
    let status = config::status(&*st);
    assert_eq!((status.provider.as_deref(), status.key_present), (Some("openrouter"), true));
    assert_eq!(st.get(LLM_KEY_SLOT).unwrap().as_deref(), Some(MINTED));
    assert!(st.get(LLM_CONFIG_SLOT).unwrap().unwrap().contains("openrouter"));
    // Review Focus 4: the key is in no output
    let outs = [format!("{started:?}"), serde_json::to_string(&started).unwrap(), format!("{:?}", l.status(&started.pending_id)), l.status(&started.pending_id).as_str().to_string(), format!("{status:?}"), serde_json::to_string(&status.provider).unwrap()];
    for o in &outs {
        assert!(!o.contains(MINTED) && !o.contains("v1-MINTED"), "{o}");
    }
    for r in &reqs {
        assert!(!format!("{r:?}").contains(MINTED));
    }
    assert!(!std::fmt::format(format_args!("{l:?}")).contains(MINTED));
    // the listener is gone: the port is free again
    assert!(port_free(cb.port().unwrap()).await);
}

#[tokio::test]
async fn review_focus_4_a_wrong_state_is_rejected_and_the_login_keeps_waiting() {
    let seen = Seen::default();
    let m = mock_or(seen.clone(), "ok").await;
    let st = store();
    let l = OrLogin::new(cfg(&m, Duration::from_secs(600)));
    // first the forged redirect (wrong state), then the real one
    let s = l.start(&FnOpener(browser(&seen, CODE, Some("forged-state"), Some("again"))), st.clone()).await.unwrap();
    assert_eq!(settle(&l, &s.pending_id).await, LoginStatus::Done);
    // the forged one never reached the exchange: exactly one POST, and only for the correct callback
    assert_eq!(m.count(), 1);
    // and a forged redirect ALONE never ends or completes anything
    let seen2 = Seen::default();
    let m2 = mock_or(seen2.clone(), "ok").await;
    let st2 = store();
    let l2 = OrLogin::new(cfg(&m2, Duration::from_secs(600)));
    let s2 = l2.start(&FnOpener(browser(&seen2, CODE, Some("forged-state"), None)), st2.clone()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(600)).await;
    assert_eq!(l2.status(&s2.pending_id), LoginStatus::Pending);
    assert_eq!(m2.count(), 0);
    assert!(st2.get(LLM_KEY_SLOT).unwrap().is_none());
}

#[tokio::test]
async fn review_focus_4_a_replayed_code_fails_and_leaves_the_saved_key_alone() {
    let seen = Seen::default();
    let m = mock_or(seen.clone(), "ok").await;
    let st = store();
    let l = OrLogin::new(cfg(&m, Duration::from_secs(600)));
    let a = l.start(&FnOpener(browser(&seen, CODE, None, None)), st.clone()).await.unwrap();
    assert_eq!(settle(&l, &a.pending_id).await, LoginStatus::Done);
    assert_eq!(st.get(LLM_KEY_SLOT).unwrap().as_deref(), Some(MINTED));
    // the same code again (a replay): the server refuses it, the login fails, nothing is overwritten
    st.set(LLM_KEY_SLOT, "sk-or-v1-EXISTING-KEY-0000").unwrap();
    let b = l.start(&FnOpener(browser(&seen, CODE, None, None)), st.clone()).await.unwrap();
    assert_eq!(settle(&l, &b.pending_id).await, LoginStatus::Failed);
    assert_eq!(st.get(LLM_KEY_SLOT).unwrap().as_deref(), Some("sk-or-v1-EXISTING-KEY-0000"));
    // the first id is no longer the current login
    assert_eq!(l.status(&a.pending_id), LoginStatus::Failed);
    assert_eq!(l.status("nonsense"), LoginStatus::Failed);
}

#[tokio::test]
async fn review_focus_4_an_expired_pending_login_reports_expired_frees_the_port_and_saves_nothing() {
    let seen = Seen::default();
    let m = mock_or(seen.clone(), "ok").await;
    let st = store();
    let l = OrLogin::new(cfg(&m, Duration::from_millis(400)));
    let port = Arc::new(Mutex::new(0u16));
    let p2 = port.clone();
    let s = l
        .start(
            &FnOpener(Box::new(move |auth: &Url| {
                *p2.lock().unwrap() = port_of(auth);
            })),
            st.clone(),
        )
        .await
        .unwrap();
    assert_eq!(l.status(&s.pending_id), LoginStatus::Pending);
    tokio::time::sleep(Duration::from_millis(900)).await;
    assert_eq!(l.status(&s.pending_id), LoginStatus::Expired);
    assert_eq!(m.count(), 0);
    assert!(st.get(LLM_KEY_SLOT).unwrap().is_none() && st.get(LLM_CONFIG_SLOT).unwrap().is_none());
    let p = *port.lock().unwrap();
    assert!(port_free(p).await);
    // a new login may start after an expiry
    let s2 = l.start(&FnOpener(browser(&seen, CODE, None, None)), st.clone()).await;
    assert!(s2.is_ok());
}

#[tokio::test]
async fn only_one_login_can_be_pending_at_a_time() {
    let seen = Seen::default();
    let m = mock_or(seen.clone(), "ok").await;
    let l = OrLogin::new(cfg(&m, Duration::from_secs(600)));
    let st = store();
    let a = l.start(&FnOpener(Box::new(|_u: &Url| {})), st.clone()).await.unwrap();
    let b = l.start(&FnOpener(Box::new(|_u: &Url| panic!("must not open a second browser"))), st.clone()).await;
    assert_eq!(b.map(|x| x.url), Err(super::client::LlmError::RateLimited));
    assert_eq!(l.status(&a.pending_id), LoginStatus::Pending);
}

#[tokio::test]
async fn a_failed_exchange_never_saves_anything_and_says_only_failed() {
    for mode in ["403", "garbage", "badkey", "nokey"] {
        let seen = Seen::default();
        let m = mock_or(seen.clone(), mode).await;
        let st = store();
        config::set_config(&*st, "openrouter", None, Some("sk-or-v1-OLD-KEY-00000000"), None, None).unwrap();
        let before = (st.get(LLM_CONFIG_SLOT).unwrap(), st.get(LLM_KEY_SLOT).unwrap());
        let l = OrLogin::new(cfg(&m, Duration::from_secs(600)));
        let s = l.start(&FnOpener(browser(&seen, CODE, None, None)), st.clone()).await.unwrap();
        assert_eq!(settle(&l, &s.pending_id).await, LoginStatus::Failed, "{mode}");
        assert_eq!(before, (st.get(LLM_CONFIG_SLOT).unwrap(), st.get(LLM_KEY_SLOT).unwrap()), "{mode}");
    }
}

#[tokio::test]
async fn a_browser_that_will_not_open_still_returns_the_link_to_show() {
    let seen = Seen::default();
    let m = mock_or(seen, "ok").await;
    let l = OrLogin::new(cfg(&m, Duration::from_secs(600)));
    let s = l.start(&Refusing, store()).await.unwrap();
    assert!(s.url.starts_with("https://openrouter.ai/auth?"));
    assert_eq!(l.status(&s.pending_id), LoginStatus::Pending);
}

#[test]
fn production_config_is_pinned_to_openrouter_and_the_opener_only_accepts_that_host() {
    let c = LoginCfg::production();
    assert_eq!(c.auth_url.as_str(), "https://openrouter.ai/auth");
    assert_eq!(c.exchange_url.as_str(), "https://openrouter.ai/api/v1/auth/keys");
    assert_eq!(c.expiry, Duration::from_secs(600));
    assert_eq!(c.callback_host, "localhost");
    for (u, ok) in [
        ("https://openrouter.ai/auth?callback_url=x", true),
        ("https://openrouter.ai.evil.com/auth", false),
        ("http://openrouter.ai/auth", false),
        ("https://evil.com/auth?u=openrouter.ai", false),
        ("https://robinhood.com/x", false),
        ("file:///etc/passwd", false),
    ] {
        assert_eq!(is_allowed_openrouter_url(&Url::parse(u).unwrap()), ok, "{u}");
    }
}
