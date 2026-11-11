import { useMemo, useState } from 'react'
import type { RhPnlTrade } from '../lib/api'
import { fmtMoney } from '../lib/format'
import { BASES_FOR, BASIS_LABELS, validateRiskEdit, type RiskEditForm } from '../lib/riskUi'
import { isEquityTicker } from '../lib/symbols'
import { useRiskStore } from '../stores/risk'

const text = (n: number | null | undefined): string => (typeof n === 'number' && Number.isFinite(n) ? String(n) : '')

/**
 * Planned risk (R) for one closed trade (M18). INFORMATIONAL ONLY: it records a number next to the trade in your local journal. Anything
 * set here is flagged "set after the fact". A suggested match from a reviewed order is only ever a button: nothing links until you click it.
 */
export function TradeRiskEditor({ trade, accountMasked }: { trade: RhPnlTrade; accountMasked: string | null }) {
  const row = useRiskStore((s) => s.risk[trade.trade_key])
  const suggestion = useRiskStore((s) => s.stats?.suggestions.find((x) => x.trade_key === trade.trade_key))
  const draft = useRiskStore((s) => (suggestion ? s.drafts.find((d) => d.review_id === suggestion.review_id) : undefined))
  const error = useRiskStore((s) => s.error)
  const [dismissed, setDismissed] = useState(false)
  const startInstrument = row?.instrument ?? (isEquityTicker(trade.symbol) ? 'equity' : 'option')
  const [form, setForm] = useState<RiskEditForm>(() => ({
    planned: text(row?.planned_risk_usd),
    basis: row?.risk_basis ?? 'manual_dollars',
    instrument: startInstrument,
    stop: text(row?.stop_price),
    entry: text(row?.entry_price),
    qty: text(row?.qty ?? trade.quantity),
    note: row?.note ?? '',
  }))
  const [localError, setLocalError] = useState('')
  const [saved, setSaved] = useState(false)
  const bases = useMemo(() => BASES_FOR[form.instrument] ?? [], [form.instrument])
  const set = (patch: Partial<RiskEditForm>) => {
    setSaved(false)
    setForm((f) => ({ ...f, ...patch }))
  }

  const save = async () => {
    const v = validateRiskEdit(form, trade, accountMasked)
    if ('error' in v) {
      setLocalError(v.error)
      return
    }
    setLocalError('')
    setSaved(await useRiskStore.getState().saveManual(trade.trade_key, v.manual))
  }

  return (
    <div className="risk-editor" data-testid="risk-editor">
      {suggestion && !dismissed && !row && (
        <div className="risk-suggest" data-testid="risk-suggest">
          <span>
            Possible match for a reviewed order{draft ? `: ${draft.symbol} ${draft.side} ${draft.qty ?? '?'}, planned risk ${fmtMoney(draft.planned_risk_usd)}` : ''}. Nothing is linked until you confirm.
          </span>
          <button type="button" onClick={() => void useRiskStore.getState().confirmSuggestion(trade.trade_key, suggestion.review_id)}>
            Confirm link
          </button>
          <button type="button" onClick={() => setDismissed(true)}>
            Not this trade
          </button>
        </div>
      )}
      <div className="risk-head">
        <b>R-multiple</b>
        {row ? (
          <span className="muted small">
            {`planned ${fmtMoney(row.planned_risk_usd)}`}
            {row.after_the_fact ? ' (set after the fact)' : ' (from the reviewed order)'}
          </span>
        ) : (
          <span className="muted small">no R recorded for this trade</span>
        )}
      </div>
      <div className="risk-form">
        <label>
          Planned risk ($)
          <input aria-label="Planned risk in dollars" inputMode="decimal" value={form.planned} onChange={(e) => set({ planned: e.target.value })} />
        </label>
        <label>
          Instrument
          <select
            aria-label="Instrument"
            value={form.instrument}
            onChange={(e) => {
              const inst = e.target.value
              set({ instrument: inst, basis: (BASES_FOR[inst] ?? []).includes(form.basis) ? form.basis : 'manual_dollars' })
            }}
          >
            <option value="equity">Stock</option>
            <option value="option">Option</option>
          </select>
        </label>
        <label>
          Basis
          <select aria-label="Risk basis" value={form.basis} onChange={(e) => set({ basis: e.target.value })}>
            {bases.map((b) => (
              <option key={b} value={b}>
                {BASIS_LABELS[b] ?? b}
              </option>
            ))}
          </select>
        </label>
        <label>
          Stop (optional)
          <input aria-label="Stop price recorded" inputMode="decimal" value={form.stop} onChange={(e) => set({ stop: e.target.value })} />
        </label>
        <label>
          Entry (optional)
          <input aria-label="Entry price recorded" inputMode="decimal" value={form.entry} onChange={(e) => set({ entry: e.target.value })} />
        </label>
        <label>
          Quantity (optional)
          <input aria-label="Quantity recorded" inputMode="decimal" value={form.qty} onChange={(e) => set({ qty: e.target.value })} />
        </label>
        <label className="wide">
          Note (optional, one line)
          <input aria-label="Risk note" value={form.note} onChange={(e) => set({ note: e.target.value })} />
        </label>
      </div>
      <div className="row">
        <button type="button" onClick={() => void save()}>
          {row ? 'Update R' : 'Save R'}
        </button>
        <span className="muted small">Saved on this computer only, flagged as set after the fact.</span>
        {saved && <span className="muted small">Saved.</span>}
      </div>
      {(localError || error) && <div className="err">{localError || error}</div>}
    </div>
  )
}
