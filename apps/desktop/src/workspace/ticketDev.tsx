/**
 * Dev-only entry (ticket-dev.html): mounts the order ticket and the Orders pane against the FAKE api backend.
 * No Tauri, no login, no network, no real order. Query params:
 *   ?approvals=on|off|unknown   approvals ON (place -> awaiting approval, default), OFF (place -> placed), or the server omits the flag
 *   &alert=1                    inject an order_checks alert (red box, "Place anyway")
 *   &fail=1                     the first place ends Unknown (retry with the same ref succeeds)
 *   &symbol=AAPL                prefilled symbol / underlying
 *   &agentic=0                  no agentic account (ticket disabled with the reason)
 *   &window=5                   with &fail=1: the unknown outcome stays retryable for only 5 s (watch Retry get disabled)
 *   &placed=rejected            with approvals=off: the placed order comes back in this state (rejected/failed/voided/cancelled shows the red card)
 *   &crash=1                    renders a component that throws inside an error boundary (message + Retry)
 *   &wipe=1                     adds a Disconnect button that runs the session wipe
 *   &opt=1                      M10: seeds option positions (long call, short put, one with no quote) in the Positions pane
 *   &strike=1                   M13: seeds the strike check: three short AAPL puts in Positions (protected, exposed, event risk), fake TM apex / expected move
 *                               and an earnings date; the option ticket's Sell + Open shows the same panel. Info only, never blocks Review
 * M10: the page also shows the Positions pane (seeded equity positions: long with held shares, short, fractional) and a
 * watchlist, so Close / Mkt / Add, row clicks, B / S and Cancel & edit can be tried. Every fill only sets ticket fields.
 */
import '../styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { normalizeSymbol } from '../chart/useChartData'
import { fake, fakePriceAt, fakeRh, fakeTm, isTauri, TM_KEY_SLOT, type ApexLevels, type ExpectedMove, type RhAccount, type RhOptionChain, type RhOptionPosition, type RhOptionRow } from '../lib/api'
import { useRhStore } from '../stores/rh'
import { disconnectSession } from '../stores/session'
import { ErrorBoundary } from './ErrorBoundary'
import { OrdersPane } from './OrdersPane'
import { OrderTicketPane } from './OrderTicketPane'
import { PositionsPane } from './PositionsPane'
import { WatchlistPane } from './WatchlistPane'

const q = new URLSearchParams(location.search)
const symbol = normalizeSymbol(q.get('symbol') ?? '') ?? 'AAPL'
const approvals = q.get('approvals')
const agentic = q.get('agentic') !== '0'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'DEMO00001111', rhs_account_number: null, rhc_account_number: null, agentic_allowed: false, option_level: '3',
  kind: 'margin', is_default: true, unsettled_funds: null, nickname: 'Main', brokerage_account_type: null, ...o,
})

/** Synthetic option chain: three Fridays, strikes around the fake price, plausible bids/asks and greeks. */
function fakeChain(sym: string): RhOptionChain {
  const base = Math.round(fakePriceAt(sym, Date.now()) / 5) * 5
  const exps: string[] = []
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + ((5 - d.getUTCDay() + 7) % 7 || 7))
  for (let i = 0; i < 3; i++) {
    exps.push(d.toISOString().slice(0, 10))
    d.setUTCDate(d.getUTCDate() + 7)
  }
  let n = 0
  const rows: RhOptionRow[] = []
  exps.forEach((exp, ei) => {
    for (let k = -4; k <= 4; k++) {
      for (const type of ['call', 'put'] as const) {
        n += 1
        const strike = base + k * 5
        const intrinsic = Math.max(0, type === 'call' ? base - strike : strike - base)
        const mid = Math.max(0.05, intrinsic + 3 + ei * 1.2 - Math.abs(k) * 0.4)
        const id = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
        rows.push({
          instrument: { id, chain_id: 'demo-chain', expiration_date: exp, strike_price: strike, option_type: type },
          quote: {
            instrument_id: id, bid: Math.round((mid - 0.05) * 100) / 100, ask: Math.round((mid + 0.05) * 100) / 100, mark: Math.round(mid * 100) / 100,
            delta: (type === 'call' ? 0.5 : -0.5) - k * 0.06 * (type === 'call' ? 1 : -1) * -1, gamma: 0.031, theta: -0.08, vega: 0.12, rho: 0.01,
            implied_volatility: 0.27 + ei * 0.01, open_interest: 400 + n * 7, volume: 20 + n,
          },
        })
      }
    }
  })
  return { chain: { id: 'demo-chain', symbol: sym, expiration_dates: exps, min_ticks: { above_tick: '0.05', below_tick: '0.01', cutoff_price: '3.00' } }, rows }
}

