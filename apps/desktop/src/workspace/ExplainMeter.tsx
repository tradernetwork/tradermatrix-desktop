import { useState } from 'react'
import { budgetState, meterText } from '../lib/explainMeter'
import { useExplainStore } from '../stores/explain'

/**
 * Usage meter (M16 B2): "42k / 60k tokens, $0.03 this month", 'est' when the provider reported no usage, 'price unknown' when the model price is
 * unknown. The two budgets (tokens per session, dollars per month) are small settings; a used-up budget stops the next ask (nothing is sent).
 */
export function ExplainMeter() {
  const usage = useExplainStore((s) => s.usage)
  const [open, setOpen] = useState(false)
  const [tokens, setTokens] = useState('')
  const [usd, setUsd] = useState('')
  if (!usage) return null
  const state = budgetState(usage)
  return (
    <div className="explain-meter small">
      <button type="button" className={`explain-meter-text ${state}`} aria-expanded={open} onClick={() => setOpen((v) => !v)} title="Usage this session and this month. Click to change the budgets.">
        {meterText(usage)}
      </button>
      {state !== 'ok' && <span className={state === 'over' ? 'err' : 'muted'}> {state === 'over' ? 'budget used up' : 'near budget'}</span>}
      {open && (
        <form
          className="explain-budget"
          onSubmit={(e) => {
            e.preventDefault()
            const t = Number(tokens)
            const m = Number(usd)
            if (tokens.trim() !== '') void useExplainStore.getState().setBudget('session_tokens', t)
            if (usd.trim() !== '') void useExplainStore.getState().setBudget('month_usd', m)
            setTokens('')
            setUsd('')
          }}
        >
          <label>
            Tokens per session
            <input inputMode="numeric" aria-label="Tokens per session" placeholder={String(usage.session_cap)} value={tokens} onChange={(e) => setTokens(e.target.value)} />
          </label>
          <label>
            Dollars per month
            <input inputMode="decimal" aria-label="Dollars per month" placeholder={String(usage.month_cap)} value={usd} onChange={(e) => setUsd(e.target.value)} />
          </label>
          <button type="submit">Save</button>
          <span className="muted">Dollars are an estimate from the model price table; an unknown price is never counted as zero.</span>
        </form>
      )}
    </div>
  )
}
