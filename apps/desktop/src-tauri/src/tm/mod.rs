//! TraderMatrix (read-only analytics) over its public MCP. Rust owns the connection and the API key;
//! the webview only ever sees the typed, snake_case shapes from `types`.
pub mod client;
pub mod reads;
pub mod types;

pub use client::{TmState, TmStatus, VaultKeyProvider, TM_ENDPOINT, TM_KEY_SLOT};

#[cfg(test)]
mod client_tests;
