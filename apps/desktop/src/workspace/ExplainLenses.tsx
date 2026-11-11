import { LENSES } from '../lib/explainLenses'
import { useExplainStore } from '../stores/explain'

/**
 * Lenses (M20b): up to two reference cards ride on the next question. "Auto" (default) picks from what you pointed at and what you asked;
 * choosing a chip switches Auto off and sends exactly the chips. The card text lives in the app, not here: this control only names ids.
 */
export function ExplainLenses() {
  const auto = useExplainStore((s) => s.lensAuto)
  const pick = useExplainStore((s) => s.lensPick)
  const busy = useExplainStore((s) => s.busy)
  return (
    <div className="explain-lenses small" role="group" aria-label="Lenses">
      <span className="muted" title="Short reference cards that define terms and say how to read the numbers. Up to two go with a question.">
        Lenses
      </span>
      <button type="button" aria-pressed={auto} className={auto ? 'sel' : ''} disabled={busy} onClick={() => useExplainStore.getState().setLensAuto(!auto)} title="Pick cards from what you pointed at and what you asked">
        Auto
      </button>
      {LENSES.map((l) => {
        const on = !auto && pick.includes(l.id)
        return (
          <button key={l.id} type="button" aria-pressed={on} className={on ? 'sel' : ''} disabled={busy} onClick={() => useExplainStore.getState().toggleLens(l.id)} title={l.blurb}>
            {l.name}
          </button>
        )
      })}
    </div>
  )
}
