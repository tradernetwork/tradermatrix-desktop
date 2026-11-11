//! M21 CLI registry + detection tests. Only FAKE scripts in temp dirs on a temp PATH are ever spawned (never a real agent CLI, never a real prompt).
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use super::cli_registry::{detect, entry, may_use, scan, check_version_with, Gate, Support, PUBLIC_BUILD, REGISTRY};
use super::client::{ChatEvent, Emit, End, LlmError, LlmState, StreamParams};
use super::config;
use crate::secrets::{MemoryStore, SecretStore};

static N: AtomicUsize = AtomicUsize::new(0);

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("rebull-m21reg-{}-{}-{tag}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&d).unwrap();
    d
}
fn put(dir: &Path, name: &str, script: &str, mode: u32) {
    let f = dir.join(name);
    std::fs::write(&f, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(mode)).unwrap();
}

#[test]
fn the_registry_is_the_static_roster_with_exactly_one_usable_and_one_experimental_entry() {
    let ids: Vec<&str> = REGISTRY.iter().map(|e| e.id).collect();
    assert_eq!(
        ids,
        ["claude", "codex", "gemini", "agy", "opencode", "hermes", "openclaw", "qwen", "goose", "cursor-agent", "kimi", "auggie", "copilot", "droid", "kiro", "codebuddy", "aider", "amp", "crush", "cline", "qoder", "nanobot", "zeroclaw", "picoclaw", "nullclaw"]
    );
    assert_eq!(REGISTRY.len(), 25);
    assert_eq!(entry("openclaw").unwrap().binaries, ["openclaw", "clawdbot", "moltbot"]);
    let usable: Vec<&str> = REGISTRY.iter().filter(|e| e.support == Support::Usable).map(|e| e.id).collect();
    let exp: Vec<&str> = REGISTRY.iter().filter(|e| e.support == Support::Experimental).map(|e| e.id).collect();
    assert_eq!((usable, exp), (vec!["claude"], vec!["hermes"]));
    for e in REGISTRY.iter() {
        assert!(!e.binaries.is_empty() && e.binaries.iter().all(|b| !b.is_empty() && !b.contains('/')), "{}", e.id);
        assert!(!e.terms.is_empty() && e.terms.len() < 220, "{}", e.id);
        if e.support != Support::Usable {
            assert!(e.reason.len() > 15 && e.reason.len() < 200 && e.reason.ends_with('.') && !e.reason.contains('`'), "{}: {}", e.id, e.reason);
        }
        // only claude and hermes may ever map to a provider card
        assert_eq!(e.provider.is_some(), matches!(e.id, "claude" | "hermes"), "{}", e.id);
    }
    assert_eq!(entry("claude").unwrap().provider, Some("claude_cli"));
    assert_eq!(entry("hermes").unwrap().provider, Some("hermes_cli"));
    // the vendor-terms lines for the three vendors whose terms bar other apps
    assert!(entry("gemini").unwrap().terms.contains("terms") && entry("agy").unwrap().terms.contains("terms") && entry("codex").unwrap().terms.contains("OpenAI"));
}

#[test]
fn review_focus_2_detection_never_executes_anything() {
    let d = tmp("marker");
    let marker = d.join("RAN");
    for n in ["codex", "claude", "hermes", "gemini", "clawdbot"] {
        put(&d, n, &format!("echo x > {}", marker.display()), 0o755);
    }
    let found = scan(&d.to_string_lossy());
    let ids: Vec<&str> = found.iter().map(|f| f.id).collect();
    assert_eq!(ids, ["claude", "codex", "gemini", "hermes", "openclaw"]);
    assert_eq!(found.iter().find(|f| f.id == "openclaw").unwrap().binary, "clawdbot");
    assert!(!marker.exists(), "detection ran a binary");
    let det = detect(&d.to_string_lossy());
    assert!(!marker.exists());
    // nothing about the directory leaks into what the webview gets
    let json = serde_json::to_string(&det).unwrap();
    assert!(!json.contains(&d.to_string_lossy().to_string()) && !json.contains("rebull-m21reg"), "{json}");
    assert_eq!(det.public_build, PUBLIC_BUILD);
}

