# TraderMatrix Desktop

**A native desk for options sellers: Robinhood as the broker, TraderMatrix positioning on the chart, an AI that explains the screen and never touches an order.**

TraderMatrix Desktop is a Linux-first Tauri app that puts your Robinhood account, live charts, option chains and TraderMatrix's positioning data (Apex levels, gamma flip, expected move) in one multi-panel workspace. It exists because premium sellers need to see where the dealers are leaning, how far the market is priced to move, and whether a strike sits outside that move, without alt-tabbing across five sites. Everything runs on your machine: keys sit in an encrypted local vault, candles and chat history sit in local SQLite, and the only network calls go to the services you connect.

Works with the Robinhood MCP. Not affiliated with or endorsed by Robinhood.

> **This app can place real orders with real money.** Read [Safety](#safety) before you connect an account.

---

## Feature tour

### Chart with TraderMatrix positioning overlays
KLineChart-based candles on 12 timeframes (1m to 1M). Toggle **Apex levels**, the **gamma flip** and **expected-move bands** on top of price. They are positioning maps, not price targets, and they never stretch the y-axis. Robinhood only serves fixed bar intervals, so 3m, 15m and 2h are aggregated client-side.

### Volume with estimated buy/sell
A volume pane that splits each bar into estimated buy and sell volume. "Estimated" is in the label on purpose: the split is derived from bar structure, not tape data.

### Option charts
Click a contract and the chart switches to that option's own price history.

### Desk overlay: fib, MA, ATR, FVG
A native overlay with per-timeframe parameters: key or full Fibonacci retracements off the higher-timeframe swing, SMA 20/50/200, a Wilder ATR band for an open position, and fair value gaps. Click cycles a layer, shift-click solos it.

### Strike check for premium sellers
Open an option ticket and get a verdict on the strike: distance to the expected move, nearest gamma wall, days to expiry, earnings inside the window. The output is a labelled read of the data (`protected`, and its siblings), not a trade recommendation.

### Level ladder
A right-gutter ladder that stacks every level on the chart (TraderMatrix levels, gamma flip, fibs, ATR, MAs) in price order, so you can read the map without hunting lines across the pane.

### One-click ticket fills
Positions get **Close**, **Mkt** and **Add**. Watchlist rows get **B** and **S**. Orders get **Cancel and edit**. Every one of them only fills the order ticket. None of them places anything. A fill expires after 30 seconds and never overwrites a ticket that is mid-review or mid-flight.

### Order ticket: review, then place
Equity and single-leg option orders go through a Rust-side review (`review_*`), then an explicit Place on that exact review. See [Safety](#safety) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). If Robinhood's trade approvals are on for your MCP account, Place returns an approval and nothing is submitted until you approve it in the Robinhood app. The ticket handles both states.

### Watchlists and TraderMatrix sync
Robinhood custom watchlists with add, remove, create. The **Sync** dialog diffs a TraderMatrix list against a Robinhood list, shows what can and cannot cross over (with reasons), and applies in either direction. Sync only adds. It never removes a symbol on either side, and a test fails if a remove call ever shows up.

### Journal
Realized P&L and trade history from Robinhood, with local notes attached per trade. Notes live in a local SQLite table and never leave the machine. CSV export neutralizes spreadsheet formula injection (cells starting with `=`, `+`, `-`, `@` get a leading quote).

### Arya, the explain-only chat
Arya reads a digest of what is on your screen (chart numbers, levels, your positions if you tick the box) and explains it in plain language. Use the **Ask about this** menus on a candle, level, ladder rung, position, strike or trade.

- **Grounded.** Every number in a reply is checked against the digest. A number that is not in your data gets a dotted underline.
- **Explain-only.** A linter flags prescriptive language, the pane carries no order vocabulary, and the chat has no tool access. Arya never places and never suggests an order.
- **Bring your own model:** OpenRouter, OpenAI, Venice, Ollama, LM Studio, any custom OpenAI-compatible endpoint, a self-hosted Hermes agent, and, as an opt-in advanced option, the Claude app already installed on your computer.
- Streaming, a token and cost meter with budgets, per-symbol threads, secret redaction on everything that leaves the box.

### Local-first
SQLite for layouts, settings, journal notes, chat threads and candles. Candles you load are stored locally and the toolbar shows the running count. Dockview panels you can rearrange; layouts autosave.

---

## Screenshot gallery

Images live in `docs/screenshots/`. Every shot here uses the built-in sample-data backend: no real account, no real prices, no real orders. See [docs/screenshots/README.md](docs/screenshots/README.md) for how each one is captured.

![Chart with TraderMatrix overlay and volume](docs/screenshots/hero-chart.png)
*Candles with Apex levels, gamma flip, expected-move band and estimated buy/sell volume.*

![Desk overlay with fib, MA and ATR](docs/screenshots/desk-overlay.png)
*Desk overlay layers on: key fibs, moving averages and an ATR band.*

![Right-gutter level ladder](docs/screenshots/ladder.png)
*Every level on the chart stacked in price order down the right edge.*

![Option ticket with strike check verdict](docs/screenshots/strike-check.png)
*Strike check on an option ticket: expected move, wall, days to expiry, earnings.*

![Positions with Close and Add and a filled ticket](docs/screenshots/ticket-fills.png)
*One click on Close or Add fills the ticket. Nothing is placed.*

![Explain pane with Arya and a grounding underline](docs/screenshots/explain-arya.png)
*Arya answers from your screen's data; a number not in the data is underlined.*

![Provider setup cards](docs/screenshots/provider-cards.png)
*Pick a model provider: hosted, local, self-hosted or an installed Claude.*

![Journal with P&L and notes](docs/screenshots/journal.png)
*Realized P&L, trade history and local notes.*

---

## Bring your own keys

There is no TraderMatrix Desktop server and no account with us. You bring three things, all optional except the first:

| What | How you give it | Used for |
|---|---|---|
| **Robinhood** | OAuth 2.1 login in your browser (PKCE, loopback redirect). You never type a Robinhood password into this app. | Accounts, quotes, bars, option chains, positions, orders, watchlists, P&L |
| **TraderMatrix API key** | Paste into the TM key panel (a `td_live_...` key from your TraderMatrix account) | Apex levels, gamma flip, expected move, IV rank, snapshot, watchlist sync |
| **An LLM key** (optional) | Paste into the provider card, or use a local model with no key at all | Arya |

### About the TraderMatrix key
Get a key at <https://www.tradermatrix.pro/settings?tab=developer>. TraderMatrix publishes these limits for its MCP: free accounts get a 25-call-per-day preview (lists cut to the first 3 items), Premium gets 200 tool calls per day, and every tier is capped at 12 tool calls per minute per account. A symbol switch costs about 4 calls and the Apex overlay refreshes on a timer, so a free or Premium day can go fast when you flip through many symbols. TraderMatrix returns a derived layer only (levels, flow scores, IV rank, gamma and Apex data). It never returns per-contract quotes or raw option chains, so quotes and chains in this app come from Robinhood. A quota-aware TraderMatrix client with rate limiting and a daily call meter is on the roadmap.

To point any other AI agent at the same TraderMatrix MCP, use the canonical skill: <https://www.tradermatrix.pro/skills/tradermatrix/SKILL.md>.

All of it lives in an encrypted local vault: a passphrase run through Argon2id, sealed with XChaCha20-Poly1305, one file in the app data directory, unlocked once per launch (the OS keychain is preferred when one exists). The webview never receives a stored secret; there is no command that returns one. Nothing is sent anywhere except the services above, and tokens and keys are scrubbed from error text and logs.

---

## Safety

- **Real orders are real money.** Place on a ticket sends a live order to your Robinhood account.
- **No order caps, by design.** There is no size limit, no kill switch and no arm step in this app. That is a decision, not an oversight. If you want a guardrail, the Robinhood side has one: see approvals below. A compromised machine or webview is a compromise of your ability to trade; treat the host accordingly.
- **The webview never builds a tool call.** It sends a validated order intent; Rust re-validates it strictly, calls the review tool, stores the review, and places only that exact review once. `unknown` outcomes are never auto-retried; an explicit retry re-sends the same reference id so Robinhood de-duplicates.
- **Approvals live in Robinhood.** The per-account trade-approval toggle is a Robinhood setting (off by default for MCP accounts). With it on, Place returns an approval and nothing is placed until you approve it in the Robinhood app. This app handles both states.
- **The AI never places or suggests orders.** Arya is explain-only and has no tools.
- **Not financial advice.** Overlays are positioning maps, not targets. Strike check is a labelled read of data. You own every order you place.
- **Not affiliated with or endorsed by Robinhood.** This app works with the Robinhood MCP. "Robinhood" is a trademark of Robinhood Markets, Inc.

Report vulnerabilities per [SECURITY.md](SECURITY.md).

---

## Install and run

**What is verified:** Linux, built with webkit2gtk-4.1 on Debian 12 and run on Debian 13. macOS and Windows are not built or tested. Treat them as unsupported.

Prerequisites (Linux):

- Rust stable (via rustup)
- Node 22 or newer and pnpm 10
- Tauri 2 system libraries: `libwebkit2gtk-4.1-dev`, `build-essential`, `libssl-dev`, `libxdo-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, `curl`, `file`
- Plenty of RAM for the Rust build. It is fine on 6 GB with `CARGO_BUILD_JOBS=2` if nothing else is hungry.

```bash
git clone https://github.com/tradernetwork/tradermatrix-desktop
cd tradermatrix-desktop

# tests (webview, script runtime, Rust core)
(cd packages/script && pnpm install && pnpm test)
(cd apps/desktop && pnpm install && pnpm test && pnpm exec tsc --noEmit)
(cd apps/desktop/src-tauri && cargo test)

# release binary (no installer bundle)
cd apps/desktop
pnpm exec tauri build --no-bundle    # first build takes minutes
./src-tauri/target/release/tradermatrix-desktop
```

First launch: create the vault passphrase, Connect Robinhood (browser login), optionally paste a TraderMatrix key, optionally set up a model provider for Arya.

Test counts at this commit: **1073** webview tests (vitest, 78 files), **232** script-runtime tests, **406** Rust tests, `cargo clippy --all-targets -- -D warnings` clean, `tsc --noEmit` clean. Every test runs against local mock servers. None touches Robinhood, TraderMatrix or any LLM provider.

`scripts/smoke-desktop.sh [binary]` launches the release binary and checks it stays up.

---

## Roadmap (planned, not built)

- **Alerts.** Price and level alerts you set on the chart.
- **Quota-aware TraderMatrix client.** Rate limiting, a daily call meter and longer cache lifetimes.
- **R-multiple tools.** Risk-in-R views for the journal and positions.
- **More LLM providers.** Additional hosted and local providers for Arya, plus first-class key handling for them.

Planned means planned. If it is not in the feature tour above, it does not exist yet.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md). Short version: test first, no network in tests, never place a real order from a test, and the chat stays explain-only. Bug reports use the template in `.github/ISSUE_TEMPLATE/`; never paste keys.

## License

MIT for the code: see [LICENSE](LICENSE). The TraderMatrix brand assets (marks, wordmark, Arya stills, background art) in `apps/desktop/src/assets/brand/` and the generated app icons are all rights reserved, are **not** MIT, and are covered by `apps/desktop/src/assets/brand/LICENSE-BRAND.txt`. Fork it? Swap them for your own. Third-party software and fonts are listed in [THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md) and [NOTICE](NOTICE) (KLineChart is Apache-2.0, bundled fonts are SIL OFL 1.1, a few Rust crates are MPL-2.0).
