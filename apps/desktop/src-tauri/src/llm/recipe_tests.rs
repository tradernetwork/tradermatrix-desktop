//! M21 recipe tests (Review Focus 5) against FAKE scripts only. The real hermes/claude/opencode binaries are never run.
use std::os::unix::fs::PermissionsExt;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use super::cli::{ask_recipe, run_guarded_recipe, CLI_ARGS};
use super::client::LlmError;
use super::recipes::{for_provider, Recipe, CLAUDE, HERMES, OPENCODE_STUB};

static N: AtomicUsize = AtomicUsize::new(0);
const T: Duration = Duration::from_secs(10);

fn fake(name: &str, script: &str) -> String {
    let d: PathBuf = std::env::temp_dir().join(format!("rebull-m21rec-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
    std::fs::create_dir_all(&d).unwrap();
    let f = d.join(name);
    std::fs::write(&f, format!("#!/bin/sh\n{script}\n")).unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
    d.to_string_lossy().into_owned()
}

#[test]
fn claude_recipe_is_the_old_cli_unchanged() {
    assert_eq!(CLAUDE.args(), CLI_ARGS.iter().map(|s| s.to_string()).collect::<Vec<_>>());
    assert_eq!(CLI_ARGS, ["-p", "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence", "--output-format", "text", "--permission-mode", "dontAsk"]);
    assert_eq!((CLAUDE.binary(), CLAUDE.stdin_prompt()), ("claude", true));
    assert_eq!(CLAUDE.env_allowlist(), ["HOME", "LANG", "LC_ALL", "LC_CTYPE"]);
    assert_eq!(CLAUDE.parse_answer("  hi there \n").unwrap(), "hi there");
    assert_eq!(CLAUDE.parse_answer("  \n"), Err(LlmError::BadReply));
}

#[test]
fn hermes_recipe_arguments_are_the_fixed_oneshot_toolless_form() {
    assert_eq!(HERMES.args(), ["chat", "-Q", "--query-file", "-", "--oneshot", "--safe-mode", "-t", "", "--max-turns", "1"].map(String::from));
    assert_eq!((HERMES.binary(), HERMES.stdin_prompt()), ("hermes", true));
    let env = HERMES.env_allowlist();
    for need in ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "HERMES_HOME"] {
        assert!(env.contains(&need), "{need}");
    }
    assert!(!env.iter().any(|v| v.contains("KEY") || v.contains("TOKEN") || v.contains("SECRET")));
}

#[test]
fn review_focus_5_a_tool_call_preview_in_the_output_is_a_bad_reply() {
    for bad in [
        "┊ 🔧 terminal: ls -la\nHere is the answer",
        "Answer first\n⚡ running tool: read_file",
        "<tool_call>{\"name\":\"x\"}</tool_call> ok",
        "{\"tool_calls\":[{\"id\":\"1\"}]} text",
        "Calling tool: terminal\nfinal words",
    ] {
        assert_eq!(HERMES.parse_answer(bad), Err(LlmError::BadReply), "{bad}");
    }
    assert_eq!(HERMES.parse_answer("Price is near the middle of its range.\n\nUsed: CHART\n").unwrap(), "Price is near the middle of its range.\n\nUsed: CHART");
    assert_eq!(HERMES.parse_answer(""), Err(LlmError::BadReply));
}

#[tokio::test]
async fn review_focus_5_the_hermes_prompt_is_on_stdin_never_in_argv_and_the_env_is_only_the_allowlist() {
    std::env::set_var("M21_LEAK_ME", "leak-value");
    std::env::set_var("OPENROUTER_API_KEY", "sk-or-should-not-pass");
    std::env::set_var("HERMES_HOME", "/tmp/m21-hermes-home");
    let p = fake("hermes", "for a in \"$@\"; do echo \"ARG:$a\"; done\n/usr/bin/env | /bin/sed 's/=.*//' | /bin/sort | /bin/sed 's/^/ENVNAME:/'\necho \"HH:$HERMES_HOME\"\necho \"STDIN<<$(/bin/cat)>>\"");
    let prompt = "TOP-SECRET-DIGEST CHART: symbol=AAPL question about the chart";
    let out = ask_recipe(&HERMES, &p, prompt, T).await.unwrap();
    let args: Vec<&str> = out.lines().filter_map(|l| l.strip_prefix("ARG:")).collect();
    assert_eq!(args, HERMES.args().iter().map(String::as_str).collect::<Vec<_>>());
    assert!(!args.iter().any(|a| a.contains("TOP-SECRET")));
    assert!(out.contains(&format!("STDIN<<{prompt}>>")), "{out}");
    assert!(out.contains("HH:/tmp/m21-hermes-home"));
    let names: Vec<&str> = out.lines().filter_map(|l| l.strip_prefix("ENVNAME:")).collect();
    let allowed = HERMES.env_allowlist();
    for n in &names {
        assert!(*n == "PATH" || allowed.contains(n) || ["PWD", "SHLVL", "_", "OLDPWD"].contains(n), "env var leaked: {n}");
    }
    assert!(!names.contains(&"M21_LEAK_ME") && !names.contains(&"OPENROUTER_API_KEY"));
    assert!(names.contains(&"PATH") && names.contains(&"HERMES_HOME"));
}

#[tokio::test]
async fn a_fake_hermes_that_prints_a_tool_preview_makes_the_whole_call_a_bad_reply() {
    let p = fake("hermes", "/bin/cat >/dev/null\necho '┊ 🔧 terminal: cat ~/.ssh/id_rsa'\necho 'Sure, here you go'");
    assert_eq!(ask_recipe(&HERMES, &p, "q", T).await, Err(LlmError::BadReply));
    let ok = fake("hermes", "/bin/cat >/dev/null\necho 'plain answer'");
    assert_eq!(ask_recipe(&HERMES, &ok, "q", T).await.unwrap(), "plain answer");
    let bad_exit = fake("hermes", "/bin/cat >/dev/null\necho partial\nexit 2");
    assert_eq!(ask_recipe(&HERMES, &bad_exit, "q", T).await, Err(LlmError::BadReply));
    assert_eq!(ask_recipe(&HERMES, &fake("claude", "exit 0"), "q", T).await, Err(LlmError::NotInstalled));
}

#[tokio::test]
async fn opencode_is_a_documented_not_shippable_stub_that_never_spawns() {
    assert!(!OPENCODE_STUB.stdin_prompt());
    assert!(for_provider("opencode_cli").is_none() && for_provider("opencode").is_none());
    let d = std::env::temp_dir().join(format!("rebull-m21oc-{}", std::process::id()));
    std::fs::create_dir_all(&d).unwrap();
    let marker = d.join("RAN");
    let f = d.join("opencode");
    std::fs::write(&f, format!("#!/bin/sh\necho x > {}\n", marker.display())).unwrap();
    std::fs::set_permissions(&f, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(ask_recipe(&OPENCODE_STUB, &d.to_string_lossy(), "secret prompt", T).await, Err(LlmError::BadRequest));
    assert!(!marker.exists());
}

#[test]
fn only_claude_and_hermes_resolve_to_recipes() {
    assert_eq!(for_provider("claude_cli").unwrap().binary(), "claude");
    assert_eq!(for_provider("hermes_cli").unwrap().binary(), "hermes");
    for p in ["codex", "gemini", "agy", "openclaw", "openrouter", "hermes", "claude", ""] {
        assert!(for_provider(p).is_none(), "{p}");
    }
}

#[tokio::test]
async fn one_cli_call_at_a_time_across_recipes() {
    let p = fake("hermes", "/bin/cat >/dev/null\n/bin/sleep 1\necho done");
    let busy = AtomicBool::new(false);
    let (a, b) = tokio::join!(run_guarded_recipe(&busy, &HERMES, &p, "q", T), async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        run_guarded_recipe(&busy, &HERMES, &p, "q", T).await
    });
    assert_eq!(a.unwrap(), "done");
    assert_eq!(b, Err(LlmError::RateLimited));
}