#[tokio::test]
async fn review_focus_2_the_version_check_is_the_only_thing_that_runs_a_binary() {
    let d = tmp("ver");
    let marker = d.join("RAN");
    put(&d, "codex", &format!("echo x > {}\necho 'codex 9.9.9'\necho second line", marker.display()), 0o755);
    assert!(scan(&d.to_string_lossy()).iter().any(|f| f.id == "codex"));
    assert!(!marker.exists());
    let v = check_version_with(&d.to_string_lossy(), "codex", Duration::from_secs(5)).await.unwrap();
    assert_eq!(v, "codex 9.9.9");
    assert!(marker.exists());
}

#[tokio::test]
async fn the_version_check_clears_the_environment_uses_an_empty_cwd_and_has_a_timeout() {
    std::env::set_var("M21_SECRET_VAR", "leak-me");
    let d = tmp("verenv");
    put(&d, "gemini", "[ -n \"$M21_SECRET_VAR\" ] && echo LEAK && exit 0\n[ -n \"$HOME\" ] && echo HOMELEAK && exit 0\n[ -z \"$(/bin/ls -A)\" ] && echo clean-1.0 || echo DIRTYCWD", 0o755);
    assert_eq!(check_version_with(&d.to_string_lossy(), "gemini", Duration::from_secs(5)).await.unwrap(), "clean-1.0");
    let s = tmp("slow");
    put(&s, "aider", "/bin/sleep 5\necho late", 0o755);
    let t0 = std::time::Instant::now();
    assert_eq!(check_version_with(&s.to_string_lossy(), "aider", Duration::from_millis(300)).await, Err(LlmError::Timeout));
    assert!(t0.elapsed() < Duration::from_secs(3));
    // noisy output is cleaned: control characters dropped, one line, at most 80 chars
    let n = tmp("noisy");
    put(&n, "amp", &format!("printf '\\033[31mv1.2\\033[0m {}\\n'", "x".repeat(200)), 0o755);
    let v = check_version_with(&n.to_string_lossy(), "amp", Duration::from_secs(5)).await.unwrap();
    assert!(v.chars().count() <= 80 && !v.chars().any(|c| c.is_control()), "{v}");
    // unknown id and a missing binary
    assert_eq!(check_version_with(&n.to_string_lossy(), "rm", Duration::from_secs(1)).await, Err(LlmError::BadRequest));
    assert_eq!(check_version_with(&n.to_string_lossy(), "codex", Duration::from_secs(1)).await, Err(LlmError::NotInstalled));
    // a failing --version is a plain bad_reply, no stderr text
    let f = tmp("fail");
    put(&f, "kimi", "echo boom-secret >&2\nexit 3", 0o755);
    assert_eq!(check_version_with(&f.to_string_lossy(), "kimi", Duration::from_secs(5)).await, Err(LlmError::BadReply));
}

#[test]
fn review_focus_3_non_executables_directories_and_relative_path_entries_are_ignored() {
    let a = tmp("noexec");
    put(&a, "codex", "exit 0", 0o644);
    let b = tmp("dir");
    std::fs::create_dir_all(b.join("gemini")).unwrap();
    let c = tmp("rel");
    put(&c, "goose", "exit 0", 0o755);
    let good = tmp("good");
    put(&good, "qwen", "exit 0", 0o755);
    assert!(scan(&a.to_string_lossy()).is_empty());
    assert!(scan(&b.to_string_lossy()).is_empty());
    assert!(scan("").is_empty() && scan(":").is_empty());
    // relative and empty entries, even when the process cwd would contain the binary
    assert!(scan(".:bin:relative/dir:").is_empty());
    let both = format!(".:{}:{}:{}", a.display(), b.display(), good.display());
    let ids: Vec<&str> = scan(&both).iter().map(|f| f.id).collect();
    assert_eq!(ids, ["qwen"]);
    // look-alike names do not count
    let l = tmp("alike");
    put(&l, "codex2", "exit 0", 0o755);
    put(&l, "Codex", "exit 0", 0o755);
    assert!(scan(&l.to_string_lossy()).is_empty());
}

