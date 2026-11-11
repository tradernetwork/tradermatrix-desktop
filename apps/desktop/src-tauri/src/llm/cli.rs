//! Local Claude CLI provider (M14b). Runs the user's own installed `claude` in print mode with EVERY built-in tool disabled, so it can
//! only produce text: it cannot read files, run commands or fetch anything. Flags verified against `claude --help` (v2.1.322) on 2026-11-11:
//!   `-p` print and exit; `--tools ""` disables all built-in tools; `--strict-mcp-config` (with no `--mcp-config`) loads no MCP servers;
//!   `--disable-slash-commands` disables skills; `--no-session-persistence` writes no session; `--output-format text` plain text;
//!   `--permission-mode dontAsk` never prompts. The prompt goes in on stdin only. `--bare` was NOT used: it ignores the CLI's own login.
//! Hygiene: binary found by the fixed name `claude` on absolute PATH entries (no shell), fresh empty temp cwd, env cleared to
//! PATH/HOME/locale, 90 s timeout then kill, stdout capped, one call at a time, stderr discarded, exit != 0 is `bad_reply`.
use std::io::{Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::time::Duration;

use super::client::{LlmError, Turn};
#[cfg(test)]
use super::recipes::CLAUDE;
use super::recipes::Recipe;

pub const CLI_NAME: &str = "claude";
pub const CLI_TIMEOUT: Duration = Duration::from_secs(90);
/// Reading stops (and the child is killed) past this many bytes.
const MAX_STDOUT_BYTES: usize = 1024 * 1024;
pub const CLI_ARGS: [&str; 10] = ["-p", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "text", "--permission-mode", "dontAsk"];

static BUSY: AtomicBool = AtomicBool::new(false);

/// First executable regular file named exactly `claude` in an ABSOLUTE `PATH` entry. Never runs anything.
pub fn find_binary(path_var: &str) -> Option<PathBuf> {
    find_in_path(path_var, CLI_NAME)
}

/// First executable regular file named exactly `name` in an ABSOLUTE `PATH` entry (empty and relative entries are skipped). Never runs anything.
pub fn find_in_path(path_var: &str, name: &str) -> Option<PathBuf> {
    for dir in path_var.split(':') {
        let d = Path::new(dir);
        if dir.is_empty() || !d.is_absolute() {
            continue;
        }
        let f = d.join(name);
        if let Ok(md) = std::fs::metadata(&f) {
            if md.is_file() && md.permissions().mode() & 0o111 != 0 {
                return Some(f);
            }
        }
    }
    None
}

pub fn claude_installed() -> bool {
    find_binary(&std::env::var("PATH").unwrap_or_default()).is_some()
}

/// Plain-text prompt: the system text (rules + digest) first, the earlier turns, then the question.
pub fn build_prompt(system: &str, turns: &[Turn]) -> String {
    let mut p = String::from(system);
    p.push_str("\n\nConversation so far:\n");
    for t in turns {
        p.push_str(if t.role == "assistant" { "Assistant: " } else { "User: " });
        p.push_str(&t.text);
        p.push('\n');
    }
    p.push_str("Assistant:");
    p
}

struct Busy<'a>(&'a AtomicBool);
impl Drop for Busy<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// One call through the recipe of a CLI provider (one at a time across all CLIs).
pub async fn ask_cli_provider(recipe: &'static dyn Recipe, prompt: &str) -> Result<String, LlmError> {
    run_guarded_recipe(&BUSY, recipe, &std::env::var("PATH").unwrap_or_default(), prompt, CLI_TIMEOUT).await
}

/// One call at a time per `busy` flag; a second concurrent caller gets `rate_limited` without spawning anything.
#[cfg(test)]
pub(crate) async fn run_guarded(busy: &AtomicBool, path_var: &str, prompt: &str, timeout: Duration) -> Result<String, LlmError> {
    run_guarded_recipe(busy, &CLAUDE, path_var, prompt, timeout).await
}

pub(crate) async fn run_guarded_recipe(busy: &AtomicBool, recipe: &dyn Recipe, path_var: &str, prompt: &str, timeout: Duration) -> Result<String, LlmError> {
    if busy.swap(true, Ordering::SeqCst) {
        return Err(LlmError::RateLimited);
    }
    let _g = Busy(busy);
    ask_recipe(recipe, path_var, prompt, timeout).await
}

#[cfg(test)]
pub(crate) async fn ask_with(path_var: &str, prompt: &str, timeout: Duration) -> Result<String, LlmError> {
    ask_recipe(&CLAUDE, path_var, prompt, timeout).await
}

