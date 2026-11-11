//! Robinhood commands for the webview. Reads go through `rh::reads`; orders go through the typed
//! `rh::writes` (review, place by review id, cancel, trade approvals). There is deliberately NO generic call command.
//! Tokens never leave Rust; errors are plain strings that carry no secrets.
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::rh::tokens::{load_tokens, now_unix, save_tokens};
use crate::rh::orders::{mask_account, EquityOrderArgs, OptionOrderArgs, PlaceOutcome, ReviewOut};
use crate::rh::reviews::{Precheck, ReviewArgs, ReviewStore, REVIEW_TTL_SECS};
use crate::rh::pnl::PnlTrades;
use crate::rh::types::*;
use crate::rh::{self, pnl, reads, watch_writes as ww, writes, InitGate, Limiter, McpClient, OAuthConfig, RhError, TauriOpener, UrlOpener, VaultTokenProvider};
use crate::secrets::SecretStore;

/// Shared limit for every Robinhood call in the app: 4/s sustained, burst 4.
const RATE_PER_SEC: u32 = 4;
const RATE_BURST: u32 = 4;
/// A place error stays visible in `last_error` this long, even if unrelated polls succeed meanwhile.
const PLACE_ERROR_HOLD_SECS: u64 = 60;

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct RhStatus {
    /// Credentials are present in the secret store (not a live server check).
    pub connected: bool,
    pub expires_soon: bool,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct CaptureResult {
    pub path: String,
    pub count: usize,
    pub names: Vec<String>,
}

/// The last error, and when it came from `place` (review-clock seconds) so routine polls do not hide it.
struct LastError {
    message: String,
    place_at: Option<u64>,
}

/// Clears the `connecting` flag and the pending login URL however `connect` ends (including when its future is
/// dropped because the command was cancelled).
struct ConnectingGuard<'a> {
    flag: &'a AtomicBool,
    pending: &'a Mutex<Option<String>>,
}

impl Drop for ConnectingGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut g) = self.pending.lock() {
            *g = None;
        }
        self.flag.store(false, Ordering::SeqCst);
    }
}

pub struct RhState {
    cfg: OAuthConfig,
    store: Arc<dyn SecretStore>,
    client: McpClient,
    /// The refreshing provider (None in tests that use static fake tokens). Login/logout go through its lock.
    tokens: Option<Arc<VaultTokenProvider>>,
    /// Single-flight gate for `initialize` (failed attempts answer queued callers fast).
    init: InitGate,
    last_error: Mutex<Option<LastError>>,
    connecting: AtomicBool,
    /// The authorize URL of the login in progress (public data: no verifier, no tokens), so the UI can offer "copy link".
    pending_login: Mutex<Option<String>>,
    /// Server-side review records: the webview only ever holds a review id.
    reviews: ReviewStore,
}

impl RhState {
    pub fn new(store: Arc<dyn SecretStore>, cfg: OAuthConfig) -> Self {
        let tokens = Arc::new(VaultTokenProvider::new(cfg.clone(), store.clone()));
        let client = McpClient::new(cfg.resource.clone(), tokens.clone(), Arc::new(Limiter::new(RATE_PER_SEC, RATE_BURST)));
        Self {
            cfg,
            store,
            client,
            tokens: Some(tokens),
            init: InitGate::new(),
            last_error: Mutex::new(None),
            connecting: AtomicBool::new(false),
            pending_login: Mutex::new(None),
            reviews: ReviewStore::new(),
        }
    }

    /// Test hook: fake tokens, an in-memory store, no login, and an injectable review clock.
    #[cfg(test)]
    pub(crate) fn for_test(endpoint: url::Url, clock: crate::rh::reviews::Clock) -> Self {
        Self::for_test_with_tokens(endpoint, clock, Arc::new(rh::testutil::StaticTokens))
    }

