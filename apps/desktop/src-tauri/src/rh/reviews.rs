//! Server-side review records. The webview only ever holds a `review_id`; the exact order parameters and
//! the idempotency `ref_id` live here, minted once per review. `place` takes the id and nothing else.
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::rh::error::RhError;
use crate::rh::orders::{EquityOrderArgs, OptionOrderArgs, OrderKind, PlaceOutcome};

/// A review may be placed for this long (first send only).
pub const REVIEW_TTL_SECS: u64 = 300;
/// An Unknown outcome may be retried (same ref_id) for this long after the FIRST send. After that the user must
/// check Orders and review again: a stale retry could land long after the market moved.
pub const RETRY_WINDOW_SECS: u64 = 600;
/// Records (including finished ones, so a double click replays the outcome) are dropped after this.
const KEEP_SECS: u64 = 3600;

#[derive(Clone, Debug, PartialEq)]
pub enum ReviewArgs {
    Equity(EquityOrderArgs),
    Option(OptionOrderArgs),
}

impl ReviewArgs {
    pub fn kind(&self) -> OrderKind {
        match self {
            ReviewArgs::Equity(_) => OrderKind::Equity,
            ReviewArgs::Option(_) => OrderKind::Option,
        }
    }
    pub fn account(&self) -> &str {
        match self {
            ReviewArgs::Equity(a) => &a.account_number,
            ReviewArgs::Option(a) => &a.account_number,
        }
    }
    pub fn review_tool(&self) -> &'static str {
        match self {
            ReviewArgs::Equity(_) => "review_equity_order",
            ReviewArgs::Option(_) => "review_option_order",
        }
    }
    pub fn place_tool(&self) -> &'static str {
        match self {
            ReviewArgs::Equity(_) => "place_equity_order",
            ReviewArgs::Option(_) => "place_option_order",
        }
    }
    pub fn tool_args(&self, ref_id: Option<&str>) -> serde_json::Value {
        match self {
            ReviewArgs::Equity(a) => a.to_tool_args(ref_id),
            ReviewArgs::Option(a) => a.to_tool_args(ref_id),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum PlaceState {
    /// Never sent.
    Fresh,
    /// Sent, result unknown. Only an explicit user retry re-sends (same ref_id), until `retry_until`.
    Unknown { message: String, retry_until: u64 },
    /// Server answered: Placed, AwaitingApproval or Rejected. Single-use: replayed, never re-sent.
    Done(PlaceOutcome),
}

pub struct ReviewRecord {
    pub review_id: String,
    pub args: ReviewArgs,
    pub ref_id: String,
    pub created_at: u64,
    /// Held for the whole duration of a send, so concurrent `place` calls serialize.
    pub state: tokio::sync::Mutex<PlaceState>,
    /// Completed send attempts. A caller that waited behind an attempt must not send again.
    pub attempts: AtomicU32,
    /// Unix seconds of the first send (0 = never sent). Anchors the retry window.
    pub first_sent_at: AtomicU64,
}

pub enum Precheck {
    /// Answer from the record without a request.
    Replay(PlaceOutcome),
    Send,
}

impl ReviewRecord {
    /// A clock stepped backwards (now < created_at) also counts as expired.
    pub fn expired(&self, now: u64) -> bool {
        now < self.created_at || now - self.created_at > REVIEW_TTL_SECS
    }

    /// Records the first send time (idempotent) and returns the retry deadline.
    pub fn mark_sent(&self, now: u64) -> u64 {
        let _ = self.first_sent_at.compare_exchange(0, now.max(1), Ordering::SeqCst, Ordering::SeqCst);
        self.first_sent_at.load(Ordering::SeqCst) + RETRY_WINDOW_SECS
    }

    /// Decides, before any client work, whether `place` needs the server. Errors on an expired first send.
    pub async fn precheck(&self, now: u64) -> Result<Precheck, RhError> {
        let st = self.state.lock().await;
        match &*st {
            PlaceState::Done(o) => Ok(Precheck::Replay(o.clone())),
            PlaceState::Unknown { retry_until, .. } if now > *retry_until => Err(retry_closed_err()),
            PlaceState::Unknown { .. } => Ok(Precheck::Send),
            PlaceState::Fresh if self.expired(now) => Err(expired_err()),
            PlaceState::Fresh => Ok(Precheck::Send),
        }
    }
}

pub fn expired_err() -> RhError {
    RhError::Invalid("this review expired (older than 5 minutes); review the order again".into())
}

pub fn retry_closed_err() -> RhError {
    RhError::Invalid(
        "the retry window for this order has closed (10 minutes after the first send); check Orders to see whether it was placed, then review again".into(),
    )
}

pub type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

pub struct ReviewStore {
    map: Mutex<HashMap<String, Arc<ReviewRecord>>>,
    clock: Clock,
}

fn system_clock() -> Clock {
    Arc::new(|| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0))
}

impl Default for ReviewStore {
    fn default() -> Self {
        Self::new()
    }
}

impl ReviewStore {
    pub fn new() -> Self {
        Self::with_clock(system_clock())
    }

    /// Test hook: the clock returns unix seconds.
    pub fn with_clock(clock: Clock) -> Self {
        Self { map: Mutex::new(HashMap::new()), clock }
    }

    pub fn now(&self) -> u64 {
        (self.clock)()
    }

    /// Stores a new record with a freshly minted `ref_id` (every review gets its own).
    pub fn insert(&self, args: ReviewArgs) -> Result<Arc<ReviewRecord>, RhError> {
        let now = self.now();
        let rec = Arc::new(ReviewRecord {
            review_id: uuid_v4()?,
            ref_id: uuid_v4()?,
            args,
            created_at: now,
            state: tokio::sync::Mutex::new(PlaceState::Fresh),
            attempts: AtomicU32::new(0),
            first_sent_at: AtomicU64::new(0),
        });
        let mut m = self.map.lock().map_err(|_| RhError::Protocol("review store poisoned".into()))?;
        m.retain(|_, r| now.saturating_sub(r.created_at) <= KEEP_SECS);
        m.insert(rec.review_id.clone(), rec.clone());
        Ok(rec)
    }

    pub fn get(&self, review_id: &str) -> Result<Arc<ReviewRecord>, RhError> {
        let now = self.now();
        let m = self.map.lock().map_err(|_| RhError::Protocol("review store poisoned".into()))?;
        match m.get(review_id) {
            Some(r) if now.saturating_sub(r.created_at) <= KEEP_SECS => Ok(r.clone()),
            _ => Err(RhError::Invalid("unknown review id; review the order again".into())),
        }
    }
}

/// UUID version 4 from the OS RNG (`getrandom`, already a direct dependency).
pub fn uuid_v4() -> Result<String, RhError> {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).map_err(|_| RhError::Protocol("system randomness unavailable".into()))?;
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h: String = b.iter().map(|x| format!("{x:02x}")).collect();
    Ok(format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32]))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args() -> ReviewArgs {
        ReviewArgs::Equity(EquityOrderArgs {
            account_number: "SYN00000002".into(),
            symbol: "AAA".into(),
            side: "buy".into(),
            r#type: "limit".into(),
            quantity: Some("1".into()),
            dollar_amount: None,
            limit_price: Some("90".into()),
            stop_price: None,
            time_in_force: None,
            market_hours: None,
        })
    }

    #[test]
    fn uuid_v4_has_the_right_shape_and_differs() {
        let a = uuid_v4().unwrap();
        let b = uuid_v4().unwrap();
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        let p: Vec<&str> = a.split('-').collect();
        assert_eq!(p.iter().map(|x| x.len()).collect::<Vec<_>>(), [8, 4, 4, 4, 12]);
        assert!(p[2].starts_with('4'), "version nibble: {a}");
        assert!("89ab".contains(p[3].chars().next().unwrap()), "variant nibble: {a}");
        assert!(a.chars().all(|c| c == '-' || c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn every_review_mints_its_own_ids_and_unknown_ids_are_refused() {
        let s = ReviewStore::new();
        let a = s.insert(args()).unwrap();
        let b = s.insert(args()).unwrap();
        assert_ne!(a.review_id, b.review_id);
        assert_ne!(a.ref_id, b.ref_id, "identical args must still get a NEW ref_id");
        assert_ne!(a.review_id, a.ref_id);
        assert!(Arc::ptr_eq(&s.get(&a.review_id).unwrap(), &a));
        assert!(matches!(s.get("nope"), Err(RhError::Invalid(_))));
        assert!(matches!(s.get(""), Err(RhError::Invalid(_))));
    }

    #[tokio::test]
    async fn expiry_gates_a_first_send_only() {
        let t = Arc::new(AtomicU64::new(1_000));
        let t2 = t.clone();
        let s = ReviewStore::with_clock(Arc::new(move || t2.load(Ordering::SeqCst)));
        let r = s.insert(args()).unwrap();
        assert!(matches!(r.precheck(s.now()).await, Ok(Precheck::Send)));
        t.store(1_000 + REVIEW_TTL_SECS, Ordering::SeqCst);
        assert!(matches!(r.precheck(s.now()).await, Ok(Precheck::Send)), "exactly at the limit is still fine");
        t.store(1_000 + REVIEW_TTL_SECS + 1, Ordering::SeqCst);
        assert!(matches!(r.precheck(s.now()).await, Err(RhError::Invalid(m)) if m.contains("expired")));
        // A finished record replays regardless of age. Unknown may be retried until its window closes
        // (changed 2026-11-11, R2d: was "regardless of age").
        *r.state.lock().await = PlaceState::Done(PlaceOutcome::Rejected { message: "x".into() });
        assert!(matches!(r.precheck(s.now()).await, Ok(Precheck::Replay(_))));
        let until = s.now() + 10;
        *r.state.lock().await = PlaceState::Unknown { message: "x".into(), retry_until: until };
        assert!(matches!(r.precheck(s.now()).await, Ok(Precheck::Send)));
        t.store(until + 1, Ordering::SeqCst);
        assert!(matches!(r.precheck(s.now()).await, Err(RhError::Invalid(m)) if m.contains("Orders")));
    }

    #[tokio::test]
    async fn a_clock_stepped_back_counts_as_expired() {
        let t = Arc::new(AtomicU64::new(1_000));
        let t2 = t.clone();
        let s = ReviewStore::with_clock(Arc::new(move || t2.load(Ordering::SeqCst)));
        let r = s.insert(args()).unwrap();
        t.store(999, Ordering::SeqCst);
        assert!(r.expired(s.now()));
        assert!(matches!(r.precheck(s.now()).await, Err(RhError::Invalid(m)) if m.contains("expired")));
    }

    #[test]
    fn old_records_are_pruned() {
        let t = Arc::new(AtomicU64::new(0));
        let t2 = t.clone();
        let s = ReviewStore::with_clock(Arc::new(move || t2.load(Ordering::SeqCst)));
        let a = s.insert(args()).unwrap();
        t.store(KEEP_SECS + 1, Ordering::SeqCst);
        assert!(s.get(&a.review_id).is_err());
        let _ = s.insert(args()).unwrap();
        assert_eq!(s.map.lock().unwrap().len(), 1, "stale record dropped on insert");
    }
}
