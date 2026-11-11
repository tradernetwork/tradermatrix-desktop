//! Request-body shapes per provider profile (M14b). Only fields the provider's current docs list are ever sent; `compat` drops everything
//! optional. Facts checked 2026-11-11: OpenRouter (`reasoning`, `max_tokens`), OpenAI (`max_completion_tokens`; `max_tokens` is deprecated and
//! rejected by o-series, and reasoning models reject a custom `temperature`), Venice (`max_completion_tokens`, `venice_parameters`),
//! Ollama (`max_tokens` supported), LM Studio (OpenAI-compatible).
use serde_json::{json, Value};

use super::provider::Profile;

pub const TEMPERATURE: f64 = 0.2;
/// OpenAI counts hidden reasoning inside `max_completion_tokens`; a 700 cap can leave an empty visible reply on a reasoning model.
pub const OPENAI_MIN_COMPLETION_TOKENS: u32 = 1500;

pub fn build_body(profile: Profile, compat: bool, model: &str, messages: Vec<Value>, max_tokens: u32) -> Value {
    match (profile, compat) {
        (Profile::OpenRouter, false) => json!({
            "model": model, "messages": messages, "max_tokens": max_tokens, "temperature": TEMPERATURE, "stream": false,
            "reasoning": {"enabled": false},
        }),
        (Profile::OpenAi, _) => json!({"model": model, "messages": messages, "max_completion_tokens": max_tokens.max(OPENAI_MIN_COMPLETION_TOKENS)}),
        (Profile::Venice, false) => json!({
            "model": model, "messages": messages, "max_completion_tokens": max_tokens, "temperature": TEMPERATURE,
            "venice_parameters": {"include_venice_system_prompt": false},
        }),
        (Profile::Venice, true) => json!({"model": model, "messages": messages, "max_completion_tokens": max_tokens}),
        // OpenRouter compat, Local, Custom: the bare minimum.
        _ => json!({"model": model, "messages": messages, "max_tokens": max_tokens}),
    }
}