#[test]
fn review_focus_1_a_detected_codex_is_not_supported_and_can_never_be_selected_or_used() {
    let d = tmp("codex");
    put(&d, "codex", "exit 0", 0o755);
    let f = scan(&d.to_string_lossy());
    let c = f.iter().find(|x| x.id == "codex").unwrap();
    assert_eq!(c.support, "unsupported");
    assert!(c.reason.len() > 15 && c.provider.is_none());
    for exp in [false, true] {
        for p in ["codex", "gemini", "agy", "opencode", "opencode_cli", "openclaw", "qwen", "goose", "aider", "claude", "hermes", "anything"] {
            assert!(!may_use(p, exp), "{p}");
        }
    }
    // the Rust save path refuses every detect-only id as a provider, with or without the experimental switch
    let s = MemoryStore::new();
    for p in ["codex", "gemini", "agy", "opencode", "opencode_cli", "openclaw", "qwen", "goose", "cursor-agent", "codex_cli", "gemini_cli"] {
        for exp in [false, true] {
            assert_eq!(config::set_config_gated(&s, p, None, None, None, None, None, exp), Err("bad_request".into()), "{p}");
        }
    }
    assert!(s.get(super::client::LLM_CONFIG_SLOT).unwrap().is_none());
}

#[test]
fn may_use_allows_claude_outside_a_public_build_and_hermes_only_when_experimental_and_not_public() {
    assert_eq!((may_use("claude_cli", false), may_use("claude_cli", true)), (!PUBLIC_BUILD, !PUBLIC_BUILD));
    assert!(!may_use("hermes_cli", false));
    assert_eq!(may_use("hermes_cli", true), !PUBLIC_BUILD);
    for p in ["openrouter", "openai", "venice", "ollama", "lmstudio", "custom", "hermes"] {
        assert!(!may_use(p, true) || !p.ends_with("_cli"), "{p}");
    }
}

#[test]
fn saving_the_experimental_hermes_cli_needs_the_switch_and_claude_does_not() {
    let s = MemoryStore::new();
    assert_eq!(config::set_config_gated(&s, "hermes_cli", None, None, None, None, None, false), Err("bad_request".into()));
    assert!(s.get(super::client::LLM_CONFIG_SLOT).unwrap().is_none());
    // no url, no key for a CLI
    assert_eq!(config::set_config_gated(&s, "hermes_cli", Some("https://x.example.com"), None, None, None, None, true), Err("bad_request".into()));
    assert_eq!(config::set_config_gated(&s, "hermes_cli", None, Some("sk-test-KEY"), None, None, None, true), Err("bad_request".into()));
    if !PUBLIC_BUILD {
        let st = config::set_config_gated(&s, "hermes_cli", None, None, None, None, None, true).unwrap();
        assert_eq!((st.provider.as_deref(), st.key_present, st.base_url), (Some("hermes_cli"), false, None));
    }
    assert_eq!(config::set_config_gated(&s, "claude_cli", None, None, None, None, None, false).is_ok(), !PUBLIC_BUILD);
    // the old entry point is the "switch off" form
    assert_eq!(config::set_config_ex(&s, "hermes_cli", None, None, None, None, None), Err("bad_request".into()));
}

fn emit_none() -> Emit {
    Arc::new(|_e: ChatEvent| {})
}
fn params() -> StreamParams {
    StreamParams { model: String::new(), digest: "CHART: symbol=AAPL".into(), question: "q".into(), history: vec![], mode: "beginner".into(), lenses: vec![] }
}

#[tokio::test]
async fn an_experimental_cli_saved_earlier_is_refused_at_ask_time_when_the_switch_is_off() {
    let d = tmp("ask");
    let marker = d.join("RAN");
    put(&d, "hermes", &format!("echo x > {}\n/bin/cat >/dev/null\necho 'hermes says hi'", marker.display()), 0o755);
    let st: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    if !PUBLIC_BUILD {
        config::set_config_gated(&*st, "hermes_cli", None, None, None, None, None, true).unwrap();
    } else {
        st.set(super::client::LLM_CONFIG_SLOT, "{\"provider\":\"hermes_cli\"}").unwrap();
    }
    let s = LlmState::for_test(st, Duration::from_secs(5)).with_cli(&d.to_string_lossy(), Duration::from_secs(10));
    // switch off (the default): nothing is spawned
    let out = s.explain_stream("req-m21-1", params(), emit_none()).await;
    assert_eq!(out.end, End::Failed(LlmError::BadRequest));
    assert!(!marker.exists());
    assert_eq!(s.ping().await, Err(LlmError::BadRequest));
    assert!(!marker.exists());
    if !PUBLIC_BUILD {
        s.set_experimental_cli(true);
        let out = s.explain_stream("req-m21-2", params(), emit_none()).await;
        assert_eq!(out.end, End::Done);
        assert_eq!(out.text, "hermes says hi");
        assert_eq!(out.provider, "hermes_cli");
        s.set_experimental_cli(false);
        assert_eq!(s.explain_stream("req-m21-3", params(), emit_none()).await.end, End::Failed(LlmError::BadRequest));
    }
}

