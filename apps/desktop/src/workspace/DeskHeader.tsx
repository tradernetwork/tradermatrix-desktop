import { useEffect, useRef, useState } from 'react'
import { planChips, stripLine } from '../lib/layoutBudget'
import { useUiStore } from '../stores/ui'
import { useElWidth } from './useElWidth'
import { deskChips, deskMetrics, deskStatChips, fmtMetric, priceLine } from '../lib/deskUi'
import { fakeBannerVisible } from '../lib/fakeBanner'
import { pnlClass } from '../lib/format'
import { connectState, useRhStore } from '../stores/rh'
import { useDeskStatsStore } from '../stores/deskStats'
import { useOrdersStore } from '../stores/orders'
import { useTmStore } from '../stores/tm'
import { useVaultStore } from '../stores/vault'

const STAT_KEYS = ['atr', 'rangepos']

/**
 * Slim status header (M9): chart symbol with a big mono last price and bid/ask, status chips, and a strip of metric cards.
 * M22: ONE row that never wraps (status chips fall back to dots with tooltips, then a "..." popover) and a metrics strip that is a single
 * condensed line by default (setting `ui.metricsStrip` = line | cards; the toggle sits at the end of the strip).
 * Everything is read from stores the panes already fill (no extra Robinhood calls); unknown values print "-".
 */
export function DeskHeader() {
  const s = useRhStore()
  const approvalSetting = useOrdersStore((o) => o.approvalSetting)
  const approvals = useOrdersStore((o) => o.approvals)
  const approvalsAccount = useOrdersStore((o) => o.approvalsAccount)
  const tmStatus = useTmStore((t) => t.status)
  const tmQuota = useTmStore((t) => t.quota)
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
    quota: tmQuota,
    vault,
    fake: fakeBannerVisible(),
  })
  chips.push(...deskStatChips(deskStats, s.chartSymbol))
  const strip = useUiStore((u) => u.strip)
  useEffect(() => {
    void useUiStore.getState().load()
  }, [])
  const chipsRef = useRef<HTMLSpanElement>(null)
  const chipsW = useElWidth(chipsRef)
  const [more, setMore] = useState(false)
  const statuses = chips.filter((c) => !STAT_KEYS.includes(c.key))
  const stats = chips.filter((c) => STAT_KEYS.includes(c.key))
  const plan = planChips(chipsW > 0 ? chipsW : Number.POSITIVE_INFINITY, statuses.map((c) => c.text), stats.map((c) => c.text))
  const hiddenChips = [...statuses.slice(plan.visible), ...(plan.showStats ? [] : stats)]
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
        <span className="desk-chips" ref={chipsRef}>
          {(plan.mode === 'full' ? chips : [...statuses.slice(0, plan.visible), ...(plan.showStats ? stats : [])]).map((c) => {
            const dot = plan.mode === 'dots' && !STAT_KEYS.includes(c.key)
            const stat = plan.mode === 'dots' && STAT_KEYS.includes(c.key)
            return (
              <span
                key={c.key}
                className={`desk-chip ${c.tone}${dot ? ' dot' : ''}${stat ? ' stat' : ''}`}
                title={c.title ? `${c.text}: ${c.title}` : c.text}
                aria-label={c.text}
                data-testid={`chip-${c.key}`}
              >
                {dot ? '' : c.text}
              </span>
            )
          })}
          {plan.moreCount > 0 && (
            <span className="desk-more">
              <button className="desk-more-btn" aria-expanded={more} aria-label={`${plan.moreCount} more status items`} title="More status items" onClick={() => setMore((o) => !o)}>
                ...
              </button>
              {more && (
                <div className="desk-more-pop" role="menu" onMouseLeave={() => setMore(false)}>
                  {hiddenChips.map((c) => (
                    <div key={c.key} className={`desk-chip ${c.tone}`} title={c.title}>
                      {c.text}
                    </div>
                  ))}
                </div>
              )}
            </span>
          )}
        </span>
      </div>
      {strip === 'cards' ? (
        <div className="desk-strip" data-testid="desk-strip-cards">
          {cards.map((c) => (
            <div key={c.k} className="metric" title={c.title}>
              <span className="k">{c.k}</span>
              <span className={`v ${c.cls ?? ''}`}>{c.v}</span>
            </div>
          ))}
          <button className="strip-toggle" aria-label="Collapse the metrics to one line" title="Collapse the metrics to one line" onClick={() => void useUiStore.getState().setStrip('line')}>
            ▴
          </button>
        </div>
      ) : (
        <div className="desk-line" data-testid="desk-strip-line">
          {stripLine({
            equity: fmtMetric(m.equity, 'money'),
            buyingPower: fmtMetric(m.buyingPower, 'money'),
            cash: fmtMetric(m.cash, 'money'),
            pnl: fmtMetric(m.unrealized, 'money'),
            pnlCls: pnlClass(m.unrealized),
            orders: fmtMetric(m.openOrders, 'count'),
            approvals: fmtMetric(m.pendingApprovals, 'count'),
          }).map((x, i) => (
            <span key={x.k} className="line-item" title={cards.find((c) => c.k.toLowerCase().startsWith(x.k.toLowerCase().slice(0, 3)))?.title}>
              {i > 0 && <i className="sep">·</i>}
              <span className="k">{x.k}</span> <b className={`v ${x.cls ?? ''}`}>{x.v}</b>
            </span>
          ))}
          <button className="strip-toggle" aria-label="Expand the metric cards" title="Show the seven metric cards" onClick={() => void useUiStore.getState().setStrip('cards')}>
            ▾
          </button>
        </div>
      )}
    </div>
  )
}
