import { EQUITY_SYMBOL } from './symbols'

/** Mirrors src-tauri/src/rh/watch_writes.rs (the Rust core is the authority; this only gives inline feedback and keeps the fake backend honest). */
export const WATCH_MAX_SYMBOLS = 50
export const WATCH_MAX_NAME = 50
export const WATCH_MAX_EMOJI_BYTES = 8
export const WATCH_MAX_DESC = 200
/** `^[A-Z][A-Z0-9.\-]{0,9}$` after trim + uppercase. */
export const WATCH_SYMBOL = EQUITY_SYMBOL

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export interface ParsedSymbols {
  symbols: string[]
  /** '' when valid. Empty input is not an error (nothing to submit yet) but yields no symbols. */
  error: string
}

/** Splits on commas and whitespace, trims, uppercases, de-duplicates (first wins). Same rules as `normalize_symbols`. */
export function parseWatchSymbols(input: string): ParsedSymbols {
  const raw = input.split(/[\s,]+/).filter((s) => s.length > 0)
  if (raw.length === 0) return { symbols: [], error: '' }
  if (raw.length > WATCH_MAX_SYMBOLS) return { symbols: [], error: `At most ${WATCH_MAX_SYMBOLS} symbols at a time.` }
  const out: string[] = []
  for (const r of raw) {
    const s = r.toUpperCase()
    if (!WATCH_SYMBOL.test(s)) return { symbols: [], error: `"${r.slice(0, 16)}" is not a stock symbol (A-Z, 0-9, . or -, max 10, starts with a letter).` }
    if (!out.includes(s)) out.push(s)
  }
  return { symbols: out, error: '' }
}

/** '' when valid, else the message. */
export function validateListName(name: string): string {
  const n = name.trim()
  if (n.length === 0 || [...n].length > WATCH_MAX_NAME || CONTROL.test(n)) return 'List name must be 1 to 50 printable characters.'
  return ''
}

export function validateEmoji(emoji: string): string {
  const e = emoji.trim()
  if (e === '') return ''
  if (new TextEncoder().encode(e).length > WATCH_MAX_EMOJI_BYTES || CONTROL.test(e)) return 'Use a single emoji.'
  return ''
}

export function validateDescription(d: string): string {
  const t = d.trim()
  if ([...t].length > WATCH_MAX_DESC || CONTROL.test(t)) return 'Description must be at most 200 printable characters.'
  return ''
}

/** Only lists the user created (owner_type custom) that are not the options list take symbol writes. */
export function watchlistWritable(w: { owner_type: string | null; allowed_object_types: string[] } | null | undefined): boolean {
  return !!w && w.owner_type === 'custom' && !w.allowed_object_types.includes('option_strategy')
}

export const OPTION_ID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/
