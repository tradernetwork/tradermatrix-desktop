//! "Sign in with OpenRouter" (M21): OAuth PKCE to a loopback callback, Rust only. The webview gets a link and a pending id, then polls a status;
//! it never sees the code, the verifier or the key. Facts re-checked against https://openrouter.ai/docs/guides/overview/auth/oauth on 2026-11-11:
//! auth URL `https://openrouter.ai/auth` with `callback_url`, `code_challenge`, `code_challenge_method=S256`, optional `key_label` and `state`
//! (returned unchanged on the callback; NOT returned when the user denies); localhost callbacks work on any port (127.0.0.1 is not documented, so the
//! callback host is `localhost`); the code is single-use and lives 10 minutes; `POST https://openrouter.ai/api/v1/auth/keys` with
//! `{code, code_verifier, code_challenge_method}` returns `{key}`. The loopback listener is the Robinhood one (`rh::oauth::await_callback`).
//! The minted key goes through the SAME sealed path as a pasted key (`config::set_config_ex`, provider openrouter) and is never logged or returned.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::net::TcpListener;
use url::Url;
use zeroize::Zeroizing;

use super::client::LlmError;
use super::config;
use crate::rh::oauth::{await_callback, pkce_pair, random_token, UrlOpener};
use crate::rh::RhError;
use crate::secrets::SecretStore;

pub const KEY_LABEL: &str = "TraderMatrix Desktop";
const LOGIN_EXPIRY: Duration = Duration::from_secs(600);
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(20);

#[derive(Debug, Clone)]
pub struct LoginCfg {
    pub auth_url: Url,
    pub exchange_url: Url,
    /// How long a pending login lives (the code itself is valid 10 minutes).
    pub expiry: Duration,
    pub callback_host: &'static str,
}

impl LoginCfg {
    pub fn production() -> Self {
        Self {
            auth_url: Url::parse("https://openrouter.ai/auth").expect("static"),
            exchange_url: Url::parse("https://openrouter.ai/api/v1/auth/keys").expect("static"),
            expiry: LOGIN_EXPIRY,
            callback_host: "localhost",
        }
    }
    #[cfg(test)]
    pub(crate) fn for_test(exchange_url: Url, expiry: Duration) -> Self {
        Self { exchange_url, expiry, ..Self::production() }
    }
}

/// Only https URLs on openrouter.ai itself may be handed to the system browser.
pub fn is_allowed_openrouter_url(u: &Url) -> bool {
    u.scheme() == "https" && u.host_str() == Some("openrouter.ai")
}

/// Production opener: a Rust-side call into tauri-plugin-opener (the webview gets no opener permission).
pub struct OrTauriOpener<R: tauri::Runtime>(pub tauri::AppHandle<R>);
impl<R: tauri::Runtime> UrlOpener for OrTauriOpener<R> {
    fn open(&self, url: &Url) -> Result<(), RhError> {
        use tauri_plugin_opener::OpenerExt;
        if !is_allowed_openrouter_url(url) {
            return Err(RhError::Protocol("refusing to open a non-OpenRouter sign-in URL".into()));
        }
        self.0.opener().open_url(url.as_str(), None::<&str>).map_err(|_| RhError::Transport("could not open the system browser".into()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LoginStatus {
    Pending,
    Done,
    Expired,
    Failed,
}
impl LoginStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            LoginStatus::Pending => "pending",
            LoginStatus::Done => "done",
            LoginStatus::Expired => "expired",
            LoginStatus::Failed => "failed",
        }
    }
}

/// What the webview gets from `start`: the sign-in link (also opened in the browser) and an opaque id to poll. Nothing secret.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LoginStart {
    pub url: String,
    pub pending_id: String,
}

struct Current {
    id: String,
    status: LoginStatus,
    started: Instant,
}

pub struct OrLogin {
    cfg: LoginCfg,
    cur: Arc<Mutex<Option<Current>>>,
}