    /// Test hook with an injectable token provider (e.g. one that fails like a locked vault).
    #[cfg(test)]
    pub(crate) fn for_test_with_tokens(endpoint: url::Url, clock: crate::rh::reviews::Clock, tokens: Arc<dyn rh::TokenProvider>) -> Self {
        let cfg = OAuthConfig { resource: endpoint.clone(), as_metadata_url: endpoint.clone(), scope: "internal".into() };
        let client = McpClient::new(endpoint, tokens, Arc::new(Limiter::new(1000, 1000)))
            .with_delays(std::time::Duration::from_millis(20), std::time::Duration::from_millis(5));
        Self {
            cfg,
            store: Arc::new(crate::secrets::MemoryStore::new()),
            client,
            tokens: None,
            init: InitGate::new(),
            last_error: Mutex::new(None),
            connecting: AtomicBool::new(false),
            pending_login: Mutex::new(None),
            reviews: ReviewStore::with_clock(clock),
        }
    }

    /// Raw pending authorize URL (tests only). The webview gets it through `webview_safe_login_url`.
    pub(crate) fn pending_raw(&self) -> Option<String> {
        self.pending_login.lock().ok().and_then(|g| g.clone())
    }

    /// The login URL in progress, but only if it is an https robinhood.com URL.
    pub fn pending_login_url(&self) -> Option<String> {
        self.pending_raw().and_then(|u| webview_safe_login_url(&u))
    }

    /// Records the outcome of a non-place command. Success clears the error, except a place error younger than
    /// `PLACE_ERROR_HOLD_SECS` (a quote poll must not wipe "your order failed" before the user saw it).
    fn note<T>(&self, r: Result<T, RhError>) -> Result<T, RhError> {
        let now = self.reviews.now();
        if let Ok(mut g) = self.last_error.lock() {
            let hold = g.as_ref().and_then(|l| l.place_at).is_some_and(|t| now >= t && now - t <= PLACE_ERROR_HOLD_SECS);
            if !hold {
                *g = r.as_ref().err().map(|e| LastError { message: e.to_string(), place_at: None });
            }
        }
        r
    }

    /// Records the outcome of `place`: an error is held; a success clears whatever was there.
    fn note_place<T>(&self, r: Result<T, RhError>) -> Result<T, RhError> {
        let now = self.reviews.now();
        if let Ok(mut g) = self.last_error.lock() {
            *g = r.as_ref().err().map(|e| LastError { message: e.to_string(), place_at: Some(now) });
        }
        r
    }

    pub fn status(&self) -> RhStatus {
        let last_error = self.last_error.lock().ok().and_then(|g| g.as_ref().map(|l| l.message.clone()));
        match load_tokens(&*self.store) {
            Ok(Some(t)) => RhStatus { connected: true, expires_soon: t.expires_soon(now_unix()), last_error },
            Ok(None) => RhStatus { connected: false, expires_soon: false, last_error },
            // e.g. the vault is locked: not connected, and say why.
            Err(e) => RhStatus { connected: false, expires_soon: false, last_error: Some(e.to_string()) },
        }
    }

    pub async fn connect(&self, opener: &dyn UrlOpener) -> Result<(), RhError> {
        if self.connecting.swap(true, Ordering::SeqCst) {
            return Err(RhError::Protocol("a Robinhood login is already in progress".into()));
        }
        let _guard = ConnectingGuard { flag: &self.connecting, pending: &self.pending_login };
        let r = async {
            let rec = Recording { inner: opener, slot: &self.pending_login };
            let t = rh::oauth::obtain_tokens(&self.cfg, &rec).await?;
            match &self.tokens {
                Some(p) => p.install(&t).await?,
                None => save_tokens(&*self.store, &t)?,
            }
            self.init.reset().await;
            self.ready().await.map(|_| ())
        }
        .await;
        self.note(r)
    }

    /// Deletes the local credentials; no request can carry a token afterwards, and a refresh that was in
    /// flight cannot write its pair back (provider lock + generation).
    pub async fn disconnect(&self) -> Result<(), RhError> {
        let r = match &self.tokens {
            Some(p) => p.logout().await,
            None => rh::logout(&*self.store),
        };
        self.init.reset().await;
        self.note(r)
    }

    /// The vault was locked: drop any rotated pair still waiting to be saved, so it is never written later.
    pub async fn forget_pending(&self) {
        if let Some(p) = &self.tokens {
            p.forget_pending().await;
        }
    }

    async fn ready(&self) -> Result<&McpClient, RhError> {
        self.init.ready(&self.client).await?;
        Ok(&self.client)
    }

