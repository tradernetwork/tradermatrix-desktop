//! One explain call end to end (M16 B2): budget checks, the stream, usage accounting. The Tauri command is a thin wrapper around `run`.
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::explain_usage::{self as eu, cost_usd, price_for, UsageSummary};
use crate::llm::{Emit, End, LlmError, LlmState, StreamParams, Usage};

#[derive(Debug, Clone, Serialize)]
pub struct AskOut {
    pub text: String,
    pub usage: Usage,
    /// `done` or `cancelled` (the user pressed Stop; `text` is the partial reply).
    pub end: String,
    /// SHA-256 of the digest that was sent (the digest itself is never kept).
    pub digest_hash: String,
    pub model: String,
    /// Estimated dollars for this call; null = price unknown (never 0 for an unknown price).
    pub cost_usd: Option<f64>,
}

fn sha256_hex(s: &str) -> String {
    Sha256::digest(s.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

/// Checks the budgets (nothing is sent when one is used up: `budget`), streams, records the usage. Failures are the fixed codes.
pub async fn run(llm: &LlmState, pool: &SqlitePool, day: &str, request_id: &str, p: StreamParams, emit: Emit) -> Result<AskOut, LlmError> {
    let b = eu::budgets(pool).await;
    if llm.session_snapshot().0 >= b.session_tokens {
        return Err(LlmError::Budget);
    }
    if let Ok(m) = eu::month(pool, eu::month_of(day)).await {
        if m.usd >= b.month_usd {
            return Err(LlmError::Budget);
        }
    }
    let digest_hash = sha256_hex(&p.digest);
    let out = llm.explain_stream(request_id, p, emit).await;
    let used = out.usage.prompt + out.usage.completion;
    let mut cost = None;
    if used > 0 {
        llm.session_add(used, out.usage.estimated);
        cost = price_for(&out.provider, &out.model).map(|pr| cost_usd(&pr, out.usage.prompt, out.usage.completion));
        let name = if out.model.is_empty() { out.provider.as_str() } else { out.model.as_str() };
        // A counter that fails to save must not turn a good answer into an error.
        let _ = eu::record(pool, day, name, &out.usage, cost).await;
    }
    match out.end {
        End::Failed(e) => Err(e),
        End::Done => Ok(AskOut { text: out.text, usage: out.usage, end: "done".into(), digest_hash, model: out.model, cost_usd: cost }),
        End::Cancelled => Ok(AskOut { text: out.text, usage: out.usage, end: "cancelled".into(), digest_hash, model: out.model, cost_usd: cost }),
    }
}

/// The meter. `reset_session` zeroes the session counter (a session wipe) before reading.
pub async fn summary(llm: &LlmState, pool: &SqlitePool, day: &str, provider: &str, model: &str, reset_session: bool) -> UsageSummary {
    if reset_session {
        llm.session_reset();
    }
    let b = eu::budgets(pool).await;
    let (session_tokens, session_estimated) = llm.session_snapshot();
    let m = eu::month(pool, eu::month_of(day)).await.unwrap_or(eu::MonthUsage { tokens: 0, usd: 0.0, est_tokens: 0, unpriced_tokens: 0 });
    UsageSummary {
        session_tokens,
        session_cap: b.session_tokens,
        session_estimated,
        month_usd: m.usd,
        month_cap: b.month_usd,
        month_tokens: m.tokens,
        month_estimated: m.est_tokens > 0,
        month_unpriced: m.unpriced_tokens > 0,
        price_known: price_for(provider, model).is_some(),
    }
}
