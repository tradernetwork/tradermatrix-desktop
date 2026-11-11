//! MCP over Streamable HTTP (JSON-RPC 2.0 POSTs). READ-ONLY policy lives in the callers; this layer
//! is transport: auth header, session id, SSE/JSON bodies, 401 refresh, rate limiting, safe retries.
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use crate::rh::error::{clip, RhError};
use crate::rh::limiter::Limiter;

const PROTOCOL_VERSION: &str = "2025-06-18";
/// Shown to Robinhood (MCP clientInfo and the OAuth client_name). Product name; the data identity (SERVICE, identifier) is deliberately unchanged.
pub const CLIENT_NAME: &str = "TraderMatrix Desktop";
/// Responses larger than this are refused (a hostile or broken server cannot exhaust memory).
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024;
const INIT_TIMEOUT: Duration = Duration::from_secs(10);
/// A failed `initialize` answers the callers queued behind it, and transport-class failures are reused for this long.
const INIT_FAIL_CACHE: Duration = Duration::from_secs(5);
const MAX_PAGES: usize = 50;
const READ_PREFIXES: [&str; 6] = ["get_", "search", "review_", "preview_", "run_scan", "list_"];

/// Only these may be retried after a transport failure or RATE_LIMITED.
pub fn is_read_tool(name: &str) -> bool {
    READ_PREFIXES.iter().any(|p| name.starts_with(p))
}

#[async_trait::async_trait]
pub trait TokenProvider: Send + Sync {
    async fn access_token(&self) -> Result<String, RhError>;
    async fn force_refresh(&self) -> Result<String, RhError>;
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
    pub protocol_version: String,
}

/// Lossless: unknown tool fields (annotations, title, outputSchema...) survive in `rest`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ToolDef {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(flatten)]
    pub rest: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    /// `structuredContent` as sent (shape `{data, guide}`), else the text parsed as JSON, else None.
    pub structured: Option<Value>,
    pub text: String,
}

impl ToolResult {
    /// The payload: `structured.data` when present, otherwise `structured` itself.
    pub fn data(&self) -> Option<&Value> {
        let s = self.structured.as_ref()?;
        Some(s.get("data").unwrap_or(s))
    }
}

/// Single-flight gate for `McpClient::initialize`, shared by every command of one connection (RhState, TmState).
/// A failed attempt answers every caller that queued behind it, and transport-class failures are reused for
/// `INIT_FAIL_CACHE` so a dead server costs one attempt, not one per queued command.
pub struct InitGate {
    state: tokio::sync::Mutex<GateState>,
    fails: AtomicU64,
}

#[derive(Default)]
struct GateState {
    ok: bool,
    failed: Option<(std::time::Instant, RhError)>,
}

impl Default for InitGate {
    fn default() -> Self {
        Self::new()
    }
}

impl InitGate {
    pub fn new() -> Self {
        Self { state: tokio::sync::Mutex::new(GateState::default()), fails: AtomicU64::new(0) }
    }

    /// Credential problems are never reused (a fixed key or a fresh login must work at once).
    fn reusable(e: &RhError) -> bool {
        matches!(e, RhError::Transport(_) | RhError::RateLimited) || matches!(e, RhError::Http(s, _) if *s >= 500)
    }

    pub async fn ready(&self, c: &McpClient) -> Result<(), RhError> {
        let seen = self.fails.load(Ordering::SeqCst);
        let mut g = self.state.lock().await;
        if g.ok {
            return Ok(());
        }
        if let Some((at, e)) = &g.failed {
            let queued_behind_it = self.fails.load(Ordering::SeqCst) != seen;
            if at.elapsed() < INIT_FAIL_CACHE && (queued_behind_it || Self::reusable(e)) {
                return Err(e.clone());
            }
        }
        match c.initialize().await {
            Ok(_) => {
                g.ok = true;
                g.failed = None;
                Ok(())
            }
            Err(e) => {
                g.failed = Some((std::time::Instant::now(), e.clone()));
                self.fails.fetch_add(1, Ordering::SeqCst);
                Err(e)
            }
        }
    }

    /// Forget the session state (login, logout, rejected key): the next call initializes again.
    pub async fn reset(&self) {
        let mut g = self.state.lock().await;
        g.ok = false;
        g.failed = None;
    }
}

pub struct McpClient {
    http: reqwest::Client,
    endpoint: Url,
    tokens: Arc<dyn TokenProvider>,
    limiter: Arc<Limiter>,
    session: Mutex<Option<String>>,
    protocol: Mutex<Option<String>>,
    next_id: AtomicU64,
    rate_backoff: Duration,
    retry_delay: Duration,
    init_timeout: Duration,
    /// Resend a read once after RATE_LIMITED (default). TraderMatrix turns this off: a hidden resend would bypass its call budget.
    rate_retry: bool,
}

