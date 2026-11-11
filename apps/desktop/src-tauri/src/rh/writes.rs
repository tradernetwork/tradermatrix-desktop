//! Typed write-tool wrappers: review_*, place_*, cancel_* (equity and option) and the trade-approval tools.
//! There is no generic entry point; tool names are fixed per function. `McpClient` never auto-retries
//! `place_*`, `cancel_*` or `decline_*` (not in its read prefixes), not even on 404 session expiry.
use std::sync::atomic::Ordering;

use serde_json::{json, Value};

use crate::rh::error::RhError;
use crate::rh::mcp::McpClient;
use crate::rh::orders::{is_account, is_uuid, OrderKind, PlaceOutcome};
use crate::rh::reviews::{expired_err, retry_closed_err, PlaceState, ReviewArgs, ReviewRecord};

const MAX_APPROVAL_PAGES: usize = 5;
const APPROVAL_STATES: [&str; 5] = ["pending", "approved", "declined", "expired", "auto_approved"];

fn bad<T>(what: &str) -> Result<T, RhError> {
    Err(RhError::Invalid(what.into()))
}

fn is_id(s: &str) -> bool {
    !s.is_empty() && s.len() <= 64 && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn data_of(r: &crate::rh::mcp::ToolResult) -> Result<Value, RhError> {
    r.data().cloned().ok_or_else(|| RhError::Protocol("tool response carried no JSON data".into()))
}

/// `review_*`: validated args without `ref_id`. Returns the tool's `data` object whole.
pub async fn review(c: &McpClient, a: &ReviewArgs) -> Result<Value, RhError> {
    let r = c.call_tool(a.review_tool(), a.tool_args(None)).await?;
    data_of(&r)
}

fn unknown(e: &RhError, retry_until: u64) -> PlaceOutcome {
    PlaceOutcome::Unknown {
        message: format!(
            "Could not confirm whether the order was placed ({e}). Check Orders before doing anything else. Retrying re-sends the same reference id, which Robinhood de-duplicates."
        ),
        retry_until: Some(retry_until),
    }
}

/// Server text that means "may have acted" or "this ref_id was already used": the order may exist, so it is
/// never reported as Rejected. 5xx in the tool's prose, timeouts, gateways, and idempotency collisions.
pub(crate) fn is_ambiguous_tool_error(text: &str) -> bool {
    let t = text.to_ascii_lowercase();
    let api_5xx = t.match_indices("api error 5").any(|(i, m)| {
        let rest = &t.as_bytes()[i + m.len()..];
        rest.len() >= 2 && rest[0].is_ascii_digit() && rest[1].is_ascii_digit()
    });
    api_5xx
        || [
            "timeout", "timed out", "gateway", "unavailable", "upstream", "try again", "internal server error",
            "duplicate", "idempotent", "idempotency", "already exists", "conflict",
        ]
        .iter()
        .any(|k| t.contains(k))
}

/// Errors produced on our side before (or instead of) anything reaching the server.
fn is_local_failure(e: &RhError) -> bool {
    match e {
        RhError::NotConnected | RhError::Unauthorized | RhError::Invalid(_) | RhError::TmVaultLocked | RhError::TmKeyMissing => true,
        RhError::Protocol(m) => m.starts_with("secret store:"),
        _ => false,
    }
}

/// Maps `data.approval.state` (prefix `APPROVAL_STATE_` optional, any case).
fn approval_outcome(a: &Value, retry_until: u64) -> PlaceOutcome {
    let raw = a.get("state").and_then(Value::as_str).unwrap_or("").to_ascii_uppercase();
    let st = raw.strip_prefix("APPROVAL_STATE_").unwrap_or(&raw);
    match st {
        "PENDING" => PlaceOutcome::AwaitingApproval { approval: a.clone() },
        "AUTO_APPROVED" | "APPROVED" => PlaceOutcome::Placed {
            order: a.get("actual_order").filter(|o| o.is_object()).cloned().unwrap_or_else(|| a.clone()),
        },
        "DECLINED" | "EXPIRED" | "CANCELLED" | "CANCELED" => PlaceOutcome::Rejected {
            message: format!("approval was {}; nothing placed", st.to_ascii_lowercase()),
        },
        _ => PlaceOutcome::Unknown {
            message: format!(
                "Robinhood returned an approval in an unrecognised state ({}). Check Orders and the Robinhood app before doing anything else.",
                if raw.is_empty() { "missing" } else { raw.as_str() }
            ),
            retry_until: Some(retry_until),
        },
    }
}

/// `retry`: this is not the first send of the record, so ANY error may hide the first send's success.
fn outcome_of(res: Result<crate::rh::mcp::ToolResult, RhError>, retry: bool, retry_until: u64) -> PlaceOutcome {
    match res {
        Ok(r) => {
            let data = r.data();
            let approval = data.and_then(|d| d.get("approval")).filter(|v| v.is_object());
            let order = data.and_then(|d| d.get("order")).filter(|v| v.is_object());
            // An approval wins over a stray `order`: its state says whether anything was placed.
            match (approval, order) {
                (Some(a), _) => approval_outcome(a, retry_until),
                (None, Some(o)) => PlaceOutcome::Placed { order: o.clone() },
                (None, None) => PlaceOutcome::Unknown {
                    message: "Robinhood answered without an order or an approval. Check Orders before doing anything else.".into(),
                    retry_until: Some(retry_until),
                },
            }
        }
        Err(e) if retry => unknown(&e, retry_until),
        Err(RhError::Tool(m)) if is_ambiguous_tool_error(&m) => unknown(&RhError::Tool(m), retry_until),
        // The server answered with a clear refusal: not placed.
        Err(RhError::Tool(m)) => PlaceOutcome::Rejected { message: m },
        Err(e) if is_local_failure(&e) => PlaceOutcome::Rejected { message: format!("nothing was sent: {e}") },
        // Anything else may have reached the server: transport, HTTP status, rate limit text, unreadable reply.
        Err(e) => unknown(&e, retry_until),
    }
}

/// Sends `place_*` for a review record. Serialized per record; never retries by itself.
/// `seen` is the attempt counter read when the caller started: if another attempt finished while this call
/// waited, the stored outcome is returned instead of sending again (a double click is not a retry).
pub async fn place(c: &McpClient, rec: &ReviewRecord, now: u64, seen: u32) -> Result<PlaceOutcome, RhError> {
    let mut st = rec.state.lock().await;
    if rec.attempts.load(Ordering::SeqCst) != seen {
        match &*st {
            PlaceState::Done(o) => return Ok(o.clone()),
            PlaceState::Unknown { message, retry_until } => {
                return Ok(PlaceOutcome::Unknown { message: message.clone(), retry_until: Some(*retry_until) })
            }
            PlaceState::Fresh => {}
        }
    }
    let retry = match &*st {
        PlaceState::Done(o) => return Ok(o.clone()),
        PlaceState::Fresh if rec.expired(now) => return Err(expired_err()),
        PlaceState::Fresh => false,
        PlaceState::Unknown { retry_until, .. } if now > *retry_until => return Err(retry_closed_err()),
        PlaceState::Unknown { .. } => true,
    };
    // Resolve credentials first: a locked vault or a lost login is known before anything is sent.
    if let Err(e) = c.preflight().await {
        if retry {
            // The earlier send is still unknown; this attempt sent nothing. Keep the record Unknown.
            return Err(e);
        }
        let out = PlaceOutcome::Rejected { message: format!("nothing was sent: {e}") };
        *st = PlaceState::Done(out.clone());
        return Ok(out);
    }
    let retry_until = rec.mark_sent(now);
    let args = rec.args.tool_args(Some(&rec.ref_id));
    let out = outcome_of(c.call_tool(rec.args.place_tool(), args).await, retry, retry_until);
    rec.attempts.fetch_add(1, Ordering::SeqCst);
    *st = match &out {
        PlaceOutcome::Unknown { message, .. } => PlaceState::Unknown { message: message.clone(), retry_until },
        o => PlaceState::Done(o.clone()),
    };
    Ok(out)
}

pub fn validate_account(account: &str) -> Result<(), RhError> {
    if is_account(account) { Ok(()) } else { bad("account must be alphanumeric") }
}

/// Checked before the client is touched, so a bad id costs zero requests (not even `initialize`).
pub fn validate_cancel(account: &str, order_id: &str) -> Result<(), RhError> {
    validate_account(account)?;
    if is_uuid(order_id) { Ok(()) } else { bad("order id must be an order UUID") }
}

/// `get_trade_approvals` LISTS pending approvals only (other states are reachable by id alone), so the only
/// state filter that means anything is `pending`; asking for another state is refused instead of returning [].
pub fn validate_approvals(account: &str, state: Option<&str>) -> Result<(), RhError> {
    validate_account(account)?;
    match state {
        None | Some("pending") => Ok(()),
        Some(s) if APPROVAL_STATES.contains(&s) => bad("only pending approvals can be listed; see the Robinhood app for approved, declined or expired ones"),
        Some(_) => bad("approval state must be pending"),
    }
}

pub fn validate_decline(account: &str, approval_id: &str) -> Result<(), RhError> {
    validate_account(account)?;
    if is_id(approval_id) { Ok(()) } else { bad("approval id is not valid") }
}

/// `cancel_*_order`. The response is only `{accepted}`; cancellation is asynchronous, so callers re-read orders.
pub async fn cancel(c: &McpClient, kind: OrderKind, account: &str, order_id: &str) -> Result<bool, RhError> {
    validate_cancel(account, order_id)?;
    let tool = match kind {
        OrderKind::Equity => "cancel_equity_order",
        OrderKind::Option => "cancel_option_order",
    };
    let r = c.call_tool(tool, json!({"account_number": account, "order_id": order_id})).await?;
    data_of(&r)?
        .get("accepted")
        .and_then(Value::as_bool)
        .ok_or_else(|| RhError::Protocol("unreadable cancel response".into()))
}

pub async fn approval_setting(c: &McpClient, account: &str) -> Result<Value, RhError> {
    validate_account(account)?;
    data_of(&c.call_tool("get_trade_approval_setting", json!({"account_number": account})).await?)
}

/// Pending approvals, exactly as the tool lists them (it lists pending ones only; no client-side filter).
pub async fn approvals(c: &McpClient, account: &str, state: Option<&str>) -> Result<Value, RhError> {
    validate_approvals(account, state)?;
    let mut all: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    for _ in 0..MAX_APPROVAL_PAGES {
        let mut args = json!({"account_number": account});
        if let Some(cu) = &cursor {
            args["cursor"] = json!(cu);
        }
        let d = data_of(&c.call_tool("get_trade_approvals", args).await?)?;
        if let Some(a) = d.get("approvals").and_then(Value::as_array) {
            all.extend(a.iter().filter(|v| v.is_object()).cloned());
        }
        match d.get("next").and_then(Value::as_str) {
            Some(n) if !n.is_empty() && cursor.as_deref() != Some(n) => cursor = Some(n.to_string()),
            _ => break,
        }
    }
    Ok(json!({"approvals": all}))
}

/// Withdraws one pending approval. A write: never auto-retried.
pub async fn decline(c: &McpClient, account: &str, approval_id: &str) -> Result<Value, RhError> {
    validate_decline(account, approval_id)?;
    data_of(&c.call_tool("decline_trade_approval", json!({"account_number": account, "approval_id": approval_id})).await?)
}
