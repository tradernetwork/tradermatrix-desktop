//! Provider config (M14b): the chosen provider, base URL, model and compat flag live in vault slot `llm_config` (JSON), the key in
//! `llm_api_key`. They are written together by `set_config` and read together under one lock, so a saved key can never be paired with
//! an endpoint the user did not choose it for. The key is never returned.
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use super::client::{valid_model, LlmError, LLM_CONFIG_SLOT, LLM_KEY_SLOT};
use super::provider::{effective_base_url_ex, preset, Kind, Preset, Profile};
use crate::secrets::SecretStore;

/// Serialises `set_config` / `clear` against the (config, key) read that every ask performs.
pub(crate) static CFG_LOCK: Mutex<()> = Mutex::new(());

pub const MAX_KEY_LEN: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LlmConfig {
    pub provider: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default)]
    pub compat: bool,
    /// Hermes only (M16 B5): the user accepted plain http to a private-LAN IP address for this profile.
    #[serde(default)]
    pub lan_http: bool,
}

/// What the webview may know. Never the key.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct LlmStatus {
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub compat: bool,
    pub key_present: bool,
    pub lan_http: bool,
}

pub fn lock() -> std::sync::MutexGuard<'static, ()> {
    CFG_LOCK.lock().unwrap_or_else(|p| p.into_inner())
}

/// Key shape per provider: OpenRouter keys start `sk-or-`; every key is printable ASCII, no spaces, at most 256 bytes.
pub fn valid_key(p: &Preset, k: &str) -> bool {
    if k.is_empty() || k.len() > MAX_KEY_LEN || !k.bytes().all(|b| b.is_ascii_graphic()) {
        return false;
    }
    if p.profile == Profile::OpenRouter {
        return k.starts_with("sk-or-") && k.len() > "sk-or-".len();
    }
    true
}

/// Caller must hold the lock (or accept a racy read for status).
pub(crate) fn load_unlocked(store: &dyn SecretStore) -> Option<LlmConfig> {
    let raw = store.get(LLM_CONFIG_SLOT).ok()??;
    let c: LlmConfig = serde_json::from_str(&raw).ok()?;
    preset(&c.provider)?;
    Some(c)
}

pub fn load(store: &dyn SecretStore) -> Option<LlmConfig> {
    let _g = lock();
    load_unlocked(store)
}

pub fn status(store: &dyn SecretStore) -> LlmStatus {
    let _g = lock();
    let Some(c) = load_unlocked(store) else { return LlmStatus::default() };
    let p = preset(&c.provider).expect("checked by load");
    let base_url = if p.kind == Kind::Http { effective_base_url_ex(p, c.base_url.as_deref(), c.lan_http).ok().map(|u| u.to_string().trim_end_matches('/').to_string()) } else { None };
    let model = c.model.clone().filter(|m| !m.is_empty()).or_else(|| Some(p.default_model.to_string()).filter(|m| !m.is_empty()));
    LlmStatus { provider: Some(c.provider), base_url, model, compat: c.compat, key_present: store.exists(LLM_KEY_SLOT).unwrap_or(false), lan_http: c.lan_http }
}

fn store_err(e: crate::error::AppError) -> String {
    e.to_string()
}

/// Validates everything first, then writes config and key together; a failed write restores the previous state.
/// Errors are fixed codes (`bad_request`) or the store's own message (never containing the key).
pub fn set_config(store: &dyn SecretStore, provider: &str, base_url: Option<&str>, api_key: Option<&str>, model: Option<&str>, compat: Option<bool>) -> Result<LlmStatus, String> {
    set_config_ex(store, provider, base_url, api_key, model, compat, None)
}

