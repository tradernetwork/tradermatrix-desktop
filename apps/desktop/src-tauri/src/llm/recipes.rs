//! Local-CLI recipes (M21). A recipe is the whole recipe for running ONE agent CLI as a text-only explainer: its fixed arguments, the few
//! environment variables it may see, whether the prompt travels on stdin, and how its output becomes an answer. A CLI that is merely
//! detected has no recipe and can never be run. Only `claude` is verified; `hermes` is experimental (smoke test pending);
//! `opencode` is a documented stub that is NOT shippable because its prompt would have to go in argv.
use super::client::{LlmError, MAX_REPLY_CHARS};

pub trait Recipe: Sync {
    fn id(&self) -> &'static str;
    /// The fixed binary name searched on the absolute PATH entries.
    fn binary(&self) -> &'static str;
    fn args(&self) -> Vec<String>;
    /// Environment variable names the child may inherit (PATH is always passed). Everything else is cleared.
    fn env_allowlist(&self) -> &'static [&'static str];
    /// The prompt goes in on stdin. A recipe that returns false is never run (a prompt in argv is visible to every process on the machine).
    fn stdin_prompt(&self) -> bool;
    fn parse_answer(&self, out: &str) -> Result<String, LlmError>;
}

fn clip(text: &str) -> Result<String, LlmError> {
    let t = text.trim();
    if t.is_empty() {
        return Err(LlmError::BadReply);
    }
    Ok(t.chars().take(MAX_REPLY_CHARS).collect())
}

/// `claude -p --tools "" ...` (flags verified against `claude --help` v2.1.322 on 2026-11-11, see cli.rs).
pub struct ClaudeRecipe;
pub static CLAUDE: ClaudeRecipe = ClaudeRecipe;
impl Recipe for ClaudeRecipe {
    fn id(&self) -> &'static str {
        "claude_cli"
    }
    fn binary(&self) -> &'static str {
        "claude"
    }
    fn args(&self) -> Vec<String> {
        super::cli::CLI_ARGS.iter().map(|s| s.to_string()).collect()
    }
    fn env_allowlist(&self) -> &'static [&'static str] {
        &["HOME", "LANG", "LC_ALL", "LC_CTYPE"]
    }
    fn stdin_prompt(&self) -> bool {
        true
    }
    fn parse_answer(&self, out: &str) -> Result<String, LlmError> {
        clip(out)
    }
}

/// `hermes chat -Q --query-file - --oneshot --safe-mode -t "" --max-turns 1` (from the 2026-11-11 research; NOT verified against a real binary).
/// Its oneshot mode auto-bypasses approvals, so the output is also screened for tool-call previews and any hint of one is a `bad_reply`.
pub struct HermesRecipe;
pub static HERMES: HermesRecipe = HermesRecipe;
const TOOL_MARKERS: [&str; 8] = ["<tool_call", "\"tool_calls\"", "tool_call:", "calling tool", "running tool", "tool call:", "tool_use", "[tool"];
impl Recipe for HermesRecipe {
    fn id(&self) -> &'static str {
        "hermes_cli"
    }
    fn binary(&self) -> &'static str {
        "hermes"
    }
    fn args(&self) -> Vec<String> {
        ["chat", "-Q", "--query-file", "-", "--oneshot", "--safe-mode", "-t", "", "--max-turns", "1"].iter().map(|s| s.to_string()).collect()
    }
    fn env_allowlist(&self) -> &'static [&'static str] {
        &["HOME", "LANG", "LC_ALL", "LC_CTYPE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "HERMES_HOME"]
    }
    fn stdin_prompt(&self) -> bool {
        true
    }
    fn parse_answer(&self, out: &str) -> Result<String, LlmError> {
        let lower = out.to_lowercase();
        let bad_line = out.lines().any(|l| {
            let t = l.trim_start();
            t.starts_with('┊') || t.starts_with('⚡') || t.starts_with('🔧')
        });
        if bad_line || TOOL_MARKERS.iter().any(|m| lower.contains(m)) {
            return Err(LlmError::BadReply);
        }
        clip(out)
    }
}

/// `opencode run <prompt>`: the prompt is an argument and there is no tools-off switch. NOT shippable; kept only so the reason is on record and tested.
pub struct OpencodeStub;
pub static OPENCODE_STUB: OpencodeStub = OpencodeStub;
impl Recipe for OpencodeStub {
    fn id(&self) -> &'static str {
        "opencode_cli"
    }
    fn binary(&self) -> &'static str {
        "opencode"
    }
    fn args(&self) -> Vec<String> {
        vec!["run".into()]
    }
    fn env_allowlist(&self) -> &'static [&'static str] {
        &["HOME", "LANG", "LC_ALL", "LC_CTYPE"]
    }
    fn stdin_prompt(&self) -> bool {
        false
    }
    fn parse_answer(&self, out: &str) -> Result<String, LlmError> {
        clip(out)
    }
}

/// The recipe for a provider id. Only verified or experimental recipes are listed; the opencode stub is deliberately absent.
pub fn for_provider(provider: &str) -> Option<&'static dyn Recipe> {
    match provider {
        "claude_cli" => Some(&CLAUDE),
        "hermes_cli" => Some(&HERMES),
        _ => None,
    }
}