impl McpClient {
    pub fn new(endpoint: Url, tokens: Arc<dyn TokenProvider>, limiter: Arc<Limiter>) -> Self {
        // Never follow redirects: the bearer token must only ever go to the configured endpoint.
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            endpoint,
            tokens,
            limiter,
            session: Mutex::new(None),
            protocol: Mutex::new(None),
            next_id: AtomicU64::new(1),
            rate_backoff: Duration::from_secs(5),
            retry_delay: Duration::from_millis(250),
            init_timeout: INIT_TIMEOUT,
            rate_retry: true,
        }
    }

    /// A rate-limited read is reported, never silently resent (the caller owns the call budget).
    pub fn without_rate_retry(mut self) -> Self {
        self.rate_retry = false;
        self
    }

    /// Test hook: shorten the `initialize` timeout.
    pub fn with_init_timeout(mut self, d: Duration) -> Self {
        self.init_timeout = d;
        self
    }

    /// Resolves an access token without sending anything (callers use it to tell "nothing was sent" apart).
    pub async fn preflight(&self) -> Result<(), RhError> {
        self.tokens.access_token().await.map(|_| ())
    }

    /// Test hook: shorten the RATE_LIMITED backoff and the transport retry delay.
    pub fn with_delays(mut self, rate_backoff: Duration, retry_delay: Duration) -> Self {
        self.rate_backoff = rate_backoff;
        self.retry_delay = retry_delay;
        self
    }

    /// One attempt, bounded by the init timeout. Starts from a clean slate: no stale session id or protocol header.
    pub async fn initialize(&self) -> Result<ServerInfo, RhError> {
        if let Ok(mut g) = self.session.lock() {
            *g = None;
        }
        if let Ok(mut g) = self.protocol.lock() {
            *g = None;
        }
        match tokio::time::timeout(self.init_timeout, self.initialize_once()).await {
            Ok(r) => r,
            Err(_) => Err(RhError::Transport("initialize timed out".into())),
        }
    }

    async fn initialize_once(&self) -> Result<ServerInfo, RhError> {
        let params = json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION")},
        });
        // Not idempotent for the transport layer: a failed initialize is not retried here (callers cache it).
        let result = self.request("initialize", params, false).await?;
        let info = ServerInfo {
            name: result["serverInfo"]["name"].as_str().unwrap_or_default().to_string(),
            version: result["serverInfo"]["version"].as_str().unwrap_or_default().to_string(),
            protocol_version: result["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION).to_string(),
        };
        if let Ok(mut p) = self.protocol.lock() {
            *p = Some(info.protocol_version.clone());
        }
        let note = json!({"jsonrpc": "2.0", "method": "notifications/initialized"});
        self.send(&note, false, None).await?;
        Ok(info)
    }

    pub async fn list_tools(&self) -> Result<Vec<ToolDef>, RhError> {
        let mut out = Vec::new();
        let mut cursor: Option<String> = None;
        for _ in 0..MAX_PAGES {
            let params = match &cursor {
                Some(c) => json!({"cursor": c}),
                None => json!({}),
            };
            let result = self.request("tools/list", params, true).await?;
            let page: Vec<ToolDef> = serde_json::from_value(result["tools"].clone())
                .map_err(|e| RhError::Protocol(format!("tools/list payload: {e}")))?;
            out.extend(page);
            match result["nextCursor"].as_str() {
                Some(c) if !c.is_empty() => cursor = Some(c.to_string()),
                _ => return Ok(out),
            }
        }
        Err(RhError::Protocol("tools/list paging did not terminate".into()))
    }

    pub async fn call_tool(&self, name: &str, args: Value) -> Result<ToolResult, RhError> {
        let read = is_read_tool(name);
        let mut rate_retried = false;
        loop {
            match self.call_tool_once(name, &args, read).await {
                Err(RhError::RateLimited) if read && !rate_retried && self.rate_retry => {
                    rate_retried = true;
                    tokio::time::sleep(self.rate_backoff).await;
                }
                other => return other,
            }
        }
    }

    async fn call_tool_once(&self, name: &str, args: &Value, read: bool) -> Result<ToolResult, RhError> {
        let result = self.request("tools/call", json!({"name": name, "arguments": args}), read).await?;
        let text = result["content"]
            .as_array()
            .map(|parts| {
                parts
                    .iter()
                    .filter_map(|p| p["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();
        let is_error = result["isError"].as_bool().unwrap_or(false);
        if text.contains("RATE_LIMITED") && (is_error || text.trim_start().starts_with("API error")) {
            return Err(RhError::RateLimited);
        }
        if is_error || text.trim_start().starts_with("API error") {
            return Err(RhError::Tool(clip(&text, None)));
        }
        let structured = match result.get("structuredContent") {
            Some(v) if !v.is_null() => Some(v.clone()),
            _ => serde_json::from_str::<Value>(&text).ok(),
        };
        Ok(ToolResult { structured, text })
    }

    /// JSON-RPC call; returns the `result` value.
    async fn request(&self, method: &str, params: Value, idempotent: bool) -> Result<Value, RhError> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let body = json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params});
        let msg = self
            .send(&body, idempotent, Some(id))
            .await?
            .ok_or_else(|| RhError::Protocol("empty response".into()))?;
        if let Some(err) = msg.get("error") {
            let text = format!("{} {}", err["code"], err["message"].as_str().unwrap_or_default());
            if text.contains("RATE_LIMITED") {
                return Err(RhError::RateLimited);
            }
            return Err(RhError::Protocol(format!("rpc error {}", clip(&text, None))));
        }
        msg.get("result").cloned().ok_or_else(|| RhError::Protocol("response has neither result nor error".into()))
    }

    /// Boxed so the send -> initialize -> send cycle has a finite future type.
    fn reinitialize(&self) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), RhError>> + Send + '_>> {
        Box::pin(async move { self.initialize().await.map(|_| ()) })
    }

    /// One logical POST with 401-refresh and (idempotent only) transport retries.
    /// Never sends DELETE. Returns the JSON-RPC message with `expect_id`, or None for notifications.
    async fn send(&self, body: &Value, idempotent: bool, expect_id: Option<u64>) -> Result<Option<Value>, RhError> {
        let mut token: Option<String> = None;
        let mut refreshed = false;
        let mut reinitialized = false;
        let method = body["method"].as_str().unwrap_or_default();
        let recoverable = method != "initialize" && method != "notifications/initialized";
        let mut transport_retries = 0u32;
        loop {
            self.limiter.acquire().await;
            let tok = match &token {
                Some(t) => t.clone(),
                None => self.tokens.access_token().await?,
            };
            let mut rb = self
                .http
                .post(self.endpoint.clone())
                .bearer_auth(&tok)
                .header("Accept", "application/json, text/event-stream")
                .header("Content-Type", "application/json")
                .body(body.to_string());
            let sent_sid = self.session.lock().ok().and_then(|g| g.clone());
            if let Some(sid) = sent_sid.clone() {
                rb = rb.header("Mcp-Session-Id", sid);
            }
            if let Some(pv) = self.protocol.lock().ok().and_then(|g| g.clone()) {
                rb = rb.header("MCP-Protocol-Version", pv);
            }
            let sent = async {
                let resp = rb.send().await?;
                let status = resp.status().as_u16();
                let sid = resp.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()).map(String::from);
                let ctype = resp
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let text = read_body(resp, &ctype, expect_id).await?;
                Ok::<_, BodyError>((status, sid, ctype, text))
            }
            .await;
            let (status, sid, ctype, text) = match sent {
                Ok(v) => v,
                Err(BodyError::TooLarge) => return Err(RhError::Protocol(format!("response too large (over {MAX_BODY_BYTES} bytes)"))),
                Err(BodyError::Http(e)) => {
                    if idempotent && transport_retries < 2 {
                        transport_retries += 1;
                        tokio::time::sleep(self.retry_delay).await;
                        continue;
                    }
                    return Err(RhError::Transport(clip(&e.without_url().to_string(), Some(&tok))));
                }
            };
            if let Some(sid) = sid {
                if let Ok(mut g) = self.session.lock() {
                    *g = Some(sid);
                }
            }
            match status {
                401 => {
                    // The server rejected before acting, so a single retry is safe for any tool.
                    if refreshed {
                        return Err(RhError::Unauthorized);
                    }
                    refreshed = true;
                    token = Some(self.tokens.force_refresh().await?);
                    continue;
                }
                404 if sent_sid.is_some() && recoverable && !reinitialized => {
                    // Session expired. Start a new one; resend only reads. A write may or may not have
                    // been processed, so it is never auto-retried.
                    reinitialized = true;
                    if let Ok(mut g) = self.session.lock() {
                        *g = None;
                    }
                    let re = self.reinitialize().await;
                    if !idempotent {
                        return Err(RhError::Http(404, "session expired; request not retried".into()));
                    }
                    re?;
                    continue;
                }
                429 => return Err(RhError::RateLimited),
                200..=299 => {}
                other => {
                    if text.contains("RATE_LIMITED") {
                        return Err(RhError::RateLimited);
                    }
                    return Err(RhError::Http(other, clip(&text, Some(&tok))));
                }
            }
            let Some(id) = expect_id else { return Ok(None) };
            return parse_response(&ctype, &text, id).map(Some);
        }
    }
}

