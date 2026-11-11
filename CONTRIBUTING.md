# Contributing

## Ground rules

1. **Test first.** Write the failing test, then the code. Pure logic goes in pure modules so it can be tested without a window.
2. **No network in tests.** Every test runs against local mock servers (loopback) or in-memory fakes. Nothing may contact Robinhood, TraderMatrix or an LLM provider. Fixtures are synthetic or scrubbed.
3. **Never place, review or cancel a real order from a test, script or agent.** Mock servers are built to fail the test if an unexpected write tool arrives. Keep that property.
4. **The chat is explain-only.** Arya has no tools, no order vocabulary in its pane, and a linter on its output. A change that gives the chat a way to build, suggest or trigger an order will not be merged.
5. **Never commit secrets.** No `.env*`, tokens, keys, real account numbers or real API responses with identifiers. Fake test keys look like `td_live_TESTKEY`, `sk-test-KEY`, `sk-or-TESTKEY`.
6. **Do not copy proprietary assets.** No Webull or Robinhood assets, no third-party indicator scripts without a clear compatible license.

## Layout

- `apps/desktop/` Tauri 2 app: Rust core in `src-tauri/`, React 19 webview in `src/`
- `packages/script/` zero-dependency runtime for the Webull-style indicator script dialect
- `docs/ARCHITECTURE.md` how the pieces fit

## Build and test (Linux)

Prerequisites are in the README. Then:

```bash
(cd packages/script && pnpm install && pnpm test && pnpm typecheck)
(cd apps/desktop && pnpm install && pnpm test && pnpm exec tsc --noEmit)
(cd apps/desktop/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings)
```

On a machine with about 6 GB RAM use `CARGO_BUILD_JOBS=2`, run vitest on one worker and do not build in parallel.

Dev pages (`apps/desktop/*-dev.html`) render panes against a fake backend with no Tauri. They are included in a build only when `REBULL_DEV_PAGES=1`; a plain `vite build` must contain none of them, and a test checks it.

## Pull requests

Keep them small and focused. Say what changed and what you ran. CI-equivalent: all three test commands above green, clippy clean. Add or update tests for any behavior change, and do not weaken an existing assertion to make a change pass.
