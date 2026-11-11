import { useEffect, useMemo } from 'react'
import { fmtMoney, maskAccount } from '../lib/format'
import { heatReadout } from '../lib/riskHeat'
import { concentration, equityOf, matchPositionRisk } from '../lib/riskUi'
import { optionLabel } from '../lib/optionPositions'
import { useRhStore } from '../stores/rh'
import { useRiskStore } from '../stores/risk'

const pctText = (p: number | null): string => (p === null ? '-' : `${p.toFixed(2)}%`)

/**
 * Heat and concentration (M18). READ-ONLY and INFORMATIONAL: heat is the sum of the planned risk recorded for open positions, and
 * concentration is each position's market value as a share of equity. There is no threshold, no target and no colour that implies a limit.
 * A position with no recorded risk is listed as unknown and never counted as zero.
 */
export function HeatPanel() {
  const account = useRhStore((s) => s.account)
  const portfolio = useRhStore((s) => s.portfolio)
  const positions = useRhStore((s) => s.positions)
  const optionPositions = useRhStore((s) => s.optionPositions)
  const quotes = useRhStore((s) => s.quotes)
  const drafts = useRiskStore((s) => s.drafts)
  const loaded = useRiskStore((s) => s.loaded)
  useEffect(() => {
    if (!loaded) void useRiskStore.getState().load()
  }, [loaded])

  const equity = equityOf(portfolio)
  const heat = useMemo(() => heatReadout(equity, matchPositionRisk(drafts, account ? maskAccount(account) : null, positions, optionPositions)), [equity, drafts, account, positions, optionPositions])
  const last = useMemo(() => Object.fromEntries(positions.map((p) => [p.symbol, quotes[p.symbol]?.last_trade_price ?? null])), [positions, quotes])
  const rows = useMemo(() => concentration(equity, positions, last, optionPositions), [equity, positions, last, optionPositions])
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const p of positions) m.set(`eq:${p.symbol}`, p.symbol)
    for (const o of optionPositions) m.set(`opt:${o.option_id}`, optionLabel(o))
    return m
  }, [positions, optionPositions])

  if (positions.length === 0 && optionPositions.length === 0) return null
  return (
    <div className="heat" data-testid="heat">
      <div className="section-title">Heat and concentration (informational)</div>
      <div className="summary" data-testid="heat-total">
        <span title="Sum of the planned risk recorded for open positions (R in dollars)">
          Planned R open <b>{fmtMoney(heat.totalUsd)}</b>
        </span>
        <span>
          % of equity <b>{pctText(heat.pctOfEquity)}</b>
        </span>
        {equity === null && <span className="muted">equity unavailable</span>}
        <span className="muted">{heat.counted} counted</span>
      </div>
      {heat.unknown.length > 0 && (
        <div className="muted small pad" data-testid="heat-unknown" title="No planned risk is recorded for these, so they are not counted (not counted as zero)">
          Unknown risk, not counted: {heat.unknown.map((id) => names.get(id) ?? id).join(', ')}
        </div>
      )}
      {rows.length > 0 && (
        <table className="grid" data-testid="concentration">
          <thead>
            <tr>
              <th>Position</th>
              <th className="num">Market value</th>
              <th className="num">% of equity</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                <td className="num">{fmtMoney(r.valueUsd)}</td>
                <td className="num">{pctText(r.pct)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
