//! In-process end to end: mock authorization server + mock MCP resource server on 127.0.0.1, fake tokens,
//! the real `RhState` (the same inner functions the Tauri commands call). No network beyond loopback.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::{json, Value};
use url::Url;

use crate::rh::mcp::is_read_tool;
use crate::rh::oauth::challenge_for;
use crate::rh::testutil::{Mock, Req, Resp};
use crate::rh::{OAuthConfig, RhError, UrlOpener};
use crate::rh_commands::RhState;
use crate::secrets::{MemoryStore, SecretStore};

macro_rules! fx {
    ($n:literal) => {
        serde_json::from_str::<Value>(include_str!(concat!("../../tests/fixtures/rh/", $n))).unwrap()
    };
}

fn structured(req: &Req, sc: Value) -> Resp {
    Resp::json(
        200,
        &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"content":[{"type":"text","text":sc.to_string()}],"structuredContent":sc}}),
    )
}

/// One host playing both roles: OAuth endpoints and `/mcp/trading`.
async fn mock_robinhood(challenge: Arc<std::sync::Mutex<String>>) -> Mock {
    Mock::start(move |req, _| {
        let base = format!("http://{}", req.header("host").unwrap());
        match (req.method.as_str(), req.path.as_str()) {
            ("GET", "/.well-known/oauth-authorization-server") => Some(Resp::json(
                200,
                &json!({"issuer":base,"authorization_endpoint":format!("{base}/authorize"),"token_endpoint":format!("{base}/token"),"registration_endpoint":format!("{base}/register")}),
            )),
            ("POST", "/register") => Some(Resp::json(201, &json!({"client_id":"client-e2e"}))),
            ("POST", "/token") => {
                let f: std::collections::HashMap<String, String> = url::form_urlencoded::parse(req.body.as_bytes()).into_owned().collect();
                let ch = challenge.lock().unwrap().clone();
                let ok = f.get("grant_type").map(String::as_str) == Some("authorization_code")
                    && f.get("code").map(String::as_str) == Some("code-e2e")
                    && f.get("code_verifier").is_some_and(|v| challenge_for(v) == ch);
                if ok {
                    Some(Resp::json(200, &json!({"access_token":"at-e2e","refresh_token":"rt-e2e","expires_in":7200})))
                } else {
                    Some(Resp::json(400, &json!({"error":"invalid_grant"})))
                }
            }
            ("POST", "/mcp/trading") => match req.rpc_method().as_str() {
                "initialize" => Some(
                    Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"mock","version":"1"}}}))
                        .header("Mcp-Session-Id", "sess-e2e"),
                ),
                "notifications/initialized" => Some(Resp::status(202)),
                "tools/list" => Some(Resp::json(
                    200,
                    &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":{"tools":[
                        {"name":"get_accounts","description":"d","inputSchema":{}},
                        {"name":"place_equity_order","inputSchema":{}}]}}),
                )),
                "tools/call" => {
                    let a = &req.json()["params"]["arguments"];
                    Some(match req.json()["params"]["name"].as_str().unwrap_or("") {
                        "get_accounts" => structured(req, fx!("accounts.json")),
                        "get_portfolio" => structured(req, fx!("portfolio.json")),
                        "get_equity_positions" => structured(req, fx!("positions_page2.json")),
                        "get_equity_quotes" => {
                            let n = a["symbols"].as_array().map(|v| v.len()).unwrap_or(0);
                            assert!(n > 0);
                            structured(req, fx!("quotes.json"))
                        }
                        _ => Resp::text(500, "unexpected tool"),
                    })
                }
                _ => Some(Resp::status(400)),
            },
            _ => Some(Resp::status(404)),
        }
    })
    .await
}

struct Browser {
    challenge: Arc<std::sync::Mutex<String>>,
    opened: Arc<AtomicBool>,
}