/** Synthetic option positions from the fake chain rows. `avg` is the per-share premium paid (or received); stored as signed dollars per contract. */
function fakeOptionPositions(chain: RhOptionChain): RhOptionPosition[] {
  const exps = chain.chain.expiration_dates
  const find = (ei: number, type: string, offset: number): RhOptionRow | undefined => {
    const rows = chain.rows.filter((r) => r.instrument.expiration_date === exps[ei] && r.instrument.option_type === type)
    const strikes = [...new Set(rows.map((r) => r.instrument.strike_price ?? 0))].sort((a, b) => a - b)
    const mid = Math.floor(strikes.length / 2) + offset
    return rows.find((r) => r.instrument.strike_price === strikes[mid])
  }
  const mk = (r: RhOptionRow | undefined, side: 'long' | 'short', quantity: number, avg: number, quoted: boolean): RhOptionPosition[] =>
    r
      ? [{
          option_id: r.instrument.id, chain_symbol: chain.chain.symbol, expiration_date: r.instrument.expiration_date, strike_price: r.instrument.strike_price,
          option_type: r.instrument.option_type, side, quantity, average_price: (side === 'short' ? -1 : 1) * Math.round(avg * 100 * 100) / 100, multiplier: 100,
          bid: quoted ? r.quote?.bid ?? null : null, ask: quoted ? r.quote?.ask ?? null : null, mark: quoted ? r.quote?.mark ?? null : null,
          delta: quoted ? r.quote?.delta ?? null : null, theta: quoted ? r.quote?.theta ?? null : null, iv: quoted ? r.quote?.implied_volatility ?? null : null,
          min_ticks: chain.chain.min_ticks ?? null, pending_buy: 0, pending_sell: 0,
        }]
      : []
  const a = find(0, 'call', 0)
  const b = find(0, 'put', -1)
  const c = find(1, 'call', 2)
  return [
    ...mk(a, 'long', 2, (a?.quote?.mark ?? 3) * 0.8, true),
    ...mk(b, 'short', 1, (b?.quote?.mark ?? 3) * 1.25, true),
    ...mk(c, 'long', 1, (c?.quote?.mark ?? 3) * 1.1, false),
  ]
}

const SEEDED = ['AAPL', 'MSFT', 'F', 'TSLA']

/**
 * M13 dev seed: three SHORT AAPL puts and fake TM / earnings data that make the strike check show each verdict.
 *  - e0 strike base-10: an Apex wall at base-7.5 in front, 2+ EM away, earnings after e0  -> protected
 *  - e0 strike base-5:  no wall between spot and the strike                                   -> exposed
 *  - e1 strike base-10: earnings land before e1                                              -> event
 * The fake TM serves apex / expected-move payloads rewritten for these expiries (EM 1.5% for both), never a real key.
 */