    pub async fn accounts(&self) -> Result<Vec<Account>, RhError> {
        let r = async { reads::accounts(self.ready().await?).await }.await;
        self.note(r)
    }
    pub async fn portfolio(&self, account: &str) -> Result<Portfolio, RhError> {
        let r = async { reads::portfolio(self.ready().await?, account).await }.await;
        self.note(r)
    }
    pub async fn positions(&self, account: &str) -> Result<Vec<EquityPosition>, RhError> {
        let r = async { reads::positions(self.ready().await?, account).await }.await;
        self.note(r)
    }
    pub async fn option_positions(&self, account: &str) -> Result<Vec<OptionPositionRow>, RhError> {
        let r = async { reads::option_positions(self.ready().await?, account).await }.await;
        self.note(r)
    }
    pub async fn orders(&self, account: &str, state: Option<&str>) -> Result<Vec<Order>, RhError> {
        let r = async { reads::orders(self.ready().await?, account, state).await }.await;
        self.note(r)
    }
    pub async fn quotes(&self, symbols: &[String]) -> Result<Vec<Quote>, RhError> {
        let r = async { reads::quotes(self.ready().await?, symbols).await }.await;
        self.note(r)
    }
    pub async fn historicals(&self, symbol: &str, interval: Option<&str>, start: &str) -> Result<Vec<Historical>, RhError> {
        let r = async { reads::historicals(self.ready().await?, &[symbol.to_string()], start, interval).await }.await;
        self.note(r)
    }
    pub async fn option_historicals(&self, option_id: &str, interval: Option<&str>, start: &str, bounds: Option<&str>) -> Result<Historical, RhError> {
        let r = async { reads::option_historicals(self.ready().await?, option_id, start, interval, bounds).await }.await;
        self.note(r)
    }
    pub async fn earnings(&self, symbol: &str) -> Result<EarningsInfo, RhError> {
        let r = async { reads::earnings(self.ready().await?, symbol).await }.await;
        self.note(r)
    }
    pub async fn option_chain(&self, symbol: &str, expiration: Option<&str>) -> Result<OptionChainWithGreeks, RhError> {
        let r = async { reads::option_chain_with_greeks(self.ready().await?, symbol, expiration).await }.await;
        self.note(r)
    }
    pub async fn watchlists(&self) -> Result<Vec<Watchlist>, RhError> {
        let r = async { reads::watchlists(self.ready().await?).await }.await;
        self.note(r)
    }
    pub async fn option_watchlist(&self) -> Result<OptionWatchlist, RhError> {
        let r = async { reads::option_watchlist(self.ready().await?).await }.await;
        self.note(r)
    }
    pub async fn watchlist_items(&self, list_id: &str) -> Result<WatchlistContents, RhError> {
        let r = async { reads::watchlist_items(self.ready().await?, list_id).await }.await;
        self.note(r)
    }

    /// The account must exist and have `agentic_allowed`. One fresh `get_accounts` read (never a stale cache).
    async fn require_agentic(&self, c: &McpClient, account: &str) -> Result<(), RhError> {
        let accounts = reads::accounts(c).await?;
        match accounts.iter().find(|a| a.account_number == account) {
            None => Err(RhError::Invalid(format!("account {} was not found", mask_account(account)))),
            Some(a) if !a.agentic_allowed => Err(RhError::Invalid(format!(
                "account {} is not enabled for agent trading (agentic_allowed is false); orders can only be reviewed and placed on agentic accounts",
                mask_account(account)
            ))),
            Some(_) => Ok(()),
        }
    }

    async fn review_any(&self, args: ReviewArgs) -> Result<ReviewOut, RhError> {
        let c = self.ready().await?;
        self.require_agentic(c, args.account()).await?;
        let data = writes::review(c, &args).await?;
        let rec = self.reviews.insert(args)?;
        let order_checks = match data.get("order_checks") {
            Some(v) if v.is_object() => v.clone(),
            _ => serde_json::json!({}),
        };
        Ok(ReviewOut {
            review_id: rec.review_id.clone(),
            kind: rec.args.kind(),
            customer_approval_required: data.get("customer_approval_required").and_then(|v| v.as_bool()),
            customer_approval_reason: data
                .get("customer_approval_required_reason")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(String::from),
            account_masked: mask_account(rec.args.account()),
            expires_in_secs: REVIEW_TTL_SECS as u32,
            echoed: data,
            order_checks,
        })
    }

