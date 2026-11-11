//! Anthropic's native Messages API (M19). Facts read from the CURRENT docs on 2026-11-11 (platform.claude.com: Messages, streaming, errors, versioning,
//! models overview). NEVER the OpenAI-compatibility layer (Anthropic calls it a test layer). The user's OWN API key only: it is sent in the `x-api-key`
//! header to the one fixed host (`https://api.anthropic.com`, enforced by `provider.rs` / `config.rs`) and nowhere else. No tool use, no thinking
//! parameters, no prompt caching, no beta headers in v1. Error and provider text never reaches the webview: only the fixed codes do.
use serde_json::{json, Value};
use url::Url;

use super::client::{AskReq, LlmError};

/// The `anthropic-version` header value the docs currently specify (versioning page, 2026-11-11). Older versions still work; newer behaviour (for
/// example removed sampling parameters) is why the request carries none of them.
pub const ANTHROPIC_VERSION: &str = "2026-10-21";
/// Thinking tokens count toward `max_tokens` on current models (adaptive thinking is on by default), so a 700 cap could leave no visible text.
/// Same idea as OpenAI's floor: ask for headroom; the reply is still capped by `MAX_REPLY_CHARS` and the 180-word prompt rule.
pub const MIN_MAX_TOKENS: u32 = 1500;

/// `<base>/v1/messages` (the validated base never ends with a slash).
pub fn messages_url(base: &Url) -> Url {
    let mut u = base.clone();
    let p = format!("{}/v1/messages", base.path().trim_end_matches('/'));
    u.set_path(&p);
    u
}

/// The request body: `model`, `max_tokens`, TOP-LEVEL `system`, `messages` (user/assistant turns only), `stream` only when streaming.
pub fn build_body(req: &AskReq, stream: bool) -> Value {
    let messages: Vec<Value> = req.turns.iter().map(|t| json!({"role": t.role, "content": t.text})).collect();
    let mut body = json!({"model": req.model, "max_tokens": req.max_tokens.max(MIN_MAX_TOKENS), "system": req.system, "messages": messages});
    if stream {
        body["stream"] = json!(true);
    }
    body
}

/// HTTP status -> fixed code (errors page: 400/413 invalid or too large, 401/402/403 key/billing/permission, 404 not found, 429 rate limit,
/// 500 api_error, 504 timeout_error, 529 overloaded).
pub fn map_status(status: u16) -> Result<(), LlmError> {
    match status {
        200..=299 => Ok(()),
        400 | 404 | 413 | 422 => Err(LlmError::BadRequest),
        401..=403 => Err(LlmError::BadKey),
        408 | 504 => Err(LlmError::Timeout),
        429 => Err(LlmError::RateLimited),
        _ => Err(LlmError::BadReply),
    }
}

/// An error object's documented `type`, mapped to a fixed code. The message is dropped on the floor.
pub fn map_error_type(v: &Value) -> LlmError {
    match v.pointer("/error/type").and_then(Value::as_str) {
        Some("authentication_error" | "permission_error" | "billing_error") => LlmError::BadKey,
        Some("invalid_request_error" | "not_found_error" | "request_too_large") => LlmError::BadRequest,
        Some("rate_limit_error") => LlmError::RateLimited,
        Some("timeout_error") => LlmError::Timeout,
        // overloaded_error, api_error and anything new
        _ => LlmError::BadReply,
    }
}

/// A non-streaming reply: the concatenated `text` blocks (thinking and unknown blocks are skipped) and `usage.input_tokens/output_tokens`.
pub fn parse_reply(buf: &[u8]) -> Result<(String, Option<(u64, u64)>), LlmError> {
    let v: Value = serde_json::from_slice(buf).map_err(|_| LlmError::BadReply)?;
    if v.get("type").and_then(Value::as_str) == Some("error") {
        return Err(map_error_type(&v));
    }
    let blocks = v.get("content").and_then(Value::as_array).ok_or(LlmError::BadReply)?;
    let text: String = blocks.iter().filter(|b| b.get("type").and_then(Value::as_str) == Some("text")).filter_map(|b| b.get("text").and_then(Value::as_str)).collect();
    if text.trim().is_empty() {
        return Err(LlmError::BadReply);
    }
    let usage = v.get("usage").and_then(|u| Some((u.get("input_tokens")?.as_u64()?, u.get("output_tokens")?.as_u64()?)));
    Ok((text, usage))
}

/// What one streamed event means. Unknown event types and unparseable payloads are ignored (the versioning page says new event types may appear).
#[derive(Debug, Default, PartialEq)]
pub struct Event {
    /// Visible answer text from a `text_delta` (thinking, signature and citation deltas are ignored).
    pub delta: Option<String>,
    /// `message_start`: the prompt's input tokens.
    pub input_tokens: Option<u64>,
    /// `message_delta`: the cumulative output tokens (and, when present, input tokens).
    pub final_usage: Option<(Option<u64>, u64)>,
    /// `message_delta` or `message_stop` was seen: the reply is complete.
    pub finished: bool,
    pub error: Option<LlmError>,
}

pub fn parse_event(data: &str) -> Event {
    let Ok(v) = serde_json::from_str::<Value>(data.trim()) else { return Event::default() };
    let mut e = Event::default();
    match v.get("type").and_then(Value::as_str) {
        Some("message_start") => e.input_tokens = v.pointer("/message/usage/input_tokens").and_then(Value::as_u64),
        Some("content_block_delta") => {
            if v.pointer("/delta/type").and_then(Value::as_str) == Some("text_delta") {
                if let Some(t) = v.pointer("/delta/text").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                    e.delta = Some(t.to_string());
                }
            }
        }
        Some("message_delta") => {
            e.finished = true;
            if let Some(out) = v.pointer("/usage/output_tokens").and_then(Value::as_u64) {
                e.final_usage = Some((v.pointer("/usage/input_tokens").and_then(Value::as_u64), out));
            }
        }
        Some("message_stop") => e.finished = true,
        Some("error") => e.error = Some(map_error_type(&v)),
        _ => {}
    }
    e
}