function seedStrikeCheck(chain: RhOptionChain, price: number): void {
  const [e0, e1] = chain.chain.expiration_dates
  if (!e0 || !e1) return
  const base = Math.round(price / 5) * 5
  const put = (exp: string, strike: number) => chain.rows.find((r) => r.instrument.expiration_date === exp && r.instrument.option_type === 'put' && r.instrument.strike_price === strike)
  const mk = (r: RhOptionRow | undefined): RhOptionPosition[] =>
    r
      ? [{
          option_id: r.instrument.id, chain_symbol: chain.chain.symbol, expiration_date: r.instrument.expiration_date, strike_price: r.instrument.strike_price, option_type: 'put',
          side: 'short', quantity: 1, average_price: -Math.round((r.quote?.mark ?? 2) * 125), multiplier: 100, bid: r.quote?.bid ?? null, ask: r.quote?.ask ?? null,
          mark: r.quote?.mark ?? null, delta: r.quote?.delta ?? null, theta: r.quote?.theta ?? null, iv: r.quote?.implied_volatility ?? null, min_ticks: chain.chain.min_ticks ?? null,
          pending_buy: 0, pending_sell: 0,
        }]
      : []
  fakeRh.optionPositions = { DEMO00005678: [...mk(put(e0, base - 10)), ...mk(put(e0, base - 5)), ...mk(put(e1, base - 10))] }
  const d = new Date(`${e0}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 3)
  fakeRh.earningsBySymbol = { AAPL: { next: { date: d.toISOString().slice(0, 10), timing: 'pm', verified: true }, last: null } }
  fake.secrets.add(TM_KEY_SLOT) // presence flag only: the fake backend never sees a key
  fakeTm.spotFor = (s) => fakePriceAt(s, Date.now())
  fakeTm.mutate = (tool, payload) => {
    if (tool === 'apex') {
      const a = payload as ApexLevels
      const lvl = (strike: number, rank: number) => ({ strike, score: 100 - rank * 10, rank, net_gex: 1e8, total_oi: 5000, is_above_spot: strike > price })
      return { ...a, spot: price, gamma_flip: base - 2.5, expirations_used: [e0, e1], levels: [lvl(base - 7.5, 1), lvl(base + 7.5, 2), lvl(base + 15, 3)] }
    }
    if (tool === 'move') {
      const m = payload as ExpectedMove
      const h = m.horizons[0]!
      const at = (label: string, through: string) => ({ ...h, label, through_date: through, expected_move_pct: 0.015, band68: { low: price * 0.985, high: price * 1.015 }, band95: { low: price * 0.97, high: price * 1.03 } })
      return { ...m, spot: price, horizons: [at('to e0', e0), at('to e1', e1)] }
    }
    return payload
  }
}

if (!isTauri()) {
  fakeRh.approvalsOn = approvals === 'off' ? false : approvals === 'unknown' ? null : true
  fakeRh.alert = q.get('alert') === '1'
  fakeRh.failPlace = q.get('fail') === '1' ? 1 : 0
  fakeRh.retryWindowSecs = Number(q.get('window')) > 0 ? Number(q.get('window')) : 600
  fakeRh.placedState = q.get('placed') ?? 'queued'
  fakeRh.accounts = [acct({}), ...(agentic ? [acct({ account_number: 'DEMO00005678', agentic_allowed: true, is_default: false, nickname: 'Agent', kind: 'limited_margin' })] : [])]
  fakeRh.portfolios = { DEMO00005678: { total_value: 5000, equity_value: 4000, options_value: 0, cash: 1000, buying_power: 2000, currency: 'USD' } }
  const px = (sym: string) => fakePriceAt(sym, Date.now())
  fakeRh.positions = {
    DEMO00005678: [
      // 40 held, 15 locked by an open sell: Close sells 25, selling 26+ is blocked on the ticket
      { symbol: 'AAPL', quantity: 40, average_buy_price: Math.round(px('AAPL') * 90) / 100, shares_available_for_sells: 25, shares_held_for_sells: 15 },
      // short stock: Close buys to cover
      { symbol: 'MSFT', quantity: -10, average_buy_price: Math.round(px('MSFT') * 105) / 100, shares_available_for_sells: 0, shares_held_for_sells: 0 },
      // fractional: Close falls back to a market order
      { symbol: 'F', quantity: 2.5, average_buy_price: 0.9, shares_available_for_sells: 2.5, shares_held_for_sells: 0 },
      { symbol: 'TSLA', quantity: 3, average_buy_price: Math.round(px('TSLA') * 110) / 100, shares_available_for_sells: 3, shares_held_for_sells: 0 },
    ],
  }
  fakeRh.watchlists = [{ id: 'wl-demo', display_name: 'Demo list', icon_emoji: null, item_count: 4, owner_type: 'custom', allowed_object_types: ['instrument'] }]
  fakeRh.items = { 'wl-demo': ['SPY', 'AAPL', 'MSFT', 'NVDA'].map((sym, i) => ({ object_id: String(i), object_type: 'instrument', symbol: sym })) }
  fakeRh.orders = {
    DEMO00005678: [
      { id: '00000000-0000-4000-8000-0000000000a1', asset: 'equity', symbol: 'MSFT', side: 'buy', order_type: 'limit', state: 'queued', trigger: 'immediate', quantity: 2, price: 300, stop_price: null, average_price: null, dollar_based_amount: null, time_in_force: 'gtc', created_at: new Date().toISOString(), reject_reason: null, legs: [] },
      { id: '00000000-0000-4000-8000-0000000000a3', asset: 'equity', symbol: 'NVDA', side: 'sell', order_type: 'limit', state: 'confirmed', trigger: 'stop', quantity: 3, price: 118.5, stop_price: 120, average_price: null, dollar_based_amount: null, time_in_force: 'gtc', created_at: new Date().toISOString(), reject_reason: null, legs: [] },
      { id: '00000000-0000-4000-8000-0000000000a4', asset: 'equity', symbol: 'F', side: 'sell', order_type: 'market', state: 'queued', trigger: 'stop', quantity: 10, price: null, stop_price: 0.8421, average_price: null, dollar_based_amount: null, time_in_force: 'gfd', created_at: new Date().toISOString(), reject_reason: null, legs: [] },
      { id: '00000000-0000-4000-8000-0000000000a2', asset: 'equity', symbol: 'TSLA', side: 'sell', order_type: 'limit', state: 'filled', trigger: 'immediate', quantity: 1, price: 250, stop_price: null, average_price: 250.1, dollar_based_amount: null, time_in_force: 'gfd', created_at: new Date().toISOString(), reject_reason: null, legs: [] },
    ],
  }
  fakeRh.optionChains = Object.fromEntries([...new Set([symbol, 'AAPL', 'MSFT', 'SPY'])].map((s) => [s, fakeChain(s)]))
  if (q.get('opt') === '1' && fakeRh.optionChains.AAPL) fakeRh.optionPositions = { DEMO00005678: fakeOptionPositions(fakeRh.optionChains.AAPL) }
  if (q.get('strike') === '1' && fakeRh.optionChains.AAPL) seedStrikeCheck(fakeRh.optionChains.AAPL, px('AAPL'))
  const wobble = () => {
    for (const s of new Set([symbol, 'SPY', 'AAPL', 'MSFT', 'NVDA', ...SEEDED])) {
      const last = fakePriceAt(s, Date.now()) * (1 + 0.004 * Math.sin(Date.now() / 4000))
      fakeRh.last[s] = last
      fakeRh.touch[s] = { bid: Math.round((last - 0.03) * 100) / 100, ask: Math.round((last + 0.03) * 100) / 100 }
    }
  }
  wobble()
  setInterval(wobble, 2000)
  useRhStore.setState({ chartSymbol: symbol })
  void useRhStore.getState().connect()
}

function Boom(): never {
  throw new Error('dev page: forced render crash')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) minmax(0, 1fr) minmax(220px, 280px)' }}>
      <div style={{ minHeight: 0, borderRight: '1px solid var(--tm-border-hair)' }}>
        <OrderTicketPane />
      </div>
      <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {q.get('wipe') === '1' && (
          <div style={{ padding: 6 }}>
            <button onClick={() => void disconnectSession()}>Disconnect (wipe session)</button>
          </div>
        )}
        {q.get('crash') === '1' && (
          <ErrorBoundary label="Dev crash test">
            <Boom />
          </ErrorBoundary>
        )}
        <div style={{ minHeight: 0, flex: 1, overflow: 'auto', borderBottom: '1px solid var(--tm-border-hair)' }}>
          <PositionsPane />
        </div>
        <div style={{ minHeight: 0, flex: 1, overflow: 'auto' }}>
          <OrdersPane />
        </div>
      </div>
      <div style={{ minHeight: 0, overflow: 'auto', borderLeft: '1px solid var(--tm-border-hair)' }}>
        <WatchlistPane />
      </div>
    </div>
  </StrictMode>,
)
