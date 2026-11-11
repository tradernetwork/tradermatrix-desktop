//! Local Claude CLI provider tests. They spawn ONLY fake `claude` shell scripts created in a temp dir (never the real CLI, never a real prompt).
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use super::cli::{ask_with, find_binary, run_guarded, CLI_ARGS};
use super::client::{LlmError, LlmState, SYSTEM_PROMPT};
use super::config;
use crate::secrets::{MemoryStore, SecretStore};

static N: AtomicUsize = AtomicUsize::new(0);

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("rebull-clitest-{}-{}-{tag}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A directory holding an executable fake named `claude`; returns the directory (use it as the whole PATH).
fn fake(script: &str) -> String {
    let d = tmp("bin");
    let f = d.join("claude");
    std::fs::write(&f, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
    d.to_string_lossy().into_owned()
}

const T: Duration = Duration::from_secs(10);

#[test]
fn binary_is_resolved_by_fixed_name_from_absolute_path_entries_only() {
    let good = fake("exit 0");
    assert_eq!(find_binary(&good).unwrap(), PathBuf::from(&good).join("claude"));
    // the name is fixed: a look-alike does not count
    let d = tmp("lookalike");
    for n in ["claude2", "claude-code", "Claude"] {
        let f = d.join(n);
        std::fs::write(&f, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    assert!(find_binary(&d.to_string_lossy()).is_none());
    // not executable, a directory named claude, relative and empty PATH entries: all ignored
    let d2 = tmp("noexec");
    std::fs::write(d2.join("claude"), "x").unwrap();
    assert!(find_binary(&d2.to_string_lossy()).is_none());
    let d3 = tmp("dir");
    std::fs::create_dir_all(d3.join("claude")).unwrap();
    assert!(find_binary(&d3.to_string_lossy()).is_none());
    assert!(find_binary("").is_none());
    assert!(find_binary(".:bin:relative/dir").is_none());
    // first absolute hit wins; a bad entry before it is skipped
    assert_eq!(find_binary(&format!(".:{d2}:{good}", d2 = d2.display())).unwrap(), PathBuf::from(&good).join("claude"));
}

#[tokio::test]
async fn missing_binary_is_not_installed() {
    let empty = tmp("empty");
    assert_eq!(ask_with(&empty.to_string_lossy(), "hi", T).await, Err(LlmError::NotInstalled));
}

#[tokio::test]
async fn args_are_fixed_all_tools_are_off_and_the_prompt_is_never_in_argv() {
    let p = fake("for a in \"$@\"; do echo \"ARG:$a\"; done");
    let secret_prompt = "TOP-SECRET-PROMPT-TEXT digest CHART: symbol=AAPL";
    let out = ask_with(&p, secret_prompt, T).await.unwrap();
    let args: Vec<&str> = out.lines().filter_map(|l| l.strip_prefix("ARG:")).collect();
    assert_eq!(args, CLI_ARGS);
    assert_eq!(CLI_ARGS, ["-p", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "text", "--permission-mode", "dontAsk"]);
    assert!(!out.contains("TOP-SECRET"), "{out}");
}

#[tokio::test]
async fn the_prompt_arrives_on_stdin_whole() {
    let p = fake("echo \"STDIN<<$(/bin/cat)>>\"");
    let prompt = format!("line one\nline two with 'quotes' and \"doubles\" and $(subshell) `tick`\n{}", "x".repeat(3000));
    let out = ask_with(&p, &prompt, T).await.unwrap();
    assert_eq!(out.trim(), format!("STDIN<<{prompt}>>"));
}

#[tokio::test]
async fn env_is_scrubbed_to_path_home_and_locale() {
    // SAFETY-ish: a unique name that no other test reads
    std::env::set_var("REBULL_TEST_POISON", "leak-me");
    std::env::set_var("OPENROUTER_API_KEY", "sk-or-must-not-reach-the-child");
    std::env::set_var("ANTHROPIC_API_KEY", "sk-ant-must-not-reach-the-child");
    let p = fake("/usr/bin/env");
    let out = ask_with(&p, "hi", T).await.unwrap();
    let keys: Vec<&str> = out.lines().filter_map(|l| l.split_once('=').map(|(k, _)| k)).collect();
    for k in &keys {
        assert!(["PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "PWD", "SHLVL", "_", "OLDPWD"].contains(k), "unexpected env var {k}: {keys:?}");
    }
    assert!(keys.contains(&"PATH") && keys.contains(&"HOME"), "{keys:?}");
    assert!(!out.contains("leak-me") && !out.contains("must-not-reach"), "{out}");
}

#[tokio::test]
async fn cwd_is_a_fresh_empty_temp_dir_removed_afterwards() {
    let p = fake("echo \"CWD:$PWD\"; echo \"LS:$(/bin/ls -A)\"");
    let out = ask_with(&p, "hi", T).await.unwrap();
    let cwd = out.lines().find_map(|l| l.strip_prefix("CWD:")).unwrap();
    let ls = out.lines().find_map(|l| l.strip_prefix("LS:")).unwrap();
    assert_eq!(ls, "", "the working directory must be empty");
    assert_ne!(PathBuf::from(cwd), std::env::current_dir().unwrap());
    assert!(PathBuf::from(cwd).starts_with(std::env::temp_dir()), "{cwd}");
    assert!(!PathBuf::from(cwd).exists(), "temp dir must be removed after the call: {cwd}");
    // a second call gets a different directory
    let out2 = ask_with(&p, "hi", T).await.unwrap();
    assert_ne!(out2.lines().find_map(|l| l.strip_prefix("CWD:")).unwrap(), cwd);
}

#[tokio::test]
async fn timeout_kills_the_child() {
    let marker = tmp("marker").join("alive");
    let p = fake(&format!("echo started > {m}; exec /bin/sleep 30", m = marker.display()));
    let t0 = Instant::now();
    assert_eq!(ask_with(&p, "hi", Duration::from_millis(400)).await, Err(LlmError::Timeout));
    assert!(t0.elapsed() < Duration::from_secs(8), "{:?}", t0.elapsed());
    assert!(marker.exists(), "the fake did run");
}

#[tokio::test]
async fn oversized_output_is_capped_and_truncated() {
    let p = fake("exec /usr/bin/yes abcdefghij");
    let t0 = Instant::now();
    let out = ask_with(&p, "hi", T).await.unwrap();
    assert_eq!(out.chars().count(), 8000);
    assert!(t0.elapsed() < Duration::from_secs(8));
}

#[tokio::test]
async fn failures_are_bad_reply_and_stderr_never_surfaces() {
    let p = fake("echo partial; echo 'SECRET-STDERR sk-xyz' >&2; exit 3");
    let r = ask_with(&p, "hi", T).await;
    assert_eq!(r, Err(LlmError::BadReply));
    assert!(!format!("{r:?}").contains("SECRET-STDERR"));
    assert_eq!(ask_with(&fake("exit 0"), "hi", T).await, Err(LlmError::BadReply), "empty output");
    assert_eq!(ask_with(&fake("echo '   '"), "hi", T).await, Err(LlmError::BadReply), "blank output");
}

#[tokio::test]
async fn only_one_cli_call_at_a_time() {
    let busy = Arc::new(AtomicBool::new(false));
    let p = fake("/bin/sleep 1; echo done");
    let (b1, p1) = (busy.clone(), p.clone());
    let first = tokio::spawn(async move { run_guarded(&b1, &p1, "a", T).await });
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(run_guarded(&busy, &p, "b", T).await, Err(LlmError::RateLimited));
    assert_eq!(first.await.unwrap().unwrap().trim(), "done");
    // the guard is released: a third call works
    assert_eq!(run_guarded(&busy, &fake("echo again"), "c", T).await.unwrap().trim(), "again");
    // and it is released after a failure too
    assert!(run_guarded(&busy, &fake("exit 1"), "d", T).await.is_err());
    assert!(!busy.load(Ordering::SeqCst));
}

#[tokio::test]
async fn the_provider_dispatch_builds_the_prompt_and_ignores_the_model() {
    let st: Arc<dyn SecretStore> = Arc::new(MemoryStore::new());
    config::set_config_with_gate(&*st, "claude_cli", None, None, None, None, None, super::cli_registry::Gate { public: false, experimental: false, advanced: false }).unwrap();
    let p = fake("echo \"STDIN<<$(/bin/cat)>>\"");
    let s = LlmState::for_test(st.clone(), Duration::from_secs(5)).with_cli(&p, T).with_public(false);
    let r = s.explain("", "CHART: symbol=AAPL\nIV: rank=72", "What is this?", vec![super::client::Turn { role: "user".into(), text: "hi".into() }, super::client::Turn { role: "assistant".into(), text: "hello".into() }]).await.unwrap();
    assert!(r.contains(SYSTEM_PROMPT), "explain-only rules travel in the prompt");
    for must in ["<digest>", "CHART: symbol=AAPL", "</digest>", "hi", "hello", "What is this?"] {
        assert!(r.contains(must), "prompt lacks {must}: {r}");
    }
    assert!(r.find("hello").unwrap() < r.find("What is this?").unwrap());
    // a missing binary surfaces as not_installed through the same path
    let s2 = LlmState::for_test(st, Duration::from_secs(5)).with_cli(&tmp("none").to_string_lossy(), T).with_public(false);
    assert_eq!(s2.explain("", "d", "q", vec![]).await, Err(LlmError::NotInstalled));
    // and the ping works through the CLI too, with no chart data
    let s3 = LlmState::for_test(Arc::new(MemoryStore::new()), T);
    assert_eq!(s3.ping().await, Err(LlmError::NoKey));
}


// ETXTBSY race: a script written a moment ago can still be held open by a concurrent fork, so exec fails with
// "Text file busy" (os error 26). A bounded retry fixes it; every other error returns at once.
#[test]
fn retry_on_busy_retries_only_text_file_busy_and_is_bounded() {
    use std::cell::Cell;
    let busy = || std::io::Error::from_raw_os_error(26);
    // busy three times, then ok: four calls, Ok
    let n = Cell::new(0);
    let r = super::cli::retry_on_busy(|| { n.set(n.get() + 1); if n.get() <= 3 { Err(busy()) } else { Ok(7) } }, 6, Duration::from_millis(1));
    assert_eq!((r.unwrap(), n.get()), (7, 4));
    // a different error returns immediately: exactly one call
    let n = Cell::new(0);
    let r: std::io::Result<u8> = super::cli::retry_on_busy(|| { n.set(n.get() + 1); Err(std::io::Error::from(std::io::ErrorKind::NotFound)) }, 6, Duration::from_millis(1));
    assert_eq!((r.unwrap_err().kind(), n.get()), (std::io::ErrorKind::NotFound, 1));
    // always busy: gives up after the attempt cap with the busy error
    let n = Cell::new(0);
    let r: std::io::Result<u8> = super::cli::retry_on_busy(|| { n.set(n.get() + 1); Err(busy()) }, 4, Duration::from_millis(1));
    assert_eq!((r.unwrap_err().raw_os_error(), n.get()), (Some(26), 4));
}
