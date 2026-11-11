//! Secret redaction for stored chat text (M16 B7). A key pasted into a question must never sit in the history database or an export.
//! Pure and bounded (one pass over the characters, no regex engine). Replaced with `[redacted]`: `sk-` / `sk-or-` keys (16+ key characters),
//! `Bearer <20+ chars>`, `td_live_<8+>`, and a 32+ character hex/base64-ish run right after the word key, token or secret. A price, a plain
//! 40-character git sha in prose and ordinary words are left alone. Idempotent: the marker itself matches nothing.

const MARKER: &str = "[redacted]";
const SK_MIN: usize = 16;
const BEARER_MIN: usize = 20;
const TD_MIN: usize = 8;
const RUN_MIN: usize = 32;
/// A word-trailing run is only looked at this far for a digit, so a hostile input cannot make the scan quadratic.
const RUN_PEEK: usize = 512;

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}
fn is_key_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '-'
}
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '~' | '+' | '/' | '=' | '-')
}
fn is_b64_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '=' | '_' | '-')
}
fn starts(c: &[char], i: usize, lit: &str, ci: bool) -> bool {
    let l: Vec<char> = lit.chars().collect();
    i + l.len() <= c.len() && l.iter().enumerate().all(|(k, &x)| if ci { c[i + k].eq_ignore_ascii_case(&x) } else { c[i + k] == x })
}
/// End of the run of `f` characters starting at `from`, scanning at most `cap` characters (the run is then known to be at least `cap` long).
fn run_end(c: &[char], from: usize, cap: usize, f: fn(char) -> bool) -> usize {
    let mut j = from;
    while j < c.len() && j - from < cap && f(c[j]) {
        j += 1;
    }
    j
}
/// End of the whole run (used once a run is known to be a secret).
fn run_all(c: &[char], from: usize, f: fn(char) -> bool) -> usize {
    run_end(c, from, usize::MAX, f)
}

fn is_filler(ch: char) -> bool {
    ch.is_whitespace() || matches!(ch, ':' | '=' | '"' | '\'' | '`' | '(')
}

/// The end of a secret that starts at `i`, if one does.
fn secret_at(c: &[char], i: usize) -> Option<(usize, usize)> {
    let boundary = i == 0 || !is_word(c[i - 1]);
    if boundary && starts(c, i, "sk-", false) {
        let from = i + 3;
        if run_end(c, from, SK_MIN, is_key_char) - from >= SK_MIN {
            return Some((i, run_all(c, from, is_key_char)));
        }
    }
    if boundary && starts(c, i, "bearer", true) {
        let mut k = i + 6;
        let ws = k;
        while k < c.len() && (c[k] == ' ' || c[k] == '\t') {
            k += 1;
        }
        if k > ws && run_end(c, k, BEARER_MIN, is_token_char) - k >= BEARER_MIN {
            return Some((i, run_all(c, k, is_token_char)));
        }
    }
    if boundary && starts(c, i, "td_live_", false) {
        let from = i + 8;
        if run_end(c, from, TD_MIN, is_word) - from >= TD_MIN {
            return Some((i, run_all(c, from, is_word)));
        }
    }
    for w in ["key", "token", "secret"] {
        if starts(c, i, w, true) {
            let mut k = i + w.len();
            if k < c.len() && c[k].is_ascii_alphanumeric() {
                continue; // keyboard, tokens, secretary
            }
            while k < c.len() && is_filler(c[k]) {
                k += 1;
            }
            // "the key is <token>", "the secret was <token>"
            for lead in ["is", "was"] {
                if starts(c, k, lead, true) && c.get(k + lead.len()).is_some_and(|x| x.is_whitespace() || matches!(x, ':' | '=')) {
                    k += lead.len();
                    while k < c.len() && is_filler(c[k]) {
                        k += 1;
                    }
                    break;
                }
            }
            let peek = run_end(c, k, RUN_PEEK, is_b64_char);
            if peek - k >= RUN_MIN && c[k..peek].iter().any(|x| x.is_ascii_digit()) {
                return Some((k, run_all(c, k, is_b64_char)));
            }
        }
    }
    None
}

