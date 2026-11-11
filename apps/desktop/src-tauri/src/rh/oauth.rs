//! OAuth 2.1 for the Robinhood Trading MCP: discovery, dynamic client registration, PKCE, one-shot
//! loopback redirect, token exchange and refresh. Nothing here logs; errors never carry secrets.
use std::time::Duration;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use url::Url;
use zeroize::Zeroizing;

use crate::rh::error::{clip, RhError};
use crate::rh::tokens::{now_unix, save_tokens, SLOT};
use crate::secrets::SecretStore;
pub use crate::rh::tokens::{StoredTokens, VaultTokenProvider, REFRESH_SKEW_SEC};

pub const LOGIN_TIMEOUT: Duration = Duration::from_secs(300);
/// Used when `expires_in` is missing from a token response.
const DEFAULT_EXPIRES_IN: i64 = 24 * 3600;

#[derive(Clone, Debug)]
pub struct OAuthConfig {
    /// https://agent.robinhood.com/mcp/trading
    pub resource: Url,
    pub as_metadata_url: Url,
    /// "internal"
    pub scope: String,
}

impl OAuthConfig {
    /// UNVERIFIED: the metadata URL is a guess (RFC 8414 root path); nothing was fetched from Robinhood.
    /// If it answers 4xx, `discover` falls back to the endpoints used by public prior art.
    pub fn robinhood() -> Self {
        Self {
            resource: Url::parse("https://agent.robinhood.com/mcp/trading").expect("static url"),
            as_metadata_url: Url::parse("https://agent.robinhood.com/.well-known/oauth-authorization-server")
                .expect("static url"),
            scope: "internal".into(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Metadata {
    pub issuer: Option<String>,
    pub authorization_endpoint: Url,
    pub token_endpoint: Url,
    pub registration_endpoint: Url,
    pub iss_required: bool,
}

pub trait UrlOpener: Send + Sync {
    fn open(&self, url: &Url) -> Result<(), RhError>;
}

/// Only https URLs on robinhood.com (or a subdomain) may be handed to the system browser.
pub fn is_allowed_authorize_url(u: &Url) -> bool {
    u.scheme() == "https"
        && u.host_str().is_some_and(|h| h == "robinhood.com" || h.ends_with(".robinhood.com"))
}

/// Production opener: Rust-side call into tauri-plugin-opener. The webview gets no opener permission.
pub struct TauriOpener<R: tauri::Runtime>(pub tauri::AppHandle<R>);

impl<R: tauri::Runtime> UrlOpener for TauriOpener<R> {
    fn open(&self, url: &Url) -> Result<(), RhError> {
        use tauri_plugin_opener::OpenerExt;
        if !is_allowed_authorize_url(url) {
            return Err(RhError::Protocol("refusing to open a non-Robinhood authorize URL".into()));
        }
        self.0
            .opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|_| RhError::Transport("could not open the system browser".into()))
    }
}

pub(crate) fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn transport(e: reqwest::Error) -> RhError {
    RhError::Transport(e.without_url().to_string())
}

fn is_loopback(u: &Url) -> bool {
    matches!(u.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]"))
}

fn require_secure(u: &Url, what: &str) -> Result<(), RhError> {
    if u.scheme() == "https" || (u.scheme() == "http" && is_loopback(u)) {
        Ok(())
    } else {
        Err(RhError::Protocol(format!("{what} must be https")))
    }
}

/// Discovered OAuth endpoints: https on robinhood.com or a subdomain. Loopback http only in tests (mock servers).
fn require_robinhood(u: &Url, what: &str) -> Result<(), RhError> {
    let rh_https = u.scheme() == "https" && u.host_str().is_some_and(|h| h == "robinhood.com" || h.ends_with(".robinhood.com"));
    let test_loopback = cfg!(test) && u.scheme() == "http" && is_loopback(u);
    if rh_https || test_loopback {
        Ok(())
    } else {
        Err(RhError::Protocol(format!("{what} must be an https robinhood.com URL")))
    }
}

pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub(crate) fn random_token() -> Result<String, RhError> {
    let mut b = [0u8; 32];
    getrandom::fill(&mut b).map_err(|_| RhError::Protocol("system randomness unavailable".into()))?;
    Ok(URL_SAFE_NO_PAD.encode(b))
}

/// (verifier, S256 challenge). The verifier is 43 URL-safe characters. Fails rather than use a weak verifier.
pub fn pkce_pair() -> Result<(String, String), RhError> {
    let v = random_token()?;
    if v.len() < 43 {
        return Err(RhError::Protocol("could not create a PKCE verifier".into()));
    }
    let c = challenge_for(&v);
    Ok((v, c))
}

fn url_field(v: &Value, k: &str) -> Result<Url, RhError> {
    let s = v[k].as_str().ok_or_else(|| RhError::Protocol(format!("metadata missing {k}")))?;
    let u = Url::parse(s).map_err(|_| RhError::Protocol(format!("metadata {k} is not a URL")))?;
    require_robinhood(&u, k)?;
    Ok(u)
}

pub(crate) async fn discover(http: &reqwest::Client, cfg: &OAuthConfig) -> Result<Metadata, RhError> {
    require_secure(&cfg.as_metadata_url, "metadata url")?;
    let resp = http
        .get(cfg.as_metadata_url.clone())
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(transport)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(transport)?;
    if status == 404 {
        // No metadata document: prior-art endpoints (unverified here), only for the real Robinhood agent host.
        // Any other 4xx is an answer from the server and is reported, not papered over.
        if cfg.resource.host_str() == Some("agent.robinhood.com") {
            let u = |s: &str| Url::parse(s).expect("static url");
            return Ok(Metadata {
                issuer: None,
                authorization_endpoint: u("https://robinhood.com/oauth"),
                token_endpoint: u("https://api.robinhood.com/oauth2/token/"),
                registration_endpoint: u("https://agent.robinhood.com/oauth/trading/register"),
                iss_required: false,
            });
        }
        return Err(RhError::Http(status, clip(&text, None)));
    }
    if !(200..300).contains(&status) {
        return Err(RhError::Http(status, clip(&text, None)));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| RhError::Protocol("metadata is not JSON".into()))?;
    Ok(Metadata {
        issuer: v["issuer"].as_str().map(String::from),
        authorization_endpoint: url_field(&v, "authorization_endpoint")?,
        token_endpoint: url_field(&v, "token_endpoint")?,
        registration_endpoint: url_field(&v, "registration_endpoint")?,
        iss_required: v["authorization_response_iss_parameter_supported"].as_bool().unwrap_or(false),
    })
}

async fn register(http: &reqwest::Client, meta: &Metadata, redirect: &str, scope: &str) -> Result<String, RhError> {
    let body = json!({
        "client_name": super::mcp::CLIENT_NAME,
        "redirect_uris": [redirect],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "application_type": "native",
        "scope": scope,
    });
    let resp = http
        .post(meta.registration_endpoint.clone())
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(transport)?;
    let status = resp.status().as_u16();
    let text = resp.text().await.map_err(transport)?;
    if !(200..300).contains(&status) {
        return Err(RhError::Http(status, clip(&text, None)));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| RhError::Protocol("registration reply is not JSON".into()))?;
    v["client_id"]
        .as_str()
        .map(String::from)
        .ok_or_else(|| RhError::Protocol("registration returned no client_id".into()))
}

fn scrub(text: &str, secrets: &[&str]) -> String {
    let mut t = text.to_string();
    for s in secrets {
        if !s.is_empty() {
            t = t.replace(s, "[redacted]");
        }
    }
    clip(&t, None)
}

/// POSTs a form to the token endpoint and builds the next stored pair.
async fn token_request(
    http: &reqwest::Client,
    meta: &Metadata,
    form: &[(&str, &str)],
    client_id: &str,
    redirect_uri: &str,
    keep_refresh: Option<&str>,
    now: i64,
) -> Result<StoredTokens, RhError> {
    let secrets: Vec<&str> = form
        .iter()
        .filter(|(k, _)| matches!(*k, "code" | "code_verifier" | "refresh_token"))
        .map(|(_, v)| *v)
        .collect();
    let resp = http
        .post(meta.token_endpoint.clone())
        .header("Accept", "application/json")
        .form(form)
        .send()
        .await
        .map_err(transport)?;
    let status = resp.status().as_u16();
    let text = Zeroizing::new(resp.text().await.map_err(transport)?);
    if !(200..300).contains(&status) {
        if status == 400 && text.contains("invalid_grant") {
            return Err(RhError::Unauthorized);
        }
        return Err(RhError::Http(status, scrub(&text, &secrets)));
    }
    let v: Value = serde_json::from_str(&text).map_err(|_| RhError::Protocol("token reply is not JSON".into()))?;
    let access = v["access_token"].as_str().ok_or_else(|| RhError::Protocol("token reply has no access_token".into()))?;
    let refresh = match (v["refresh_token"].as_str(), keep_refresh) {
        (Some(r), _) => r,
        (None, Some(old)) => old,
        (None, None) => return Err(RhError::Protocol("token reply has no refresh_token".into())),
    };
    let expires_in = v["expires_in"].as_i64().filter(|n| *n > 0).unwrap_or(DEFAULT_EXPIRES_IN);
    let expires_at = now.checked_add(expires_in).ok_or_else(|| RhError::Protocol("token lifetime is out of range".into()))?;
    Ok(StoredTokens {
        client_id: client_id.to_string(),
        redirect_uri: redirect_uri.to_string(),
        access_token: access.to_string(),
        refresh_token: refresh.to_string(),
        expires_at,
        issued_at: now,
    })
}

pub(crate) async fn refresh_grant(
    http: &reqwest::Client,
    meta: &Metadata,
    cur: &StoredTokens,
    now: i64,
) -> Result<StoredTokens, RhError> {
    token_request(
        http,
        meta,
        &[("grant_type", "refresh_token"), ("refresh_token", &cur.refresh_token), ("client_id", &cur.client_id)],
        &cur.client_id,
        &cur.redirect_uri,
        Some(&cur.refresh_token),
        now,
    )
    .await
}

// ---- loopback callback ----------------------------------------------------------------------------

/// Pure decision on the redirect target (`/callback?...`). `None`: not our redirect (missing or wrong state, so
/// it may be a stray or forged request), keep waiting. `Some(result)`: the login ends with this.
fn evaluate_callback(target: &str, state: &str, issuer: Option<&str>, iss_required: bool) -> Option<Result<String, RhError>> {
    let Ok(u) = Url::parse(&format!("http://127.0.0.1{target}")) else { return None };
    let get = |k: &str| u.query_pairs().find(|(a, _)| a == k).map(|(_, v)| v.into_owned());
    let got_state = get("state").unwrap_or_default();
    let same = got_state.len() == state.len()
        && got_state.bytes().zip(state.bytes()).fold(0u8, |a, (x, y)| a | (x ^ y)) == 0;
    if !same {
        return None;
    }
    Some(decide_callback(&get, issuer, iss_required))
}

fn decide_callback(get: &dyn Fn(&str) -> Option<String>, issuer: Option<&str>, iss_required: bool) -> Result<String, RhError> {
    if let Some(err) = get("error") {
        let safe: String = err.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_').take(40).collect();
        return Err(RhError::Protocol(format!("authorization failed: {safe}")));
    }
    match (get("iss"), issuer) {
        (Some(iss), Some(expected)) if iss != expected => return Err(RhError::Protocol("issuer mismatch in OAuth callback".into())),
        (None, _) if iss_required => return Err(RhError::Protocol("OAuth callback is missing iss".into())),
        _ => {}
    }
    get("code")
        .filter(|c| !c.is_empty())
        .ok_or_else(|| RhError::Protocol("OAuth callback has no code".into()))
}

async fn read_head(sock: &mut TcpStream) -> Option<String> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") && buf.len() < 8192 {
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    String::from_utf8_lossy(&buf).lines().next().map(String::from)
}

async fn respond(sock: &mut TcpStream, status: &str, body: &str) {
    let out = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\n\r\n{body}",
        body.len()
    );
    let _ = sock.write_all(out.as_bytes()).await;
    let _ = sock.shutdown().await;
}

/// Waits for the single OAuth redirect on `listener`; the listener is consumed so the port is freed on return.
/// Requests to other paths (favicon etc.) get a 404, and `/callback` requests without the right `state` get a
/// 400; neither ends the wait. The first `/callback` with the right state decides.
pub(crate) async fn await_callback(
    listener: TcpListener,
    state: &str,
    issuer: Option<&str>,
    iss_required: bool,
    wait: Duration,
) -> Result<String, RhError> {
    let run = async {
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return Err(RhError::Transport("loopback listener failed".into()));
            };
            let Ok(Some(line)) = tokio::time::timeout(Duration::from_secs(5), read_head(&mut sock)).await else {
                continue;
            };
            let mut parts = line.split(' ');
            let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or(""));
            if method != "GET" || !(target == "/callback" || target.starts_with("/callback?")) {
                respond(&mut sock, "404 Not Found", "Not found").await;
                continue;
            }
            let Some(res) = evaluate_callback(target, state, issuer, iss_required) else {
                respond(&mut sock, "400 Bad Request", "<h3>TraderMatrix Desktop: this link does not belong to the login in progress.</h3>").await;
                continue;
            };
            match &res {
                Ok(_) => respond(&mut sock, "200 OK", "<h3>TraderMatrix Desktop: login complete. You can close this tab.</h3>").await,
                Err(_) => respond(&mut sock, "400 Bad Request", "<h3>TraderMatrix Desktop: login failed. Return to the app.</h3>").await,
            }
            return res;
        }
    };
    match tokio::time::timeout(wait, run).await {
        Ok(r) => r,
        Err(_) => Err(RhError::Protocol("login timed out waiting for the browser".into())),
    }
}