#[tokio::test]
async fn a_stored_config_naming_a_detect_only_cli_never_resolves() {
    let d = tmp("tamper");
    let marker = d.join("RAN");
    for n in ["codex", "gemini", "opencode"] {
        put(&d, n, &format!("echo x > {}\necho no", marker.display()), 0o755);
    }
    for p in ["codex", "gemini", "opencode", "codex_cli", "opencode_cli"] {
        let st: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
        st.set(super::client::LLM_CONFIG_SLOT, &format!("{{\"provider\":\"{p}\"}}")).unwrap();
        let s = LlmState::for_test(st, Duration::from_secs(5)).with_cli(&d.to_string_lossy(), Duration::from_secs(5));
        s.set_experimental_cli(true);
        let out = s.explain_stream("req-m21-t", params(), emit_none()).await;
        assert!(matches!(out.end, End::Failed(_)), "{p}");
        assert!(out.text.is_empty());
    }
    assert!(!marker.exists());
}

/// EXPLAIN ONLY: none of the M21 provider files may reach order tooling (the same rule the TypeScript guard enforces for the chat files).
#[test]
fn the_new_provider_files_never_touch_order_tooling() {
    for (name, src) in [
        ("cli_registry.rs", include_str!("cli_registry.rs")),
        ("recipes.rs", include_str!("recipes.rs")),
        ("openrouter_login.rs", include_str!("openrouter_login.rs")),
        ("cli.rs", include_str!("cli.rs")),
        ("anthropic.rs", include_str!("anthropic.rs")),
    ] {
        for bad in ["rh::orders", "rh::writes", "rh::reviews", "rh::watch_writes", "McpClient", "place_", "review_", "cancel_", "decline_", "ticket", "rh_commands", "TmState"] {
            assert!(!src.contains(bad), "{name} mentions {bad}");
        }
    }
    // the sign-in reuses only the loopback listener, PKCE helpers and the opener trait from the Robinhood OAuth module
    let l = include_str!("openrouter_login.rs");
    assert!(l.contains("rh::oauth::{await_callback, pkce_pair, random_token, UrlOpener}"));
}

// ---------- M19: public-build gating refined by the `llm.advancedCli` setting ----------

const OTHERS: [&str; 7] = ["openrouter", "openai", "venice", "ollama", "lmstudio", "custom", "hermes"];

#[test]
fn review_focus_3_the_gating_matrix_for_both_cli_providers() {
    // (public build, experimental switch, advanced switch) -> (claude_cli, hermes_cli)
    let rows = [
        (false, false, false, true, false),
        (false, true, false, true, true),
        (false, false, true, true, false),
        (false, true, true, true, true),
        (true, false, false, false, false),
        (true, true, false, false, false),
        (true, false, true, true, false),
        (true, true, true, true, true),
    ];
    for (public, experimental, advanced, claude, hermes) in rows {
        let g = Gate { public, experimental, advanced };
        assert_eq!(g.allows("claude_cli"), claude, "{g:?}");
        assert_eq!(g.allows("hermes_cli"), hermes, "{g:?}");
        for p in OTHERS.iter().chain(["anthropic", "codex", "gemini", "opencode_cli", "claude", ""].iter()) {
            assert!(!g.allows(p), "{p} {g:?}");
        }
    }
    // the compile-time constant feeds the real gate; the old two-argument form is the "advanced off" gate
    let cur = Gate::current(true, false);
    assert_eq!((cur.public, cur.experimental, cur.advanced), (PUBLIC_BUILD, true, false));
    assert_eq!(may_use("claude_cli", false), !PUBLIC_BUILD);
}

