//! TraderMatrix connection: a static-key `TokenProvider` over the vault slot `tm_api_key`, and `TmState`, which
//! owns the `McpClient`, a per-call TTL cache, and in-flight de-duplication. The key is read inside Rust on
//! every call, sent only as `Authorization: Bearer`, and scrubbed from any error text before it leaves here.
use std::any::Any;
use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use sqlx::SqlitePool;
use url::Url;

use crate::error::AppError;
use crate::rh::{InitGate, Limiter, McpClient, RhError, TokenProvider};
use crate::secrets::SecretStore;
use crate::tm::quota::{self, Admit, Budgets, Clock, Gate, Priority, QuotaStatus, Signal, SystemClock};
use crate::tm::reads;
use crate::tm::types::*;

pub const TM_ENDPOINT: &str = "https://api.traderdaddy.pro/api/v1/mcp";
pub const TM_KEY_SLOT: &str = "tm_api_key";
const KEY_PREFIX: &str = "td_live_";
/// Transport smoothing only (2 requests/s, burst 2, shared by the handshake and calls). The CALL BUDGET (10 per minute, 200 per day,
/// priorities, learning) is `quota::Gate`, applied in `TmState::gated` before every tool call.
const RATE_PER_SEC: u32 = 2;
const RATE_BURST: u32 = 2;
/// Apex levels move slowly (TM's own per-ticker change cooldown is 4 h), so they cache as long as the rest (was 60 s before M20a).
const TTL_APEX: Duration = Duration::from_secs(300);
const TTL_OTHER: Duration = Duration::from_secs(300);
const TTL_WATCHLISTS: Duration = Duration::from_secs(20);
/// Above this many cache slots, idle ones are dropped.
const MAX_SLOTS: usize = 256;

fn store_err(e: AppError) -> RhError {
    let m = e.to_string();
    if m.contains("vault locked") {
        RhError::TmVaultLocked
    } else {
        // Secret-store messages never carry secret values.
        RhError::Protocol(format!("secret store: {m}"))
    }
}

/// Reads the key from the secret store on every call; nothing is cached here.
pub struct VaultKeyProvider {
    store: Arc<dyn SecretStore>,
}

impl VaultKeyProvider {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        Self { store }
    }

    fn key(&self) -> Result<String, RhError> {
        let raw = zeroize::Zeroizing::new(self.store.get(TM_KEY_SLOT).map_err(store_err)?.ok_or(RhError::TmKeyMissing)?);
        let k = raw.trim();
        if k.is_empty() {
            return Err(RhError::TmKeyMissing);
        }
        // The value is deliberately not echoed in this message.
        if !k.starts_with(KEY_PREFIX) || k.len() == KEY_PREFIX.len() || !k.bytes().all(|b| b.is_ascii_graphic()) {
            return Err(RhError::Invalid("the stored TraderMatrix key is malformed (expected td_live_...); set it again".into()));
        }
        Ok(k.to_string())
    }
}

impl std::fmt::Debug for VaultKeyProvider {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("VaultKeyProvider")
    }
}

#[async_trait::async_trait]
impl TokenProvider for VaultKeyProvider {
    async fn access_token(&self) -> Result<String, RhError> {
        self.key()
    }
    /// A static key cannot be refreshed: the 401 that triggers this call IS the rejection. Failing here (instead
    /// of retrying) means exactly one request is spent on a bad key.
    async fn force_refresh(&self) -> Result<String, RhError> {
        Err(RhError::TmKeyRejected)
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TmStatus {
    /// A non-empty value exists in the slot. The value itself is never returned.
    pub key_present: bool,
    pub last_error: Option<String>,
}

type Cached = Arc<dyn Any + Send + Sync>;
type Slot = Arc<tokio::sync::Mutex<Option<(Instant, Cached)>>>;

pub struct TmState {
    store: Arc<dyn SecretStore>,
    client: McpClient,
    /// Single-flight gate for `initialize` (failed attempts answer queued callers fast).
    init: InitGate,
    last_error: Mutex<Option<String>>,
    /// One slot per tool+args. Holding the slot's lock while fetching is what de-duplicates concurrent calls.
    slots: Mutex<HashMap<String, Slot>>,
    /// Test hook: milliseconds added to the clock so TTL expiry can be tested without sleeping.
    skew_ms: AtomicU64,
    /// Epoch-ms clock for the call budget (a fake one in tests).
    clock: Arc<dyn Clock>,
    gate: Mutex<Gate>,
    pool: Option<SqlitePool>,
    /// Budgets and today's count are read from the database once, before the first call that needs them.
    loaded: tokio::sync::OnceCell<()>,
    /// Serialises writes of today's row so a stale snapshot can never overwrite a newer one.
    persist_lock: tokio::sync::Mutex<()>,
    #[cfg(test)]
    fake: Option<Arc<quota::FakeClock>>,
}

impl std::fmt::Debug for TmState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TmState")
    }
}

