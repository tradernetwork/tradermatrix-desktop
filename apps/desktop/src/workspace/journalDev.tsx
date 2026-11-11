/**
 * Dev-only entry (journal-dev.html): mounts the Watchlist pane (with its write controls) and the Journal pane
 * against the FAKE api backend. No Tauri, no login, no network, no real watchlist, no real trade. Query params:
 *   ?empty=1   no trades and no notes (empty states); the watchlists are still there
 *   &fail=1    every watchlist write, P&L read and CSV export fails with a server-style error
 *   &many=1    120 trades (exercises "Load older trades": 5 pages of 10, then resume)
 *   &norhs=1   the selected account has no rhs_account_number (the P&L refusal)
 */
import '../styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { fake, fakeRh, isTauri, type RhAccount, type RhPnlTrade } from '../lib/api'
import { useRhStore } from '../stores/rh'
import { JournalPane } from './JournalPane'
import { WatchlistPane } from './WatchlistPane'

const q = new URLSearchParams(location.search)
const empty = q.get('empty') === '1'
const fail = q.get('fail') === '1'
const many = q.get('many') === '1'
const norhs = q.get('norhs') === '1'

const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: 'DEMO00001111', rhs_account_number: '900001111', rhc_account_number: null, agentic_allowed: false, option_level: '3',
  kind: 'margin', is_default: true, unsettled_funds: null, nickname: 'Main', brokerage_account_type: null, ...o,
})

const SYMS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'SPY', 'META', 'GOOG']
function trades(n: number): RhPnlTrade[] {
  const out: RhPnlTrade[] = []
  for (let i = 0; i < n; i++) {
    const sym = SYMS[i % SYMS.length]!
    const gain = i % 7 === 3 ? null : Math.round(((((i * 37) % 200) - 80) + ((i * 13) % 10) / 10) * 100) / 100
    const ts = new Date(Date.now() - (i * 0.55 + 0.1) * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z')
    out.push({ trade_key: `t_demo_${String(i).padStart(4, '0')}`, symbol: sym, side: i % 3 === 0 ? 'buy' : 'sell', quantity: 1 + (i % 9), price: 50 + ((i * 17) % 300) + 0.25, realized_gain: gain, timestamp: ts })
  }
  return out
}

if (!isTauri()) {
  fakeRh.accounts = [acct({ rhs_account_number: norhs ? null : '900001111' }), acct({ account_number: 'DEMO00002222', rhs_account_number: '900002222', is_default: false, nickname: 'Second' })]
  fakeRh.watchlists = [
    { id: 'wl-mine', display_name: 'Mine', icon_emoji: '\u{1F680}', item_count: 3, owner_type: 'custom', allowed_object_types: ['instrument'] },
    { id: 'wl-empty', display_name: 'Scratch', icon_emoji: null, item_count: 0, owner_type: 'custom', allowed_object_types: ['instrument'] },
    { id: 'wl-hot', display_name: 'Top Movers (curated)', icon_emoji: null, item_count: 2, owner_type: 'robinhood', allowed_object_types: ['instrument'] },
    { id: 'wl-opt', display_name: 'My Options', icon_emoji: null, item_count: 1, owner_type: 'custom', allowed_object_types: ['option_strategy'] },
  ]
  fakeRh.items = {
    'wl-mine': ['AAPL', 'MSFT', 'NVDA'].map((s, i) => ({ object_id: `o${i}`, object_type: 'instrument', symbol: s })),
    'wl-hot': ['TSLA', 'AMD'].map((s, i) => ({ object_id: `h${i}`, object_type: 'instrument', symbol: s })),
  }
  fakeRh.optionItems = [{ id: 'oi1', name: 'AAPL 250 call', option_ids: ['11111111-2222-4333-8444-555555555555'], chain_symbol: 'AAPL', expiration_date: '2026-12-18', strike_price: 250, contract_type: 'call' }]
  fakeRh.last = { AAPL: 231.4, MSFT: 418.2, NVDA: 141.9, TSLA: 320.5, AMD: 144.2 }
  fakeRh.pnlPage = 10
  const all = empty ? [] : trades(many ? 120 : 24)
  fakeRh.pnlTrades = { DEMO00001111: all, DEMO00002222: all.slice(0, 5) }
  if (fail) {
    fakeRh.failWrite = 'tool error: API error 400: {"detail":"synthetic failure for the fail=1 dev page"}'
    fakeRh.failPnl = 'tool error: API error 503: synthetic upstream outage (fail=1)'
  }
  if (!empty) {
    fake.journalAdd({ body: 'Took profit too early on the gap, the plan said hold to VWAP.', tags: ['plan', 'exit'], symbol: 'AAPL', trade_key: 't_demo_0001', account_masked: '••••1111' })
    fake.journalAdd({ body: 'Free-form: size down on Fridays.\nSecond line to show wrapping.', tags: ['rule'] })
  }
  void useRhStore.getState().connect()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'grid', gridTemplateColumns: 'minmax(300px, 380px) minmax(0, 1fr)' }}>
      <div style={{ minHeight: 0, borderRight: '1px solid var(--tm-border-hair)' }}>
        <WatchlistPane />
      </div>
      <div style={{ minHeight: 0 }}>
        <JournalPane />
      </div>
    </div>
  </StrictMode>,
)
