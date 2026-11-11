pub mod error;
pub mod limiter;
pub mod mcp;
pub mod oauth;
pub mod orders;
pub mod pnl;
pub mod reads;
pub mod reviews;
pub mod tokens;
pub mod types;
pub mod watch_writes;
pub mod writes;
#[cfg(test)]
mod e2e_tests;
#[cfg(test)]
mod orders_e2e_tests;
#[cfg(test)]
mod pnl_tests;
#[cfg(test)]
mod watch_tests;
#[cfg(test)]
pub mod testutil;

pub use error::RhError;
pub use limiter::Limiter;
pub use mcp::{InitGate, McpClient, ServerInfo, TokenProvider, ToolDef, ToolResult};
pub use oauth::{login, logout, pkce_pair, OAuthConfig, TauriOpener, UrlOpener};
pub use tokens::{StoredTokens, VaultTokenProvider, REFRESH_SKEW_SEC};
