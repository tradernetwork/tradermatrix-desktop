import { useEffect, useMemo } from 'react'
import { helperView, type HelperInputs } from '../lib/riskHelper'
import { equityOf } from '../lib/riskUi'
import { useRhStore } from '../stores/rh'
import { useRiskStore } from '../stores/risk'

/**
 * Position-size helper (M18). INFORMATIONAL ONLY. It shows what a given risk would mean in shares or contracts; "Use" hands the quantity
 * text to `onUse`, which the host wires to its ordinary quantity field. The helper gets no ticket and no order state, and nothing it shows
 * is a rule: the order can be reviewed and sent with any quantity, with or without this panel.
 */
export interface RiskHelperProps {
  kind: 'equity' | 'option'
  /** Stock symbol, or the option's underlying. Numbers typed here belong to this symbol and are cleared when it changes. */
  symbol: string
  side: 'buy' | 'sell'
  /** Price from the form (limit price or the touch) used when no entry is typed. */
  entryHint: number | null
  /** Option limit price, the default credit. */
  creditHint: number | null
  /** Smallest step for a share quantity (1 whole, 0.001 fractional). */
  increment: number
  onUse: (quantityText: string) => void
}

const parsePct = (s: string): number | null => {
  const n = Number(s.trim())
  return s.trim() !== '' && Number.isFinite(n) && n > 0 && n <= 100 ? n : null
}

export function RiskHelper({ kind, symbol, side, entryHint, creditHint, increment, onUse }: RiskHelperProps) {
  const helper = useRiskStore((s) => s.helper)
  const settings = useRiskStore((s) => s.settings)
  const loaded = useRiskStore((s) => s.loaded)
  const note = useRiskStore((s) => s.note)
  const portfolio = useRhStore((s) => s.portfolio)
  const equity = equityOf(portfolio)
  const set = (patch: Partial<HelperInputs>) => useRiskStore.getState().setHelper({ ...patch, touched: true })

  useEffect(() => {
    if (!loaded) void useRiskStore.getState().load()
  }, [loaded])
  // The numbers belong to one symbol, side and kind: moving to another clears the stop and prices (see the store).
  useEffect(() => {
    useRiskStore.getState().setHelper({ kind, symbol: symbol.trim().toUpperCase(), side })
  }, [kind, symbol, side])

  const view = useMemo(
    () => helperView(helper, { equity, entryHint, creditHint, increment, defaultStopMult: settings?.default_option_stop_mult ?? 2 }),
    [helper, equity, entryHint, creditHint, increment, settings],
  )
  const active = helper.kind === kind && helper.symbol === symbol.trim().toUpperCase()
  const usd = helper.mode === 'usd'

  return (
    <details className="risk-helper" data-testid="risk-helper">
      <summary title="Informational only. Nothing here limits or changes your order.">Size helper</summary>
      <div className="risk-body">
        <div className="seg" role="group" aria-label="Risk basis">
          <button type="button" className={!usd ? 'active' : ''} onClick={() => void useRiskStore.getState().rememberHelper({ mode: 'pct' })}>
            % of equity
          </button>
          <button type="button" className={usd ? 'active' : ''} onClick={() => void useRiskStore.getState().rememberHelper({ mode: 'usd' })}>
            Flat $
          </button>
        </div>
        {usd ? (
          <label>
            Risk ($)
            <input aria-label="Risk in dollars" inputMode="decimal" value={helper.riskUsd} onChange={(e) => set({ riskUsd: e.target.value })} />
          </label>
        ) : (
          <label>
            Risk (% of equity)
            <input
              aria-label="Risk percent"
              inputMode="decimal"
              value={helper.riskPct}
              onChange={(e) => set({ riskPct: e.target.value })}
              onBlur={() => {
                const p = parsePct(helper.riskPct)
                if (p !== null && p !== settings?.default_risk_pct) void useRiskStore.getState().setRiskPct(p)
              }}
            />
          </label>
        )}
        {kind === 'equity' ? (
          <>
            <label>
              Entry
              <input aria-label="Sizing entry price" inputMode="decimal" placeholder={entryHint ? String(entryHint) : ''} value={helper.entry} onChange={(e) => set({ entry: e.target.value })} />
            </label>
            <label>
              Stop
              <input aria-label="Stop price" inputMode="decimal" value={helper.stop} onChange={(e) => set({ stop: e.target.value })} />
            </label>
          </>
        ) : (
          <>
            <label>
              Basis
              <select aria-label="Option risk basis" value={helper.basis} onChange={(e) => void useRiskStore.getState().rememberHelper({ basis: e.target.value as HelperInputs['basis'] })}>
                <option value="spread_max_loss">Credit spread: width minus credit</option>
                <option value="stop_mult">Short option: stop buyback minus credit</option>
              </select>
            </label>
            {helper.basis === 'spread_max_loss' && (
              <label>
                Spread width
                <input aria-label="Spread width" inputMode="decimal" value={helper.width} onChange={(e) => set({ width: e.target.value })} />
              </label>
            )}
            <label>
              Credit
              <input aria-label="Credit received" inputMode="decimal" placeholder={creditHint ? String(creditHint) : ''} value={helper.credit} onChange={(e) => set({ credit: e.target.value })} />
            </label>
            {helper.basis === 'stop_mult' && (
              <>
                <label>
                  Stop buyback
                  <input aria-label="Stop buyback price" inputMode="decimal" value={helper.stopBuyback} onChange={(e) => set({ stopBuyback: e.target.value })} />
                </label>
                <label>
                  Or stop at x credit
                  <input aria-label="Stop multiple" inputMode="decimal" placeholder={String(settings?.default_option_stop_mult ?? 2)} value={helper.stopMult} onChange={(e) => set({ stopMult: e.target.value })} />
                </label>
                <label>
                  Short strike (collateral)
                  <input aria-label="Short strike" inputMode="decimal" value={helper.strike} onChange={(e) => set({ strike: e.target.value })} />
                </label>
              </>
            )}
          </>
        )}
        {active && helper.touched && (
          <div className="risk-out" data-testid="risk-out">
            {view.error && <div className="muted small">{view.error}</div>}
            {view.message && <div className="muted small">{view.message}</div>}
            <table className="kv">
              <tbody>
                {view.rows.map((r) => (
                  <tr key={r.label}>
                    <td>{r.label}</td>
                    <td className="num">{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="row">
          <button type="button" disabled={view.useQty === null || !active} title="Copies this quantity into the quantity field. You still review and send the order yourself." onClick={() => view.useQty !== null && onUse(view.useQty)}>
            {view.useQty === null ? 'Use' : `Use ${view.useQty}`}
          </button>
          <span className="muted small">R is dollars you plan to lose on this trade.</span>
        </div>
        {note && <div className="muted small">{note}</div>}
      </div>
    </details>
  )
}
