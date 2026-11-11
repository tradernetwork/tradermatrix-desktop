## What changed

<!-- One or two sentences. -->

## What I ran

- [ ] `cd packages/script && pnpm test && pnpm typecheck`
- [ ] `cd apps/desktop && pnpm test && pnpm exec tsc --noEmit`
- [ ] `cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`

## Checklist

- [ ] Tests first; no existing assertion weakened
- [ ] No network in tests; nothing touches Robinhood, TraderMatrix or an LLM provider
- [ ] No real order placed, reviewed or cancelled from a test, script or agent
- [ ] The chat stays explain-only (no tools, no order vocabulary, nothing that builds or triggers an order)
- [ ] No secrets, real account numbers or identifying API responses committed
- [ ] No proprietary or unlicensed third-party assets or scripts added