/// The JSON-RPC message answers request `id`: same id as a number or a string, or an error with `id: null`
/// (the server could not read the request at all, which is still the answer to it).
fn answers(v: &Value, id: u64) -> bool {
    let same = match v.get("id") {
        Some(Value::Number(n)) => n.as_u64() == Some(id),
        Some(Value::String(s)) => s.parse::<u64>().ok() == Some(id),
        Some(Value::Null) => v.get("error").is_some(),
        _ => false,
    };
    same && (v.get("result").is_some() || v.get("error").is_some())
}

enum BodyError {
    Http(reqwest::Error),
    TooLarge,
}

impl From<reqwest::Error> for BodyError {
    fn from(e: reqwest::Error) -> Self {
        BodyError::Http(e)
    }
}

/// Complete SSE events in `buf` (terminated by a blank line), as joined `data:` payloads.
fn sse_events(buf: &str) -> Vec<String> {
    let norm = buf.replace("\r\n", "\n");
    let mut out = Vec::new();
    let mut parts: Vec<&str> = norm.split("\n\n").collect();
    parts.pop(); // the tail is not yet terminated
    for ev in parts {
        let data: Vec<&str> = ev.lines().filter_map(|l| l.strip_prefix("data:")).map(|r| r.strip_prefix(' ').unwrap_or(r)).collect();
        if !data.is_empty() {
            out.push(data.join("\n"));
        }
    }
    out
}

