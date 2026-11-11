/**
 * Dev-only entry (risk-dev.html): the Journal (R column + editor), the R-stats panel and the Positions pane (heat + concentration)
 * against the FAKE api backend. No Tauri, no login, no network, no real trade. The FAKE DATA banner is always on. Query params:
 *   ?trades=many|few|none   many: 60 closed trades (about three quarters carry an R); few: 8 trades (5 with R, so SQN shows "too few to rank");
 *                           none: no trades at all (empty states)
 *   &heat=1                 seeds open positions: AAPL 10 and MSFT 5 with a PLACED planned-risk draft each ($250 and $400 on $25,000 equity, so
 *                           $650 = 2.60%), NVDA 7 with none (listed as unknown risk, not counted), plus one option position
 *   &suggest=1              one closing trade (AMD sell 7, no R) that matches exactly one placed draft (AMD buy 7): the Journal shows "?" on it
 *                           and, when you open the trade, a "Confirm link" button. Nothing is linked until you click it
 *   &noequity=1             the portfolio has no value: "equity unavailable" and "-" instead of percentages
 * The R stats use Journal's span; click a trade row in the Journal to see the R editor ("Save R" is flagged "set after the fact").
 */
import '../styles/app.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { fakeRh, fakeRisk, isTauri, type RhAccount, type RhOptionPosition, type RhPnlTrade } from '../lib/api'
import { useRhStore } from '../stores/rh'
import { FakeBanner } from './FakeBanner'
import { JournalPane } from './JournalPane'
import { PositionsPane } from './PositionsPane'
import { RStatsPane } from './RStatsPane'

const q = new URLSearchParams(location.search)
const mode = q.get('trades') === 'few' ? 'few' : q.get('trades') === 'none' ? 'none' : 'many'
const heat = q.get('heat') === '1'
const suggest = q.get('suggest') === '1'
const noEquity = q.get('noequity') === '1'

const ACCOUNT = 'DEMO00001111'
const MASK = '••••1111'
const acct = (o: Partial<RhAccount>): RhAccount => ({
  account_number: ACCOUNT, rhs_account_number: '900001111', rhc_account_number: null, agentic_allowed: true, option_level: '3',
  kind: 'margin', is_default: true, unsettled_funds: null, nickname: 'Main', brokerage_account_type: null, ...o,
})

const SYMS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'SPY', 'META', 'GOOG']

/** Deterministic closed trades: a mix of winners and losers, newest first. */
function makeTrades(n: number): RhPnlTrade[] {
  const out: RhPnlTrade[] = []
  for (let i = 0; i < n; i++) {
    const unit = [2.1, -1, -1, 1.4, -0.6, 3.2, -1, 0.5, -1.2, 1.8][i % 10]!
    const planned = 100 + (i % 5) * 50
    out.push({
      trade_key: `t_demo_${String(i).padStart(4, '0')}`, symbol: SYMS[i % SYMS.length]!, side: 'sell', quantity: 5 + (i % 6), price: 100 + i,
      realized_gain: Math.round(unit * planned * 100) / 100, timestamp: new Date(Date.now() - (i * 0.45 + 0.2) * 86_400_000).toISOString().replace(/\.\d+Z$/, 'Z'),
    })
  }
  return out
}