pub async fn login(cfg: &OAuthConfig, opener: &dyn UrlOpener, store: &dyn SecretStore) -> Result<(), RhError> {
    let tokens = obtain_tokens(cfg, opener).await?;
    save_tokens(store, &tokens)
}

/// The whole browser login, returning the new pair without storing it (the caller stores it under its own lock).
pub async fn obtain_tokens(cfg: &OAuthConfig, opener: &dyn UrlOpener) -> Result<StoredTokens, RhError> {
    let http = http_client();
    let meta = discover(&http, cfg).await?;
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|_| RhError::Transport("could not bind loopback port".into()))?;
    let port = listener.local_addr().map_err(|_| RhError::Transport("no loopback port".into()))?.port();
    let redirect = format!("http://127.0.0.1:{port}/callback");
    let client_id = register(&http, &meta, &redirect, &cfg.scope).await?;

    let (verifier, challenge) = pkce_pair()?;
    let verifier = Zeroizing::new(verifier);
    let state = random_token()?;
    let mut auth = meta.authorization_endpoint.clone();
    auth.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", &client_id)
        .append_pair("redirect_uri", &redirect)
        .append_pair("scope", &cfg.scope)
        .append_pair("state", &state)
        .append_pair("code_challenge", &challenge)
        .append_pair("code_challenge_method", "S256");
    opener.open(&auth)?;

    let code = Zeroizing::new(await_callback(listener, &state, meta.issuer.as_deref(), meta.iss_required, LOGIN_TIMEOUT).await?);
    token_request(
        &http,
        &meta,
        &[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect),
            ("client_id", &client_id),
            ("code_verifier", &verifier),
        ],
        &client_id,
        &redirect,
        None,
        now_unix(),
    )
    .await
}

