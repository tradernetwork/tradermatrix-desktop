/**
 * Dev-only entry (chat-dev.html): the Explain pane against the FAKE api backend. NO model is called, no network, no real key
 * (type anything, for OpenRouter anything starting sk-or-). Replies are canned from the digest, so you can see exactly what the model would get.
 *   ?key=none|saved        provider state at load: none = nothing set up (first-run cards), saved = OpenRouter with a key (default saved)
 *   &provider=openai|ollama|hermes|...   with key=saved, start with that provider configured instead of OpenRouter (hermes + &setup=1 shows the Hermes card, its tool-less profile steps and the warning)
 *   &setup=1               open the provider cards on load ("Change provider")
 *   &detect=claude,ollama,lmstudio   pretend these are found on this computer (cards tagged and ordered first)
 *   &fail=401|unreachable|not_installed|429|timeout   every ask AND the Test button fail with that fixed code (bad_key / unreachable / not_installed / rate_limited / timeout)
 *   &slow=1                each ask takes 2.5 s (shows the busy state)
 *   &symbol=AAPL           chart symbol (the digest follows it)
 *   &reply=grounded|ungrounded|prescriptive|hostile|glossary   canned model reply per pipeline stage (default: plain canned reply built from the digest):
 *                          grounded = no flags; ungrounded = numbers not in the digest get a dotted underline; prescriptive = muted advice notice;
 *                          hostile = markdown + <script>/javascript: links rendered as inert text; glossary = hover terms
 *   &positions=1           seeds two fake positions so the "Include my positions" box has something to show
 *   &stream=1              the canned reply streams in small chunks, 120 ms apart (Stop, partial text, the pulsing busy state)
 *   &stall=1               with stream=1: only the first words arrive, then the stream goes silent until the idle watchdog (4 s here, 15 s in the app) ends it as a timeout with the partial kept
 *   &threads=1             seeds saved threads for AAPL (two) and MSFT (one) so the switcher, New thread, Delete and Export have something to show
 *   &usage=high            seeds the meter near the budgets (55k of 60k tokens, $1.90 of $2.00); the next question or two hits the "budget" stop
 *   &nousage=1             the fake provider reports no usage (the meter shows "est")
 *   &savehistory=0         starts with "Save chat history" off
 *   &focus=candle|level|ladder|position|strike|trade   pre-seeds the "Ask about this" state as if that menu item was chosen: the question box is prefilled and the focus note shows; nothing is sent (the digest below shows the fragment after you press Ask)
 *   &streaming=1           shows Arya's streaming ring state (a held in-flight answer)
 *   &flagged=1             shows Arya's "check numbers" state (an answer with a number that is not in the data)
 *   &bars=1                ticks "Include recent bars" and seeds 40 fake bars
 */
import '../styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { explainVariants } from '../lib/explainFake'
import { fake, fakeExplain, fakeLlm, fakeThreads, fakeTm, isTauri, TM_KEY_SLOT } from '../lib/api'
import { providerInfo } from '../lib/llmProviders'
import { useExplainStore } from '../stores/explain'
import { askAbout, confirmAskAbout } from '../stores/explainFocus'
import type { AskSpec } from '../lib/explainFocus'
import { useChartContext } from '../stores/chartContext'
import { useRhStore } from '../stores/rh'
import { normalizeSymbol } from '../chart/useChartData'
import { ExplainPane } from './ExplainPane'
import { FakeBanner } from './FakeBanner'

const q = new URLSearchParams(location.search)
const key = q.get('key') ?? 'saved'
const symbol = normalizeSymbol(q.get('symbol') ?? '') ?? 'AAPL'

