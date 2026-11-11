//! Local agent CLI registry + presence-only detection (M21). The roster is a static table (ids and binary names, in the spirit of AionUi's list).
//! Detection is a PATH walk over ABSOLUTE entries (executable regular file, exact name, no shell) and NEVER runs anything. A found CLI is usable
//! ONLY when it has a verified tool-less recipe (`claude`; `hermes` behind the experimental switch); every other entry is detect-only, and
//! the Rust save and ask paths refuse it (`may_use`). The one thing that executes a binary is `check_version`, on an explicit user click.
use std::io::Read;
use std::sync::mpsc;
use std::time::Duration;

use serde::Serialize;

use super::cli::{find_in_path, TempCwd};
use super::client::LlmError;

/// Compile-time public-build gate (cargo feature `public-build`, default off). In a public build the experimental CLI cards never exist.
pub const PUBLIC_BUILD: bool = cfg!(feature = "public-build");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Support {
    /// A verified tool-less recipe exists (claude).
    Usable,
    /// A recipe exists but is unverified: off unless the user turns on `llm.experimentalCli` (never in a public build).
    Experimental,
    /// Detected only. No recipe, never runnable.
    DetectOnly,
}

#[derive(Debug, Clone, Copy)]
pub struct CliEntry {
    pub id: &'static str,
    pub label: &'static str,
    /// Binary names looked up on PATH, in order.
    pub binaries: &'static [&'static str],
    pub support: Support,
    /// The provider id of its card (only claude and hermes have one).
    pub provider: Option<&'static str>,
    /// One plain sentence: why it is not (fully) supported. Empty for the usable entry.
    pub reason: &'static str,
    /// The per-CLI vendor terms disclosure line shown on its card.
    pub terms: &'static str,
}

const NOTE: &str = "This app does not use it. It is listed only so you can see it was found.";
const fn e(id: &'static str, label: &'static str, binaries: &'static [&'static str], reason: &'static str) -> CliEntry {
    CliEntry { id, label, binaries, support: Support::DetectOnly, provider: None, reason, terms: NOTE }
}
const NO_SWITCH: &str = "It has no verified way to turn its tools off, so it could act on your computer.";

pub const REGISTRY: [CliEntry; 25] = [
    CliEntry {
        id: "claude",
        label: "Claude",
        binaries: &["claude"],
        support: Support::Usable,
        provider: Some("claude_cli"),
        reason: "",
        terms: "Uses your installed Claude (your own login). Usage counts against your own Claude plan and is subject to Anthropic's terms.",
    },
    CliEntry {
        id: "codex",
        label: "Codex",
        binaries: &["codex"],
        support: Support::DetectOnly,
        provider: None,
        reason: "Even in its read-only mode it can still run commands, so it cannot be made text-only.",
        terms: "OpenAI says automating a ChatGPT login is not meant for public or open-source apps.",
    },
    CliEntry {
        id: "gemini",
        label: "Gemini",
        binaries: &["gemini"],
        support: Support::DetectOnly,
        provider: None,
        reason: "It has no switch that turns all its tools off, and its terms do not allow other apps to use it.",
        terms: "Google's terms do not allow third-party tools to use its backend.",
    },
    CliEntry {
        id: "agy",
        label: "Antigravity",
        binaries: &["agy"],
        support: Support::DetectOnly,
        provider: None,
        reason: "It only offers a read-only mode, not a text-only one, and its terms do not allow other apps to use it.",
        terms: "Antigravity's terms do not allow third-party software to drive it.",
    },
    CliEntry {
        id: "opencode",
        label: "OpenCode",
        binaries: &["opencode"],
        support: Support::DetectOnly,
        provider: None,
        reason: "Your question would have to be typed on its command line, where other programs on this computer can read it, and it cannot turn its tools off.",
        terms: NOTE,
    },
    CliEntry {
        id: "hermes",
        label: "Hermes agent",
        binaries: &["hermes"],
        support: Support::Experimental,
        provider: Some("hermes_cli"),
        reason: "Experimental and untested here: it stays off until you turn it on in Advanced.",
        terms: "Runs your own Hermes install under its own settings. You are responsible for what that install is allowed to do.",
    },
    CliEntry {
        id: "openclaw",
        label: "OpenClaw",
        binaries: &["openclaw", "clawdbot", "moltbot"],
        support: Support::DetectOnly,
        provider: None,
        reason: "It runs as a background gateway and takes your question on its command line, with no way to turn its tools off.",
        terms: NOTE,
    },
    e("qwen", "Qwen Code", &["qwen"], NO_SWITCH),
    e("goose", "Goose", &["goose"], "It is built to run tools on your computer and has no verified way to turn them off."),
    e("cursor-agent", "Cursor Agent", &["cursor-agent"], NO_SWITCH),
    e("kimi", "Kimi", &["kimi"], NO_SWITCH),
    e("auggie", "Auggie", &["auggie"], NO_SWITCH),
    e("copilot", "GitHub Copilot CLI", &["copilot"], NO_SWITCH),
    e("droid", "Droid", &["droid"], NO_SWITCH),
    e("kiro", "Kiro", &["kiro-cli", "kiro"], NO_SWITCH),
    e("codebuddy", "CodeBuddy", &["codebuddy"], NO_SWITCH),
    e("aider", "Aider", &["aider"], "It edits files in your project and has no text-only mode."),
    e("amp", "Amp", &["amp"], NO_SWITCH),
    e("crush", "Crush", &["crush"], NO_SWITCH),
    e("cline", "Cline", &["cline"], NO_SWITCH),
    e("qoder", "Qoder", &["qodercli", "qoder"], NO_SWITCH),
    e("nanobot", "Nanobot", &["nanobot"], NO_SWITCH),
    e("zeroclaw", "ZeroClaw", &["zeroclaw"], NO_SWITCH),
    e("picoclaw", "PicoClaw", &["picoclaw"], NO_SWITCH),
    e("nullclaw", "NullClaw", &["nullclaw"], NO_SWITCH),
];