    /// Validates locally (no request on failure), checks the account, then calls `review_equity_order`.
    pub async fn review_equity(&self, a: EquityOrderArgs) -> Result<ReviewOut, RhError> {
        let r = async {
            a.validate()?;
            self.review_any(ReviewArgs::Equity(a)).await
        }
        .await;
        self.note(r)
    }

    pub async fn review_option(&self, a: OptionOrderArgs) -> Result<ReviewOut, RhError> {
        let r = async {
            a.validate()?;
            self.review_any(ReviewArgs::Option(a)).await
        }
        .await;
        self.note(r)
    }

    /// Places exactly the reviewed parameters with the stored `ref_id`. Single-use: a repeat returns the stored
    /// outcome without a request, except after `Unknown`, where an explicit call re-sends the SAME `ref_id`.
    pub async fn place(&self, review_id: &str) -> Result<PlaceOutcome, RhError> {
        let r = async {
            let rec = self.reviews.get(review_id)?;
            // Attempts completed before this call began: if one finishes while we wait, we replay it, never re-send.
            let seen = rec.attempts.load(std::sync::atomic::Ordering::SeqCst);
            if let Precheck::Replay(o) = rec.precheck(self.reviews.now()).await? {
                return Ok(o);
            }
            let c = self.ready().await?;
            writes::place(c, &rec, self.reviews.now(), seen).await
        }
        .await;
        self.note_place(r)
    }

    pub async fn cancel_equity(&self, account: &str, order_id: &str) -> Result<bool, RhError> {
        let r = async {
            writes::validate_cancel(account, order_id)?;
            writes::cancel(self.ready().await?, rh::orders::OrderKind::Equity, account, order_id).await
        }
        .await;
        self.note(r)
    }
    pub async fn cancel_option(&self, account: &str, order_id: &str) -> Result<bool, RhError> {
        let r = async {
            writes::validate_cancel(account, order_id)?;
            writes::cancel(self.ready().await?, rh::orders::OrderKind::Option, account, order_id).await
        }
        .await;
        self.note(r)
    }
    pub async fn approval_setting(&self, account: &str) -> Result<serde_json::Value, RhError> {
        let r = async {
            writes::validate_account(account)?;
            writes::approval_setting(self.ready().await?, account).await
        }
        .await;
        self.note(r)
    }
    pub async fn approvals(&self, account: &str, state: Option<&str>) -> Result<serde_json::Value, RhError> {
        let r = async {
            writes::validate_approvals(account, state)?;
            writes::approvals(self.ready().await?, account, state).await
        }
        .await;
        self.note(r)
    }
    pub async fn decline_approval(&self, account: &str, approval_id: &str) -> Result<serde_json::Value, RhError> {
        let r = async {
            writes::validate_decline(account, approval_id)?;
            writes::decline(self.ready().await?, account, approval_id).await
        }
        .await;
        self.note(r)
    }

    // ---- M7 watchlist writes: typed, validated before any request, never auto-retried. No order tool is reachable from here. ----
    pub async fn watchlist_create(&self, name: &str, emoji: Option<&str>, description: Option<&str>) -> Result<serde_json::Value, RhError> {
        let r = async {
            ww::prepare_create(name, emoji, description)?;
            ww::create(self.ready().await?, name, emoji, description).await
        }
        .await;
        self.note(r)
    }
    pub async fn watchlist_update(&self, list_id: &str, name: Option<&str>, emoji: Option<&str>, description: Option<&str>) -> Result<serde_json::Value, RhError> {
        let r = async {
            ww::prepare_update(list_id, name, emoji, description)?;
            ww::update(self.ready().await?, list_id, name, emoji, description).await
        }
        .await;
        self.note(r)
    }
    pub async fn watchlist_add(&self, list_id: &str, symbols: &[String]) -> Result<serde_json::Value, RhError> {
        let r = async {
            ww::prepare_symbol_op(list_id, symbols)?;
            ww::add_symbols(self.ready().await?, list_id, symbols).await
        }
        .await;
        self.note(r)
    }
    pub async fn watchlist_remove(&self, list_id: &str, symbols: &[String]) -> Result<serde_json::Value, RhError> {
        let r = async {
            ww::prepare_symbol_op(list_id, symbols)?;
            ww::remove_symbols(self.ready().await?, list_id, symbols).await
        }
        .await;
        self.note(r)
    }
    pub async fn option_watchlist_add(&self, option_ids: &[String]) -> Result<serde_json::Value, RhError> {
        let r = async {
            ww::normalize_option_ids(option_ids)?;
            ww::add_options(self.ready().await?, option_ids).await
        }
        .await;
        self.note(r)
    }
    pub async fn option_watchlist_remove(&self, option_ids: &[String]) -> Result<serde_json::Value, RhError> {
        let r = async {
            ww::normalize_option_ids(option_ids)?;
            ww::remove_options(self.ready().await?, option_ids).await
        }
        .await;
        self.note(r)
    }