impl TmState {
    pub fn new(store: Arc<dyn SecretStore>) -> Self {
        let endpoint = Url::parse(TM_ENDPOINT).expect("static TraderMatrix endpoint");
        let tokens = Arc::new(VaultKeyProvider::new(store.clone()));
        let client = McpClient::new(endpoint, tokens, Arc::new(Limiter::new(RATE_PER_SEC, RATE_BURST))).without_rate_retry();
        Self::build(store, client)
    }

    /// Keeps the daily counter and the two budgets in the app database (call before the state is shared).
    pub fn with_pool(mut self, pool: SqlitePool) -> Self {
        self.pool = Some(pool);
        self
    }

    /// Legacy tests: a fake clock and budgets so large that the gate never interferes.
    #[cfg(test)]
    pub(crate) fn for_test(endpoint: Url, store: Arc<dyn SecretStore>) -> Self {
        let clock = Arc::new(quota::FakeClock::new(quota::utc_ms(2026, 11, 11, 15, 0, 0)));
        Self::for_test_with(endpoint, store, clock, None, Budgets { per_min: 1000, per_day: 100_000 })
    }

    #[cfg(test)]
    pub(crate) fn for_test_with(endpoint: Url, store: Arc<dyn SecretStore>, clock: Arc<quota::FakeClock>, pool: Option<SqlitePool>, budgets: Budgets) -> Self {
        let tokens = Arc::new(VaultKeyProvider::new(store.clone()));
        let client = McpClient::new(endpoint, tokens, Arc::new(Limiter::new(1000, 1000))).without_rate_retry().with_delays(Duration::from_millis(20), Duration::from_millis(5));
        let mut s = Self::build(store, client);
        s.clock = clock.clone();
        s.fake = Some(clock);
        s.gate = Mutex::new(Gate::new(budgets));
        s.pool = pool;
        s
    }

