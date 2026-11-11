/// Errors from the Robinhood client. Messages never contain tokens, codes, verifiers or passphrases.
#[derive(thiserror::Error, Debug, Clone, PartialEq)]
pub enum RhError {
    #[error("not connected to Robinhood")]
    NotConnected,
    #[error("Robinhood rejected the credentials (unauthorized)")]
    Unauthorized,
    #[error("Robinhood rate limit hit")]
    RateLimited,
    #[error("HTTP {0}: {1}")]
    Http(u16, String),
    #[error("tool error: {0}")]
    Tool(String),
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("transport error: {0}")]
    Transport(String),
    /// A caller-supplied order or id failed local validation; nothing was sent.
    #[error("invalid input: {0}")]
    Invalid(String),
    /// TraderMatrix (tm module) only: no `tm_api_key` in the secret store.
    #[error("TraderMatrix key not set")]
    TmKeyMissing,
    /// TraderMatrix (tm module) only: the server answered 401 to the stored key.
    #[error("TraderMatrix rejected the key (invalid or revoked)")]
    TmKeyRejected,
    /// TraderMatrix (tm module) only: the secret store is locked, so the key cannot be read.
    #[error("vault locked: unlock it to use TraderMatrix")]
    TmVaultLocked,
}

impl From<RhError> for String {
    fn from(e: RhError) -> Self {
        e.to_string()
    }
}

/// Shortens server-provided text for error messages and removes `secret` if the server echoed it.
pub fn clip(text: &str, secret: Option<&str>) -> String {
    let mut t = text.to_string();
    if let Some(s) = secret {
        if !s.is_empty() {
            t = t.replace(s, "[redacted]");
        }
    }
    let t = t.trim();
    if t.chars().count() > 300 {
        let cut: String = t.chars().take(300).collect();
        format!("{cut}...")
    } else {
        t.to_string()
    }
}
