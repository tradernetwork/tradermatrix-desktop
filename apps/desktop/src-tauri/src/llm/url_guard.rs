//! Base-URL validation for LLM endpoints (M14b). The bearer key goes wherever this accepts, so the rules are strict and parse the host
//! (never a prefix match): https anywhere, plain http ONLY to a loopback host, no userinfo, no query, no fragment, nothing but http(s).
use url::Url;

use super::client::LlmError;

const MAX_URL_LEN: usize = 200;

pub fn validate_base_url(s: &str) -> Result<Url, LlmError> {
    let s = s.trim();
    if s.is_empty() || s.len() > MAX_URL_LEN {
        return Err(LlmError::BadRequest);
    }
    let mut u = Url::parse(s).map_err(|_| LlmError::BadRequest)?;
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() {
        return Err(LlmError::BadRequest);
    }
    match u.scheme() {
        "https" => {}
        "http" => {
            if !super::provider::is_loopback(&u) {
                return Err(LlmError::BadRequest);
            }
        }
        _ => return Err(LlmError::BadRequest),
    }
    if u.host().is_none() {
        return Err(LlmError::BadRequest);
    }
    let trimmed = u.path().trim_end_matches('/').to_string();
    u.set_path(&trimmed);
    Ok(u)
}

/// Hermes (self-hosted, M16 B5): https to ANY user-typed host; plain http to loopback, or (only with the per-profile `lan_http` acceptance)
/// to an IP-literal host in RFC1918 or 100.64.0.0/10. The host is parsed, never prefix-matched; hostnames never qualify for non-loopback http.
pub fn validate_hermes_url(s: &str, lan_http: bool) -> Result<Url, LlmError> {
    let s = s.trim();
    if s.is_empty() || s.len() > MAX_URL_LEN {
        return Err(LlmError::BadRequest);
    }
    let mut u = Url::parse(s).map_err(|_| LlmError::BadRequest)?;
    if !u.username().is_empty() || u.password().is_some() || u.query().is_some() || u.fragment().is_some() || u.host().is_none() {
        return Err(LlmError::BadRequest);
    }
    match u.scheme() {
        "https" => {}
        "http" => {
            let ok = super::provider::is_loopback(&u) || (lan_http && matches!(u.host(), Some(url::Host::Ipv4(a)) if is_private_lan(a)));
            if !ok {
                return Err(LlmError::BadRequest);
            }
        }
        _ => return Err(LlmError::BadRequest),
    }
    let trimmed = u.path().trim_end_matches('/').to_string();
    u.set_path(&trimmed);
    Ok(u)
}

/// RFC1918 (10/8, 172.16/12, 192.168/16) or the CGNAT block 100.64.0.0/10 (Tailscale). Nothing else: not link-local, not IPv6.
pub fn is_private_lan(a: std::net::Ipv4Addr) -> bool {
    let o = a.octets();
    o[0] == 10 || (o[0] == 172 && (16..=31).contains(&o[1])) || (o[0] == 192 && o[1] == 168) || (o[0] == 100 && (64..=127).contains(&o[1]))
}