    fn build(store: Arc<dyn SecretStore>, client: McpClient) -> Self {
        Self {
            store,
            client,
            init: InitGate::new(),
            last_error: Mutex::new(None),
            slots: Mutex::new(HashMap::new()),
            skew_ms: AtomicU64::new(0),
            clock: Arc::new(SystemClock),
            gate: Mutex::new(Gate::new(Budgets::default())),
            pool: None,
            loaded: tokio::sync::OnceCell::new(),
            persist_lock: tokio::sync::Mutex::new(()),
            #[cfg(test)]
            fake: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn advance_clock(&self, d: Duration) {
        self.skew_ms.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
        if let Some(f) = &self.fake {
            f.advance(d.as_millis() as i64);
        }
    }

    // ---- call budget (M20a) ----

    async fn load_once(&self) {
        self.loaded
            .get_or_init(|| async {
                let Some(pool) = &self.pool else { return };
                let now = self.clock.now_ms();
                let budgets = quota::load_budgets_opt(pool).await;
                let row = quota::load_day(pool, &quota::day_string(now)).await.ok().flatten();
                if let Ok(mut g) = self.gate.lock() {
                    if let Some(b) = budgets {
                        g.set_budgets(b);
                    }
                    if let Some(r) = row {
                        g.restore(now, r);
                    }
                }
            })
            .await;
    }

    /// Writes today's row (the latest state, under a lock so writes cannot cross). Counts and flags only. A failed write is not fatal:
    /// the in-memory count keeps working and the next call writes it again.
    async fn persist(&self) {
        let Some(pool) = &self.pool else { return };
        let _g = self.persist_lock.lock().await;
        let now = self.clock.now_ms();
        let row = match self.gate.lock() {
            Ok(mut g) => g.day_row(now),
            Err(_) => return,
        };
        let _ = quota::save_day(pool, &row).await;
    }

    /// Would the budget refuse this call right now? Nothing is recorded and nothing is sent.
    fn peek(&self, prio: Priority) -> Result<(), RhError> {
        let now = self.clock.now_ms();
        let mut g = self.gate.lock().map_err(|_| RhError::Protocol("quota gate poisoned".into()))?;
        match g.check(now, prio) {
            Admit::Deny { message, .. } => Err(RhError::TmPaused(message)),
            _ => Ok(()),
        }
    }

    /// Takes one slot: waits (on the clock) when the wait is short, refuses with the time when it is not.
    async fn admit(&self, prio: Priority) -> Result<(), RhError> {
        loop {
            let now = self.clock.now_ms();
            let step = self.gate.lock().map_err(|_| RhError::Protocol("quota gate poisoned".into()))?.try_acquire(now, prio);
            match step {
                Admit::Go => {
                    self.persist().await;
                    return Ok(());
                }
                Admit::Wait { until_ms } => self.clock.sleep_until_ms(until_ms).await,
                Admit::Deny { message, .. } => return Err(RhError::TmPaused(message)),
            }
        }
    }

    /// Reads what the server said about its limits (tool errors, HTTP errors, 429) and tightens the gate. Never loosens it.
    async fn learn<T>(&self, r: &Result<T, RhError>) {
        let Err(e) = r else { return };
        let signal = match e {
            RhError::RateLimited => Some(Signal::SlowDown),
            RhError::Tool(t) | RhError::Protocol(t) | RhError::Http(_, t) => quota::signal_from_text(t),
            _ => None,
        };
        if let Some(sig) = signal {
            let now = self.clock.now_ms();
            if let Ok(mut g) = self.gate.lock() {
                g.learn(now, sig);
            }
            self.persist().await;
        }
    }

    fn note_preview(&self, preview: bool) {
        if preview {
            if let Ok(mut g) = self.gate.lock() {
                g.note_preview();
            }
        }
    }

    /// One TM tool call under the budget. Order matters for "nothing sent": a missing or locked key is reported first (free), a paused
    /// day is reported before even the handshake, the handshake is not a tool call (not counted), then a slot is taken and the call runs.
    async fn gated<'a, T, F, Fut>(&'a self, prio: Priority, f: F) -> Result<T, RhError>
    where
        F: FnOnce(&'a McpClient) -> Fut,
        Fut: Future<Output = Result<T, RhError>> + 'a,
    {
        self.load_once().await;
        self.client.preflight().await?;
        self.peek(prio)?;
        let c = self.ready().await?;
        self.admit(prio).await?;
        let r = f(c).await;
        self.learn(&r).await;
        r
    }

    /// Today's count, the effective limit, the budgets and any pause or backoff. Local only: this never calls TraderMatrix.
    pub async fn quota_status(&self) -> QuotaStatus {
        self.load_once().await;
        let now = self.clock.now_ms();
        match self.gate.lock() {
            Ok(mut g) => g.status(now),
            Err(p) => p.into_inner().status(now),
        }
    }

    /// Saves and applies the two budgets (validated: 1 to 12 per minute, 1 to 10000 per day).
    pub async fn quota_set(&self, per_min: u32, per_day: u32) -> Result<QuotaStatus, RhError> {
        let b = Budgets::validate(per_min, per_day)?;
        self.load_once().await;
        if let Some(pool) = &self.pool {
            quota::save_budgets(pool, &b).await.map_err(|e| RhError::Protocol(format!("could not save the budgets: {e}")))?;
        }
        if let Ok(mut g) = self.gate.lock() {
            g.set_budgets(b);
        }
        Ok(self.quota_status().await)
    }

    fn now(&self) -> Instant {
        Instant::now() + Duration::from_millis(self.skew_ms.load(Ordering::SeqCst))
    }

    fn set_error(&self, e: Option<String>) {
        if let Ok(mut g) = self.last_error.lock() {
            *g = e;
        }
    }

    /// Replaces the key with `[redacted]` in any text a server or transport might have echoed back.
    fn scrub(&self, e: RhError) -> RhError {
        let key = match self.store.get(TM_KEY_SLOT).map(|k| k.map(zeroize::Zeroizing::new)) {
            Ok(Some(k)) if k.trim().len() >= 4 => zeroize::Zeroizing::new(k.trim().to_string()),
            _ => return e,
        };
        let r = |s: String| s.replace(key.as_str(), "[redacted]");
        match e {
            RhError::Http(c, s) => RhError::Http(c, r(s)),
            RhError::Tool(s) => RhError::Tool(r(s)),
            RhError::Protocol(s) => RhError::Protocol(r(s)),
            RhError::Transport(s) => RhError::Transport(r(s)),
            RhError::Invalid(s) => RhError::Invalid(r(s)),
            other => other,
        }
    }

    fn note<T>(&self, r: Result<T, RhError>) -> Result<T, RhError> {
        let r = r.map_err(|e| self.scrub(e));
        match &r {
            Ok(_) => self.set_error(None),
            Err(e) => self.set_error(Some(e.to_string())),
        }
        r
    }

    /// Key presence only (never the value). A locked vault is reported as `vault locked`.
    pub fn status(&self) -> TmStatus {
        let last_error = self.last_error.lock().ok().and_then(|g| g.clone());
        match self.store.exists(TM_KEY_SLOT) {
            Ok(key_present) => TmStatus { key_present, last_error },
            Err(e) => TmStatus { key_present: false, last_error: Some(store_err(e).to_string()) },
        }
    }

    async fn ready(&self) -> Result<&McpClient, RhError> {
        self.init.ready(&self.client).await?;
        Ok(&self.client)
    }

    /// Returns a fresh cached value, or runs `fetch` while holding the slot so identical concurrent calls wait
    /// for it and then read its result. Failures are never cached. A rejected key re-arms `initialize`.
    async fn cached<T, F, Fut>(&self, key: String, ttl: Duration, fetch: F) -> Result<T, RhError>
    where
        T: Clone + Send + Sync + 'static,
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<T, RhError>>,
    {
        let slot = {
            let mut m = self.slots.lock().map_err(|_| RhError::Protocol("cache poisoned".into()))?;
            if m.len() >= MAX_SLOTS && !m.contains_key(&key) {
                m.retain(|_, s| Arc::strong_count(s) > 1);
            }
            m.entry(key).or_default().clone()
        };
        let mut g = slot.lock().await;
        if let Some((at, v)) = g.as_ref() {
            if self.now().saturating_duration_since(*at) < ttl {
                if let Some(t) = v.downcast_ref::<T>() {
                    return Ok(t.clone());
                }
            }
        }
        let started = self.now();
        match fetch().await {
            Ok(t) => {
                *g = Some((started, Arc::new(t.clone())));
                Ok(t)
            }
            Err(e) => {
                *g = None;
                if matches!(e, RhError::TmKeyRejected) {
                    self.init.reset().await;
                }
                Err(e)
            }
        }
    }

    pub async fn apex_levels(&self, symbol: &str, expiration: Option<&str>) -> Result<ApexLevels, RhError> {
        self.apex_levels_with(symbol, expiration, Priority::Interactive).await
    }

    pub async fn apex_levels_with(&self, symbol: &str, expiration: Option<&str>, prio: Priority) -> Result<ApexLevels, RhError> {
        let r = async {
            let sym = reads::valid_symbol(symbol)?;
            let exp = expiration.map(reads::valid_expiration).transpose()?;
            let key = format!("{}|{}", reads::TOOL_APEX_LEVELS, reads::apex_args(&sym, exp.as_deref()));
            self.cached(key, TTL_APEX, || async { self.marked(prio, |c| reads::fetch_apex_levels(c, &sym, exp.as_deref())).await }).await
        }
        .await;
        self.note(r)
    }

    pub async fn expected_move(&self, symbol: &str) -> Result<ExpectedMove, RhError> {
        self.expected_move_with(symbol, Priority::Interactive).await
    }

    pub async fn expected_move_with(&self, symbol: &str, prio: Priority) -> Result<ExpectedMove, RhError> {
        let r = async {
            let sym = reads::valid_symbol(symbol)?;
            let key = format!("{}|{sym}", reads::TOOL_EXPECTED_MOVE);
            self.cached(key, TTL_OTHER, || async { self.marked(prio, |c| reads::fetch_expected_move(c, &sym)).await }).await
        }
        .await;
        self.note(r)
    }

    pub async fn iv_rank(&self, symbol: &str) -> Result<IvRank, RhError> {
        self.iv_rank_with(symbol, Priority::Interactive).await
    }

    pub async fn iv_rank_with(&self, symbol: &str, prio: Priority) -> Result<IvRank, RhError> {
        let r = async {
            let sym = reads::valid_symbol(symbol)?;
            let key = format!("{}|{sym}", reads::TOOL_IV_RANK);
            self.cached(key, TTL_OTHER, || async { self.marked(prio, |c| reads::fetch_iv_rank(c, &sym)).await }).await
        }
        .await;
        self.note(r)
    }

    pub async fn snapshot(&self, symbol: &str) -> Result<Snapshot, RhError> {
        self.snapshot_with(symbol, Priority::Interactive).await
    }

    pub async fn snapshot_with(&self, symbol: &str, prio: Priority) -> Result<Snapshot, RhError> {
        let r = async {
            let sym = reads::valid_symbol(symbol)?;
            let key = format!("{}|{sym}", reads::TOOL_TICKER_SNAPSHOT);
            self.cached(key, TTL_OTHER, || async { self.marked(prio, |c| reads::fetch_snapshot(c, &sym)).await }).await
        }
        .await;
        self.note(r)
    }

    /// A budgeted read whose response may carry TM's `preview` marker.
    async fn marked<'a, T, F, Fut>(&'a self, prio: Priority, f: F) -> Result<T, RhError>
    where
        F: FnOnce(&'a McpClient) -> Fut,
        Fut: Future<Output = Result<reads::Fetched<T>, RhError>> + 'a,
    {
        let (v, preview) = self.gated(prio, f).await?;
        self.note_preview(preview);
        Ok(v)
    }

    fn watchlists_key() -> String {
        reads::TOOL_LIST_WATCHLISTS.to_string()
    }

    /// Forget the cached list read. Called after every write attempt, successful or not: a refused or
    /// interrupted write may still have changed the server, so the cache cannot be trusted.
    fn invalidate_watchlists(&self) {
        if let Ok(mut m) = self.slots.lock() {
            m.remove(&Self::watchlists_key());
        }
    }

    pub async fn watchlists(&self) -> Result<TmWatchlists, RhError> {
        self.watchlists_with(Priority::Interactive).await
    }

    pub async fn watchlists_with(&self, prio: Priority) -> Result<TmWatchlists, RhError> {
        let r = self.cached(Self::watchlists_key(), TTL_WATCHLISTS, || async { self.marked(prio, reads::fetch_watchlists).await }).await;
        self.note(r)
    }

    /// Adds one symbol to a list (name or numeric id). Idempotent upstream. Never auto-retried (not a read tool).
    pub async fn watchlist_add(&self, list: &str, ticker: &str) -> Result<TmAddOutcome, RhError> {
        self.watchlist_add_with(list, ticker, Priority::Interactive).await
    }

    pub async fn watchlist_add_with(&self, list: &str, ticker: &str, prio: Priority) -> Result<TmAddOutcome, RhError> {
        let r = async {
            let list = reads::valid_list_ref(list)?;
            let sym = reads::valid_symbol(ticker)?;
            // A call the budget refused never reached the server, so the cached list is still trustworthy: invalidate only after a real attempt.
            let out = self.gated(prio, |c| reads::add_to_watchlist(c, &list, &sym)).await;
            if !matches!(out, Err(RhError::TmPaused(_))) {
                self.invalidate_watchlists();
            }
            out
        }
        .await;
        self.note(r)
    }

    /// Creates an empty list. Never auto-retried.
    pub async fn watchlist_create(&self, name: &str) -> Result<TmWatchlistMeta, RhError> {
        self.watchlist_create_with(name, Priority::Interactive).await
    }

    pub async fn watchlist_create_with(&self, name: &str, prio: Priority) -> Result<TmWatchlistMeta, RhError> {
        let r = async {
            let name = reads::valid_list_ref(name)?;
            let out = self.gated(prio, |c| reads::create_watchlist(c, &name)).await;
            if !matches!(out, Err(RhError::TmPaused(_))) {
                self.invalidate_watchlists();
            }
            out
        }
        .await;
        self.note(r)
    }
}