/// Reads the body with a size cap. For an event stream that answers a request, stops at the first event that
/// carries the answer instead of waiting for the server to close the stream.
async fn read_body(mut resp: reqwest::Response, ctype: &str, expect_id: Option<u64>) -> Result<String, BodyError> {
    let mut buf: Vec<u8> = Vec::new();
    let sse = ctype.contains("text/event-stream");
    while let Some(chunk) = resp.chunk().await? {
        if buf.len() + chunk.len() > MAX_BODY_BYTES {
            return Err(BodyError::TooLarge);
        }
        buf.extend_from_slice(&chunk);
        if let (true, Some(id)) = (sse, expect_id) {
            let text = String::from_utf8_lossy(&buf);
            if let Some(ev) = sse_events(&text).into_iter().find(|e| serde_json::from_str::<Value>(e).is_ok_and(|v| answers(&v, id))) {
                // Re-emit just that event so the parser below sees one complete, matching event.
                return Ok(format!("data: {ev}\n\n"));
            }
        }
    }
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

fn parse_response(ctype: &str, text: &str, id: u64) -> Result<Value, RhError> {
    let matches_id = |v: &Value| answers(v, id);
    if ctype.contains("text/event-stream") {
        let mut data = String::new();
        let flush = |data: &mut String| -> Option<Value> {
            if data.is_empty() {
                return None;
            }
            let v = serde_json::from_str::<Value>(data).ok();
            data.clear();
            v.filter(matches_id)
        };
        for line in text.lines() {
            if line.is_empty() {
                if let Some(v) = flush(&mut data) {
                    return Ok(v);
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(rest.strip_prefix(' ').unwrap_or(rest));
            }
        }
        if let Some(v) = flush(&mut data) {
            return Ok(v);
        }
        return Err(RhError::Protocol("no matching JSON-RPC response in event stream".into()));
    }
    let v: Value = serde_json::from_str(text).map_err(|_| RhError::Protocol("response is not JSON".into()))?;
    if let Some(arr) = v.as_array() {
        return arr.iter().find(|m| matches_id(m)).cloned().ok_or_else(|| RhError::Protocol("no matching response in batch".into()));
    }
    if matches_id(&v) {
        Ok(v)
    } else {
        Err(RhError::Protocol("response id does not match request".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rh::testutil::{Mock, Req, Resp};
    use std::sync::atomic::AtomicUsize;

    struct FakeTokens {
        refreshes: AtomicUsize,
    }
    impl FakeTokens {
        fn new() -> Arc<Self> {
            Arc::new(Self { refreshes: AtomicUsize::new(0) })
        }
    }
    #[async_trait::async_trait]
    impl TokenProvider for FakeTokens {
        async fn access_token(&self) -> Result<String, RhError> {
            Ok("tok-1".into())
        }
        async fn force_refresh(&self) -> Result<String, RhError> {
            self.refreshes.fetch_add(1, Ordering::SeqCst);
            Ok("tok-2".into())
        }
    }

    fn client(m: &Mock, t: Arc<FakeTokens>) -> McpClient {
        McpClient::new(m.url("/mcp"), t, Arc::new(Limiter::new(1000, 1000)))
            .with_delays(Duration::from_millis(50), Duration::from_millis(10))
    }

    fn rpc_ok(req: &Req, result: Value) -> Resp {
        Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"result":result}))
    }
    fn tool_ok(req: &Req, text: &str) -> Resp {
        rpc_ok(req, json!({"content":[{"type":"text","text":text}]}))
    }
    fn no_delete(m: &Mock) {
        assert!(m.requests().iter().all(|r| r.method == "POST"), "client must only POST");
    }

    #[tokio::test]
    async fn initialize_sets_and_echoes_session_id() {
        let m = Mock::start(|req, _| match req.rpc_method().as_str() {
            "initialize" => Some(
                rpc_ok(req, json!({"protocolVersion":"2025-06-18","serverInfo":{"name":"rh","version":"9"},"capabilities":{}}))
                    .header("Mcp-Session-Id", "sess-1"),
            ),
            "notifications/initialized" => Some(Resp::status(202)),
            "tools/list" => Some(rpc_ok(req, json!({"tools":[]}))),
            _ => Some(Resp::status(400)),
        })
        .await;
        let c = client(&m, FakeTokens::new());
        let info = c.initialize().await.unwrap();
        assert_eq!(info.name, "rh");
        assert_eq!(info.version, "9");
        c.list_tools().await.unwrap();
        let rs = m.requests();
        assert_eq!(rs.len(), 3);
        assert_eq!(rs[0].rpc_method(), "initialize");
        assert_eq!(rs[0].header("authorization"), Some("Bearer tok-1"));
        assert!(rs[0].header("accept").unwrap().contains("text/event-stream"));
        assert!(rs[0].header("content-type").unwrap().contains("application/json"));
        assert_eq!(rs[0].header("mcp-session-id"), None);
        assert_eq!(rs[1].rpc_method(), "notifications/initialized");
        assert!(rs[1].json().get("id").is_none(), "notification has no id");
        assert_eq!(rs[1].header("mcp-session-id"), Some("sess-1"));
        assert_eq!(rs[2].header("mcp-session-id"), Some("sess-1"));
        no_delete(&m);
    }

    #[tokio::test]
    async fn tools_list_follows_next_cursor() {
        let m = Mock::start(|req, i| {
            let cur = req.json()["params"]["cursor"].as_str().map(String::from);
            match (i, cur.as_deref()) {
                (0, None) => Some(rpc_ok(req, json!({"tools":[{"name":"get_a","description":"d","inputSchema":{},"annotations":{"x":1}}],"nextCursor":"c2"}))),
                (1, Some("c2")) => Some(rpc_ok(req, json!({"tools":[{"name":"get_b","inputSchema":{}}]}))),
                _ => Some(Resp::status(500)),
            }
        })
        .await;
        let tools = client(&m, FakeTokens::new()).list_tools().await.unwrap();
        assert_eq!(tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["get_a", "get_b"]);
        assert_eq!(tools[0].description.as_deref(), Some("d"));
        assert!(tools[0].rest.contains_key("annotations"), "unknown fields preserved");
        assert_eq!(m.count(), 2);
    }

    #[tokio::test]
    async fn json_and_sse_responses_both_parse() {
        let m = Mock::start(|req, i| {
            let id = req.json()["id"].clone();
            if i == 0 {
                Some(tool_ok(req, r#"{"data":{"n":1}}"#))
            } else {
                let other = json!({"jsonrpc":"2.0","method":"notifications/progress","params":{}});
                let mine = json!({"jsonrpc":"2.0","id":id,"result":{"content":[{"type":"text","text":"hi"}],"structuredContent":{"data":{"n":2},"guide":"g"}}});
                Some(Resp::sse(&format!("event: message\ndata: {other}\n\nevent: message\ndata: {mine}\n\n")))
            }
        })
        .await;
        let c = client(&m, FakeTokens::new());
        let a = c.call_tool("get_x", json!({})).await.unwrap();
        assert_eq!(a.data().unwrap()["n"], 1, "text JSON fallback");
        let b = c.call_tool("get_x", json!({})).await.unwrap();
        assert_eq!(b.data().unwrap()["n"], 2, "structuredContent preferred");
        assert_eq!(b.structured.as_ref().unwrap()["guide"], "g");
        assert_eq!(b.text, "hi");
    }

    #[tokio::test]
    async fn is_error_true_is_tool_error() {
        let m = Mock::start(|req, _| Some(rpc_ok(req, json!({"isError":true,"content":[{"type":"text","text":"bad symbol"}]})))).await;
        let e = client(&m, FakeTokens::new()).call_tool("get_x", json!({})).await.unwrap_err();
        assert!(matches!(&e, RhError::Tool(t) if t.contains("bad symbol")), "{e:?}");
    }

    #[tokio::test]
    async fn prose_api_error_is_tool_error() {
        let m = Mock::start(|req, _| Some(tool_ok(req, "API error 400: bad"))).await;
        let e = client(&m, FakeTokens::new()).call_tool("get_x", json!({})).await.unwrap_err();
        assert!(matches!(&e, RhError::Tool(t) if t.contains("API error 400")), "{e:?}");
    }

    #[tokio::test]
    async fn jsonrpc_error_object_is_protocol_error() {
        let m = Mock::start(|req, _| {
            Some(Resp::json(200, &json!({"jsonrpc":"2.0","id":req.json()["id"],"error":{"code":-32602,"message":"nope"}})))
        })
        .await;
        let e = client(&m, FakeTokens::new()).call_tool("get_x", json!({})).await.unwrap_err();
        assert!(matches!(&e, RhError::Protocol(t) if t.contains("nope")), "{e:?}");
    }

    #[tokio::test]
    async fn one_401_triggers_exactly_one_refresh_then_succeeds() {
        let m = Mock::start(|req, i| {
            if i == 0 {
                Some(Resp::status(401))
            } else {
                assert_eq!(req.header("authorization"), Some("Bearer tok-2"));
                Some(tool_ok(req, "{}"))
            }
        })
        .await;
        let t = FakeTokens::new();
        client(&m, t.clone()).call_tool("get_x", json!({})).await.unwrap();
        assert_eq!(t.refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(m.count(), 2);
    }

    #[tokio::test]
    async fn second_401_is_unauthorized_without_leaking_tokens() {
        let m = Mock::start(|_, _| Some(Resp::status(401))).await;
        let t = FakeTokens::new();
        let e = client(&m, t.clone()).call_tool("place_equity_order", json!({})).await.unwrap_err();
        assert_eq!(e, RhError::Unauthorized);
        assert_eq!(t.refreshes.load(Ordering::SeqCst), 1);
        assert_eq!(m.count(), 2);
        let dbg = format!("{e:?} {e}");
        assert!(!dbg.contains("tok-"));
    }

    #[tokio::test]
    async fn write_tool_transport_failure_is_not_retried_but_read_is() {
        let m = Mock::start(|_, _| None).await;
        let e = client(&m, FakeTokens::new()).call_tool("place_equity_order", json!({})).await.unwrap_err();
        assert!(matches!(e, RhError::Transport(_)), "{e:?}");
        assert_eq!(m.count(), 1, "write must not be retried");

        let m2 = Mock::start(|req, i| if i == 0 { None } else { Some(tool_ok(req, "{}")) }).await;
        client(&m2, FakeTokens::new()).call_tool("get_accounts", json!({})).await.unwrap();
        assert_eq!(m2.count(), 2);

        let m3 = Mock::start(|_, _| None).await;
        let e = client(&m3, FakeTokens::new()).call_tool("get_accounts", json!({})).await.unwrap_err();
        assert!(matches!(e, RhError::Transport(_)));
        assert_eq!(m3.count(), 3, "1 try + max 2 retries");
    }

    #[tokio::test]
    async fn rate_limited_retries_reads_once_after_backoff_writes_never() {
        let m = Mock::start(|req, i| if i == 0 { Some(tool_ok(req, "API error 429: RATE_LIMITED")) } else { Some(tool_ok(req, "{}")) }).await;
        client(&m, FakeTokens::new()).call_tool("get_accounts", json!({})).await.unwrap();
        assert_eq!(m.count(), 2);

        let m2 = Mock::start(|req, _| Some(tool_ok(req, "API error 429: RATE_LIMITED"))).await;
        let e = client(&m2, FakeTokens::new()).call_tool("get_accounts", json!({})).await.unwrap_err();
        assert_eq!(e, RhError::RateLimited);
        assert_eq!(m2.count(), 2, "one retry only");

        let m3 = Mock::start(|_, _| Some(Resp::status(429))).await;
        let e = client(&m3, FakeTokens::new()).call_tool("place_equity_order", json!({})).await.unwrap_err();
        assert_eq!(e, RhError::RateLimited);
        assert_eq!(m3.count(), 1);
    }

    #[tokio::test]
    async fn http_error_maps_and_redacts() {
        let m = Mock::start(|_, _| Some(Resp::text(500, "boom tok-1 boom"))).await;
        let e = client(&m, FakeTokens::new()).call_tool("place_equity_order", json!({})).await.unwrap_err();
        assert!(matches!(&e, RhError::Http(500, b) if b.contains("boom") && !b.contains("tok-1")), "{e:?}");
        no_delete(&m);
    }

    /// Mock that issues sess-N per initialize and 404s the first tools/call (the expired session).
    fn expiring_session_mock() -> impl Fn(&Req, usize) -> Option<Resp> + Send + Sync + 'static {
        let inits = Arc::new(AtomicUsize::new(0));
        let call_404 = Arc::new(AtomicUsize::new(0));
        move |req, _| match req.rpc_method().as_str() {
            "initialize" => {
                let n = inits.fetch_add(1, Ordering::SeqCst) + 1;
                Some(rpc_ok(req, json!({"protocolVersion":"2025-06-18","serverInfo":{"name":"rh","version":"1"}})).header("Mcp-Session-Id", &format!("sess-{n}")))
            }
            "notifications/initialized" => Some(Resp::status(202)),
            "tools/call" => {
                if call_404.fetch_add(1, Ordering::SeqCst) == 0 {
                    Some(Resp::text(404, "session not found"))
                } else {
                    Some(tool_ok(req, r#"{"ok":true}"#))
                }
            }
            _ => Some(Resp::status(400)),
        }
    }

    #[tokio::test]
    async fn expired_session_404_reinitializes_and_retries_read_once() {
        let m = Mock::start(expiring_session_mock()).await;
        let c = client(&m, FakeTokens::new());
        c.initialize().await.unwrap();
        let r = c.call_tool("get_accounts", json!({"a":1})).await.unwrap();
        assert_eq!(r.data().unwrap()["ok"], true);
        let rs = m.requests();
        let methods: Vec<String> = rs.iter().map(|r| r.rpc_method()).collect();
        assert_eq!(
            methods,
            ["initialize", "notifications/initialized", "tools/call", "initialize", "notifications/initialized", "tools/call"]
        );
        assert_eq!(rs[2].header("mcp-session-id"), Some("sess-1"));
        assert_eq!(rs[3].header("mcp-session-id"), None, "stale session must be cleared before re-initialize");
        assert_eq!(rs[5].header("mcp-session-id"), Some("sess-2"));
        assert_eq!(rs[2].body, rs[5].body, "the SAME request is retried");
        no_delete(&m);
    }

    #[tokio::test]
    async fn expired_session_404_never_retries_a_write() {
        let m = Mock::start(expiring_session_mock()).await;
        let c = client(&m, FakeTokens::new());
        c.initialize().await.unwrap();
        let e = c.call_tool("place_equity_order", json!({"a":1})).await.unwrap_err();
        assert!(matches!(e, RhError::Http(404, _)), "{e:?}");
        let calls = m.requests().iter().filter(|r| r.rpc_method() == "tools/call").count();
        assert_eq!(calls, 1, "a write must be sent exactly once");
        // Session was refreshed for whatever the user does next.
        let rs = m.requests();
        assert!(rs.iter().filter(|r| r.rpc_method() == "initialize").count() == 2);
    }

    #[tokio::test]
    async fn expired_session_404_retries_only_once_and_404_without_session_is_plain() {
        let m = Mock::start(|req, _| match req.rpc_method().as_str() {
            "initialize" => Some(rpc_ok(req, json!({"protocolVersion":"2025-06-18"})).header("Mcp-Session-Id", "s")),
            "notifications/initialized" => Some(Resp::status(202)),
            _ => Some(Resp::text(404, "gone")),
        })
        .await;
        let c = client(&m, FakeTokens::new());
        c.initialize().await.unwrap();
        let e = c.call_tool("get_accounts", json!({})).await.unwrap_err();
        assert!(matches!(e, RhError::Http(404, _)), "{e:?}");
        let calls = m.requests().iter().filter(|r| r.rpc_method() == "tools/call").count();
        assert_eq!(calls, 2, "original + exactly one retry");

        let m2 = Mock::start(|_, _| Some(Resp::text(404, "nope"))).await;
        let e = client(&m2, FakeTokens::new()).call_tool("get_accounts", json!({})).await.unwrap_err();
        assert!(matches!(e, RhError::Http(404, _)));
        assert_eq!(m2.count(), 1, "no session was sent, so no recovery");
    }

    #[test]
    fn read_name_set() {
        for n in ["get_accounts", "search_symbols", "review_order", "preview_order", "run_scan", "list_x"] {
            assert!(is_read_tool(n), "{n}");
        }
        for n in [
            "place_equity_order", "cancel_order", "exercise_option", "register_agent", "place_option_order",
            "cancel_equity_order", "cancel_option_order", "decline_trade_approval", "place_advanced_order",
        ] {
            assert!(!is_read_tool(n), "{n}");
        }
        for n in ["review_equity_order", "review_option_order", "get_trade_approvals", "get_trade_approval_setting"] {
            assert!(is_read_tool(n), "{n}");
        }
    }

    // ---- R3 hardening ----

    #[tokio::test]
    async fn redirects_are_never_followed() {
        let m = Mock::start(|req, i| if i == 0 { Some(Resp::status(307).header("Location", "/elsewhere")) } else { Some(tool_ok(req, "{}")) }).await;
        let e = client(&m, FakeTokens::new()).call_tool("get_x", json!({})).await.unwrap_err();
        assert!(matches!(e, RhError::Http(307, _)), "{e:?}");
        assert_eq!(m.count(), 1, "the bearer token must not be replayed to a redirect target");
    }

    #[tokio::test]
    async fn initialize_is_a_single_attempt() {
        let m = Mock::start(|_, _| None).await;
        let e = client(&m, FakeTokens::new()).initialize().await.unwrap_err();
        assert!(matches!(e, RhError::Transport(_)), "{e:?}");
        assert_eq!(m.count(), 1, "no transport retries for initialize");
    }

    #[tokio::test]
    async fn initialize_times_out() {
        // Accepts and then never answers.
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let _hold = tokio::spawn(async move {
            let mut socks = vec![];
            while let Ok((s, _)) = l.accept().await {
                socks.push(s);
            }
        });
        let c = McpClient::new(Url::parse(&format!("http://{addr}/mcp")).unwrap(), FakeTokens::new(), Arc::new(Limiter::new(1000, 1000)))
            .with_init_timeout(Duration::from_millis(300));
        let r = tokio::time::timeout(Duration::from_secs(5), c.initialize()).await;
        let e = r.expect("initialize must give up on its own").unwrap_err();
        assert!(matches!(&e, RhError::Transport(t) if t.contains("timed out")), "{e:?}");
    }

    #[tokio::test]
    async fn initialize_starts_without_the_old_session_or_protocol() {
        let m = Mock::start(|req, _| match req.rpc_method().as_str() {
            "initialize" => Some(rpc_ok(req, json!({"protocolVersion":"2025-06-18"})).header("Mcp-Session-Id", "sess-old")),
            _ => Some(Resp::status(202)),
        })
        .await;
        let c = client(&m, FakeTokens::new());
        c.initialize().await.unwrap();
        c.initialize().await.unwrap();
        let inits: Vec<Req> = m.requests().into_iter().filter(|r| r.rpc_method() == "initialize").collect();
        assert_eq!(inits[1].header("mcp-session-id"), None);
        assert_eq!(inits[1].header("mcp-protocol-version"), None);
    }

    #[tokio::test]
    async fn oversized_bodies_are_refused() {
        let big = "x".repeat(9 * 1024 * 1024);
        let m = Mock::start(move |req, _| Some(tool_ok(req, &big))).await;
        let e = client(&m, FakeTokens::new()).call_tool("get_x", json!({})).await.unwrap_err();
        assert!(matches!(&e, RhError::Protocol(t) if t.contains("too large")), "{e:?}");
    }

    #[tokio::test]
    async fn event_stream_returns_at_the_first_matching_event_without_waiting_for_close() {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        let _srv = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let mut keep = vec![];
            while let Ok((mut s, _)) = l.accept().await {
                let mut buf = vec![0u8; 65536];
                let n = s.read(&mut buf).await.unwrap_or(0);
                let body = String::from_utf8_lossy(&buf[..n]).to_string();
                let id = body.split("\"id\":").nth(1).and_then(|t| t.split([',', '}']).next()).unwrap_or("1").to_string();
                let ev = format!("event: message\ndata: {{\"jsonrpc\":\"2.0\",\"id\":{id},\"result\":{{\"content\":[{{\"type\":\"text\",\"text\":\"{{}}\"}}]}}}}\n\n");
                let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: keep-alive\r\n\r\n";
                let _ = s.write_all(head.as_bytes()).await;
                let _ = s.write_all(ev.as_bytes()).await;
                keep.push(s); // never closed: the stream stays open
            }
        });
        let c = McpClient::new(Url::parse(&format!("http://{addr}/mcp")).unwrap(), FakeTokens::new(), Arc::new(Limiter::new(1000, 1000)));
        let r = tokio::time::timeout(Duration::from_secs(5), c.call_tool("get_x", json!({}))).await;
        assert!(r.expect("must not wait for the stream to close").is_ok());
    }

    #[tokio::test]
    async fn string_ids_match_and_null_id_errors_are_server_errors() {
        let m = Mock::start(|req, i| {
            let id = req.json()["id"].as_u64().unwrap();
            if i == 0 {
                Some(Resp::json(200, &json!({"jsonrpc":"2.0","id":id.to_string(),"result":{"content":[{"type":"text","text":"{\"ok\":1}"}]}})))
            } else {
                Some(Resp::json(200, &json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}})))
            }
        })
        .await;
        let c = client(&m, FakeTokens::new());
        assert_eq!(c.call_tool("get_x", json!({})).await.unwrap().data().unwrap()["ok"], 1);
        let e = c.call_tool("get_x", json!({})).await.unwrap_err();
        assert!(matches!(&e, RhError::Protocol(t) if t.contains("Parse error")), "{e:?}");
    }

    /// M6: every order-mutating tool is sent exactly once on 404 session expiry, a dropped connection, and 429.
    #[tokio::test]
    async fn order_mutating_tools_are_never_resent() {
        for tool in ["place_equity_order", "place_option_order", "cancel_equity_order", "cancel_option_order", "decline_trade_approval"] {
            let m = Mock::start(expiring_session_mock()).await;
            let c = client(&m, FakeTokens::new());
            c.initialize().await.unwrap();
            let e = c.call_tool(tool, json!({"a":1})).await.unwrap_err();
            assert!(matches!(e, RhError::Http(404, _)), "{tool}: {e:?}");
            let calls = m.requests().iter().filter(|r| r.rpc_method() == "tools/call").count();
            assert_eq!(calls, 1, "{tool}: 404 must not resend");

            let m = Mock::start(|_, _| None).await;
            let e = client(&m, FakeTokens::new()).call_tool(tool, json!({})).await.unwrap_err();
            assert!(matches!(e, RhError::Transport(_)), "{tool}: {e:?}");
            assert_eq!(m.count(), 1, "{tool}: transport failure must not resend");

            let m = Mock::start(|req, _| Some(tool_ok(req, "API error 429: RATE_LIMITED"))).await;
            let e = client(&m, FakeTokens::new()).call_tool(tool, json!({})).await.unwrap_err();
            assert_eq!(e, RhError::RateLimited, "{tool}");
            assert_eq!(m.count(), 1, "{tool}: rate limit must not resend");
        }
    }
}
