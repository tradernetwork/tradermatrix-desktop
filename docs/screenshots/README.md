# Screenshots

The README gallery links to the files below. The eight dev-page shots are in the repository, captured from the built-in sample-data backend. `unlock` and `layout` only exist in the real app and are not captured yet, so they are not linked from the main README. Capture at a **1536x864** viewport, PNG, no browser chrome.

Dev pages render the real UI against a fake backend (a red FAKE DATA banner is visible, crop it or keep it). They are built only with `REBULL_DEV_PAGES=1`. To serve them:

```bash
cd apps/desktop
REBULL_DEV_PAGES=1 pnpm exec vite build
python3 -I -m http.server -b 127.0.0.1 -d dist 8081
# open http://127.0.0.1:8081/<page>
```

| File | Shows | Capture recipe |
|---|---|---|
| `hero-chart.png` | Chart with TM overlay and volume | `chart-dev.html?symbol=AAPL&tf=15m&tm=1&split=1&desk=0` |
| `desk-overlay.png` | Fib, MA and ATR layers on | `chart-dev.html?symbol=AAPL&tf=15m&desk=1&fib=key&atr=1&pos=long&tm=1` (add `&fvg=1` for gaps) |
| `ladder.png` | Right-gutter level ladder | `chart-dev.html?symbol=AAPL&tf=15m&desk=1&ladder=1&fib=all&atr=1&fvg=1&tm=1` |
| `strike-check.png` | Option ticket with the strike verdict | `ticket-dev.html?symbol=AAPL&opt=1&strike=1` |
| `ticket-fills.png` | Positions with Close/Add, ticket filled | `ticket-dev.html?symbol=AAPL&opt=1`, then click Close or Add on a position row |
| `explain-arya.png` | Explain pane, grounding underline | `chat-dev.html?symbol=AAPL&key=saved&reply=ungrounded&positions=1`, then press Ask |
| `provider-cards.png` | Provider setup cards | `chat-dev.html?key=none` (first-run cards) or `chat-dev.html?setup=1&detect=claude,ollama` |
| `journal.png` | Journal with P&L and notes | `journal-dev.html?many=1` |
| `alerts.png` | Chart with alert lines, bells and a toast | **Not captured yet.** `chart-dev.html?symbol=AAPL&tf=15m&tm=1`, right-click for an alert (no quote poller runs on the fake page) |
| `r-tools.png` | Ticket size helper, journal R column, R-stats panel and heat | **Not captured yet.** Needs a dev-page pass with the fake risk backend |
| `unlock.png` | Vault unlock screen | **Real app only**: launch the release binary with no vault, or lock an existing one |
| `layout.png` | Full three-column layout | **Real app only**: the default layout after connecting accounts (the fake pages mount single panes) |

Real app only: `unlock`, `layout`. Any shot taken in the real app must be redacted first: account numbers are already masked in the UI, but check symbols, balances and any visible keys before committing.