pub fn entry(id: &str) -> Option<&'static CliEntry> {
    REGISTRY.iter().find(|e| e.id == id)
}

/// What the webview may know about one found CLI: no path, only the binary NAME.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct Found {
    pub id: &'static str,
    pub label: &'static str,
    pub binary: String,
    /// `usable` | `experimental` | `unsupported`
    pub support: &'static str,
    pub reason: &'static str,
    pub terms: &'static str,
    pub provider: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct CliDetect {
    pub public_build: bool,
    pub found: Vec<Found>,
}

fn support_str(s: Support) -> &'static str {
    match s {
        Support::Usable => "usable",
        Support::Experimental => "experimental",
        Support::DetectOnly => "unsupported",
    }
}

/// Registry scan: which roster entries have an executable on the absolute PATH entries. Runs nothing.
pub fn scan(path_var: &str) -> Vec<Found> {
    let mut out = Vec::new();
    for e in REGISTRY.iter() {
        if let Some(b) = e.binaries.iter().find(|b| find_in_path(path_var, b).is_some()) {
            out.push(Found { id: e.id, label: e.label, binary: (*b).to_string(), support: support_str(e.support), reason: e.reason, terms: e.terms, provider: e.provider });
        }
    }
    out
}

pub fn detect(path_var: &str) -> CliDetect {
    CliDetect { public_build: PUBLIC_BUILD, found: scan(path_var) }
}

/// Everything that decides whether a CLI provider may be saved or run (M19). `public` is the compile-time build flavour; `experimental` and `advanced` mirror the
/// user settings `llm.experimentalCli` and `llm.advancedCli` (both default off). In a public build NO CLI provider is usable until `advanced` is on; the personal
/// build (feature off) ignores `advanced` and behaves exactly as before M19.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Gate {
    pub public: bool,
    pub experimental: bool,
    pub advanced: bool,
}

impl Gate {
    /// The real gate: the compile-time flavour plus the two settings.
    pub fn current(experimental: bool, advanced: bool) -> Gate {
        Gate { public: PUBLIC_BUILD, experimental, advanced }
    }
    /// May this provider id be saved and run? `claude_cli` unless this is a public build with Advanced off; `hermes_cli` additionally needs the experimental
    /// switch. Every other id (including every detect-only CLI) is refused.
    pub fn allows(&self, provider: &str) -> bool {
        let visible = !self.public || self.advanced;
        match provider {
            "claude_cli" => visible,
            "hermes_cli" => visible && self.experimental,
            _ => false,
        }
    }
}

/// `Gate::current(experimental, false)`: the check with the Advanced switch off (kept for callers and tests that predate M19).
pub fn may_use(provider: &str, experimental: bool) -> bool {
    Gate::current(experimental, false).allows(provider)
}

/// `<binary> --version` for one registry entry, run ONLY because the user clicked "Check version": 3 s timeout, environment cleared to PATH,
/// fresh empty temp cwd, no stdin, stderr dropped. Returns the first line, control characters removed, at most 80 characters.
pub async fn check_version(id: &str) -> Result<String, LlmError> {
    check_version_with(&std::env::var("PATH").unwrap_or_default(), id, Duration::from_secs(3)).await
}

pub(crate) async fn check_version_with(path_var: &str, id: &str, timeout: Duration) -> Result<String, LlmError> {
    let e = entry(id).ok_or(LlmError::BadRequest)?;
    let bin = e.binaries.iter().find_map(|b| find_in_path(path_var, b)).ok_or(LlmError::NotInstalled)?;
    let path_var = path_var.to_string();
    tauri::async_runtime::spawn_blocking(move || version_blocking(&bin, &path_var, timeout)).await.map_err(|_| LlmError::BadReply)?
}

fn version_blocking(bin: &std::path::Path, path_var: &str, timeout: Duration) -> Result<String, LlmError> {
    let cwd = TempCwd::new().ok_or(LlmError::BadReply)?;
    let mut cmd = std::process::Command::new(bin);
    cmd.arg("--version")
        .current_dir(&cwd.0)
        .env_clear()
        .env("PATH", path_var)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());
    let mut child = super::cli::spawn_retry(&mut cmd).map_err(|_| LlmError::NotInstalled)?;
    let mut so = child.stdout.take().ok_or(LlmError::BadReply)?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = so.by_ref().take(4096).read_to_end(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(timeout) {
        Ok(buf) => {
            let status = child.wait().map_err(|_| LlmError::BadReply)?;
            if !status.success() {
                return Err(LlmError::BadReply);
            }
            let text = String::from_utf8_lossy(&buf);
            let line = text.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("");
            let clean: String = line.chars().filter(|c| !c.is_control()).take(80).collect();
            if clean.is_empty() {
                return Err(LlmError::BadReply);
            }
            Ok(clean)
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(LlmError::Timeout)
        }
    }
}
