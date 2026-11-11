//! Explain-only chat (M14). Rust owns the HTTP call and the API key; the webview gets a plain-text reply or a fixed error code.
pub mod cli;
pub mod client;
pub mod config;
pub mod profiles;
pub mod provider;
pub mod sse;
pub mod url_guard;

pub use client::{AskReq, ChatEvent, Detect, Emit, End, LlmError, LlmState, Mode, StreamOutcome, StreamParams, Turn, Usage, LLM_CONFIG_SLOT, LLM_KEY_SLOT, PROMPT_VERSION, SYSTEM_PROMPT};
pub use config::LlmStatus;

#[cfg(test)]
mod cli_tests;
#[cfg(test)]
mod hermes_tests;
#[cfg(test)]
mod client_tests;
#[cfg(test)]
mod stream_tests;