/// `lan_http` (Hermes only): the explicit "I accept plain LAN http" acceptance. `Some(true)` on any other provider is refused. `None` keeps the
/// saved acceptance ONLY while the address is left alone; a newly typed address must be accepted again.
#[allow(clippy::too_many_arguments)] // one sealed write: every field travels together
pub fn set_config_ex(store: &dyn SecretStore, provider: &str, base_url: Option<&str>, api_key: Option<&str>, model: Option<&str>, compat: Option<bool>, lan_http: Option<bool>) -> Result<LlmStatus, String> {
    let bad = || LlmError::BadRequest.code().to_string();
    let p = preset(provider).ok_or_else(bad)?;
    let _g = lock();
    let old = load_unlocked(store);
    let old_p = old.as_ref().and_then(|c| preset(&c.provider));
    let same_provider = old.as_ref().map(|c| c.provider == provider).unwrap_or(false);

    // URL: hosted presets are fixed (an explicit different URL is refused, not ignored); local presets and custom accept one.
    let given_url = base_url.map(str::trim).filter(|s| !s.is_empty());
    let new_url_str: Option<String> = match p.kind {
        Kind::ClaudeCli => {
            if given_url.is_some() {
                return Err(bad());
            }
            None
        }
        Kind::Http if p.url_editable() => given_url.map(str::to_string).or_else(|| if same_provider { old.as_ref().and_then(|c| c.base_url.clone()) } else { None }),
        Kind::Http => {
            if let Some(u) = given_url {
                if u.trim_end_matches('/') != p.base_url {
                    return Err(bad());
                }
            }
            None
        }
    };
    if lan_http == Some(true) && p.profile != Profile::Hermes {
        return Err(bad());
    }
    let lan = p.profile == Profile::Hermes && lan_http.unwrap_or(same_provider && given_url.is_none() && old.as_ref().is_some_and(|c| c.lan_http));
    let new_eff = if p.kind == Kind::Http { Some(effective_base_url_ex(p, new_url_str.as_deref(), lan).map_err(|e| e.code().to_string())?) } else { None };
    let old_eff = old.as_ref().zip(old_p).and_then(|(c, op)| if op.kind == Kind::Http { effective_base_url_ex(op, c.base_url.as_deref(), c.lan_http).ok() } else { None });

    // Key: keyless providers (local presets, the CLI) never take one; any other provider takes one.
    let takes_key = p.kind == Kind::Http && !p.is_local_preset();
    let key_given = api_key.map(str::trim).filter(|k| !k.is_empty());
    if !takes_key && api_key.is_some() && key_given.is_some() {
        return Err(bad());
    }
    if let Some(k) = key_given {
        if !valid_key(p, k) {
            return Err(bad());
        }
    }
    let key_saved = store.exists(LLM_KEY_SLOT).map_err(store_err)?;
    // The seal: a saved key may only follow an endpoint it was supplied for. A changed endpoint needs the key again, in this same call.
    let url_changed = new_eff != old_eff;
    if takes_key && key_saved && key_given.is_none() && url_changed {
        return Err(bad());
    }

    let model = match model.map(str::trim).filter(|m| !m.is_empty()) {
        Some(m) => {
            if !valid_model(m) {
                return Err(bad());
            }
            Some(m.to_string())
        }
        None => {
            if same_provider {
                old.as_ref().and_then(|c| c.model.clone())
            } else {
                None
            }
        }
    };
    let compat = compat.unwrap_or(if same_provider { old.as_ref().map(|c| c.compat).unwrap_or(false) } else { false });
    let cfg = LlmConfig { provider: provider.to_string(), base_url: new_url_str, model, compat, lan_http: lan };
    let json = serde_json::to_string(&cfg).map_err(|_| bad())?;

    // Write: config first, then the key (or removal of a stale one). Restore on any failure.
    let old_cfg_raw = store.get(LLM_CONFIG_SLOT).map_err(store_err)?;
    let old_key = store.get(LLM_KEY_SLOT).map_err(store_err)?;
    let restore = |store: &dyn SecretStore| {
        match &old_cfg_raw {
            Some(v) => {
                let _ = store.set(LLM_CONFIG_SLOT, v);
            }
            None => {
                let _ = store.delete(LLM_CONFIG_SLOT);
            }
        }
        match &old_key {
            Some(v) => {
                let _ = store.set(LLM_KEY_SLOT, v);
            }
            None => {
                let _ = store.delete(LLM_KEY_SLOT);
            }
        }
    };
    if let Err(e) = store.set(LLM_CONFIG_SLOT, &json) {
        restore(store);
        return Err(store_err(e));
    }
    let key_step = if let Some(k) = key_given {
        store.set(LLM_KEY_SLOT, k)
    } else if !takes_key && key_saved {
        store.delete(LLM_KEY_SLOT)
    } else {
        Ok(())
    };
    if let Err(e) = key_step {
        restore(store);
        return Err(store_err(e));
    }
    drop(_g);
    Ok(status(store))
}