/// Runs the recipe's binary with the prompt on stdin. A recipe whose prompt would go in argv is refused before anything is spawned.
pub(crate) async fn ask_recipe(recipe: &dyn Recipe, path_var: &str, prompt: &str, timeout: Duration) -> Result<String, LlmError> {
    if !recipe.stdin_prompt() {
        return Err(LlmError::BadRequest);
    }
    let bin = find_in_path(path_var, recipe.binary()).ok_or(LlmError::NotInstalled)?;
    let args = recipe.args();
    let env_names: Vec<&'static str> = recipe.env_allowlist().to_vec();
    let (path_var, prompt) = (path_var.to_string(), prompt.to_string());
    let out = tauri::async_runtime::spawn_blocking(move || run_blocking(&bin, &args, &env_names, &path_var, &prompt, timeout)).await.map_err(|_| LlmError::BadReply)??;
    recipe.parse_answer(&out)
}

static DIRS: AtomicUsize = AtomicUsize::new(0);

/// A fresh, empty, owner-only directory under the system temp dir; removed on drop.
pub(crate) struct TempCwd(pub(crate) PathBuf);
impl TempCwd {
    pub(crate) fn new() -> Option<Self> {
        for _ in 0..8 {
            let mut r = [0u8; 8];
            getrandom::fill(&mut r).ok()?;
            let name = format!("rebull-cli-{}-{}-{}", std::process::id(), DIRS.fetch_add(1, Ordering::SeqCst), r.iter().map(|b| format!("{b:02x}")).collect::<String>());
            let p = std::env::temp_dir().join(name);
            if std::fs::create_dir(&p).is_ok() {
                let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o700));
                return Some(Self(p));
            }
        }
        None
    }
}
impl Drop for TempCwd {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Retries `f` while it fails with ETXTBSY ("Text file busy", os error 26), at most `attempts` times with `delay` between. A script that was
/// written a moment ago can still be held open by a concurrent fork in another thread, which makes exec fail with this error; it clears
/// within milliseconds. Any other error is returned at once.
pub(crate) fn retry_on_busy<T>(mut f: impl FnMut() -> std::io::Result<T>, attempts: u32, delay: Duration) -> std::io::Result<T> {
    let mut tries = 0;
    loop {
        tries += 1;
        match f() {
            Err(e) if e.raw_os_error() == Some(26) && tries < attempts => std::thread::sleep(delay),
            other => return other,
        }
    }
}

/// `cmd.spawn()` with the ETXTBSY retry (6 tries, 25 ms apart).
pub(crate) fn spawn_retry(cmd: &mut Command) -> std::io::Result<std::process::Child> {
    retry_on_busy(|| cmd.spawn(), 6, Duration::from_millis(25))
}

/// Returns the raw stdout (capped); the recipe turns it into an answer.
fn run_blocking(bin: &Path, args: &[String], env_names: &[&str], path_var: &str, prompt: &str, timeout: Duration) -> Result<String, LlmError> {
    let cwd = TempCwd::new().ok_or(LlmError::BadReply)?;
    let mut cmd = Command::new(bin);
    cmd.args(args).current_dir(&cwd.0).env_clear().env("PATH", path_var).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    for k in env_names {
        if let Ok(v) = std::env::var(k) {
            cmd.env(k, v);
        }
    }
    let mut child = spawn_retry(&mut cmd).map_err(|e| if e.kind() == std::io::ErrorKind::NotFound { LlmError::NotInstalled } else { LlmError::BadReply })?;

    // stdin: written from its own thread so a child that never reads cannot block us; dropping it closes the pipe.
    if let Some(mut si) = child.stdin.take() {
        let data = prompt.as_bytes().to_vec();
        std::thread::spawn(move || {
            let _ = si.write_all(&data);
        });
    }
    // stdout: read (capped) on a thread; the main thread waits with the deadline and kills the child on timeout or cap.
    let mut so = child.stdout.take().ok_or(LlmError::BadReply)?;
    let (tx, rx) = mpsc::channel::<(Vec<u8>, bool)>();
    std::thread::spawn(move || {
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 8192];
        let mut capped = false;
        loop {
            match so.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    buf.extend_from_slice(&chunk[..n]);
                    if buf.len() >= MAX_STDOUT_BYTES {
                        buf.truncate(MAX_STDOUT_BYTES);
                        capped = true;
                        break;
                    }
                }
            }
        }
        let _ = tx.send((buf, capped));
    });
    match rx.recv_timeout(timeout) {
        Ok((buf, capped)) => {
            if capped {
                // enough output: stop the child, use what we have
                let _ = child.kill();
                let _ = child.wait();
                return Ok(String::from_utf8_lossy(&buf).into_owned());
            }
            let status = child.wait().map_err(|_| LlmError::BadReply)?;
            if !status.success() {
                return Err(LlmError::BadReply);
            }
            Ok(String::from_utf8_lossy(&buf).into_owned())
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(LlmError::Timeout)
        }
    }
}
