//! Provider presets (M14b). Facts below were checked against each provider's CURRENT docs on 2026-11-11.
use super::client::LlmError;
use super::url_guard::validate_base_url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Http,
    /// A local agent CLI run through a recipe (`recipes.rs`): `claude_cli` (verified) and `hermes_cli` (experimental).
    Cli,
}

/// Which request-body shape a provider gets. Unknown fields are never sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Profile {
    OpenRouter,
    OpenAi,
    Venice,
    /// Ollama / LM Studio / any local server: `model`, `messages`, `max_tokens` only.
    Local,
    /// Custom endpoint: same bare minimum as Local.
    Custom,
    /// Anthropic's native Messages API (M19): `POST /v1/messages`, `x-api-key` + `anthropic-version` headers, top-level `system`. Never the OpenAI-compat layer.
    Anthropic,
    /// Self-hosted Hermes agent (M16 B5): `/v1/chat/completions` only, the bare body, Bearer key optional.
    Hermes,
    /// A local agent CLI (no HTTP): claude, or the experimental hermes.
    Cli,
}

#[derive(Debug, Clone, Copy)]
pub struct Preset {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    pub base_url: &'static str,
    pub key_help_url: &'static str,
    pub blurb: &'static str,
    pub profile: Profile,
    pub needs_key: bool,
    pub default_model: &'static str,
}