/// Deletes the local credentials. Robinhood exposes no revocation endpoint, so the server-side
/// grant stays valid until it expires or is revoked in the Robinhood app.
pub fn logout(store: &dyn SecretStore) -> Result<(), RhError> {
    store.delete(SLOT).map_err(|e| RhError::Protocol(format!("secret store: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use crate::rh::mcp::TokenProvider;
    use crate::rh::testutil::{Mock, Req, Resp};
    use crate::rh::tokens::{load_tokens, now_unix, save_tokens, SLOT};
    use crate::secrets::{BackendStatus, MemoryStore};
    use serde_json::json;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    // ---- helpers -------------------------------------------------------------------------------

    #[derive(Default)]
    struct AsState {
        valid_refresh: Mutex<String>,
        challenge: Mutex<Option<String>>,
        token_calls: AtomicUsize,
        refresh_calls: AtomicUsize,
        refresh_n: AtomicUsize,
    }

    fn form(req: &Req) -> std::collections::HashMap<String, String> {
        url::form_urlencoded::parse(req.body.as_bytes()).into_owned().collect()
    }

    /// Mock authorization server + resource metadata. `iss` toggles the issuer in the metadata.
    async fn mock_as(st: Arc<AsState>) -> Mock {
        *st.valid_refresh.lock().unwrap() = "rt-1".into();
        Mock::start(move |req, _| {
            let base = format!("http://{}", req.header("host").unwrap());
            match (req.method.as_str(), req.path.as_str()) {
                ("GET", "/.well-known/oauth-authorization-server") => Some(Resp::json(
                    200,
                    &json!({
                        "issuer": base,
                        "authorization_endpoint": format!("{base}/authorize"),
                        "token_endpoint": format!("{base}/token"),
                        "registration_endpoint": format!("{base}/register"),
                        "code_challenge_methods_supported": ["S256"],
                    }),
                )),
                ("POST", "/register") => Some(Resp::json(201, &json!({"client_id": "client-xyz"}))),
                ("POST", "/token") => {
                    st.token_calls.fetch_add(1, Ordering::SeqCst);
                    let f = form(req);
                    match f.get("grant_type").map(String::as_str) {
                        Some("authorization_code") => {
                            let ch = st.challenge.lock().unwrap().clone().unwrap_or_default();
                            let ok = f.get("code").map(String::as_str) == Some("code-1")
                                && f.get("client_id").map(String::as_str) == Some("client-xyz")
                                && f.get("code_verifier").map(|v| challenge_for(v) == ch).unwrap_or(false)
                                && f.contains_key("redirect_uri");
                            if ok {
                                Some(Resp::json(200, &json!({"access_token":"at-1","refresh_token":"rt-1","expires_in":7200,"token_type":"Bearer"})))
                            } else {
                                Some(Resp::json(400, &json!({"error":"invalid_grant"})))
                            }
                        }
                        Some("refresh_token") => {
                            st.refresh_calls.fetch_add(1, Ordering::SeqCst);
                            let mut valid = st.valid_refresh.lock().unwrap();
                            if f.get("refresh_token") == Some(&*valid) {
                                let n = st.refresh_n.fetch_add(1, Ordering::SeqCst) + 2;
                                *valid = format!("rt-{n}");
                                Some(Resp::json(200, &json!({"access_token":format!("at-{n}"),"refresh_token":format!("rt-{n}"),"expires_in":7200})))
                            } else {
                                Some(Resp::json(400, &json!({"error":"invalid_grant"})))
                            }
                        }
                        _ => Some(Resp::status(400)),
                    }
                }
                _ => Some(Resp::status(404)),
            }
        })
        .await
    }

    fn cfg(m: &Mock) -> OAuthConfig {
        OAuthConfig {
            resource: m.url("/mcp/trading"),
            as_metadata_url: m.url("/.well-known/oauth-authorization-server"),
            scope: "internal".into(),
        }
    }

    type Hook = Box<dyn Fn(&Url) + Send + Sync>;
    struct FnOpener(Hook);
    impl UrlOpener for FnOpener {
        fn open(&self, url: &Url) -> Result<(), RhError> {
            (self.0)(url);
            Ok(())
        }
    }

    fn q(url: &Url, k: &str) -> String {
        url.query_pairs().find(|(a, _)| a == k).map(|(_, v)| v.into_owned()).unwrap_or_default()
    }

    /// Opener that plays the browser: records the PKCE challenge in the mock, then calls the redirect.
    fn browser(st: Arc<AsState>, tail: &'static str, extra: Option<&'static str>) -> FnOpener {
        FnOpener(Box::new(move |url| {
            *st.challenge.lock().unwrap() = Some(q(url, "code_challenge"));
            let redirect = q(url, "redirect_uri");
            let state = q(url, "state");
            let target = tail.replace("{state}", &state);
            let first = format!("{redirect}?{target}");
            let second = extra.map(|e| format!("{redirect}?{e}"));
            tokio::spawn(async move {
                let c = reqwest::Client::new();
                let _ = c.get(first).send().await;
                if let Some(s) = second {
                    let _ = c.get(s).send().await;
                }
            });
        }))
    }

    async fn port_is_free(redirect: &str) -> bool {
        let u = Url::parse(redirect).unwrap();
        TcpListener::bind(("127.0.0.1", u.port().unwrap())).await.is_ok()
    }

    /// Store spy: records `set` calls, can be told to fail.
    #[derive(Default)]
    struct SpyStore {
        inner: MemoryStore,
        sets: Mutex<Vec<String>>,
        fail_set: AtomicBool,
    }
    impl SecretStore for SpyStore {
        fn set(&self, slot: &str, value: &str) -> Result<(), AppError> {
            if self.fail_set.load(Ordering::SeqCst) {
                return Err(AppError::Secret("disk full".into()));
            }
            self.sets.lock().unwrap().push(value.to_string());
            self.inner.set(slot, value)
        }
        fn exists(&self, slot: &str) -> Result<bool, AppError> {
            self.inner.exists(slot)
        }
        fn delete(&self, slot: &str) -> Result<(), AppError> {
            self.inner.delete(slot)
        }
        fn get(&self, slot: &str) -> Result<Option<String>, AppError> {
            self.inner.get(slot)
        }
        fn status(&self) -> BackendStatus {
            self.inner.status()
        }
    }

    fn seed(store: &dyn SecretStore, expires_at: i64) {
        save_tokens(
            store,
            &StoredTokens {
                client_id: "client-xyz".into(),
                redirect_uri: "http://127.0.0.1:1/callback".into(),
                access_token: "at-1".into(),
                refresh_token: "rt-1".into(),
                expires_at,
                issued_at: 0,
            },
        )
        .unwrap();
    }

    fn assert_no_secrets(e: &RhError, secrets: &[&str]) {
        let t = format!("{e} {e:?}");
        for s in secrets {
            assert!(!t.contains(s), "error text leaked a secret: {t}");
        }
    }

    // ---- PKCE ----------------------------------------------------------------------------------

    #[test]
    fn pkce_matches_rfc7636_appendix_b() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn pkce_pair_is_consistent_and_random() {
        let (v1, c1) = pkce_pair().unwrap();
        let (v2, _) = pkce_pair().unwrap();
        assert_ne!(v1, v2);
        assert_eq!(challenge_for(&v1), c1);
        assert!(v1.len() >= 43 && v1.len() <= 128);
        assert!(v1.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
    }

    // ---- login ---------------------------------------------------------------------------------

    #[tokio::test]
    async fn full_login_stores_tokens() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store = MemoryStore::new();
        let opened = Arc::new(Mutex::new(None::<Url>));
        let o2 = opened.clone();
        let st2 = st.clone();
        let inner = browser(st2, "code=code-1&state={state}", None);
        let opener = FnOpener(Box::new(move |u| {
            *o2.lock().unwrap() = Some(u.clone());
            (inner.0)(u)
        }));
        login(&cfg(&m), &opener, &store).await.unwrap();

        let t = load_tokens(&store).unwrap().unwrap();
        assert_eq!(t.client_id, "client-xyz");
        assert_eq!(t.access_token, "at-1");
        assert_eq!(t.refresh_token, "rt-1");
        assert!((t.expires_at - (now_unix() + 7200)).abs() < 10);
        assert!(t.redirect_uri.starts_with("http://127.0.0.1:") && t.redirect_uri.ends_with("/callback"));

        let url = opened.lock().unwrap().clone().unwrap();
        assert_eq!(url.path(), "/authorize");
        assert_eq!(q(&url, "response_type"), "code");
        assert_eq!(q(&url, "client_id"), "client-xyz");
        assert_eq!(q(&url, "code_challenge_method"), "S256");
        assert_eq!(q(&url, "scope"), "internal");
        assert!(!q(&url, "state").is_empty());
        // Exactly the parameter set of the known-working client (kevin1chun/robinhood-for-agents). We once also sent
        // `resource=` (RFC 8707); Robinhood's authorize step looped after 2FA, so it must NOT be sent.
        let mut keys: Vec<String> = url.query_pairs().map(|(k, _)| k.into_owned()).collect();
        keys.sort();
        assert_eq!(
            keys,
            ["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "response_type", "scope", "state"]
        );

        let reqs = m.requests();
        let reg = reqs.iter().find(|r| r.path == "/register").unwrap().json();
        assert_eq!(reg["client_name"], "TraderMatrix Desktop");
        assert_eq!(reg["token_endpoint_auth_method"], "none");
        assert_eq!(reg["application_type"], "native");
        assert_eq!(reg["grant_types"], json!(["authorization_code", "refresh_token"]));
        assert_eq!(reg["response_types"], json!(["code"]));
        assert_eq!(reg["scope"], "internal");
        assert_eq!(reg["redirect_uris"][0], t.redirect_uri);
        let tok = reqs.iter().find(|r| r.path == "/token").unwrap();
        assert!(tok.header("content-type").unwrap().starts_with("application/x-www-form-urlencoded"));
    }

    /// R6 (changed 2026-11-11): a callback with the wrong state is ignored (it may be a stray or hostile request),
    /// so the wait goes on until the real redirect or the timeout. Port freed, no token request.
    #[tokio::test]
    async fn wrong_state_is_ignored_until_timeout_and_frees_the_port() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        tokio::spawn(async move {
            let c = reqwest::Client::new();
            let _ = c.get(format!("http://127.0.0.1:{port}/callback?code=code-1&state=WRONG")).send().await;
            let _ = c.get(format!("http://127.0.0.1:{port}/callback?error=access_denied&state=WRONG")).send().await;
        });
        let e = await_callback(l, "right-state", None, false, Duration::from_millis(800)).await.unwrap_err();
        assert!(matches!(&e, RhError::Protocol(t) if t.contains("timed out")), "{e:?}");
        assert_no_secrets(&e, &["code-1"]);
        assert!(TcpListener::bind(("127.0.0.1", port)).await.is_ok(), "port must be freed");
    }

    #[tokio::test]
    async fn a_wrong_state_callback_does_not_end_the_login() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store = MemoryStore::new();
        let st2 = st.clone();
        let opener = FnOpener(Box::new(move |url| {
            *st2.challenge.lock().unwrap() = Some(q(url, "code_challenge"));
            let redirect = q(url, "redirect_uri");
            let state = q(url, "state");
            tokio::spawn(async move {
                let c = reqwest::Client::new();
                let _ = c.get(format!("{redirect}?code=evil&state=WRONG")).send().await;
                let _ = c.get(format!("{redirect}?error=access_denied&state=WRONG")).send().await;
                let _ = c.get(format!("{redirect}?code=code-1&state={state}")).send().await;
            });
        }));
        login(&cfg(&m), &opener, &store).await.unwrap();
        assert_eq!(st.token_calls.load(Ordering::SeqCst), 1);
        assert_eq!(load_tokens(&store).unwrap().unwrap().access_token, "at-1");
    }

    /// R6: the pinned fallback is for a missing metadata document (404) only; other 4xx are errors.
    #[tokio::test]
    async fn discovery_falls_back_on_404_only() {
        for (status, fallback) in [(404u16, true), (403, false), (400, false), (410, false)] {
            let m = Mock::start(move |_, _| Some(Resp::status(status))).await;
            let c = OAuthConfig {
                resource: Url::parse("https://agent.robinhood.com/mcp/trading").unwrap(),
                as_metadata_url: m.url("/.well-known/oauth-authorization-server"),
                scope: "internal".into(),
            };
            let r = discover(&http_client(), &c).await;
            if fallback {
                assert_eq!(r.unwrap().token_endpoint.as_str(), "https://api.robinhood.com/oauth2/token/");
            } else {
                assert!(matches!(r, Err(RhError::Http(s, _)) if s == status), "{status}");
            }
            assert_eq!(m.count(), 1);
        }
    }

    /// R6: discovered endpoints must be https on robinhood.com (loopback http only in tests).
    #[tokio::test]
    async fn discovered_endpoints_must_be_robinhood_https() {
        let meta = |a: &str, t: &str, r: &str| json!({"authorization_endpoint": a, "token_endpoint": t, "registration_endpoint": r});
        let good = "https://api.robinhood.com/oauth2/token/";
        for (body, ok) in [
            (meta("https://robinhood.com/oauth", good, "https://agent.robinhood.com/oauth/trading/register"), true),
            (meta("https://robinhood.com/oauth", "https://evil.invalid/token", "https://agent.robinhood.com/r"), false),
            (meta("https://robinhood.com/oauth", good, "https://robinhood.com.evil.invalid/r"), false),
            (meta("https://evil.invalid/authorize", good, "https://agent.robinhood.com/r"), false),
            (meta("https://robinhood.com/oauth", "http://api.robinhood.com/t", "https://agent.robinhood.com/r"), false),
        ] {
            let b2 = body.clone();
            let m = Mock::start(move |_, _| Some(Resp::json(200, &b2))).await;
            let r = discover(&http_client(), &cfg(&m)).await;
            assert_eq!(r.is_ok(), ok, "{body}: {r:?}");
        }
    }

    /// R6: a token lifetime that would overflow is an error, not a panic or a wrapped expiry.
    #[tokio::test]
    async fn absurd_expires_in_is_refused() {
        let m = Mock::start(|req, _| {
            let base = format!("http://{}", req.header("host").unwrap());
            match req.path.as_str() {
                "/.well-known/oauth-authorization-server" => Some(Resp::json(
                    200,
                    &json!({"authorization_endpoint":format!("{base}/authorize"),"token_endpoint":format!("{base}/token"),"registration_endpoint":format!("{base}/register")}),
                )),
                "/token" => Some(Resp::json(200, &json!({"access_token":"at-x","refresh_token":"rt-x","expires_in":i64::MAX}))),
                _ => Some(Resp::status(404)),
            }
        })
        .await;
        let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        seed(&*store, 0);
        let p = VaultTokenProvider::new(cfg(&m), store.clone());
        let e = p.access_token().await.unwrap_err();
        assert!(matches!(e, RhError::Protocol(_)), "{e:?}");
        assert_no_secrets(&e, &["at-x", "rt-x"]);
    }

    /// R4: refresh skew is min(3600, lifetime/2), so a 10-minute token is not refreshed on every call.
    #[tokio::test]
    async fn short_lived_tokens_use_half_their_lifetime_as_skew() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        let now = now_unix();
        save_tokens(
            &*store,
            &StoredTokens { client_id: "client-xyz".into(), redirect_uri: "r".into(), access_token: "at-1".into(), refresh_token: "rt-1".into(), expires_at: now + 600, issued_at: now },
        )
        .unwrap();
        let p = VaultTokenProvider::new(cfg(&m), store.clone());
        assert_eq!(p.access_token().await.unwrap(), "at-1");
        assert_eq!(m.count(), 0, "300 s of the 600 s lifetime remain: no refresh");
        save_tokens(
            &*store,
            &StoredTokens { client_id: "client-xyz".into(), redirect_uri: "r".into(), access_token: "at-1".into(), refresh_token: "rt-1".into(), expires_at: now + 200, issued_at: now - 400 },
        )
        .unwrap();
        assert_eq!(p.access_token().await.unwrap(), "at-2", "inside the last half: refreshed");
        let t = load_tokens(&*store).unwrap().unwrap();
        assert!((t.issued_at - now_unix()).abs() < 10, "issued_at is recorded on refresh");
    }

    /// R4: logout under the provider lock drops a rotated-but-unsaved pair, so it cannot resurrect the session.
    #[tokio::test]
    async fn logout_discards_a_pending_pair() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let spy = Arc::new(SpyStore::default());
        seed(&*spy, 0);
        let p = VaultTokenProvider::new(cfg(&m), spy.clone());
        spy.fail_set.store(true, Ordering::SeqCst);
        assert!(p.access_token().await.is_err(), "the rotated pair is pending");
        p.logout().await.unwrap();
        spy.fail_set.store(false, Ordering::SeqCst);
        assert_eq!(p.access_token().await.unwrap_err(), RhError::NotConnected, "pending pair must not be written back after logout");
        assert!(!spy.exists(SLOT).unwrap());
    }

    #[tokio::test]
    async fn access_denied_callback_errors_and_frees_port() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store = MemoryStore::new();
        let redirect = Arc::new(Mutex::new(String::new()));
        let r2 = redirect.clone();
        let inner = browser(st.clone(), "error=access_denied&state={state}", None);
        let opener = FnOpener(Box::new(move |u| {
            *r2.lock().unwrap() = q(u, "redirect_uri");
            (inner.0)(u)
        }));
        let e = login(&cfg(&m), &opener, &store).await.unwrap_err();
        assert!(matches!(&e, RhError::Protocol(t) if t.contains("access_denied")), "{e:?}");
        assert!(!store.exists(SLOT).unwrap());
        assert_eq!(st.token_calls.load(Ordering::SeqCst), 0);
        let r = redirect.lock().unwrap().clone();
        assert!(port_is_free(&r).await);
    }

    #[tokio::test]
    async fn missing_code_and_foreign_issuer_are_rejected() {
        for tail in ["state={state}", "code=code-1&state={state}&iss=https%3A%2F%2Fevil.example"] {
            let st = Arc::new(AsState::default());
            let m = mock_as(st.clone()).await;
            let store = MemoryStore::new();
            let e = login(&cfg(&m), &browser(st.clone(), tail, None), &store).await.unwrap_err();
            assert!(matches!(e, RhError::Protocol(_)), "{tail}: {e:?}");
            assert!(!store.exists(SLOT).unwrap());
            assert_eq!(st.token_calls.load(Ordering::SeqCst), 0);
        }
    }

    #[tokio::test]
    async fn second_callback_request_is_ignored() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store = MemoryStore::new();
        let opener = browser(st.clone(), "code=code-1&state={state}", Some("code=evil&state=whatever"));
        login(&cfg(&m), &opener, &store).await.unwrap();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(st.token_calls.load(Ordering::SeqCst), 1);
        assert_eq!(load_tokens(&store).unwrap().unwrap().access_token, "at-1");
    }

    #[tokio::test]
    async fn stray_paths_do_not_end_the_login() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store = MemoryStore::new();
        let st2 = st.clone();
        let opener = FnOpener(Box::new(move |url| {
            *st2.challenge.lock().unwrap() = Some(q(url, "code_challenge"));
            let redirect = q(url, "redirect_uri");
            let state = q(url, "state");
            tokio::spawn(async move {
                let c = reqwest::Client::new();
                let base = redirect.trim_end_matches("/callback").to_string();
                let _ = c.get(format!("{base}/favicon.ico")).send().await;
                let _ = c.get(format!("{redirect}?code=code-1&state={state}")).send().await;
            });
        }));
        login(&cfg(&m), &opener, &store).await.unwrap();
        assert!(store.exists(SLOT).unwrap());
    }

    #[tokio::test(start_paused = true)]
    async fn listener_times_out_after_5_minutes_and_frees_port() {
        let l = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = l.local_addr().unwrap().port();
        let t0 = tokio::time::Instant::now();
        let e = await_callback(l, "s", None, false, LOGIN_TIMEOUT).await.unwrap_err();
        assert!(matches!(&e, RhError::Protocol(t) if t.contains("timed out")), "{e:?}");
        assert!(t0.elapsed() >= Duration::from_secs(300));
        assert!(TcpListener::bind(("127.0.0.1", port)).await.is_ok(), "port must be freed");
    }

    #[tokio::test]
    async fn failed_save_on_login_surfaces() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store = SpyStore::default();
        store.fail_set.store(true, Ordering::SeqCst);
        let e = login(&cfg(&m), &browser(st, "code=code-1&state={state}", None), &store).await.unwrap_err();
        assert!(matches!(e, RhError::Protocol(_)), "{e:?}");
        assert_no_secrets(&e, &["at-1", "rt-1"]);
    }

    #[tokio::test]
    async fn token_endpoint_error_does_not_leak_code_or_verifier() {
        let st = Arc::new(AsState::default());
        let m = Mock::start(|req, _| {
            let base = format!("http://{}", req.header("host").unwrap());
            match req.path.as_str() {
                "/.well-known/oauth-authorization-server" => Some(Resp::json(
                    200,
                    &json!({"issuer":base,"authorization_endpoint":format!("{base}/authorize"),"token_endpoint":format!("{base}/token"),"registration_endpoint":format!("{base}/register")}),
                )),
                "/register" => Some(Resp::json(201, &json!({"client_id":"c"}))),
                "/token" => {
                    let f = form(req);
                    let echo = format!("bad request: {} {}", f["code"], f["code_verifier"]);
                    Some(Resp::text(400, &echo))
                }
                _ => Some(Resp::status(404)),
            }
        })
        .await;
        let store = MemoryStore::new();
        let e = login(&cfg(&m), &browser(st, "code=SECRETCODE&state={state}", None), &store).await.unwrap_err();
        assert!(matches!(e, RhError::Http(400, _)), "{e:?}");
        let verifier = m.requests().iter().find(|r| r.path == "/token").map(|r| form(r)["code_verifier"].clone()).unwrap();
        assert_no_secrets(&e, &["SECRETCODE", &verifier]);
    }

    #[tokio::test]
    async fn insecure_non_loopback_endpoints_are_refused() {
        let m = Mock::start(|_, _| {
            Some(Resp::json(
                200,
                &json!({"authorization_endpoint":"http://evil.example/a","token_endpoint":"http://evil.example/t","registration_endpoint":"http://evil.example/r"}),
            ))
        })
        .await;
        let st = Arc::new(AsState::default());
        let e = login(&cfg(&m), &browser(st, "code=x&state={state}", None), &MemoryStore::new()).await.unwrap_err();
        assert!(matches!(e, RhError::Protocol(_)), "{e:?}");
    }

    #[tokio::test]
    async fn discovery_404_on_a_foreign_host_is_an_error_not_a_fallback() {
        let m = Mock::start(|_, _| Some(Resp::status(404))).await;
        let st = Arc::new(AsState::default());
        let e = login(&cfg(&m), &browser(st, "code=x&state={state}", None), &MemoryStore::new()).await.unwrap_err();
        assert!(matches!(e, RhError::Http(404, _)), "{e:?}");
    }

    #[test]
    fn robinhood_config_and_opener_allowlist() {
        let c = OAuthConfig::robinhood();
        assert_eq!(c.resource.as_str(), "https://agent.robinhood.com/mcp/trading");
        assert_eq!(c.scope, "internal");
        assert!(is_allowed_authorize_url(&Url::parse("https://robinhood.com/oauth?x=1").unwrap()));
        assert!(!is_allowed_authorize_url(&Url::parse("http://robinhood.com/oauth").unwrap()));
        assert!(!is_allowed_authorize_url(&Url::parse("https://robinhood.com.evil.example/oauth").unwrap()));
        assert!(!is_allowed_authorize_url(&Url::parse("https://evil.example/").unwrap()));
        assert!(!is_allowed_authorize_url(&Url::parse("file:///etc/passwd").unwrap()));
    }

    // ---- refresh -------------------------------------------------------------------------------

    #[tokio::test]
    async fn fresh_token_is_returned_without_network() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        seed(&*store, now_unix() + REFRESH_SKEW_SEC + 600);
        let p = VaultTokenProvider::new(cfg(&m), store);
        assert_eq!(p.access_token().await.unwrap(), "at-1");
        assert_eq!(m.count(), 0);
    }

    #[tokio::test]
    async fn not_connected_without_tokens() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st).await;
        let p = VaultTokenProvider::new(cfg(&m), Arc::new(MemoryStore::new()));
        assert_eq!(p.access_token().await.unwrap_err(), RhError::NotConnected);
    }

    #[tokio::test]
    async fn concurrent_expired_callers_cause_exactly_one_refresh() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let spy = Arc::new(SpyStore::default());
        seed(&*spy, 0);
        spy.sets.lock().unwrap().clear();
        let p = Arc::new(VaultTokenProvider::new(cfg(&m), spy.clone()));
        let (a, b, c) = tokio::join!(p.access_token(), p.access_token(), p.access_token());
        assert_eq!(a.unwrap(), "at-2");
        assert_eq!(b.unwrap(), "at-2");
        assert_eq!(c.unwrap(), "at-2");
        assert_eq!(st.refresh_calls.load(Ordering::SeqCst), 1, "refresh tokens are single-use");
        // Rotated pair persisted.
        let t = load_tokens(&*spy).unwrap().unwrap();
        assert_eq!((t.access_token.as_str(), t.refresh_token.as_str()), ("at-2", "rt-2"));
        assert_eq!(spy.sets.lock().unwrap().len(), 1);
        let refresh = m.requests().into_iter().find(|r| r.path == "/token").unwrap();
        let f = form(&refresh);
        assert_eq!(f["grant_type"], "refresh_token");
        assert_eq!(f["refresh_token"], "rt-1");
        assert_eq!(f["client_id"], "client-xyz");
    }

    #[tokio::test]
    async fn rotated_pair_is_saved_before_access_token_returns() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let spy = Arc::new(SpyStore::default());
        seed(&*spy, 0);
        spy.sets.lock().unwrap().clear();
        let p = VaultTokenProvider::new(cfg(&m), spy.clone());
        let tok = p.access_token().await.unwrap();
        let sets = spy.sets.lock().unwrap().clone();
        assert_eq!(sets.len(), 1);
        assert!(sets[0].contains(&tok), "save happened by the time the token was returned");
    }

    #[tokio::test]
    async fn failed_save_surfaces_and_the_pair_is_not_lost() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let spy = Arc::new(SpyStore::default());
        seed(&*spy, 0);
        let p = VaultTokenProvider::new(cfg(&m), spy.clone());
        spy.fail_set.store(true, Ordering::SeqCst);
        let e = p.access_token().await.unwrap_err();
        assert!(matches!(e, RhError::Protocol(_)), "{e:?}");
        assert_no_secrets(&e, &["at-2", "rt-2", "at-1", "rt-1"]);
        assert_eq!(st.refresh_calls.load(Ordering::SeqCst), 1);
        // Disk recovers: the pending pair is written without burning another refresh token.
        spy.fail_set.store(false, Ordering::SeqCst);
        assert_eq!(p.access_token().await.unwrap(), "at-2");
        assert_eq!(st.refresh_calls.load(Ordering::SeqCst), 1);
        assert_eq!(load_tokens(&*spy).unwrap().unwrap().refresh_token, "rt-2");
    }

    #[tokio::test]
    async fn rejected_refresh_is_unauthorized_and_leaks_nothing() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        seed(&*store, 0);
        *st.valid_refresh.lock().unwrap() = "something-else".into();
        let p = VaultTokenProvider::new(cfg(&m), store);
        let e = p.access_token().await.unwrap_err();
        assert_eq!(e, RhError::Unauthorized);
        assert_no_secrets(&e, &["rt-1", "at-1"]);
    }

    #[tokio::test]
    async fn force_refresh_refreshes_a_fresh_token_once() {
        let st = Arc::new(AsState::default());
        let m = mock_as(st.clone()).await;
        let store: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        seed(&*store, now_unix() + 100_000);
        let p = VaultTokenProvider::new(cfg(&m), store);
        let (a, b) = tokio::join!(p.force_refresh(), p.force_refresh());
        assert_eq!(a.unwrap(), "at-2");
        assert_eq!(b.unwrap(), "at-2");
        assert_eq!(st.refresh_calls.load(Ordering::SeqCst), 1);
    }

    // ---- logout / redaction ---------------------------------------------------------------------

    #[test]
    fn logout_deletes_the_slot_and_is_idempotent() {
        let store = MemoryStore::new();
        seed(&store, 1);
        logout(&store).unwrap();
        assert!(!store.exists(SLOT).unwrap());
        logout(&store).unwrap();
    }

    #[test]
    fn debug_of_tokens_is_redacted() {
        let t = StoredTokens {
            client_id: "c".into(),
            redirect_uri: "r".into(),
            access_token: "SECRET-A".into(),
            refresh_token: "SECRET-R".into(),
            expires_at: 1,
            issued_at: 0,
        };
        let d = format!("{t:?}");
        assert!(!d.contains("SECRET"), "{d}");
    }
}
