import { useEffect, useMemo } from 'react'
import { PNL_SPANS } from '../lib/api'
import { fmtPct } from '../lib/format'
import { SPAN_LABELS } from '../lib/journalUi'
import { approximateRs, curvePoints, fmtR, histogramBars, statsView } from '../lib/riskUi'
import { useJournalStore } from '../stores/journal'
import { connectState, useRhStore } from '../stores/rh'
import { useRiskStore } from '../stores/risk'
import { EmptyState } from './EmptyState'

const W = 320
const H = 90

/**
 * R-multiple statistics (M18). INFORMATIONAL ONLY: expectancy, win rate, SQN, a histogram and an equity curve in R, computed from trades that
 * have a recorded planned risk. Trades without one are left out ("N of M trades have R"); nothing here is a rule, a limit or a target.
 */
export function RStatsPane() {
  const { status, connecting, connectError, account } = useRhStore()
  const connected = connectState({ status, connecting, connectError }) === 'connected'
  const { span, trades, pnlLoading, pnlError } = useJournalStore()
  const stats = useRiskStore((s) => s.stats)
  const settings = useRiskStore((s) => s.settings)
  const error = useRiskStore((s) => s.error)
  const approxOn = settings?.r_fallback_enabled === true

  useEffect(() => {
    void useRiskStore.getState().load()
  }, [])
  // The trade list is the Journal's: this pane asks for it when nobody has loaded it yet.
  useEffect(() => {
    if (connected && account && trades.length === 0 && !pnlLoading) void useJournalStore.getState().loadPnl()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected, account])

  const approx = useMemo(() => approximateRs(trades, new Set((stats?.rows ?? []).map((r) => r.trade_key))), [trades, stats])
  const view = useMemo(() => statsView(stats, approx.items, approxOn), [stats, approx, approxOn])
  const s = view.stats
  const bars = useMemo(() => histogramBars(s.histogram), [s])
  const pts = useMemo(() => curvePoints(s.n > 0 ? [0, ...s.curve] : [], W, H), [s])

  if (!connected) return <EmptyState>Connect Robinhood to load your closed trades. R-multiple statistics are computed from them.</EmptyState>

  return (
    <div className="pane rstats" data-testid="rstats">
      <div className="pane-head">
        <div className="seg" role="group" aria-label="Span">
          {PNL_SPANS.map((x) => (
            <button key={x} className={x === span ? 'on' : ''} aria-pressed={x === span} onClick={() => void useJournalStore.getState().setSpan(x)}>
              {SPAN_LABELS[x]}
            </button>
          ))}
        </div>
        <span className="muted small" data-testid="rstats-counter">{view.counter}</span>
        {pnlLoading && <span className="muted small">Loading...</span>}
        {(pnlError || error) && <span className="err">{pnlError || error}</span>}
      </div>

      {view.nWithR === 0 && !pnlLoading ? (
        <EmptyState>
          No trade in this window has a recorded R yet. Use the size helper on the ticket, or open a trade in the Journal and enter its planned risk.
        </EmptyState>
      ) : (
        <>
          <div className="summary" data-testid="rstats-summary">
            <span>Trades <b>{s.n}</b></span>
            <span>Expectancy <b>{fmtR(s.expectancy)}</b></span>
            <span>Win rate <b>{s.winRate === null ? '-' : fmtPct(s.winRate * 100).replace('+', '')}</b></span>
            <span>Avg win <b>{fmtR(s.avgWinR)}</b></span>
            <span>Avg loss <b>{fmtR(s.avgLossR)}</b></span>
            <span title="Mean R divided by its sample standard deviation, scaled by the square root of the trade count. Shown from 30 trades.">
              SQN <b data-testid="rstats-sqn">{view.sqn}</b>
            </span>
          </div>
          {view.sqnCaveat && (
            <div className="muted small pad" data-testid="rstats-caveat">
              SQN needs at least 30 trades with R to mean anything. With fewer it is not shown.
            </div>
          )}
          {view.missingRealized > 0 && <div className="muted small pad">{view.missingRealized} trade(s) with R have no realized gain yet and are left out.</div>}

          <div className="section-title">Distribution (0.5R bins)</div>
          <div className="hist" role="img" aria-label="Histogram of R-multiples" data-testid="rstats-hist">
            {bars.map((b) => (
              <div key={b.label} className="hist-col" title={`${b.label}: ${b.count}`}>
                <div className="hist-bar" style={{ height: `${b.height}%` }} />
              </div>
            ))}
          </div>
          <div className="hist-axis muted small">
            <span>&lt; -3R</span>
            <span>0</span>
            <span>&gt;= 5R</span>
          </div>

          <div className="section-title">Equity curve in R</div>
          {pts.length > 1 ? (
            <svg className="rcurve" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Cumulative R by close time" data-testid="rstats-curve" preserveAspectRatio="none">
              <polyline fill="none" stroke="var(--tm-gold)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" points={pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} />
            </svg>
          ) : (
            <div className="muted small pad">Needs at least one closed trade with R.</div>
          )}
          <div className="muted small pad">Cumulative R after {s.n} trade(s): <b>{fmtR(s.curve[s.curve.length - 1] ?? null)}</b></div>
        </>
      )}

      <div className="section-title">Approximation</div>
      <label className="small pad" title="Off by default. Trades without a recorded R are normally left out. This treats the average LOSING trade among them as 1R, which is a rough stand-in, not your recorded risk.">
        <input type="checkbox" checked={approxOn} onChange={(e) => void useRiskStore.getState().setApproximation(e.target.checked)} /> Approximation: treat my average loss on trades without R as 1R
      </label>
      {approxOn && (
        <div className="muted small pad" data-testid="rstats-approx">
          {approx.avgLossUsd === null
            ? 'No losing trade without a recorded R in this window, so nothing was approximated.'
            : `Approximated, not recorded R: ${view.approximated} trade(s) use 1R = $${approx.avgLossUsd.toFixed(2)} (their average loss). Numbers above include them.`}
        </div>
      )}
    </div>
  )
}
