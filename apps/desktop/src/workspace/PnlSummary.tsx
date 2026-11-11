import type { RhRealizedPnl } from '../lib/api'
import { fmtPct } from '../lib/format'
import { bucketBars, fmtSignedMoney, pnlTone } from '../lib/journalUi'
import { useMask } from './useMask'

/** Window totals and one bar per P&L bucket (green up for a gain, red down for a loss). Every number can be missing. */
export function PnlSummary({ pnl, loading, error }: { pnl: RhRealizedPnl | null; loading: boolean; error: string }) {
  const mask = useMask()
  if (error && !pnl) return <div className="err pnl-state" role="alert">{mask(error)}</div>
  if (!pnl) return <div className="pane-empty">{loading ? 'Loading realized P&L...' : 'No P&L loaded.'}</div>
  const bars = bucketBars(pnl.data_points)
  const trades = pnl.data_points.reduce((a, p) => a + (p.number_of_trades ?? 0), 0)
  return (
    <div className="pnl">
      {error && <div className="err pnl-state" role="alert">{mask(error)}</div>}
      <div className="summary">
        <span>
          Realized <b className={pnlTone(pnl.total_returns)}>{fmtSignedMoney(pnl.total_returns)}</b>
        </span>
        <span>
          Return <b className={pnlTone(pnl.total_rate_of_return)}>{fmtPct(pnl.total_rate_of_return)}</b>
        </span>
        <span>
          Closed trades <b>{trades}</b>
        </span>
        {pnl.window && <span className="muted">{pnl.window}</span>}
      </div>
      {bars.length === 0 ? (
        <div className="pane-empty">No closed trades in this window.</div>
      ) : (
        <div className="bars" role="img" aria-label="Realized P&L by period">
          {bars.map((b) => (
            <div key={b.key} className="bar-col" title={b.title}>
              {b.height > 0 && <div className={`bar ${b.tone}`} style={{ height: `${b.height / 2}%` }} />}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