#[test]
fn review_focus_3_the_rust_save_refuses_the_cli_in_a_public_build_until_advanced_is_on() {
    for provider in ["claude_cli", "hermes_cli"] {
        let off = Gate { public: true, experimental: true, advanced: false };
        let on = Gate { public: true, experimental: true, advanced: true };
        let s = MemoryStore::new();
        assert_eq!(config::set_config_with_gate(&s, provider, None, None, None, None, None, off), Err("bad_request".into()), "{provider}");
        assert!(s.get(super::client::LLM_CONFIG_SLOT).unwrap().is_none(), "nothing written");
        let st = config::set_config_with_gate(&s, provider, None, None, None, None, None, on).unwrap();
        assert_eq!(st.provider.as_deref(), Some(provider));
        // the personal build (feature off) saves claude exactly as before, hermes only with its own switch
        let personal = Gate { public: false, experimental: provider == "hermes_cli", advanced: false };
        assert!(config::set_config_with_gate(&MemoryStore::new(), provider, None, None, None, None, None, personal).is_ok(), "{provider}");
    }
    // a hosted provider is never affected by the gate
    let off = Gate { public: true, experimental: false, advanced: false };
    assert!(config::set_config_with_gate(&MemoryStore::new(), "anthropic", None, Some("sk-ant-TESTKEY"), None, None, None, off).is_ok());
    assert!(config::set_config_with_gate(&MemoryStore::new(), "openrouter", None, Some("sk-or-TESTKEY"), None, None, None, off).is_ok());
}

#[tokio::test]
async fn review_focus_3_a_saved_claude_card_is_not_run_in_a_public_build_unless_advanced_is_on() {
    let d = tmp("pub");
    let marker = d.join("RAN");
    put(&d, "claude", &format!("echo x > {}\n/bin/cat >/dev/null\necho 'claude says hi'", marker.display()), 0o755);
    let st: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    st.set(super::client::LLM_CONFIG_SLOT, "{\"provider\":\"claude_cli\"}").unwrap();
    let s = LlmState::for_test(st, Duration::from_secs(5)).with_cli(&d.to_string_lossy(), Duration::from_secs(10)).with_public(true);
    // public build, advanced off (the default): refused, nothing spawned, for ask, stream and test
    let out = s.explain_stream("req-m19-1", params(), emit_none()).await;
    assert_eq!(out.end, End::Failed(LlmError::BadRequest));
    assert_eq!(s.ping().await, Err(LlmError::BadRequest));
    assert!(!marker.exists());
    // advanced on: it runs
    s.set_advanced_cli(true);
    let out = s.explain_stream("req-m19-2", params(), emit_none()).await;
    assert_eq!((out.end, out.text.as_str()), (End::Done, "claude says hi"));
    assert!(marker.exists());
    // and off again: refused again
    s.set_advanced_cli(false);
    assert_eq!(s.explain_stream("req-m19-3", params(), emit_none()).await.end, End::Failed(LlmError::BadRequest));
    // personal build (feature off): works with advanced off, exactly as today
    let st2: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    st2.set(super::client::LLM_CONFIG_SLOT, "{\"provider\":\"claude_cli\"}").unwrap();
    let p = LlmState::for_test(st2, Duration::from_secs(5)).with_cli(&d.to_string_lossy(), Duration::from_secs(10)).with_public(false);
    assert_eq!(p.explain_stream("req-m19-4", params(), emit_none()).await.end, End::Done);
}

#[tokio::test]
async fn the_state_level_save_obeys_the_same_gate() {
    let st: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    let s = LlmState::for_test(st.clone(), Duration::from_secs(5)).with_public(true);
    assert_eq!(s.config_set("claude_cli".into(), None, None, None, None, None).await, Err("bad_request".into()));
    assert!(st.get(super::client::LLM_CONFIG_SLOT).unwrap().is_none());
    s.set_advanced_cli(true);
    assert_eq!(s.config_set("claude_cli".into(), None, None, None, None, None).await.unwrap().provider.as_deref(), Some("claude_cli"));
}