if (!isTauri()) {
  const detect = (q.get('detect') ?? '').split(',')
  fakeLlm.detect = { claude_cli: detect.includes('claude'), ollama: detect.includes('ollama'), lmstudio: detect.includes('lmstudio') }
  if (key === 'saved') {
    const p = providerInfo(q.get('provider') ?? 'openrouter') ?? providerInfo('openrouter')!
    fakeLlm.set(p.id, p.id === 'custom' ? 'https://example.com/v1' : p.id === 'hermes' ? 'https://hermes.example.com' : null, p.takesKey ? (p.id === 'openrouter' ? 'sk-or-v1-TESTKEY' : 'sk-test-KEY') : null, p.id === 'custom' || p.id === 'lmstudio' ? 'my-model' : p.id === 'hermes' ? 'tm-explain' : null, null)
  }
  if (q.get('setup') === '1') useExplainStore.getState().openSetup(true)
  // TM data for the digest comes from the fake TM backend (real sample responses); it needs its own fake key
  fake.secrets.add(TM_KEY_SLOT)
  fakeTm.delayMs = 0
  const fail = q.get('fail')
  const codes: Record<string, string> = { '401': 'bad_key', '429': 'rate_limited', timeout: 'timeout', unreachable: 'unreachable', not_installed: 'not_installed' }
  if (fail && codes[fail]) fakeExplain.fail = codes[fail]!
  const reply = q.get('reply') ?? ''
  if ((explainVariants as readonly string[]).includes(reply)) fakeExplain.variant = reply
  fakeExplain.delayMs = q.get('slow') === '1' ? 2500 : 300
  if (q.get('stream') === '1') fakeExplain.chunkDelayMs = 120
  if (q.get('streaming') === '1') {
    // hold an answer mid-stream so the pulsing ring stays on screen (the idle watchdog here is 10 minutes)
    fakeExplain.stall = true
    fakeExplain.idleMs = 600_000
    fakeExplain.chunkDelayMs = 400
  }
  if (q.get('flagged') === '1') fakeExplain.variant = 'ungrounded'
  if (q.get('stall') === '1') {
    fakeExplain.stall = true
    fakeExplain.idleMs = 4000
    if (fakeExplain.chunkDelayMs === 0) fakeExplain.chunkDelayMs = 120
  }
  if (q.get('usage') === 'high') {
    fakeExplain.sessionTokens = 55_000
    fakeExplain.monthUsd = 1.9
    fakeExplain.monthTokens = 900_000
  }
  if (q.get('nousage') === '1') fakeExplain.reportsUsage = false
  if (q.get('savehistory') === '0') void fake.settingSet('chat.saveHistory', 'false')
  if (q.get('threads') === '1') {
    fakeThreads.seed('AAPL', [
      { role: 'user', text: 'What is the gamma flip telling me?' },
      { role: 'assistant', text: 'The gamma flip is the price where dealer hedging changes character. Above it, hedging tends to calm moves; below it, hedging can add to them. It is a positioning map, not a target.\n\nUsed: LEVELS' },
    ])
    fakeThreads.seed('AAPL', [
      { role: 'user', text: 'Explain this chart' },
      { role: 'assistant', text: 'Price is sitting in the middle of its recent range. It last traded at 87.38 with a high of 89.1 and a low of 85.25.\n\nUsed: CHART, RANGE' },
      { role: 'user', text: 'Is IV rank high?' },
      { role: 'assistant', text: 'IV rank is NA in this data, so I cannot say.\n\nUsed: IV' },
    ])
    fakeThreads.seed('MSFT', [
      { role: 'user', text: 'What does the expected move band mean?' },
      { role: 'assistant', text: 'It is a statistical range the options market implies, not a forecast.\n\nUsed: LEVELS' },
    ])
  }
  if (q.get('positions') === '1') {
    useRhStore.setState({
      positions: [{ symbol: 'AAPL', quantity: 10, average_buy_price: 150.25, shares_available_for_sells: 10, shares_held_for_sells: 0 }],
      optionPositions: [
        { option_id: 'x', chain_symbol: 'AAPL', expiration_date: '2026-12-18', strike_price: 95, option_type: 'put', side: 'short', quantity: 1, average_price: -210, multiplier: 100, bid: null, ask: null, mark: null, delta: null, theta: null, iv: null, min_ticks: null, pending_buy: null, pending_sell: null },
      ],
    })
  }
}
useRhStore.setState({ chartSymbol: symbol })
// the chart is not on this page: publish a small fixed context so the digest has chart numbers to show
useChartContext.setState({
  chart: { symbol, tf: '15m', bars: 834, last: 87.38, hi: 89.1, lo: 85.25, chg: 0.0123, estBuyShare: 0.41 },
  overlays: { fib: 'key', fvg: false, ma: [50, 200], atr: 'off' },
  fib: { up: true, r382: 86.1, r500: 85.9, r618: 85.4 },
  strike: { right: 'put', strike: 95, dte: 9, emUnits: 1.25, wall: 97, earningsInside: false, verdict: 'protected' },
})

// ?focus=...: as if the menu item had been chosen (the question box is prefilled, the focus note shows, NOTHING is sent)
const FOCUS_DEMO: Record<string, AskSpec> = {
  candle: { kind: 'candle', bar: { ts: Date.UTC(2026, 10, 11, 14, 30), open: 86.9, high: 88.1, low: 86.4, close: 87.38, volume: 18200 }, prevClose: 86.9 },
  level: { kind: 'level', price: 88.66, source: 'tm' },
  ladder: { kind: 'ladder', price: 85.81, source: 'flip' },
  position: { kind: 'position', position: { kind: 'equity', symbol, qty: 10, avg: 150.25, last: 87.38 } },
  strike: { kind: 'strike', right: 'put', strike: 95, dte: 9, delta: -0.18, mid: 1.35, iv: 0.42 },
  trade: { kind: 'trade', trade: { symbol, side: 'sell', qty: 1, price: 1.5, pnl: 12.5, timestamp: '2026-11-08T15:00:00Z' } },
}
const focusDemo = FOCUS_DEMO[q.get('focus') ?? '']
if (focusDemo) {
  askAbout(focusDemo, { x: 1, y: 1 })
  confirmAskAbout()
}
if (q.get('bars') === '1') {
  const t0 = Date.UTC(2026, 10, 11, 9, 30)
  useChartContext.setState({ recentBars: Array.from({ length: 40 }, (_, i) => ({ timestamp: t0 + i * 900_000, open: 86 + i * 0.05, high: 86.6 + i * 0.05, low: 85.7 + i * 0.05, close: 86.3 + i * 0.05, volume: 9000 + i * 100 })) })
  useExplainStore.getState().setIncludeBars(true)
}
// ?streaming=1 / ?flagged=1: ask one question on load so Arya's state is on screen (FAKE backend only; the product never auto-sends)
if (q.get('streaming') === '1' || q.get('flagged') === '1') {
  setTimeout(() => void useExplainStore.getState().ask('Explain this chart'), 700)
}

function DigestPeek() {
  return (
    <details style={{ padding: 8 }}>
      <summary className="muted small">Calls sent to the fake backend (digest per call)</summary>
      <pre className="small" id="calls" style={{ whiteSpace: 'pre-wrap' }} />
    </details>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <FakeBanner />
      <div className="toolbar">
        <span className="title">CHAT DEV</span>
        <span className="muted">fake backend, canned replies built from the digest, no model is called</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, maxWidth: 420 }}>
        <ExplainPane />
      </div>
      <DigestPeek />
    </div>
  </StrictMode>,
)
// show the last digest sent, for the visual check
setInterval(() => {
  const el = document.getElementById('calls')
  if (el) el.textContent = fakeExplain.calls.map((c, i) => `#${i + 1} model=${c.model} history=${c.history.length}\n${c.digest}`).join('\n\n')
}, 500)
