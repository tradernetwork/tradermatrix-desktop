//! Hand-rolled HTTP/1.1 mock server on 127.0.0.1 for tests. One request per connection.
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use url::Url;

#[derive(Clone, Debug)]
pub struct Req {
    pub method: String,
    pub path: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Req {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    pub fn json(&self) -> Value {
        serde_json::from_str(&self.body).unwrap_or(Value::Null)
    }
    /// JSON-RPC method of the body, or "".
    pub fn rpc_method(&self) -> String {
        self.json()["method"].as_str().unwrap_or("").to_string()
    }
}

pub struct Resp {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

impl Resp {
    pub fn json(status: u16, v: &Value) -> Self {
        Self { status, headers: vec![("Content-Type".into(), "application/json".into())], body: v.to_string() }
    }
    pub fn sse(body: &str) -> Self {
        Self { status: 200, headers: vec![("Content-Type".into(), "text/event-stream".into())], body: body.to_string() }
    }
    pub fn status(status: u16) -> Self {
        Self { status, headers: vec![], body: String::new() }
    }
    pub fn text(status: u16, body: &str) -> Self {
        Self { status, headers: vec![("Content-Type".into(), "text/plain".into())], body: body.to_string() }
    }
    pub fn header(mut self, k: &str, v: &str) -> Self {
        self.headers.push((k.into(), v.into()));
        self
    }
}

pub struct Mock {
    pub addr: SocketAddr,
    reqs: Arc<Mutex<Vec<Req>>>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Mock {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Mock {
    /// `handler(request, index)`; returning None drops the connection without a response (transport failure).
    pub async fn start<F>(handler: F) -> Mock
    where
        F: Fn(&Req, usize) -> Option<Resp> + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let reqs: Arc<Mutex<Vec<Req>>> = Arc::new(Mutex::new(vec![]));
        let handler = Arc::new(handler);
        let r2 = reqs.clone();
        let task = tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else { return };
                let handler = handler.clone();
                let reqs = r2.clone();
                tokio::spawn(async move {
                    let Some(req) = read_req(&mut sock).await else { return };
                    let idx = {
                        let mut g = reqs.lock().unwrap();
                        g.push(req.clone());
                        g.len() - 1
                    };
                    let Some(resp) = handler(&req, idx) else { return };
                    let mut out = format!("HTTP/1.1 {} X\r\n", resp.status);
                    for (k, v) in &resp.headers {
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    out.push_str(&format!("Content-Length: {}\r\nConnection: close\r\n\r\n", resp.body.len()));
                    out.push_str(&resp.body);
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Mock { addr, reqs, task }
    }

    pub fn url(&self, path: &str) -> Url {
        Url::parse(&format!("http://{}{}", self.addr, path)).unwrap()
    }
    pub fn requests(&self) -> Vec<Req> {
        self.reqs.lock().unwrap().clone()
    }
    pub fn count(&self) -> usize {
        self.reqs.lock().unwrap().len()
    }
}

async fn read_req(sock: &mut tokio::net::TcpStream) -> Option<Req> {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let head_end = loop {
        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break i;
        }
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            return None;
        }
        buf.extend_from_slice(&tmp[..n]);
    };
    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next()?;
    let mut parts = first.split(' ');
    let method = parts.next()?.to_string();
    let path = parts.next()?.to_string();
    let headers: Vec<(String, String)> = lines
        .filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string())))
        .collect();
    let len: usize = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, v)| v.parse().ok())
        .unwrap_or(0);
    let mut body = buf[head_end + 4..].to_vec();
    while body.len() < len {
        let n = sock.read(&mut tmp).await.ok()?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&tmp[..n]);
    }
    Some(Req { method, path, headers, body: String::from_utf8_lossy(&body).to_string() })
}

/// Fixed fake tokens for client tests. Never real credentials.
pub struct StaticTokens;

#[async_trait::async_trait]
impl crate::rh::mcp::TokenProvider for StaticTokens {
    async fn access_token(&self) -> Result<String, crate::rh::RhError> {
        Ok("fake-access-token".into())
    }
    async fn force_refresh(&self) -> Result<String, crate::rh::RhError> {
        Ok("fake-access-token-2".into())
    }
}