    // ---- M7 realized P&L reads (journal). The UI passes the selected account; pnl maps it to rhs_account_number. ----
    pub async fn realized_pnl(&self, account: &str, span: &str, asset_classes: &[String]) -> Result<RealizedPnl, RhError> {
        let r = async {
            writes::validate_account(account)?;
            pnl::validate_realized(span, asset_classes)?;
            pnl::realized_pnl(self.ready().await?, account, span, asset_classes).await
        }
        .await;
        self.note(r)
    }
    pub async fn pnl_trades(&self, account: &str, span: &str, symbol: Option<&str>, cursor: Option<&str>) -> Result<PnlTrades, RhError> {
        let r = async {
            writes::validate_account(account)?;
            pnl::validate_trades(span, symbol, cursor)?;
            pnl::pnl_trades(self.ready().await?, account, span, symbol, cursor).await
        }
        .await;
        self.note(r)
    }

    /// Writes `tools/list` to `<data_dir>/captures/robinhood-tools-<date>.json`. Tool definitions are not secret.
    pub async fn capture_tools(&self, data_dir: &Path, date: &str) -> Result<CaptureResult, RhError> {
        let r = async {
            let tools = self.ready().await?.list_tools().await?;
            let dir = data_dir.join("captures");
            std::fs::create_dir_all(&dir).map_err(|e| RhError::Protocol(format!("capture dir: {e}")))?;
            let path: PathBuf = dir.join(format!("robinhood-tools-{date}.json"));
            let json = serde_json::to_string_pretty(&tools).map_err(|_| RhError::Protocol("could not serialize tools".into()))?;
            write_private(&dir, &path, json.as_bytes()).map_err(|e| RhError::Protocol(format!("capture write: {e}")))?;
            Ok(CaptureResult {
                path: path.to_string_lossy().into_owned(),
                count: tools.len(),
                names: tools.iter().map(|t| t.name.clone()).collect(),
            })
        }
        .await;
        self.note(r)
    }
}

/// Writes `path` with mode 0600 inside `dir` (mode 0700). Replaces an existing capture of the same day.
fn write_private(dir: &Path, path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        o.mode(0o600);
    }
    let mut f = o.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    f.write_all(bytes)
}

/// YYYY-MM-DD (UTC) for a unix timestamp. Howard Hinnant's civil-from-days.
pub fn ymd_utc(unix: i64) -> String {
    let z = unix.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Remembers the URL handed to the browser (so the UI can offer to copy it), then delegates.
struct Recording<'a> {
    inner: &'a dyn UrlOpener,
    slot: &'a Mutex<Option<String>>,
}

impl UrlOpener for Recording<'_> {
    fn open(&self, url: &url::Url) -> Result<(), RhError> {
        if let Ok(mut g) = self.slot.lock() {
            *g = Some(url.to_string());
        }
        self.inner.open(url)
    }
}

/// Only an https URL on robinhood.com (or a subdomain) may be shown to the webview.
pub fn webview_safe_login_url(u: &str) -> Option<String> {
    let parsed = url::Url::parse(u).ok()?;
    rh::oauth::is_allowed_authorize_url(&parsed).then(|| parsed.to_string())
}

type Rh<'a> = State<'a, Arc<RhState>>;

#[tauri::command]
pub async fn rh_pending_login_url(rh: Rh<'_>) -> Result<Option<String>, String> {
    Ok(rh.pending_login_url())
}

#[tauri::command]
pub async fn rh_connect(app: AppHandle, rh: Rh<'_>) -> Result<(), String> {
    Ok(rh.connect(&TauriOpener(app)).await?)
}