/// Forget the provider and the key.
pub fn clear(store: &dyn SecretStore) -> Result<(), String> {
    let _g = lock();
    store.delete(LLM_KEY_SLOT).map_err(store_err)?;
    store.delete(LLM_CONFIG_SLOT).map_err(store_err)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::AppError;
    use crate::secrets::{BackendStatus, MemoryStore};

    const K1: &str = "sk-test-KEY";
    const K2: &str = "sk-test-KEY2";

    fn set(s: &dyn SecretStore, provider: &str, url: Option<&str>, key: Option<&str>) -> Result<LlmStatus, String> {
        set_config(s, provider, url, key, None, None)
    }

    #[test]
    fn review_focus_2_a_changed_endpoint_without_a_key_is_refused_and_nothing_changes() {
        let s = MemoryStore::new();
        set(&s, "custom", Some("https://a.example.com/v1"), Some(K1)).unwrap();
        let before = (s.get(LLM_CONFIG_SLOT).unwrap(), s.get(LLM_KEY_SLOT).unwrap());
        // the attack: re-point the saved key at a new host without supplying a key
        assert_eq!(set(&s, "custom", Some("https://evil.example.com/v1"), None), Err("bad_request".into()));
        assert_eq!(before, (s.get(LLM_CONFIG_SLOT).unwrap(), s.get(LLM_KEY_SLOT).unwrap()));
        // switching to another hosted provider with the old key saved is the same swap
        assert_eq!(set(&s, "openai", None, None), Err("bad_request".into()));
        assert_eq!(set(&s, "openrouter", None, None), Err("bad_request".into()));
        assert_eq!(before, (s.get(LLM_CONFIG_SLOT).unwrap(), s.get(LLM_KEY_SLOT).unwrap()));
        // the same endpoint with a new key is fine, and so is a new endpoint WITH a key
        let st = set(&s, "custom", Some("https://a.example.com/v1/"), Some(K2)).unwrap();
        assert!(st.key_present);
        assert_eq!(s.get(LLM_KEY_SLOT).unwrap().as_deref(), Some(K2));
        set(&s, "custom", Some("https://b.example.com/v1"), Some(K1)).unwrap();
        assert_eq!(s.get(LLM_KEY_SLOT).unwrap().as_deref(), Some(K1));
        // same endpoint, no key, other settings: fine, key kept
        let st = set_config(&s, "custom", None, None, Some("m1"), Some(true)).unwrap();
        assert_eq!((st.model.as_deref(), st.compat, st.base_url.as_deref()), (Some("m1"), true, Some("https://b.example.com/v1")));
        assert_eq!(s.get(LLM_KEY_SLOT).unwrap().as_deref(), Some(K1));
    }

    #[test]
    fn a_url_change_with_no_saved_key_needs_no_key() {
        let s = MemoryStore::new();
        set(&s, "custom", Some("https://a.example.com/v1"), None).unwrap();
        set(&s, "custom", Some("https://b.example.com/v1"), None).unwrap();
        assert!(!status(&s).key_present);
    }

    #[test]
    fn hosted_presets_refuse_a_different_url_and_accept_their_own() {
        let s = MemoryStore::new();
        assert_eq!(set(&s, "openrouter", Some("https://evil.example.com/v1"), Some("sk-or-X1")), Err("bad_request".into()));
        assert!(s.get(LLM_CONFIG_SLOT).unwrap().is_none() && s.get(LLM_KEY_SLOT).unwrap().is_none());
        let st = set(&s, "openrouter", Some("https://openrouter.ai/api/v1/"), Some("sk-or-X1")).unwrap();
        assert_eq!(st.base_url.as_deref(), Some("https://openrouter.ai/api/v1"));
        assert_eq!(st.model.as_deref(), Some("deepseek/deepseek-v4-flash"));
    }

    #[test]
    fn key_rules_per_provider_and_keyless_providers_take_none() {
        let s = MemoryStore::new();
        assert_eq!(set(&s, "openrouter", None, Some("sk-test-KEY")), Err("bad_request".into()), "OpenRouter keys start sk-or-");
        assert_eq!(set(&s, "openai", None, Some("has space")), Err("bad_request".into()));
        assert_eq!(set(&s, "openai", None, Some(&"k".repeat(257))), Err("bad_request".into()));
        assert_eq!(set(&s, "ollama", None, Some(K1)), Err("bad_request".into()), "local presets take no key");
        assert_eq!(set(&s, "claude_cli", None, Some(K1)), Err("bad_request".into()));
        assert_eq!(set(&s, "nope", None, None), Err("bad_request".into()));
        assert!(s.get(LLM_CONFIG_SLOT).unwrap().is_none());
        // an empty key string counts as "no key given"
        assert!(set(&s, "openai", None, Some("  ")).is_ok());
    }

    #[test]
    fn switching_to_a_keyless_provider_removes_the_stale_key() {
        let s = MemoryStore::new();
        set(&s, "openai", None, Some(K1)).unwrap();
        let st = set(&s, "ollama", None, None).unwrap();
        assert!(!st.key_present);
        assert!(s.get(LLM_KEY_SLOT).unwrap().is_none());
        assert_eq!(st.base_url.as_deref(), Some("http://127.0.0.1:11434/v1"));
        let st = set(&s, "claude_cli", None, None).unwrap();
        assert_eq!((st.provider.as_deref(), st.base_url, st.key_present), (Some("claude_cli"), None, false));
    }

    #[test]
    fn urls_follow_the_guard_rules() {
        let s = MemoryStore::new();
        for bad in ["http://example.com/v1", "http://127.0.0.1.evil.com/v1", "https://u:p@example.com/v1", "ftp://x/v1", "https://example.com/v1?x=1"] {
            assert_eq!(set(&s, "custom", Some(bad), None), Err("bad_request".into()), "{bad}");
        }
        assert_eq!(set(&s, "ollama", Some("https://example.com/v1"), None), Err("bad_request".into()), "local presets stay on loopback");
        assert_eq!(set(&s, "custom", None, None), Err("bad_request".into()), "custom needs an address");
        assert_eq!(set(&s, "claude_cli", Some("https://example.com"), None), Err("bad_request".into()));
        assert!(set(&s, "ollama", Some("http://localhost:9999/v1"), None).is_ok());
        assert!(set(&s, "custom", Some("http://[::1]:8080/v1"), None).is_ok());
        assert!(s.get(LLM_KEY_SLOT).unwrap().is_none());
    }

    #[test]
    fn models_are_validated() {
        let s = MemoryStore::new();
        assert_eq!(set_config(&s, "custom", Some("https://a.example.com"), None, Some("bad model"), None), Err("bad_request".into()));
        assert!(set_config(&s, "custom", Some("https://a.example.com"), None, Some("Llama-3.2:3b"), None).is_ok());
    }

    /// A store whose `set` fails for one slot, to prove a half-failed write leaves the old config intact.
    struct FailOn {
        inner: MemoryStore,
        slot: &'static str,
    }
    impl SecretStore for FailOn {
        fn set(&self, slot: &str, v: &str) -> Result<(), AppError> {
            if slot == self.slot {
                return Err(AppError::Secret("disk full".into()));
            }
            self.inner.set(slot, v)
        }
        fn exists(&self, slot: &str) -> Result<bool, AppError> {
            self.inner.exists(slot)
        }
        fn delete(&self, slot: &str) -> Result<(), AppError> {
            self.inner.delete(slot)
        }
        fn get(&self, slot: &str) -> Result<Option<String>, AppError> {
            self.inner.get(slot)
        }
        fn status(&self) -> BackendStatus {
            self.inner.status()
        }
    }

    #[test]
    fn a_failed_vault_write_leaves_the_old_config_intact() {
        // 1. the key write fails after the config write succeeded: the config is rolled back
        let s = FailOn { inner: MemoryStore::new(), slot: "" };
        set(&s.inner, "custom", Some("https://a.example.com/v1"), Some(K1)).unwrap();
        let before = status(&s);
        let s = FailOn { inner: s.inner, slot: LLM_KEY_SLOT };
        let r = set(&s, "custom", Some("https://b.example.com/v1"), Some(K2));
        assert_eq!(r, Err("secret store error: disk full".into()));
        assert_eq!(status(&s), before);
        assert_eq!(s.inner.get(LLM_KEY_SLOT).unwrap().as_deref(), Some(K1));
        assert!(!r.unwrap_err().contains(K2));
        // 2. the config write fails first: nothing is written at all
        let s = FailOn { inner: s.inner, slot: LLM_CONFIG_SLOT };
        assert!(set(&s, "custom", Some("https://c.example.com/v1"), Some(K2)).is_err());
        assert_eq!(status(&s), before);
        assert_eq!(s.inner.get(LLM_KEY_SLOT).unwrap().as_deref(), Some(K1));
        // 3. a first-ever failed write leaves the slots empty
        let s = FailOn { inner: MemoryStore::new(), slot: LLM_KEY_SLOT };
        assert!(set(&s, "openai", None, Some(K1)).is_err());
        assert!(s.inner.get(LLM_CONFIG_SLOT).unwrap().is_none() && s.inner.get(LLM_KEY_SLOT).unwrap().is_none());
    }

    #[test]
    fn status_never_contains_the_key_and_clear_forgets_everything() {
        let s = MemoryStore::new();
        let st = set(&s, "openai", None, Some(K1)).unwrap();
        assert!(!format!("{st:?} {}", serde_json::to_string(&st).unwrap()).contains(K1));
        assert!(st.key_present);
        clear(&s).unwrap();
        assert_eq!(status(&s), LlmStatus::default());
    }

    #[test]
    fn a_garbled_config_slot_reads_as_unconfigured() {
        let s = MemoryStore::new();
        s.set(LLM_CONFIG_SLOT, "{not json").unwrap();
        assert_eq!(status(&s), LlmStatus::default());
        s.set(LLM_CONFIG_SLOT, "{\"provider\":\"nope\"}").unwrap();
        assert_eq!(status(&s), LlmStatus::default());
    }

    #[test]
    fn hermes_lan_http_needs_the_explicit_toggle_and_a_private_ip() {
        let s = MemoryStore::new();
        let h = |s: &MemoryStore, url: Option<&str>, key: Option<&str>, lan: Option<bool>| set_config_ex(s, "hermes", url, key, Some("tm-explain"), None, lan);
        // nothing typed: refused (no default address)
        assert_eq!(h(&s, None, None, None), Err("bad_request".into()));
        // https to any host: fine, key optional
        let st = h(&s, Some("https://hermes.example.com"), Some(K1), None).unwrap();
        assert_eq!((st.provider.as_deref(), st.base_url.as_deref(), st.key_present, st.lan_http), (Some("hermes"), Some("https://hermes.example.com/v1"), true, false));
        // LAN http without the toggle: refused and nothing changes
        let before = (s.get(LLM_CONFIG_SLOT).unwrap(), s.get(LLM_KEY_SLOT).unwrap());
        assert_eq!(h(&s, Some("http://192.168.1.5:8642"), Some(K1), None), Err("bad_request".into()));
        assert_eq!(h(&s, Some("http://192.168.1.5:8642"), Some(K1), Some(false)), Err("bad_request".into()));
        assert_eq!(before, (s.get(LLM_CONFIG_SLOT).unwrap(), s.get(LLM_KEY_SLOT).unwrap()));
        // with the toggle: accepted, remembered, reported
        let st = h(&s, Some("http://192.168.1.5:8642"), Some(K1), Some(true)).unwrap();
        assert_eq!((st.base_url.as_deref(), st.lan_http), (Some("http://192.168.1.5:8642/v1"), true));
        // public IP and hostnames over http are refused even with the toggle
        for bad in ["http://8.8.8.8:8642", "http://hermes.lan:8642", "http://172.32.0.1"] {
            assert_eq!(h(&s, Some(bad), Some(K1), Some(true)), Err("bad_request".into()), "{bad}");
        }
        // 100.64/10 is accepted with the toggle
        assert!(h(&s, Some("http://100.100.1.1:8642"), Some(K1), Some(true)).is_ok());
        // a newly typed address does NOT inherit an earlier acceptance
        assert_eq!(h(&s, Some("http://192.168.1.9:8642"), Some(K1), None), Err("bad_request".into()));
        // the same address with other settings keeps it
        let st = set_config_ex(&s, "hermes", None, None, Some("other"), None, None).unwrap();
        assert!(st.lan_http && st.model.as_deref() == Some("other"));
        // turning the acceptance off while the address is plain LAN http is refused (no silent downgrade of the guard)
        assert_eq!(set_config_ex(&s, "hermes", None, None, None, None, Some(false)), Err("bad_request".into()));
        assert!(status(&s).lan_http);
        // moving to https drops the stored acceptance
        let st = h(&s, Some("https://hermes.example.com"), Some(K1), Some(false)).unwrap();
        assert!(!st.lan_http);
    }

    #[test]
    fn the_lan_toggle_exists_for_hermes_only_and_the_seal_still_holds() {
        let s = MemoryStore::new();
        for p in ["openrouter", "openai", "venice", "ollama", "lmstudio", "custom", "claude_cli"] {
            let url = (p == "custom").then_some("https://a.example.com/v1");
            assert_eq!(set_config_ex(&s, p, url, None, None, None, Some(true)), Err("bad_request".into()), "{p}");
        }
        assert!(s.get(LLM_CONFIG_SLOT).unwrap().is_none());
        // a saved Hermes key may not follow a changed address
        set_config_ex(&s, "hermes", Some("https://a.example.com"), Some(K1), Some("m"), None, None).unwrap();
        assert_eq!(set_config_ex(&s, "hermes", Some("https://evil.example.com"), None, None, None, None), Err("bad_request".into()));
        assert_eq!(set_config_ex(&s, "hermes", Some("http://192.168.1.5"), None, None, None, Some(true)), Err("bad_request".into()), "scheme change is an address change");
        assert_eq!(s.get(LLM_KEY_SLOT).unwrap().as_deref(), Some(K1));
        // an old config without the field reads as lan_http=false
        s.set(LLM_CONFIG_SLOT, "{\"provider\":\"hermes\",\"base_url\":\"https://a.example.com\",\"model\":\"m\",\"compat\":false}").unwrap();
        assert!(!status(&s).lan_http);
        // switching away from Hermes clears the flag
        set_config_ex(&s, "hermes", Some("http://192.168.1.5"), Some(K1), None, None, Some(true)).unwrap();
        let st = set_config(&s, "ollama", None, None, None, None).unwrap();
        assert!(!st.lan_http);
    }
}
