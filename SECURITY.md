# Security

## Report a vulnerability

Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Do not open a public issue for anything that could expose keys, tokens or let someone place an order. Include the version or commit, your OS, reproduction steps and the impact. Redact keys, tokens and account numbers from everything you send.

## What this app can do

TraderMatrix Desktop **can place real orders** on a real Robinhood account. That makes these classes of bug high severity:

- anything that lets a webview, a dependency, a crafted API response or another process cause an order to be reviewed, placed, cancelled or declined without the user's explicit click
- anything that leaks a vault secret, an OAuth token, a TraderMatrix key or an LLM key
- anything that bypasses the explain-only boundary of the chat (the model gets no tools and the pane never builds an order)

## Design facts a reviewer should know

- **The webview never builds a tool call.** It sends typed intents to Rust. Rust validates strictly (unknown fields are rejected), calls the broker review tool, stores the review, and places that exact review once.
- **No raw or write passthrough command exists.** A test pins the exact list of exposed commands.
- **Secrets stay in the vault.** Passphrase through Argon2id, sealed with XChaCha20-Poly1305, one local file, unlocked once per launch. No command returns a stored secret to the webview. Secret commands from the webview touch only the TraderMatrix key slot.
- **The webview CSP allows `'self'` and IPC only.** All network access and all tokens live in Rust. No external fonts or scripts.
- **No order caps by design.** The absence of size limits or a kill switch is a documented product decision, not a vulnerability. A report that amounts to "there is no cap" will be closed. A report that shows a way around the review-then-place flow will not.
- **MCP clients never follow redirects**, and errors are scrubbed of keys and tokens before they reach the UI or logs.
- **Local only.** Plain http to an LLM endpoint is accepted only for loopback, or for a private IP literal after an explicit opt-in.

## Supported versions

Pre-1.0. Only the latest commit on the default branch is supported.