pub const PRESETS: [Preset; 10] = [
    Preset { id: "openrouter", label: "OpenRouter", kind: Kind::Http, base_url: "https://openrouter.ai/api/v1", key_help_url: "https://openrouter.ai/keys", blurb: "One key, many models, pay as you go. Cheap models cost cents.", profile: Profile::OpenRouter, needs_key: true, default_model: "deepseek/deepseek-v4-flash" },
    Preset { id: "openai", label: "OpenAI", kind: Kind::Http, base_url: "https://api.openai.com/v1", key_help_url: "https://platform.openai.com/api-keys", blurb: "ChatGPT's maker. Needs an API key with billing set up.", profile: Profile::OpenAi, needs_key: true, default_model: "gpt-4.1-mini" },
    Preset { id: "venice", label: "Venice", kind: Kind::Http, base_url: "https://api.venice.ai/api/v1", key_help_url: "https://venice.ai/settings/api", blurb: "Privacy-focused hosted models.", profile: Profile::Venice, needs_key: true, default_model: "llama-3.3-70b" },
    Preset { id: "anthropic", label: "Anthropic", kind: Kind::Http, base_url: "https://api.anthropic.com", key_help_url: "https://console.anthropic.com", blurb: "Use your own Anthropic API key.", profile: Profile::Anthropic, needs_key: true, default_model: "claude-haiku-5-5" },
    Preset { id: "ollama", label: "Ollama (this computer)", kind: Kind::Http, base_url: "http://127.0.0.1:11434/v1", key_help_url: "", blurb: "Runs a model on your own machine. Free, private, no key.", profile: Profile::Local, needs_key: false, default_model: "llama3.2" },
    Preset { id: "lmstudio", label: "LM Studio (this computer)", kind: Kind::Http, base_url: "http://127.0.0.1:1234/v1", key_help_url: "", blurb: "Runs a model on your own machine. Free, private, no key.", profile: Profile::Local, needs_key: false, default_model: "" },
    Preset { id: "custom", label: "Custom endpoint", kind: Kind::Http, base_url: "", key_help_url: "", blurb: "Any OpenAI-compatible address you already use.", profile: Profile::Custom, needs_key: false, default_model: "" },
    Preset { id: "hermes", label: "Hermes (self-hosted)", kind: Kind::Http, base_url: "", key_help_url: "", blurb: "Your own Hermes agent, reached over HTTPS. You set it up and secure it.", profile: Profile::Hermes, needs_key: false, default_model: "" },
    Preset { id: "claude_cli", label: "Claude (installed on this computer)", kind: Kind::Cli, base_url: "", key_help_url: "", blurb: "Uses the Claude app you already signed in to. No key to paste.", profile: Profile::Cli, needs_key: false, default_model: "" },
    Preset { id: "hermes_cli", label: "Hermes agent (installed on this computer)", kind: Kind::Cli, base_url: "", key_help_url: "", blurb: "Experimental. Runs the Hermes you installed here, text only. Off unless you turn it on in Advanced.", profile: Profile::Cli, needs_key: false, default_model: "" },
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

impl Preset {
    /// May the user choose the base URL? Local presets (a different port, loopback only) and custom. Hosted presets are fixed.
    pub fn url_editable(&self) -> bool {
        matches!(self.profile, Profile::Local | Profile::Custom | Profile::Hermes)
    }
    pub fn is_local_preset(&self) -> bool {
        self.profile == Profile::Local
    }
}

/// The base URL a config resolves to, validated. Hosted presets ignore any stored value (fixed table); local presets must stay on loopback.
pub fn effective_base_url(p: &Preset, stored: Option<&str>) -> Result<url::Url, LlmError> {
    effective_base_url_ex(p, stored, false)
}

/// Same, with the per-profile "I accept plain LAN http" acceptance (only Hermes looks at it). Hermes URLs are normalised to end in `/v1`
/// (the preset talks to `<base>/chat/completions` of the OpenAI-compatible API, so `http://127.0.0.1:8642` works as typed).
pub fn effective_base_url_ex(p: &Preset, stored: Option<&str>, lan_http: bool) -> Result<url::Url, LlmError> {
    let raw = if p.url_editable() { stored.filter(|s| !s.trim().is_empty()).unwrap_or(p.base_url) } else { p.base_url };
    if raw.is_empty() {
        return Err(LlmError::BadRequest);
    }
    if p.profile == Profile::Hermes {
        let mut u = super::url_guard::validate_hermes_url(raw, lan_http)?;
        let path = u.path().trim_end_matches('/').to_string();
        if !path.ends_with("/v1") {
            u.set_path(&format!("{path}/v1"));
        }
        return Ok(u);
    }
    let u = validate_base_url(raw)?;
    if p.is_local_preset() && !is_loopback(&u) {
        return Err(LlmError::BadRequest);
    }
    Ok(u)
}

pub fn is_loopback(u: &url::Url) -> bool {
    match u.host() {
        Some(url::Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(url::Host::Ipv4(a)) => a.is_loopback(),
        Some(url::Host::Ipv6(a)) => a.is_loopback(),
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preset_ids_are_unique_and_known() {
        let mut ids: Vec<&str> = PRESETS.iter().map(|p| p.id).collect();
        ids.sort();
        let n = ids.len();
        ids.dedup();
        assert_eq!(ids.len(), n);
        assert_eq!(n, 10);
        assert!(preset("openrouter").is_some() && preset("nope").is_none() && preset("").is_none());
    }

    #[test]
    fn every_http_preset_url_passes_validation_and_fixed_ones_are_https() {
        for p in PRESETS.iter().filter(|p| p.kind == Kind::Http && !p.base_url.is_empty()) {
            let u = validate_base_url(p.base_url).unwrap_or_else(|_| panic!("{}", p.id));
            if !p.url_editable() {
                assert_eq!(u.scheme(), "https", "{}", p.id);
            } else {
                assert!(is_loopback(&u), "{}", p.id);
            }
        }
        assert!(PRESETS.iter().filter(|p| p.needs_key).all(|p| p.kind == Kind::Http && !p.key_help_url.is_empty()));
    }

    #[test]
    fn hosted_presets_ignore_a_stored_url_and_local_presets_stay_on_loopback() {
        let or = preset("openrouter").unwrap();
        assert_eq!(effective_base_url(or, Some("https://evil.example.com/v1")).unwrap().as_str(), "https://openrouter.ai/api/v1");
        let ol = preset("ollama").unwrap();
        assert_eq!(effective_base_url(ol, Some("http://127.0.0.1:9999/v1")).unwrap().port(), Some(9999));
        assert_eq!(effective_base_url(ol, Some("https://example.com/v1")), Err(LlmError::BadRequest));
        assert_eq!(effective_base_url(ol, None).unwrap().port(), Some(11434));
        let c = preset("custom").unwrap();
        assert_eq!(effective_base_url(c, None), Err(LlmError::BadRequest));
        assert!(effective_base_url(c, Some("https://example.com/v1")).is_ok());
        assert_eq!(effective_base_url(c, Some("http://example.com/v1")), Err(LlmError::BadRequest));
    }

    #[test]
    fn hermes_is_a_url_editable_keyless_capable_preset_with_no_prefilled_address() {
        let h = preset("hermes").unwrap();
        assert_eq!((h.kind, h.profile, h.needs_key, h.base_url, h.default_model, h.key_help_url), (Kind::Http, Profile::Hermes, false, "", "", ""));
        assert!(h.url_editable() && !h.is_local_preset());
        // nothing typed: nothing assumed
        assert_eq!(effective_base_url_ex(h, None, false), Err(LlmError::BadRequest));
        assert_eq!(effective_base_url_ex(h, Some("  "), true), Err(LlmError::BadRequest));
        // the base is normalised to the OpenAI-compatible `/v1` root; the chat URL is `/v1/chat/completions` and nothing else
        for (typed, lan, want) in [
            ("https://hermes.example.com", false, "https://hermes.example.com/v1"),
            ("https://hermes.example.com/", false, "https://hermes.example.com/v1"),
            ("https://hermes.example.com/v1/", false, "https://hermes.example.com/v1"),
            ("https://hermes.example.com/agent", false, "https://hermes.example.com/agent/v1"),
            ("http://127.0.0.1:8642", false, "http://127.0.0.1:8642/v1"),
            ("http://[::1]:8642/v1", false, "http://[::1]:8642/v1"),
            ("http://192.168.1.5:8642", true, "http://192.168.1.5:8642/v1"),
            ("http://100.100.1.1:8642/v1", true, "http://100.100.1.1:8642/v1"),
        ] {
            let u = effective_base_url_ex(h, Some(typed), lan).unwrap_or_else(|_| panic!("{typed}"));
            assert_eq!(u.as_str(), want, "{typed}");
            let chat = super::super::url_guard::chat_url(&u);
            assert!(chat.path().ends_with("/v1/chat/completions"), "{chat}");
            assert!(!chat.path().contains("responses"));
        }
        for (typed, lan) in [("http://192.168.1.5:8642", false), ("http://8.8.8.8", true), ("http://hermes.lan", true), ("http://100.100.1.1", false)] {
            assert_eq!(effective_base_url_ex(h, Some(typed), lan), Err(LlmError::BadRequest), "{typed} lan={lan}");
        }
        // the plain variant never accepts LAN http
        assert_eq!(effective_base_url(h, Some("http://192.168.1.5:8642")), Err(LlmError::BadRequest));
        // other presets ignore the toggle entirely
        let c = preset("custom").unwrap();
        assert_eq!(effective_base_url_ex(c, Some("http://192.168.1.5/v1"), true), Err(LlmError::BadRequest));
    }
}