pub fn redact_secrets(s: &str) -> String {
    let c: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    let mut emitted = 0;
    while i < c.len() {
        match secret_at(&c, i) {
            Some((start, end)) if end > start => {
                out.extend(&c[emitted..start]);
                out.push_str(MARKER);
                i = end.max(i + 1);
                emitted = i;
            }
            _ => i += 1,
        }
    }
    out.extend(&c[emitted..]);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const R: &str = "[redacted]";
    const SK: &str = "sk-proj-abcdefghijklmnop1234";
    const OR: &str = "sk-or-v1-0123456789abcdef0123456789abcdef";

    #[test]
    fn sk_keys_and_openrouter_keys_are_redacted() {
        assert_eq!(redact_secrets(&format!("my key is {SK} ok")), format!("my key is {R} ok"));
        assert_eq!(redact_secrets(OR), R);
        assert_eq!(redact_secrets(&format!("({OR})")), format!("({R})"));
        assert_eq!(redact_secrets(&format!("a {SK}\n{OR} b")), format!("a {R}\n{R} b"));
        // exactly 16 key characters after `sk-` counts, 15 does not
        assert_eq!(redact_secrets("sk-0123456789abcdef"), R);
        assert_eq!(redact_secrets("sk-0123456789abcde"), "sk-0123456789abcde");
    }

    #[test]
    fn bearer_tokens_are_redacted() {
        assert_eq!(redact_secrets("Authorization: Bearer abcdefghij0123456789xyz"), format!("Authorization: {R}"));
        assert_eq!(redact_secrets("bearer ABCDEFGHIJ.0123456789-xyz_=="), R);
        assert_eq!(redact_secrets("Bearer short"), "Bearer short");
        assert_eq!(redact_secrets("a Bearer of bad news and a very long sentence follows"), "a Bearer of bad news and a very long sentence follows");
    }

    #[test]
    fn td_live_keys_are_redacted() {
        assert_eq!(redact_secrets("td_live_AbCd1234"), R);
        assert_eq!(redact_secrets("use td_live_AbCd1234efgh please"), format!("use {R} please"));
        assert_eq!(redact_secrets("td_live_short"), "td_live_short");
    }

    #[test]
    fn long_runs_after_key_token_or_secret_are_redacted() {
        let hex = "0123456789abcdef0123456789abcdef";
        let b64 = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MTIzNDU2Nzg5";
        assert_eq!(redact_secrets(&format!("api key: {hex}")), format!("api key: {R}"));
        assert_eq!(redact_secrets(&format!("token={b64}")), format!("token={R}"));
        assert_eq!(redact_secrets(&format!("the secret is \"{hex}\".")), format!("the secret is \"{R}\"."));
        assert_eq!(redact_secrets(&format!("API_KEY={hex}")), format!("API_KEY={R}"));
        assert_eq!(redact_secrets(&format!("Secret {b64}")), format!("Secret {R}"));
        // 31 characters is not enough
        let short = "0123456789abcdef0123456789abcde";
        assert_eq!(redact_secrets(&format!("key {short}")), format!("key {short}"));
    }

    #[test]
    fn ordinary_text_is_left_alone() {
        for s in [
            "The last price is 187.32 and the high is 189.10.",
            "What is IV rank 72 telling me at the 95 strike?",
            "risk-reward-ratio-calculation-example-with-long-words",
            "ask-me-anything-about-the-chart-and-its-levels",
            "task-list-of-things-that-are-long-enough-to-matter",
            "sk-",
            "sk-abc",
            "the key level is 187.32",
            "token 12345",
            "keyboard 0123456789abcdef0123456789abcdef0123",
            "",
        ] {
            assert_eq!(redact_secrets(s), s, "{s:?}");
        }
        // a 40-character git sha in prose is allowed (no key/token/secret word right before it)
        let sha = "3f2a9c1b7d4e5f60718293a4b5c6d7e8f9012345";
        assert_eq!(sha.len(), 40);
        let prose = format!("The fix landed in commit {sha} last week.");
        assert_eq!(redact_secrets(&prose), prose);
    }

    #[test]
    fn idempotent_and_unicode_safe() {
        let all = format!("a {SK} b Bearer abcdefghij0123456789xyz c td_live_AbCd1234 d token={}", "0123456789abcdef".repeat(2));
        let once = redact_secrets(&all);
        assert!(!once.contains("sk-") && !once.contains("td_live") && !once.contains("abcdefghij0123456789xyz"));
        assert_eq!(redact_secrets(&once), once);
        let u = "caf\u{e9} \u{1f4c8} price 187.32 \u{2014} \u{4e2d}\u{6587}";
        assert_eq!(redact_secrets(u), u);
        assert_eq!(redact_secrets(&format!("\u{1f4c8}{SK}\u{1f4c8}")), format!("\u{1f4c8}{R}\u{1f4c8}"));
    }

    #[test]
    fn a_very_long_input_stays_linear() {
        let big = "ab12 ".repeat(200_000);
        assert_eq!(redact_secrets(&big), big);
    }
}