impl std::fmt::Debug for OrLogin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("OrLogin")
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl OrLogin {
    pub fn new(cfg: LoginCfg) -> Self {
        Self { cfg, cur: Arc::new(Mutex::new(None)) }
    }

    /// `pending`, `done`, `expired` or `failed`. An id that is not the current login is `failed`. A pending login past its lifetime reads as `expired`.
    pub fn status(&self, id: &str) -> LoginStatus {
        let g = lock(&self.cur);
        match g.as_ref() {
            Some(c) if c.id == id => {
                if c.status == LoginStatus::Pending && c.started.elapsed() >= self.cfg.expiry {
                    LoginStatus::Expired
                } else {
                    c.status
                }
            }
            _ => LoginStatus::Failed,
        }
    }

    /// Binds a random loopback port, builds the PKCE sign-in link, opens it and waits for the redirect in the background. One pending login at a time
    /// (`rate_limited`). If the browser cannot be opened the link is still returned so it can be shown for the user to open.
    pub async fn start(&self, opener: &dyn UrlOpener, store: Arc<dyn SecretStore>) -> Result<LoginStart, LlmError> {
        {
            let g = lock(&self.cur);
            if g.as_ref().is_some_and(|c| c.status == LoginStatus::Pending && c.started.elapsed() < self.cfg.expiry) {
                return Err(LlmError::RateLimited);
            }
        }
        let listener = TcpListener::bind("127.0.0.1:0").await.map_err(|_| LlmError::Unreachable)?;
        let port = listener.local_addr().map_err(|_| LlmError::Unreachable)?.port();
        let callback = format!("http://{}:{port}/callback", self.cfg.callback_host);
        let (verifier, challenge) = pkce_pair().map_err(|_| LlmError::BadReply)?;
        let verifier = Zeroizing::new(verifier);
        let state = random_token().map_err(|_| LlmError::BadReply)?;
        let id = {
            let mut b = [0u8; 16];
            getrandom::fill(&mut b).map_err(|_| LlmError::BadReply)?;
            b.iter().map(|x| format!("{x:02x}")).collect::<String>()
        };
        let mut auth = self.cfg.auth_url.clone();
        auth.query_pairs_mut()
            .append_pair("callback_url", &callback)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("key_label", KEY_LABEL)
            .append_pair("state", &state);

        let started = Instant::now();
        {
            let mut g = lock(&self.cur);
            // re-check under the lock: two quick clicks must not both start
            if g.as_ref().is_some_and(|c| c.status == LoginStatus::Pending && c.started.elapsed() < self.cfg.expiry) {
                return Err(LlmError::RateLimited);
            }
            *g = Some(Current { id: id.clone(), status: LoginStatus::Pending, started });
        }
        let _ = opener.open(&auth); // a refused browser is not an error: the link is returned for the user to open

        let (cur, exchange_url, expiry, my_id) = (self.cur.clone(), self.cfg.exchange_url.clone(), self.cfg.expiry, id.clone());
        tauri::async_runtime::spawn(async move {
            let result = run(listener, &state, &verifier, &exchange_url, expiry, store).await;
            let mut g = lock(&cur);
            if let Some(c) = g.as_mut() {
                if c.id == my_id {
                    c.status = result;
                }
            }
        });
        Ok(LoginStart { url: auth.to_string(), pending_id: id })
    }
}

/// Waits for the redirect (the listener is consumed, so the port is freed on return), exchanges the code, saves the key.
async fn run(listener: TcpListener, state: &str, verifier: &str, exchange_url: &Url, expiry: Duration, store: Arc<dyn SecretStore>) -> LoginStatus {
    let code = match await_callback(listener, state, None, false, expiry).await {
        Ok(c) => Zeroizing::new(c),
        // the wait ending without a redirect is an expiry; any other end (a listener failure) is a plain failure
        Err(RhError::Protocol(m)) if m.contains("timed out") => return LoginStatus::Expired,
        Err(_) => return LoginStatus::Failed,
    };
    let Some(key) = exchange(exchange_url, &code, verifier).await else { return LoginStatus::Failed };
    let saved = tauri::async_runtime::spawn_blocking(move || config::set_config_ex(&*store, "openrouter", None, Some(key.as_str()), None, None, None).is_ok()).await.unwrap_or(false);
    if saved {
        LoginStatus::Done
    } else {
        LoginStatus::Failed
    }
}

/// `POST {code, code_verifier, code_challenge_method}`; returns the key only when it has the OpenRouter key shape. Never follows a redirect, never logs.
async fn exchange(url: &Url, code: &str, verifier: &str) -> Option<Zeroizing<String>> {
    let http = reqwest::Client::builder().timeout(EXCHANGE_TIMEOUT).redirect(reqwest::redirect::Policy::none()).build().ok()?;
    let body = json!({"code": code, "code_verifier": verifier, "code_challenge_method": "S256"});
    let resp = http.post(url.clone()).header("content-type", "application/json").body(body.to_string()).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let bytes = resp.bytes().await.ok()?;
    if bytes.len() > 16 * 1024 {
        return None;
    }
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    let key = Zeroizing::new(v.get("key")?.as_str()?.trim().to_string());
    let p = super::provider::preset("openrouter")?;
    config::valid_key(p, &key).then_some(key)
}
