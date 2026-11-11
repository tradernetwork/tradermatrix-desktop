/**
 * Arya lens cards, webview side (M20b). EXPLAIN ONLY. The cards themselves are compiled into the Rust binary (`src-tauri/lenses/*.md`);
 * the webview knows only their ids, names and versions (a test compares them with `llm/lenses.rs`) and sends IDS, never text. At most two
 * ride on a question: either the user's chips, or the "auto" rules below, which read the digest sections and the question's own words.
 * Pure: no store, no network.
 */
export const LENS_IDS = ['options', 'sizing', 'posture', 'chart'] as const
export type LensId = (typeof LENS_IDS)[number]
export const MAX_LENSES = 2

export interface LensInfo {
  id: LensId
  name: string
  version: number
  /** One line for the chip's tooltip. */
  blurb: string
}
/** Mirrors `LENSES` in src-tauri/src/llm/lenses.rs (ids, names, versions). */
export const LENSES: readonly LensInfo[] = [
  { id: 'options', name: 'Options seller', version: 1, blurb: 'Defines premium, delta, theta, IV rank and expected move, and how to read the strike check.' },
  { id: 'sizing', name: 'Sizing and R', version: 1, blurb: 'Defines R, expectancy, win rate, SQN and heat, and how to read your R stats.' },
  { id: 'posture', name: 'Market posture', version: 1, blurb: 'Defines breadth, regime and exposure, and says what a one-symbol digest cannot show.' },
  { id: 'chart', name: 'Chart reading', version: 1, blurb: 'Defines trend, levels, averages, ATR, Fibonacci and candles, and how to read the chart numbers.' },
]

export const isLensId = (v: unknown): v is LensId => typeof v === 'string' && (LENS_IDS as readonly string[]).includes(v)

/** Chip click: adds (up to two), or removes. A third pick is ignored. */
export function toggleLens(pick: readonly LensId[], id: LensId): LensId[] {
  if (pick.includes(id)) return pick.filter((p) => p !== id)
  return pick.length >= MAX_LENSES ? [...pick] : [...pick, id]
}

const OPTION_WORDS = /\b(strikes?|options?|puts?|calls?|delta|theta|premium|dte|iv|expir\w*|assign\w*|short|covered|cash-secured)\b/i
const SIZING_WORDS = /\b(r-multiples?|expectancy|sqn|heat|sizing|position size|risk per trade|1r)\b/i
const CHART_WORDS = /\b(candles?|trend|support|resistance|fib\w*|fvg|gaps?|moving averages?|atr|wicks?|volume)\b/i
const POSTURE_WORDS = /\b(market|breadth|regime|exposure|posture|s&p|spy|qqq|index)\b/i
const hasLine = (digest: string, key: string): boolean => new RegExp(`^${key}:`, 'm').test(digest)

/**
 * Which cards go with this question. `auto` follows the focus (the digest section the "Ask about this" item added) and the question's words:
 * a contract or an options question with a STRIKE line -> options; RSTATS or TRADE or R words -> sizing; CANDLE or LEVEL or chart words -> chart
 * reading; market words -> posture (no digest section carries market data). Fixed priority options, sizing, chart, posture; two at most; none when
 * nothing matches. Manual mode sends exactly the chips (two at most).
 */
export function selectLenses(auto: boolean, pick: readonly LensId[], c: { digest: string; question: string }): LensId[] {
  if (!auto) return pick.filter(isLensId).filter((id, i, a) => a.indexOf(id) === i).slice(0, MAX_LENSES)
  const { digest, question } = c
  const out: LensId[] = []
  if (hasLine(digest, 'CONTRACT') || (hasLine(digest, 'STRIKE') && OPTION_WORDS.test(question))) out.push('options')
  if (hasLine(digest, 'RSTATS') || hasLine(digest, 'TRADE') || SIZING_WORDS.test(question)) out.push('sizing')
  if (hasLine(digest, 'CANDLE') || hasLine(digest, 'LEVEL') || CHART_WORDS.test(question)) out.push('chart')
  if (POSTURE_WORDS.test(question)) out.push('posture')
  return out.slice(0, MAX_LENSES)
}

/** Names and versions for the "What I sent" drawer. */
export function lensSent(ids: readonly LensId[]): { id: LensId; name: string; version: number }[] {
  return ids.flatMap((id) => {
    const l = LENSES.find((x) => x.id === id)
    return l ? [{ id: l.id, name: l.name, version: l.version }] : []
  })
}

/** Dev page `?lenses=auto|options,sizing|none`. Anything unrecognised is auto. */
export function parseLensParam(raw: string | null | undefined): { auto: boolean; pick: LensId[] } {
  if (!raw || raw === 'auto') return { auto: true, pick: [] }
  if (raw === 'none') return { auto: false, pick: [] }
  const ids = raw.split(',').filter(isLensId).filter((id, i, a) => a.indexOf(id) === i).slice(0, MAX_LENSES)
  return ids.length ? { auto: false, pick: ids } : { auto: true, pick: [] }
}
