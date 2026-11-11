/**
 * Glossary tooltips (M16 A7). A static dictionary; the pane marks the FIRST whole-word occurrence of each term in a reply and shows the
 * static definition on hover or focus. Definitions are fixed text written here: nothing from a model or a provider is ever shown as one.
 * Matching rules: a term is a whole word (letters, digits and underscore on either side block it); a hyphen counts as a boundary, so
 * `delta-neutral` marks `delta`; a space inside a multi-word term also accepts a hyphen (`gamma-flip`, `short-put`, `IV-rank`); terms that
 * start with an upper-case acronym (IV, OI, ATR, DTE, FVG) are case sensitive, the rest are not; the longest term wins over one inside it.
 */
export interface GlossaryEntry {
  term: string
  def: string
}

export const GLOSSARY: readonly GlossaryEntry[] = [
  { term: 'IV rank', def: 'Where implied volatility sits today against its own past year, from 0 (the lowest) to 100 (the highest). A high rank means options are priced rich compared with their own history.' },
  { term: 'IV', def: 'Implied volatility: how much movement the option market is pricing in, taken from option prices rather than from past moves.' },
  { term: 'implied volatility', def: 'How much movement the option market is pricing in, taken from option prices rather than from past moves.' },
  { term: 'expected move', def: 'A statistical range for where price may land by a given date, derived from option prices. It is a range of likelihood, not a forecast or a promise.' },
  { term: 'gamma flip', def: 'The price where dealer hedging is estimated to change character. Above it hedging tends to calm moves; below it hedging tends to amplify them. A positioning map, not a target.' },
  { term: 'gamma', def: 'How fast an option delta changes when the stock moves. High gamma means the option reacts sharply to small moves.' },
  { term: 'vega', def: 'How much an option price changes for a one point change in implied volatility.' },
  { term: 'Apex', def: 'A TraderMatrix level where option positioning is concentrated. Apex levels are maps of where activity clusters, not price targets.' },
  { term: 'FVG', def: 'Fair value gap: a price range that a fast move skipped through with little trading. Charts mark it as an area price sometimes revisits.' },
  { term: 'fair value gap', def: 'A price range that a fast move skipped through with little trading. Charts mark it as an area price sometimes revisits.' },
  { term: 'ATR', def: 'Average true range: the typical distance price travels in one bar, a measure of how big the swings are lately.' },
  { term: 'delta', def: 'How much an option price moves for a one dollar move in the stock. It is also a rough read on the odds the option finishes in the money.' },
  { term: 'DTE', def: 'Days to expiration: how many calendar days remain before the option expires.' },
  { term: 'theta', def: 'How much value an option loses each day from the passing of time alone, all else equal.' },
  { term: 'OI', def: 'Open interest: how many contracts of an option are currently open (not yet closed out).' },
  { term: 'open interest', def: 'How many contracts of an option are currently open (not yet closed out).' },
  { term: 'short put', def: 'An option position that sold a put: it collects the premium up front and takes on the obligation to buy shares at the strike if the put finishes in the money.' },
  { term: 'short call', def: 'An option position that sold a call: it collects the premium up front and takes on the obligation to deliver shares at the strike if the call finishes in the money.' },
]

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const caseSensitive = (term: string) => /^[A-Z]{2,}\b/.test(term)
const COMPILED = GLOSSARY.map((g) => ({ g, re: new RegExp(`(?<![A-Za-z0-9_])${g.term.split(' ').map(esc).join('[ -]')}(?![A-Za-z0-9_])`, caseSensitive(g.term) ? 'g' : 'gi') }))

export interface TermMatch {
  term: string
  def: string
  start: number
  end: number
}

/** Non-overlapping matches, longest first. `seen` (optional, mutated) holds terms already marked earlier in the reply: only first occurrences are returned. */
export function findTerms(text: string, seen: Set<string> = new Set()): TermMatch[] {
  const all: TermMatch[] = []
  for (const { g, re } of COMPILED) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) all.push({ term: g.term, def: g.def, start: m.index, end: m.index + m[0].length })
  }
  all.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const out: TermMatch[] = []
  let edge = 0
  for (const m of all) {
    if (m.start < edge) continue
    edge = m.end
    if (seen.has(m.term)) continue
    seen.add(m.term)
    out.push(m)
  }
  return out
}