#[tauri::command]
pub async fn rh_disconnect(rh: Rh<'_>) -> Result<(), String> {
    Ok(rh.disconnect().await?)
}

/// Reads the secret store (keyring D-Bus or vault), so it runs off the async runtime's worker threads.
#[tauri::command]
pub async fn rh_status(rh: Rh<'_>) -> Result<RhStatus, String> {
    let rh = rh.inner().clone();
    tauri::async_runtime::spawn_blocking(move || rh.status()).await.map_err(|_| "status task failed".to_string())
}

#[tauri::command]
pub async fn rh_accounts(rh: Rh<'_>) -> Result<Vec<Account>, String> {
    Ok(rh.accounts().await?)
}

#[tauri::command]
pub async fn rh_portfolio(rh: Rh<'_>, account: String) -> Result<Portfolio, String> {
    Ok(rh.portfolio(&account).await?)
}

#[tauri::command]
pub async fn rh_positions(rh: Rh<'_>, account: String) -> Result<Vec<EquityPosition>, String> {
    Ok(rh.positions(&account).await?)
}

#[tauri::command]
pub async fn rh_option_positions(rh: Rh<'_>, account: String) -> Result<Vec<OptionPositionRow>, String> {
    Ok(rh.option_positions(&account).await?)
}

#[tauri::command]
pub async fn rh_orders(rh: Rh<'_>, account: String, state: Option<String>) -> Result<Vec<Order>, String> {
    Ok(rh.orders(&account, state.as_deref()).await?)
}

#[tauri::command]
pub async fn rh_quotes(rh: Rh<'_>, symbols: Vec<String>) -> Result<Vec<Quote>, String> {
    Ok(rh.quotes(&symbols).await?)
}

#[tauri::command]
pub async fn rh_historicals(rh: Rh<'_>, symbol: String, interval: Option<String>, start: String) -> Result<Vec<Historical>, String> {
    Ok(rh.historicals(&symbol, interval.as_deref(), &start).await?)
}

/// M11: price history of ONE option contract (uuid). Read-only; OHLC only, no volume exists for options.
#[tauri::command]
pub async fn rh_option_historicals(rh: Rh<'_>, option_id: String, interval: Option<String>, start: String, bounds: Option<String>) -> Result<Historical, String> {
    Ok(rh.option_historicals(&option_id, interval.as_deref(), &start, bounds.as_deref()).await?)
}

/// M13: next and last earnings date for ONE symbol (get_earnings_results, read-only). Feeds the informational strike check.
#[tauri::command]
pub async fn rh_earnings(rh: Rh<'_>, symbol: String) -> Result<EarningsInfo, String> {
    Ok(rh.earnings(&symbol).await?)
}

#[tauri::command]
pub async fn rh_option_chain(rh: Rh<'_>, symbol: String, expiration: Option<String>) -> Result<OptionChainWithGreeks, String> {
    Ok(rh.option_chain(&symbol, expiration.as_deref()).await?)
}

#[tauri::command]
pub async fn rh_watchlists(rh: Rh<'_>) -> Result<Vec<Watchlist>, String> {
    Ok(rh.watchlists().await?)
}

#[tauri::command]
pub async fn rh_watchlist_items(rh: Rh<'_>, list_id: String) -> Result<WatchlistContents, String> {
    Ok(rh.watchlist_items(&list_id).await?)
}

#[tauri::command]
pub async fn rh_option_watchlist(rh: Rh<'_>) -> Result<OptionWatchlist, String> {
    Ok(rh.option_watchlist().await?)
}

/// Typed order commands. The webview never sends a raw tool call, a `ref_id` or a tool name: the arg structs
/// reject unknown fields, and `rh_place_order` takes only the id of a server-side review.
#[tauri::command]
pub async fn rh_review_equity_order(rh: Rh<'_>, args: EquityOrderArgs) -> Result<ReviewOut, String> {
    Ok(rh.review_equity(args).await?)
}

#[tauri::command]
pub async fn rh_review_option_order(rh: Rh<'_>, args: OptionOrderArgs) -> Result<ReviewOut, String> {
    Ok(rh.review_option(args).await?)
}

#[tauri::command]
pub async fn rh_place_order(rh: Rh<'_>, review_id: String) -> Result<PlaceOutcome, String> {
    Ok(rh.place(&review_id).await?)
}