impl UrlOpener for Browser {
    fn open(&self, url: &Url) -> Result<(), RhError> {
        let q = |k: &str| url.query_pairs().find(|(a, _)| a == k).map(|(_, v)| v.into_owned()).unwrap_or_default();
        *self.challenge.lock().unwrap() = q("code_challenge");
        self.opened.store(true, Ordering::SeqCst);
        let target = format!("{}?code=code-e2e&state={}", q("redirect_uri"), q("state"));
        tokio::spawn(async move {
            let _ = reqwest::Client::new().get(target).send().await;
        });
        Ok(())
    }
}

fn cfg(m: &Mock) -> OAuthConfig {
    OAuthConfig {
        resource: m.url("/mcp/trading"),
        as_metadata_url: m.url("/.well-known/oauth-authorization-server"),
        scope: "internal".into(),
    }
}

#[tokio::test]
async fn login_then_reads_then_logout_end_to_end() {
    let challenge = Arc::new(std::sync::Mutex::new(String::new()));
    let m = mock_robinhood(challenge.clone()).await;
    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let rh = RhState::new(store.clone(), cfg(&m));

    // Before login: not connected, and a read fails WITHOUT touching the server.
    assert!(!rh.status().connected);
    assert_eq!(rh.accounts().await.unwrap_err(), RhError::NotConnected);
    assert_eq!(m.count(), 0);

    let opened = Arc::new(AtomicBool::new(false));
    rh.connect(&Browser { challenge, opened: opened.clone() }).await.unwrap();
    assert!(opened.load(Ordering::SeqCst));
    let st = rh.status();
    assert!(st.connected && !st.expires_soon, "{st:?}");

    let accounts = rh.accounts().await.unwrap();
    assert_eq!(accounts.len(), 2);
    let agentic = accounts.iter().find(|a| a.agentic_allowed).unwrap();
    assert_eq!(agentic.account_number, "SYN00000002");
    let positions = rh.positions(&agentic.account_number).await.unwrap();
    assert_eq!(positions.len(), 1);
    assert_eq!(positions[0].symbol, "CCC");
    let q = rh.quotes(&["AAA".to_string(), "BBB".to_string()]).await.unwrap();
    assert_eq!(q[0].last_trade_price, Some(101.25));
    assert_eq!(rh.portfolio(&agentic.account_number).await.unwrap().buying_power, Some(4000.25));

    // Only read tools reached the server; the session was opened once and echoed; the token was the fake one.
    let mcp: Vec<Req> = m.requests().into_iter().filter(|r| r.path == "/mcp/trading").collect();
    let calls: Vec<String> = mcp
        .iter()
        .filter(|r| r.rpc_method() == "tools/call")
        .map(|r| r.json()["params"]["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(calls, ["get_accounts", "get_equity_positions", "get_equity_quotes", "get_portfolio"]);
    assert!(calls.iter().all(|n| is_read_tool(n)), "write tool reached the server: {calls:?}");
    assert!(calls.iter().all(|n| !["place", "cancel", "exercise"].iter().any(|p| n.contains(p))));
    assert_eq!(mcp.iter().filter(|r| r.rpc_method() == "initialize").count(), 1);
    let init = mcp.iter().find(|r| r.rpc_method() == "initialize").unwrap().json();
    assert_eq!(init["params"]["clientInfo"]["name"], "TraderMatrix Desktop");
    assert!(mcp.iter().all(|r| r.header("authorization") == Some("Bearer at-e2e")));
    assert!(mcp.iter().filter(|r| r.rpc_method() != "initialize").all(|r| r.header("mcp-session-id") == Some("sess-e2e")));
    assert!(m.requests().iter().all(|r| r.method != "DELETE"));

    // Logout: credentials gone, and no later request carries a token (or reaches the server at all).
    let before = m.count();
    rh.disconnect().await.unwrap();
    assert!(!rh.status().connected);
    assert_eq!(rh.accounts().await.unwrap_err(), RhError::NotConnected);
    assert_eq!(rh.quotes(&["AAA".to_string()]).await.unwrap_err(), RhError::NotConnected);
    assert_eq!(m.count(), before, "nothing may be sent after logout");
}

#[tokio::test]
async fn capture_tools_writes_names_to_a_temp_dir() {
    let challenge = Arc::new(std::sync::Mutex::new(String::new()));
    let m = mock_robinhood(challenge.clone()).await;
    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let rh = RhState::new(store, cfg(&m));
    rh.connect(&Browser { challenge, opened: Arc::new(AtomicBool::new(false)) }).await.unwrap();

    let dir = std::env::temp_dir().join(format!("rebull-capture-test-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let r = rh.capture_tools(&dir, "2026-11-10").await.unwrap();
    assert_eq!(r.count, 2);
    assert_eq!(r.names, ["get_accounts", "place_equity_order"]);
    assert!(r.path.ends_with("captures/robinhood-tools-2026-11-10.json"), "{}", r.path);
    let written: Value = serde_json::from_str(&std::fs::read_to_string(&r.path).unwrap()).unwrap();
    assert_eq!(written[0]["name"], "get_accounts");
    assert!(!std::fs::read_to_string(&r.path).unwrap().contains("at-e2e"), "no token in a capture");
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn status_reports_a_locked_store_without_secrets() {
    struct Locked;
    impl SecretStore for Locked {
        fn set(&self, _: &str, _: &str) -> Result<(), crate::error::AppError> {
            Err(crate::error::AppError::Secret("vault locked".into()))
        }
        fn exists(&self, _: &str) -> Result<bool, crate::error::AppError> {
            Err(crate::error::AppError::Secret("vault locked".into()))
        }
        fn delete(&self, _: &str) -> Result<(), crate::error::AppError> {
            Err(crate::error::AppError::Secret("vault locked".into()))
        }
        fn get(&self, _: &str) -> Result<Option<String>, crate::error::AppError> {
            Err(crate::error::AppError::Secret("vault locked".into()))
        }
        fn status(&self) -> crate::secrets::BackendStatus {
            crate::secrets::BackendStatus { available: false, backend: "vault".into(), detail: String::new() }
        }
    }
    let m = mock_robinhood(Arc::new(std::sync::Mutex::new(String::new()))).await;
    let rh = RhState::new(Arc::new(Locked), cfg(&m));
    let st = rh.status();
    assert!(!st.connected);
    assert!(st.last_error.unwrap().contains("vault locked"));
    assert!(rh.accounts().await.is_err());
    assert_eq!(m.count(), 0);
}

#[test]
fn only_robinhood_https_login_urls_reach_the_webview() {
    use crate::rh_commands::webview_safe_login_url as safe;
    assert!(safe("https://robinhood.com/oauth?client_id=x&state=y").is_some());
    assert!(safe("https://api.robinhood.com/oauth").is_some());
    assert!(safe("http://robinhood.com/oauth").is_none());
    assert!(safe("https://robinhood.com.evil.example/oauth").is_none());
    assert!(safe("javascript:alert(1)").is_none());
    assert!(safe("not a url").is_none());
}

#[tokio::test]
async fn pending_login_url_is_visible_during_login_and_cleared_after() {
    let challenge = Arc::new(std::sync::Mutex::new(String::new()));
    let m = mock_robinhood(challenge.clone()).await;
    let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let rh = Arc::new(RhState::new(store, cfg(&m)));
    assert!(rh.pending_raw().is_none());

    struct Peek {
        rh: Arc<RhState>,
        seen: Arc<std::sync::Mutex<Option<String>>>,
        inner: Browser,
    }
    impl UrlOpener for Peek {
        fn open(&self, url: &Url) -> Result<(), RhError> {
            // The recorder stores the URL before delegating to the real opener.
            *self.seen.lock().unwrap() = self.rh.pending_raw();
            self.inner.open(url)
        }
    }
    let seen = Arc::new(std::sync::Mutex::new(None));
    let opener = Peek {
        rh: rh.clone(),
        seen: seen.clone(),
        inner: Browser { challenge, opened: Arc::new(AtomicBool::new(false)) },
    };
    rh.connect(&opener).await.unwrap();
    let url = seen.lock().unwrap().clone().expect("pending url was set while the browser was opened");
    assert!(url.contains("code_challenge=") && url.contains("state="));
    assert!(!url.contains("code_verifier"), "the verifier must never be in the URL");
    assert!(rh.pending_raw().is_none(), "cleared after a successful login");

    // A failing opener also leaves nothing pending.
    struct Broken;
    impl UrlOpener for Broken {
        fn open(&self, _: &Url) -> Result<(), RhError> {
            Err(RhError::Transport("no browser".into()))
        }
    }
    assert!(rh.connect(&Broken).await.is_err());
    assert!(rh.pending_raw().is_none(), "cleared after a failed login");
}

/// R9: a connect whose future is dropped (window closed, command cancelled) must not leave `connecting` stuck.
#[tokio::test]
async fn a_cancelled_connect_does_not_block_the_next_one() {
    let m = mock_robinhood(Arc::new(std::sync::Mutex::new(String::new()))).await;
    let rh = RhState::new(Arc::new(MemoryStore::new()), cfg(&m));
    struct Silent;
    impl UrlOpener for Silent {
        fn open(&self, _: &Url) -> Result<(), RhError> {
            Ok(()) // the browser never calls back
        }
    }
    let r = tokio::time::timeout(std::time::Duration::from_millis(300), rh.connect(&Silent)).await;
    assert!(r.is_err(), "the login was still waiting and got cancelled");
    assert!(rh.pending_raw().is_none(), "pending URL cleared on cancel");
    struct Broken;
    impl UrlOpener for Broken {
        fn open(&self, _: &Url) -> Result<(), RhError> {
            Err(RhError::Transport("no browser".into()))
        }
    }
    let e = rh.connect(&Broken).await.unwrap_err();
    assert!(matches!(&e, RhError::Transport(t) if t.contains("no browser")), "stuck connecting flag: {e:?}");
}

/// R5: tool captures are private files.
#[tokio::test]
async fn capture_file_is_0600_in_a_0700_dir() {
    use std::os::unix::fs::PermissionsExt;
    let challenge = Arc::new(std::sync::Mutex::new(String::new()));
    let m = mock_robinhood(challenge.clone()).await;
    let rh = RhState::new(Arc::new(MemoryStore::new()), cfg(&m));
    rh.connect(&Browser { challenge, opened: Arc::new(AtomicBool::new(false)) }).await.unwrap();
    let dir = std::env::temp_dir().join(format!("rebull-capture-mode-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let r = rh.capture_tools(&dir, "2026-11-11").await.unwrap();
    assert_eq!(std::fs::metadata(&r.path).unwrap().permissions().mode() & 0o777, 0o600);
    assert_eq!(std::fs::metadata(dir.join("captures")).unwrap().permissions().mode() & 0o777, 0o700);
    let _ = std::fs::remove_dir_all(&dir);
}

/// R3: one failed initialize answers the callers queued behind it (and for 5 s after), instead of each retrying.
#[tokio::test]
async fn a_failed_initialize_fails_queued_callers_fast() {
    let m = Mock::start(|_, _| None).await;
    let rh = RhState::for_test(m.url("/mcp/trading"), Arc::new(|| 1_000_000));
    let (a, b, c) = tokio::join!(rh.accounts(), rh.accounts(), rh.accounts());
    assert!(a.is_err() && b.is_err() && c.is_err());
    assert!(rh.accounts().await.is_err());
    let inits = m.requests().iter().filter(|r| r.rpc_method() == "initialize").count();
    assert_eq!(inits, 1, "one attempt serves everyone for 5 s");
}
