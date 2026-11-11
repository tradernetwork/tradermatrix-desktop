//! Server-sent-events parsing for streamed chat replies (M16 B1). Pure and bounded: bytes in, event payloads out. A line longer than
//! `MAX_LINE_BYTES` or an event larger than `MAX_EVENT_BYTES` is a protocol error (the caller maps it to `bad_reply`), so a hostile
//! or broken server cannot make the buffer grow without limit. Only `data:` fields are used; comments (`: ...`), `event:`, `id:` and
//! `retry:` lines are ignored.
use serde_json::Value;

use super::client::LlmError;

pub const MAX_LINE_BYTES: usize = 64 * 1024;
pub const MAX_EVENT_BYTES: usize = 128 * 1024;

#[derive(Default)]
pub struct SseParser {
    buf: Vec<u8>,
    data: Vec<String>,
    data_bytes: usize,
    /// The `event:` name of the event being read. Events named `hermes.*` (Hermes tool progress) are never part of the answer and are dropped.
    event: Option<String>,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feeds raw bytes (chunk boundaries may fall anywhere, including inside a multi-byte character or between CR and LF) and returns
    /// the payload of every event completed by them.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<String>, LlmError> {
        let mut out = Vec::new();
        for &b in bytes {
            if b == b'\n' {
                let mut line = std::mem::take(&mut self.buf);
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                self.line(&line, &mut out)?;
            } else {
                self.buf.push(b);
                if self.buf.len() > MAX_LINE_BYTES {
                    return Err(LlmError::BadReply);
                }
            }
        }
        Ok(out)
    }

    /// End of stream: a final line without a newline and an event without its blank line still count.
    pub fn finish(&mut self) -> Result<Vec<String>, LlmError> {
        let mut out = Vec::new();
        if !self.buf.is_empty() {
            let mut line = std::mem::take(&mut self.buf);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            self.line(&line, &mut out)?;
        }
        self.dispatch(&mut out);
        Ok(out)
    }

    fn line(&mut self, line: &[u8], out: &mut Vec<String>) -> Result<(), LlmError> {
        if line.is_empty() {
            self.dispatch(out);
            return Ok(());
        }
        if line[0] == b':' {
            return Ok(());
        }
        let text = String::from_utf8_lossy(line);
        let (field, value) = match text.split_once(':') {
            Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
            None => (text.as_ref(), ""),
        };
        if field == "event" {
            self.event = Some(value.to_string());
        }
        if field == "data" {
            self.data_bytes += value.len() + 1;
            if self.data_bytes > MAX_EVENT_BYTES {
                return Err(LlmError::BadReply);
            }
            self.data.push(value.to_string());
        }
        Ok(())
    }

    fn dispatch(&mut self, out: &mut Vec<String>) {
        let hermes_progress = self.event.take().is_some_and(|e| e.trim().starts_with("hermes."));
        if !self.data.is_empty() {
            if !hermes_progress {
                out.push(self.data.join("\n"));
            }
            self.data.clear();
        }
        self.data_bytes = 0;
    }
}

/// What one event payload means for the reply.
#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    /// Visible answer text (reasoning deltas and any non-text deltas are ignored).
    pub delta: Option<String>,
    /// `(prompt_tokens, completion_tokens)` when the provider reports usage.
    pub usage: Option<(u64, u64)>,
    /// `[DONE]` or a non-null `finish_reason`.
    pub finished: bool,
    /// An error object inside the stream, mapped to a fixed code (the message is dropped).
    pub error: Option<LlmError>,
}

