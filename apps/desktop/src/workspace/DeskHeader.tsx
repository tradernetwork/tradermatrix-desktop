import { deskChips, deskMetrics, deskStatChips, fmtMetric, priceLine } from '../lib/deskUi'
import { fakeBannerVisible } from '../lib/fakeBanner'
import { pnlClass } from '../lib/format'
import { connectState, useRhStore } from '../stores/rh'
import { useDeskStatsStore } from '../stores/deskStats'
import { useOrdersStore } from '../stores/orders'
import { useTmStore } from '../stores/tm'
import { useVaultStore } from '../stores/vault'

/**
 * Slim status header (M9): chart symbol with a big mono last price and bid/ask, status chips, and a strip of metric cards.
 * Everything is read from stores the panes already fill (no extra Robinhood calls); unknown values print "-".
 */
export function DeskHeader() {
  const s = useRhStore()
  const approvalSetting = useOrdersStore((o) => o.approvalSetting)
  const approvals = useOrdersStore((o) => o.approvals)
  const approvalsAccount = useOrdersStore((o) => o.approvalsAccount)
  const tmStatus = useTmStore((t) => t.status)
  const vault = useVaultStore((v) => v.status)
  const deskStats = useDeskStatsStore((d) => d.stats)
  const state = connectState(s)
  const connected = state === 'connected'
  const m = deskMetrics({
    connected,
    account: s.account,
    portfolio: s.portfolio,
    positions: s.positions,
    optionPositions: s.optionPositions,
    quotes: s.quotes,
    orders: s.orders,
    ordersError: s.ordersError,
    approvals,
    approvalsAccount,
  })
  const p = priceLine(connected ? s.quotes[s.chartSymbol] : undefined)
  const chips = deskChips({
    rh: state,
    account: s.account,
    approvalOn: s.account ? approvalSetting[s.account] : undefined,
    tm: tmStatus,
    vault,
    fake: fakeBannerVisible(),
  })
  chips.push(...deskStatChips(deskStats, s.chartSymbol))
  const part = m.unrealizedPartial ? ' (some positions have no price yet)' : ''
  const cards: Array<{ k: string; v: string; cls?: string; title?: string }> = [
    { k: 'Equity', v: fmtMetric(m.equity, 'money') },
    { k: 'Buying power', v: fmtMetric(m.buyingPower, 'money') },
    { k: 'Cash', v: fmtMetric(m.cash, 'money') },
    { k: 'Positions', v: fmtMetric(m.positionsCount, 'count') },
    { k: 'Unrealized P&L', v: fmtMetric(m.unrealized, 'money'), cls: pnlClass(m.unrealized), title: `Open positions, last price vs average cost${part}` },
    { k: 'Open orders', v: fmtMetric(m.openOrders, 'count'), title: 'Open (cancelable) orders in the loaded Orders list' },
    { k: 'Pending approvals', v: fmtMetric(m.pendingApprovals, 'count'), title: 'Read when the Orders pane has loaded approvals for this account' },
  ]

  return (
    <div className="desk-header" data-testid="desk-header">
      <div className="desk-top">
        <span className="desk-sym" data-testid="desk-symbol">{s.chartSymbol}</span>
        <span className={`desk-price ${p.cls}`} data-testid="desk-price">{p.last}</span>
        <span className={`desk-price-meta ${p.cls}`}>
          <b className={p.cls}>{p.change}</b>
          <b className={p.cls}>{p.changePct}</b>
        </span>
        <span className="desk-price-meta">
          <span>Bid <b>{p.bid}</b></span>
          <span>Ask <b>{p.ask}</b></span>
        </span>
        <span className="desk-chips">
          {chips.map((c) => (
            <span key={c.key} className={`desk-chip ${c.tone}`} title={c.title} data-testid={`chip-${c.key}`}>
              {c.text}
            </span>
          ))}
        </span>
      </div>
      <div className="desk-strip">
        {cards.map((c) => (
          <div key={c.k} className="metric" title={c.title}>
            <span className="k">{c.k}</span>
            <span className={`v ${c.cls ?? ''}`}>{c.v}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
