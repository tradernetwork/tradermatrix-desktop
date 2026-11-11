# Architecture

Short version: Rust owns every secret, every network call and every order. The webview draws, asks, and holds no credentials.

## Two halves

- **Rust core** (`apps/desktop/src-tauri/`): Tauri 2 commands, the encrypted vault, MCP clients for Robinhood and TraderMatrix, the LLM client, SQLite via sqlx, rate limiting, secret redaction.
- **Webview** (`apps/desktop/src/`): React 19, dockview panels, zustand stores, KLineChart. Its Content Security Policy allows `'self'` and IPC only, so it cannot reach the network or load external code. Everything it knows comes through typed Tauri commands.
- **Script runtime** (`packages/script/`): a zero-dependency interpreter for a Webull-style indicator dialect. The webview compiles and runs scripts against bars and turns the output into draw operations. One original built-in script ships (an EMA ribbon).

## Vault and secrets

One file in the app data directory. A passphrase goes through Argon2id; the derived key seals the secret map with XChaCha20-Poly1305. The vault is unlocked once per launch and zeroized on lock. When an OS keychain exists it is preferred. There is no command that returns a stored secret to the webview, and the webview-facing secret commands can touch only the TraderMatrix key slot (the UI sees `key_present`, never the key). Error text is passed through a redactor before it leaves Rust.

## MCP clients

Both Robinhood and TraderMatrix speak MCP over Streamable HTTP through one client.

- Robinhood auth is OAuth 2.1 with PKCE, dynamic client registration and a loopback redirect. Refresh tokens rotate and are single use, so the new one is saved before the old one is spent.
- A 4 calls per second limiter. Retries only for read tools. The client never follows redirects and never sends the session DELETE.
- TraderMatrix reads its API key from the vault on every call, caches reads briefly, and de-duplicates in-flight requests.

## Order flow

```
webview ticket
   | typed intent (never a tool call)
   v
rh_review_*_order   Rust validates strictly (unknown fields rejected),
   |                refuses non-agentic accounts without a review call,
   |                calls the review tool, stores a review with a ref_id
   v
user sees the preview, clicks Place
   v
rh_place_order(reviewId)   single use; concurrent callers replay one outcome;
   |                       exactly one place request is sent
   v
outcome: placed | awaiting_approval | rejected | unknown
```

- `awaiting_approval`: the account has Robinhood trade approvals on. Nothing was placed. The user approves or declines in the Robinhood app, and the app can decline too.
- `unknown`: the request might have reached the server (timeout, gateway error, duplicate-reference text). It is never auto-retried. An explicit retry re-sends the same `ref_id` so Robinhood de-duplicates, and the ticket blocks a new review while one is unresolved. The retry window is 600 seconds.
- `rejected`: includes local failures before anything was sent.
- Place, cancel and decline are never auto-retried, not even on a 404.
- There is no order cap, arm step or kill switch. That is a product decision.

Fills from positions, watchlist and orders only set ticket fields. They never place.

## Storage

SQLite in the app data directory, with migrations in `src-tauri/migrations/`: layouts and settings, journal notes (keyed by a hash of account, symbol, side, quantity, price and time), candles, and explain threads and usage. Candles loaded from Robinhood are stored locally so a chart can render from disk first. Nothing in these tables is uploaded anywhere.

## Explain-only boundary

The chat (Arya) is a one-way street: the app builds a digest of visible chart and position data, sends it with the question to the user's chosen provider, and shows the reply.

- The LLM client has no tool or function calling. Request bodies are minimal per provider and unknown fields are never sent.
- The digest builder and the pane contain no order vocabulary, and a test enforces that on source.
- Replies pass a pipeline: grounding (numbers not in the digest are underlined), a lint for prescriptive language, safe markdown rendering with no HTML or script.
- Plain http to a model endpoint is allowed for loopback, or for a private IP literal after an explicit opt-in. Hosted providers are fixed https URLs.
- The optional installed-Claude provider shells out to the local `claude` CLI with no tools enabled.
- Secrets, bearer tokens and keys are redacted from questions and replies before they are stored or shown.

## Build-time notes

Dev pages (`*-dev.html`) mount single panes against an in-memory fake backend with a red FAKE DATA banner. They are built only with `REBULL_DEV_PAGES=1`. The Rust crate keeps its original name `rebull_lib` and the Tauri identifier `app.rebull.desktop`, so data directories and vaults from earlier builds keep working.
