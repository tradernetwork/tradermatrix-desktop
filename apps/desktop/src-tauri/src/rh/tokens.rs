//! Token persistence (vault slot `robinhood_oauth`) and the refreshing `TokenProvider`.
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use zeroize::Zeroize;

use crate::rh::error::RhError;
use crate::rh::mcp::TokenProvider;
use crate::rh::oauth::{self, Metadata, OAuthConfig};
use crate::secrets::SecretStore;

pub const SLOT: &str = "robinhood_oauth";
/// Refresh when fewer than this many seconds remain (capped at half the token's lifetime, see `refresh_skew`).
pub const REFRESH_SKEW_SEC: i64 = 3600;
/// A `force_refresh` that arrives this soon after a completed refresh reuses it (the 401 was for a stale token).
const FORCE_REUSE_WINDOW_SEC: u64 = 10;

/// Serialized only into the vault slot. Debug is redacted.
#[derive(Clone, Serialize, Deserialize)]
pub struct StoredTokens {
    pub client_id: String,
    pub redirect_uri: String,
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: i64,
    /// When this pair was issued (0 for pairs stored before 2026-11-11: lifetime unknown).
    #[serde(default)]
    pub issued_at: i64,
}

impl std::fmt::Debug for StoredTokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("StoredTokens")
            .field("client_id", &self.client_id)
            .field("access_token", &"[redacted]")
            .field("refresh_token", &"[redacted]")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

impl Drop for StoredTokens {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

/// min(3600, lifetime / 2): a short-lived token is not refreshed on every call. Unknown lifetime: 3600.
pub fn refresh_skew(t: &StoredTokens) -> i64 {
    match t.expires_at.checked_sub(t.issued_at) {
        Some(life) if t.issued_at > 0 && life > 0 => REFRESH_SKEW_SEC.min(life / 2),
        _ => REFRESH_SKEW_SEC,
    }
}

impl StoredTokens {
    /// True when the token is inside its refresh window.
    pub fn expires_soon(&self, now: i64) -> bool {
        self.expires_at.saturating_sub(now) <= refresh_skew(self)
    }
}

pub fn now_unix() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn store_err(e: crate::error::AppError) -> RhError {
    // The secret-store layer never puts secret values in its messages.
    RhError::Protocol(format!("secret store: {e}"))
}

pub fn load_tokens(store: &dyn SecretStore) -> Result<Option<StoredTokens>, RhError> {
    match store.get(SLOT).map_err(store_err)? {
        None => Ok(None),
        Some(json) => serde_json::from_str::<StoredTokens>(&zeroize::Zeroizing::new(json))
            .map(Some)
            .map_err(|_| RhError::Protocol("stored Robinhood credentials are unreadable; reconnect".into())),
    }
}

pub fn save_tokens(store: &dyn SecretStore, t: &StoredTokens) -> Result<(), RhError> {
    let json = zeroize::Zeroizing::new(serde_json::to_string(t).map_err(|_| RhError::Protocol("could not serialize credentials".into()))?);
    store.set(SLOT, &json).map_err(store_err)
}

struct Inner {
    meta: Option<Metadata>,
    /// A rotated pair that could not be written. The old refresh token is already spent server-side,
    /// so this is the only live copy; every call retries the save before doing anything else.
    pending: Option<StoredTokens>,
    last_refresh: Option<Instant>,
    /// Bumped by login, logout and lock: a refresh that started under an older generation never writes.
    generation: u64,
}

pub struct VaultTokenProvider {
    cfg: OAuthConfig,
    store: Arc<dyn SecretStore>,
    http: reqwest::Client,
    inner: Mutex<Inner>,
}

impl VaultTokenProvider {
    pub fn new(cfg: OAuthConfig, store: Arc<dyn SecretStore>) -> Self {
        Self {
            cfg,
            store,
            http: oauth::http_client(),
            inner: Mutex::new(Inner { meta: None, pending: None, last_refresh: None, generation: 0 }),
        }
    }

    /// One path for both entry points. The tokio Mutex is the single-flight gate: a second caller
    /// waits, then re-reads the store and finds the already-rotated pair.
    async fn ensure(&self, force: bool) -> Result<String, RhError> {
        let mut g = self.inner.lock().await;
        if let Some(p) = g.pending.clone() {
            save_tokens(&*self.store, &p)?;
            g.pending = None;
        }
        let cur = load_tokens(&*self.store)?.ok_or(RhError::NotConnected)?;
        let fresh = !cur.expires_soon(now_unix());
        let just_refreshed = g.last_refresh.is_some_and(|t| t.elapsed().as_secs() < FORCE_REUSE_WINDOW_SEC);
        if (!force && fresh) || (force && just_refreshed) {
            return Ok(cur.access_token.clone());
        }
        if g.meta.is_none() {
            g.meta = Some(oauth::discover(&self.http, &self.cfg).await?);
        }
        let meta = g.meta.clone().ok_or(RhError::NotConnected)?;
        let generation = g.generation;
        let next = oauth::refresh_grant(&self.http, &meta, &cur, now_unix()).await?;
        if g.generation != generation {
            // Logged out (or in again) meanwhile: this pair belongs to a session that no longer exists.
            return Err(RhError::NotConnected);
        }
        g.last_refresh = Some(Instant::now());
        // Persist the rotated pair BEFORE the new access token is handed to anyone.
        if let Err(e) = save_tokens(&*self.store, &next) {
            g.pending = Some(next);
            return Err(e);
        }
        Ok(next.access_token.clone())
    }
}

impl VaultTokenProvider {
    /// Runs `f` under the provider lock after dropping any pending pair and bumping the generation, so no
    /// in-flight or failed-to-save refresh can write tokens across a login, logout or lock.
    async fn exclusive<T>(&self, f: impl FnOnce() -> Result<T, RhError>) -> Result<T, RhError> {
        let mut g = self.inner.lock().await;
        g.pending = None;
        g.last_refresh = None;
        g.generation += 1;
        f()
    }

    /// Deletes the stored pair.
    pub async fn logout(&self) -> Result<(), RhError> {
        self.exclusive(|| oauth::logout(&*self.store)).await
    }

    /// Stores a freshly obtained pair (login).
    pub async fn install(&self, t: &StoredTokens) -> Result<(), RhError> {
        self.exclusive(|| save_tokens(&*self.store, t)).await
    }

    /// Drops an unsaved rotated pair (the vault was locked: nothing may be written to it later).
    pub async fn forget_pending(&self) {
        let _ = self.exclusive(|| Ok(())).await;
    }
}

#[async_trait::async_trait]
impl TokenProvider for VaultTokenProvider {
    async fn access_token(&self) -> Result<String, RhError> {
        self.ensure(false).await
    }
    async fn force_refresh(&self) -> Result<String, RhError> {
        self.ensure(true).await
    }
}