#[tauri::command]
pub async fn rh_cancel_equity_order(rh: Rh<'_>, account: String, order_id: String) -> Result<bool, String> {
    Ok(rh.cancel_equity(&account, &order_id).await?)
}

#[tauri::command]
pub async fn rh_cancel_option_order(rh: Rh<'_>, account: String, order_id: String) -> Result<bool, String> {
    Ok(rh.cancel_option(&account, &order_id).await?)
}

#[tauri::command]
pub async fn rh_trade_approval_setting(rh: Rh<'_>, account: String) -> Result<serde_json::Value, String> {
    Ok(rh.approval_setting(&account).await?)
}

#[tauri::command]
pub async fn rh_trade_approvals(rh: Rh<'_>, account: String, state: Option<String>) -> Result<serde_json::Value, String> {
    Ok(rh.approvals(&account, state.as_deref()).await?)
}

#[tauri::command]
pub async fn rh_decline_trade_approval(rh: Rh<'_>, account: String, approval_id: String) -> Result<serde_json::Value, String> {
    Ok(rh.decline_approval(&account, &approval_id).await?)
}

/// M7: watchlist writes (these change the user's Robinhood lists, never move money). Typed args only.
#[tauri::command]
pub async fn rh_watchlist_create(rh: Rh<'_>, name: String, emoji: Option<String>, description: Option<String>) -> Result<serde_json::Value, String> {
    Ok(rh.watchlist_create(&name, emoji.as_deref(), description.as_deref()).await?)
}

#[tauri::command]
pub async fn rh_watchlist_update(
    rh: Rh<'_>,
    list_id: String,
    name: Option<String>,
    emoji: Option<String>,
    description: Option<String>,
) -> Result<serde_json::Value, String> {
    Ok(rh.watchlist_update(&list_id, name.as_deref(), emoji.as_deref(), description.as_deref()).await?)
}

#[tauri::command]
pub async fn rh_watchlist_add(rh: Rh<'_>, list_id: String, symbols: Vec<String>) -> Result<serde_json::Value, String> {
    Ok(rh.watchlist_add(&list_id, &symbols).await?)
}

#[tauri::command]
pub async fn rh_watchlist_remove(rh: Rh<'_>, list_id: String, symbols: Vec<String>) -> Result<serde_json::Value, String> {
    Ok(rh.watchlist_remove(&list_id, &symbols).await?)
}

#[tauri::command]
pub async fn rh_option_watchlist_add(rh: Rh<'_>, option_ids: Vec<String>) -> Result<serde_json::Value, String> {
    Ok(rh.option_watchlist_add(&option_ids).await?)
}

#[tauri::command]
pub async fn rh_option_watchlist_remove(rh: Rh<'_>, option_ids: Vec<String>) -> Result<serde_json::Value, String> {
    Ok(rh.option_watchlist_remove(&option_ids).await?)
}

/// M7: realized P&L reads for the journal. `account` is the selected account number; Rust maps it to rhs_account_number.
#[tauri::command]
pub async fn rh_realized_pnl(rh: Rh<'_>, account: String, span: String, asset_classes: Option<Vec<String>>) -> Result<RealizedPnl, String> {
    Ok(rh.realized_pnl(&account, &span, &asset_classes.unwrap_or_default()).await?)
}

#[tauri::command]
pub async fn rh_pnl_trades(rh: Rh<'_>, account: String, span: String, symbol: Option<String>, cursor: Option<String>) -> Result<PnlTrades, String> {
    Ok(rh.pnl_trades(&account, &span, symbol.as_deref(), cursor.as_deref()).await?)
}

#[tauri::command]
pub async fn rh_capture_tools(app: AppHandle, rh: Rh<'_>) -> Result<CaptureResult, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(rh.capture_tools(&dir, &ymd_utc(now_unix())).await?)
}

#[cfg(test)]
mod tests {
    use super::ymd_utc;

    #[test]
    fn dates_are_civil_utc() {
        assert_eq!(ymd_utc(0), "1970-01-01");
        assert_eq!(ymd_utc(951_782_400), "2000-02-29");
        assert_eq!(ymd_utc(1_762_732_800), "2025-11-10");
        assert_eq!(ymd_utc(1_767_225_599), "2025-12-31");
        assert_eq!(ymd_utc(1_767_225_600), "2026-01-01");
    }
}