/// `<base>/chat/completions` (the base never ends with a slash after validation).
pub fn chat_url(base: &Url) -> Url {
    let mut u = base.clone();
    let p = format!("{}/chat/completions", base.path().trim_end_matches('/'));
    u.set_path(&p);
    u
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn https_is_fine_anywhere() {
        for s in ["https://openrouter.ai/api/v1", "https://api.openai.com/v1", "https://api.venice.ai/api/v1", "https://example.com", "https://203.0.113.5:8443/v1"] {
            assert!(validate_base_url(s).is_ok(), "{s}");
        }
    }

    #[test]
    fn plain_http_only_to_loopback_by_parsed_host() {
        for s in ["http://127.0.0.1:11434/v1", "http://localhost:1234/v1", "http://[::1]:8080/v1", "http://127.0.0.2/v1", "http://LOCALHOST:1234/v1"] {
            assert!(validate_base_url(s).is_ok(), "{s}");
        }
        for s in [
            "http://example.com/v1",
            "http://192.168.1.5:11434/v1",
            "http://127.0.0.1.evil.com/v1",
            "http://localhost.evil.com/v1",
            "http://evil.com/127.0.0.1",
            "http://0.0.0.0:11434/v1",
            "http://[::2]/v1",
            "http://localhost@evil.com/v1",
        ] {
            assert_eq!(validate_base_url(s), Err(LlmError::BadRequest), "{s}");
        }
    }

    #[test]
    fn userinfo_query_fragment_and_other_schemes_are_refused() {
        for s in [
            "https://user@openrouter.ai/api/v1",
            "https://user:pw@openrouter.ai/api/v1",
            "https://:pw@openrouter.ai/api/v1",
            "https://openrouter.ai/api/v1?x=1",
            "https://openrouter.ai/api/v1#frag",
            "ftp://127.0.0.1/v1",
            "file:///etc/passwd",
            "javascript:alert(1)",
            "ws://127.0.0.1/v1",
            "//openrouter.ai/v1",
            "openrouter.ai/v1",
            "",
            "   ",
            "https://",
        ] {
            assert_eq!(validate_base_url(s), Err(LlmError::BadRequest), "{s:?}");
        }
        assert_eq!(validate_base_url(&format!("https://example.com/{}", "a".repeat(300))), Err(LlmError::BadRequest));
    }

    #[test]
    fn trailing_slash_is_normalised_and_chat_url_appends_once() {
        let u = validate_base_url("https://openrouter.ai/api/v1/").unwrap();
        assert_eq!(chat_url(&u).as_str(), "https://openrouter.ai/api/v1/chat/completions");
        let u = validate_base_url("http://127.0.0.1:11434/v1").unwrap();
        assert_eq!(chat_url(&u).as_str(), "http://127.0.0.1:11434/v1/chat/completions");
        let u = validate_base_url("http://localhost:1234").unwrap();
        assert_eq!(chat_url(&u).as_str(), "http://localhost:1234/chat/completions");
    }

    #[test]
    fn hermes_url_matrix() {
        let ok = |s: &str, lan: bool| validate_hermes_url(s, lan).is_ok();
        // https to any host, with or without the toggle
        for s in ["https://hermes.example.com", "https://hermes.tailnet.ts.net/v1", "https://203.0.113.5:8443", "https://192.168.1.5", "https://8.8.8.8/v1", "https://[2001:db8::1]/v1"] {
            assert!(ok(s, false) && ok(s, true), "{s}");
        }
        // loopback http needs no toggle (IPv4, localhost, IPv6)
        for s in ["http://127.0.0.1:8642", "http://localhost:8642/v1", "http://[::1]:8642", "http://127.0.0.2:8642"] {
            assert!(ok(s, false) && ok(s, true), "{s}");
        }
        // private LAN http: refused without the toggle, accepted with it
        for s in ["http://192.168.1.5", "http://192.168.1.5:8642/v1", "http://10.0.0.5:8642", "http://10.255.255.255", "http://172.16.0.1", "http://172.31.255.255:8642", "http://100.64.0.1", "http://100.100.1.1:8642", "http://100.127.255.255"] {
            assert!(!ok(s, false), "{s} without the toggle");
            assert!(ok(s, true), "{s} with the toggle");
        }
        // never, even with the toggle
        for s in [
            "http://8.8.8.8",
            "http://8.8.8.8:8642/v1",
            "http://172.15.255.255",
            "http://172.32.0.1",
            "http://100.63.255.255",
            "http://100.128.0.1",
            "http://169.254.1.1",
            "http://0.0.0.0:8642",
            "http://192.169.0.1",
            "http://11.0.0.1",
            "http://134744072",            // decimal form of 8.8.8.8
            "http://[fd00::1]:8642",       // IPv6 private is not covered
            "http://[::ffff:192.168.1.5]", // mapped IPv6 is not covered
            "http://[fe80::1]",
            "http://hermes.lan:8642",
            "http://hermes.example.com",
            "http://myhost",
            "http://192.168.1.5.evil.com",
            "http://192.168.1.5.nip.io",
            "http://localhost.evil.com",
            "http://127.0.0.1.evil.com",
            "http://evil.com/192.168.1.5",
            "http://192.168.1.5@evil.com",
            "http://user:pw@192.168.1.5",
            "ftp://192.168.1.5",
            "ws://192.168.1.5",
            "file:///etc/passwd",
            "192.168.1.5",
            "//192.168.1.5",
            "",
            "http://",
        ] {
            assert!(!ok(s, true), "{s} must be refused even with the toggle");
            assert!(!ok(s, false), "{s} must be refused without the toggle");
        }
        // the shared hygiene rules still apply to https
        for s in ["https://u@host", "https://host?x=1", "https://host#f"] {
            assert!(!ok(s, true), "{s}");
        }
        assert_eq!(validate_hermes_url("http://192.168.1.5:8642/v1/", true).unwrap().as_str(), "http://192.168.1.5:8642/v1");
    }
}
