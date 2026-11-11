/** Deterministic follow-up chips (M16 A5): at most three, built from the on-screen state alone. No model text, no prescriptive verbs. */
import type { ExplainState } from './explainDigest'

export const DEFAULT_CHIPS: readonly string[] = ['Explain this chart', 'What do the Apex levels mean here?', 'What is the expected move saying?']
export interface Focus {
  /** A price the user pointed at (A5 takes it when given; the pane does not set it yet). */
  price?: number | null
}
const NEAR = 0.01

const fmt = (n: number) => String(Number(n.toFixed(2)))

export function chipsFor(state: ExplainState, focus?: Focus): string[] {
  const out: string[] = []
  if (state.strike?.verdict === 'exposed') out.push('Why exposed?')
  if (typeof state.ivRank === 'number' && Number.isFinite(state.ivRank)) out.push('Is IV rank high?')
  const ref = focus?.price ?? state.chart?.last ?? null
  const apex = state.levels?.apex ?? []
  if (typeof ref === 'number' && Number.isFinite(ref) && ref > 0 && apex.length) {
    let best: number | null = null
    for (const a of apex) if (Number.isFinite(a) && (best === null || Math.abs(a - ref) < Math.abs(best - ref))) best = a
    if (best !== null && Math.abs(best - ref) / ref <= NEAR) out.push(`What is the wall at ${fmt(best)}?`)
  }
  for (const d of DEFAULT_CHIPS) if (out.length < 3 && !out.includes(d)) out.push(d)
  return out.slice(0, 3)
}
