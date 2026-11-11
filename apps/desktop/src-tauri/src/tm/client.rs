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
use url::Url;

use crate::error::AppError;
use crate::rh::{InitGate, Limiter, McpClient, RhError, TokenProvider};
use crate::secrets::SecretStore;
use crate::tm::reads;
use crate::tm::types::*;

pub const TM_ENDPOINT: &str = "https://api.traderdaddy.pro/api/v1/mcp";
pub const TM_KEY_SLOT: &str = "tm_api_key";
const KEY_PREFIX: &str = "td_live_";
/// 2 calls/s, burst 2.
const RATE_PER_SEC: u32 = 2;
const RATE_BURST: u32 = 2;
const TTL_APEX: Duration = Duration::from_secs(60);
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
        let client = McpClient::new(endpoint, tokens, Arc::new(Limiter::new(RATE_PER_SEC, RATE_BURST)));
        Self::build(store, client)
    }

    #[cfg(test)]
    pub(crate) fn for_test(endpoint: Url, store: Arc<dyn SecretStore>) -> Self {
        let tokens = Arc::new(VaultKeyProvider::new(store.clone()));
        let client = McpClient::new(endpoint, tokens, Arc::new(Limiter::new(1000, 1000))).with_delays(Duration::from_millis(20), Duration::from_millis(5));
        Self::build(store, client)
    }

    fn build(store: Arc<dyn SecretStore>, client: McpClient) -> Self {
        Self { store, client, init: InitGate::new(), last_error: Mutex::new(None), slots: Mutex::new(HashMap::new()), skew_ms: AtomicU64::new(0) }
    }

    #[cfg(test)]
    pub(crate) fn advance_clock(&self, d: Duration) {
        self.skew_ms.fetch_add(d.as_millis() as u64, Ordering::SeqCst);
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
        let r = async {
            let sym = reads::valid_symbol(symbol)?;
            let exp = expiration.map(reads::valid_expiration).transpose()?;
            let key = format!("{}|{}", reads::TOOL_APEX_LEVELS, reads::apex_args(&sym, exp.as_deref()));
            self.cached(key, TTL_APEX, || async { reads::fetch_apex_levels(self.ready().await?, &sym, exp.as_deref()).await }).await
        }
        .await;
        self.note(r)
    }

    pub async fn expected_move(&self, symbol: &str) -> Result<ExpectedMove, RhError> {
        let r = async {
            let sym = reads::valid_symbol(symbol)?;
            let key = format!("{}|{sym}", reads::TOOL_EXPECTED_MOVE);
            self.cached(key, TTL_OTHER, || async { reads::fetch_expected_move(self.ready().await?, &sym).await }).await
        }
        .await;
        self.note(r)
    }

    pub async fn iv_rank(&self, symbol: &str) -> Result<IvRank, RhError> {
        let r = async {
            let sym = reads::valid_symbol(symbol)?;
            let key = format!("{}|{sym}", reads::TOOL_IV_RANK);
            self.cached(key, TTL_OTHER, || async { reads::fetch_iv_rank(self.ready().await?, &sym).await }).await
        }
        .await;
        self.note(r)
    }

    pub async fn snapshot(&self, symbol: &str) -> Result<Snapshot, RhError> {
        let r = async {
            let sym = reads::valid_symbol(symbol)?;
            let key = format!("{}|{sym}", reads::TOOL_TICKER_SNAPSHOT);
            self.cached(key, TTL_OTHER, || async { reads::fetch_snapshot(self.ready().await?, &sym).await }).await
        }
        .await;
        self.note(r)
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
        let r = self.cached(Self::watchlists_key(), TTL_WATCHLISTS, || async { reads::fetch_watchlists(self.ready().await?).await }).await;
        self.note(r)
    }

    /// Adds one symbol to a list (name or numeric id). Idempotent upstream. Never auto-retried (not a read tool).
    pub async fn watchlist_add(&self, list: &str, ticker: &str) -> Result<TmAddOutcome, RhError> {
        let r = async {
            let list = reads::valid_list_ref(list)?;
            let sym = reads::valid_symbol(ticker)?;
            let out = reads::add_to_watchlist(self.ready().await?, &list, &sym).await;
            self.invalidate_watchlists();
            out
        }
        .await;
        self.note(r)
    }

    /// Creates an empty list. Never auto-retried.
    pub async fn watchlist_create(&self, name: &str) -> Result<TmWatchlistMeta, RhError> {
        let r = async {
            let name = reads::valid_list_ref(name)?;
            let out = reads::create_watchlist(self.ready().await?, &name).await;
            self.invalidate_watchlists();
            out
        }
        .await;
        self.note(r)
    }
}