if (!isTauri()) {
  fakeRh.accounts = [acct({})]
  fakeRh.portfolios = { [ACCOUNT]: { total_value: noEquity ? null : 25000, equity_value: noEquity ? null : 20000, options_value: 1000, cash: 4000, buying_power: 8000, currency: 'USD' } }
  fakeRh.last = { AAPL: 231.4, MSFT: 418.2, NVDA: 141.9, TSLA: 320.5, AMD: 144.2, AMZN: 210, SPY: 600, META: 580, GOOG: 175 }
  fakeRh.touch = Object.fromEntries(Object.entries(fakeRh.last).map(([s, p]) => [s, { bid: p - 0.03, ask: p + 0.03 }]))
  fakeRh.pnlPage = 25
  let all = mode === 'none' ? [] : makeTrades(mode === 'few' ? 8 : 60)
  // R recorded for about three quarters of the trades (few: the first 5), half of them as if confirmed from a reviewed order
  all.forEach((t, i) => {
    const withR = mode === 'few' ? i < 5 : i % 4 !== 3
    if (!withR) return
    const planned = 100 + (i % 5) * 50
    const manual = i % 2 === 0
    if (manual) {
      fakeRisk.promote({ trade_key: t.trade_key, manual: { account_masked: MASK, symbol: t.symbol, instrument: 'equity', risk_basis: 'manual_dollars', planned_risk_usd: planned } })
    } else {
      const id = `bbbbbbbb-0000-4000-8000-${String(i).padStart(12, '0')}`
      fakeRisk.draftPut({ review_id: id, fields: { side: 'buy', account_masked: MASK, symbol: t.symbol, instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: planned, qty: t.quantity ?? 1, entry_price: 100, stop_price: 95 } })
      fakeRisk.draftPut({ review_id: id, order_id: `dev-order-${i}` })
      fakeRisk.promote({ trade_key: t.trade_key, review_id: id })
    }
  })
  if (suggest) {
    fakeRisk.draftPut({ review_id: 'cccccccc-0000-4000-8000-000000000001', fields: { side: 'buy', account_masked: MASK, symbol: 'AMD', instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: 70, qty: 7, entry_price: 144, stop_price: 134 } })
    fakeRisk.draftPut({ review_id: 'cccccccc-0000-4000-8000-000000000001', order_id: 'dev-order-amd' })
    all = [{ trade_key: 't_demo_suggest', symbol: 'AMD', side: 'sell', quantity: 7, price: 150, realized_gain: 49, timestamp: new Date(Date.now() + 3_600_000).toISOString().replace(/\.\d+Z$/, 'Z') }, ...all]
  }
  fakeRh.pnlTrades = { [ACCOUNT]: all }
  if (heat) {
    fakeRh.positions = {
      [ACCOUNT]: [
        { symbol: 'AAPL', quantity: 10, average_buy_price: 225, shares_available_for_sells: 10, shares_held_for_sells: 0 },
        { symbol: 'MSFT', quantity: 5, average_buy_price: 410, shares_available_for_sells: 5, shares_held_for_sells: 0 },
        { symbol: 'NVDA', quantity: 7, average_buy_price: 138, shares_available_for_sells: 7, shares_held_for_sells: 0 },
      ],
    }
    const opt: RhOptionPosition = {
      option_id: '00000000-0000-4000-8000-0000000000f1', chain_symbol: 'AAPL', expiration_date: '2026-12-18', strike_price: 220, option_type: 'put', side: 'short', quantity: 2, average_price: -250,
      multiplier: 100, bid: 2.4, ask: 2.5, mark: 2.45, delta: -0.25, theta: 0.1, iv: 0.3, min_ticks: null, pending_buy: 0, pending_sell: 0,
    }
    fakeRh.optionPositions = { [ACCOUNT]: [opt] }
    const place = (id: string, sym: string, qty: number, planned: number) => {
      fakeRisk.draftPut({ review_id: id, fields: { side: 'buy', account_masked: MASK, symbol: sym, instrument: 'equity', risk_basis: 'equity_stop', planned_risk_usd: planned, qty, entry_price: 100, stop_price: 90 } })
      fakeRisk.draftPut({ review_id: id, order_id: `dev-open-${sym}` })
    }
    place('dddddddd-0000-4000-8000-000000000001', 'AAPL', 10, 250)
    place('dddddddd-0000-4000-8000-000000000002', 'MSFT', 5, 400)
  }
  void useRhStore.getState().connect()
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <FakeBanner />
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(320px, 1fr)' }}>
        <div style={{ minHeight: 0, overflow: 'auto', borderRight: '1px solid var(--tm-border-hair)' }}>
          <JournalPane />
        </div>
        <div style={{ minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto', borderBottom: '1px solid var(--tm-border-hair)' }}>
            <RStatsPane />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <PositionsPane />
          </div>
        </div>
      </div>
    </div>
  </StrictMode>,
)