pub fn parse_event(data: &str) -> Parsed {
    let d = data.trim();
    if d == "[DONE]" {
        return Parsed { finished: true, ..Parsed::default() };
    }
    let Ok(v) = serde_json::from_str::<Value>(d) else {
        // Not JSON (a keep-alive or a proprietary event): nothing to show.
        return Parsed::default();
    };
    let mut p = Parsed::default();
    if let Some(err) = v.get("error") {
        p.error = Some(match err.get("code").and_then(Value::as_u64) {
            Some(400 | 404 | 422) => LlmError::BadRequest,
            Some(401..=403) => LlmError::BadKey,
            Some(408) => LlmError::Timeout,
            Some(429) => LlmError::RateLimited,
            _ => LlmError::BadReply,
        });
        return p;
    }
    if let Some(s) = v.pointer("/choices/0/delta/content").and_then(Value::as_str) {
        if !s.is_empty() {
            p.delta = Some(s.to_string());
        }
    }
    if v.pointer("/choices/0/finish_reason").is_some_and(|f| !f.is_null()) {
        p.finished = true;
    }
    if let Some(u) = v.get("usage").filter(|u| u.is_object()) {
        let g = |k: &str| u.get(k).and_then(Value::as_u64);
        if let (Some(a), Some(b)) = (g("prompt_tokens"), g("completion_tokens")) {
            p.usage = Some((a, b));
        }
    }
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn events_split_across_chunks_and_crlf_are_reassembled() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: {\"a\":1}\r").unwrap().is_empty());
        assert!(p.push(b"\n").unwrap().is_empty());
        assert_eq!(p.push(b"\r\ndata: two\n\n").unwrap(), vec!["{\"a\":1}".to_string(), "two".to_string()]);
    }

    #[test]
    fn a_multibyte_character_split_between_chunks_survives() {
        let s = "data: caf\u{e9}\n\n".as_bytes().to_vec();
        let i = s.iter().position(|b| *b == 0xc3).unwrap() + 1;
        let mut p = SseParser::new();
        assert!(p.push(&s[..i]).unwrap().is_empty());
        assert_eq!(p.push(&s[i..]).unwrap(), vec!["caf\u{e9}".to_string()]);
    }

    #[test]
    fn comments_other_fields_and_multi_line_data() {
        let mut p = SseParser::new();
        let got = p.push(b": OPENROUTER PROCESSING\n\nevent: ping\nid: 7\ndata: a\ndata: b\n\n").unwrap();
        assert_eq!(got, vec!["a\nb".to_string()]);
    }

    #[test]
    fn finish_flushes_an_unterminated_event() {
        let mut p = SseParser::new();
        assert!(p.push(b"data: tail").unwrap().is_empty());
        assert_eq!(p.finish().unwrap(), vec!["tail".to_string()]);
        assert!(p.finish().unwrap().is_empty());
    }

    #[test]
    fn oversized_lines_and_events_are_protocol_errors() {
        let mut p = SseParser::new();
        assert_eq!(p.push(&vec![b'x'; MAX_LINE_BYTES + 1]), Err(LlmError::BadReply));
        let mut q = SseParser::new();
        let line = format!("data: {}\n", "y".repeat(50_000));
        assert!(q.push(line.as_bytes()).is_ok());
        assert!(q.push(line.as_bytes()).is_ok());
        assert_eq!(q.push(line.as_bytes()), Err(LlmError::BadReply));
    }

    #[test]
    fn events_map_to_delta_usage_finish_and_error() {
        assert!(parse_event("[DONE]").finished);
        assert_eq!(parse_event(r#"{"choices":[{"delta":{"content":"hi"}}]}"#).delta.as_deref(), Some("hi"));
        assert_eq!(parse_event(r#"{"choices":[{"delta":{"role":"assistant","content":""}}]}"#), Parsed::default());
        // reasoning text is never shown
        assert_eq!(parse_event(r#"{"choices":[{"delta":{"reasoning":"hmm","reasoning_content":"x"}}]}"#), Parsed::default());
        let f = parse_event(r#"{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":7}}"#);
        assert!(f.finished);
        assert_eq!(f.usage, Some((12, 7)));
        assert_eq!(parse_event(r#"{"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":4}}"#).usage, Some((3, 4)));
        assert_eq!(parse_event(r#"{"error":{"code":429,"message":"sk-test-KEY secret"}}"#).error, Some(LlmError::RateLimited));
        assert_eq!(parse_event(r#"{"error":{"code":500}}"#).error, Some(LlmError::BadReply));
        assert_eq!(parse_event("not json at all"), Parsed::default());
        assert_eq!(parse_event(r#"{"usage":{"prompt_tokens":"x"}}"#).usage, None);
    }

    #[test]
    fn hermes_tool_progress_events_are_dropped_by_event_type() {
        let mut p = SseParser::new();
        let leak = r#"{"choices":[{"delta":{"content":"LEAK"}}]}"#;
        let input = format!("event: hermes.tool.progress\ndata: {leak}\n\ndata: {{\"choices\":[{{\"delta\":{{\"content\":\"hi\"}}}}]}}\n\nevent: hermes.other.thing\ndata: {leak}\n\nevent: message\ndata: ok\n\n");
        let got = p.push(input.as_bytes()).unwrap();
        assert_eq!(got.len(), 2, "{got:?}");
        assert!(got.iter().all(|g| !g.contains("LEAK")));
        // the event name does not leak into the next event
        assert_eq!(got[1], "ok");
        // an unterminated trailing Hermes event is dropped at finish too
        let mut q = SseParser::new();
        assert!(q.push(format!("event: hermes.tool.progress\ndata: {leak}").as_bytes()).unwrap().is_empty());
        assert!(q.finish().unwrap().is_empty());
    }
}
