/** Desk overlay settings (setting key `tmdesk.overlay.v1`): parse with per-field fallback, serialise, solo, cycle and the ATR "auto" rule. */
import type { RhPosition } from '../../lib/api'
import type { Side } from './atr'
import { clampLookback } from './tfTable'

export const DESK_SETTING_KEY = 'tmdesk.overlay.v1'

export type FibMode = 'off' | 'key' | 'all'
export type AtrMode = 'off' | 'auto' | 'on'

export interface DeskSettings {
  fib: FibMode
  fvg: boolean
  sma: { p20: boolean; p50: boolean; p200: boolean }
  atr: AtrMode
  /** Tighter stop and take profits (Pine "Use Tighter Stop Loss and Take Profit"). */
  narrow: boolean
  /** Swing lookback in chart bars (5..500) or null for the per-timeframe default. */
  lookbackOverride: number | null
  /** Right-gutter level ladder (M13). Default off. */
  ladder: boolean
}

export const DEFAULT_DESK_SETTINGS: DeskSettings = {
  fib: 'key',
  fvg: false,
  sma: { p20: false, p50: true, p200: true },
  atr: 'auto',
  narrow: false,
  lookbackOverride: null,
  ladder: false,
}

const isRec = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)

/** Any garbage (not JSON, not an object, a version other than 1) gives the defaults; a bad single field falls back on its own. */
export function parseDeskSettings(raw: string | null | undefined): DeskSettings {
  const d = DEFAULT_DESK_SETTINGS
  if (typeof raw !== 'string' || raw === '') return { ...d, sma: { ...d.sma } }
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return { ...d, sma: { ...d.sma } }
  }
  if (!isRec(j) || j.v !== 1) return { ...d, sma: { ...d.sma } }
  const sma = isRec(j.sma) ? { p20: bool(j.sma.p20, d.sma.p20), p50: bool(j.sma.p50, d.sma.p50), p200: bool(j.sma.p200, d.sma.p200) } : { ...d.sma }
  return {
    fib: j.fib === 'off' || j.fib === 'key' || j.fib === 'all' ? j.fib : d.fib,
    fvg: bool(j.fvg, d.fvg),
    sma,
    atr: j.atr === 'off' || j.atr === 'auto' || j.atr === 'on' ? j.atr : d.atr,
    narrow: bool(j.narrow, d.narrow),
    lookbackOverride: typeof j.lookbackOverride === 'number' && Number.isFinite(j.lookbackOverride) ? clampLookback(j.lookbackOverride) : null,
    ladder: bool(j.ladder, d.ladder),
  }
}

export const serializeDeskSettings = (s: DeskSettings): string => JSON.stringify({ v: 1, ...s })

export type DeskLayer = 'fib' | 'fvg' | 'sma' | 'atr'

/** Shift-click: show only this layer. */
export function soloLayer(s: DeskSettings, layer: DeskLayer): DeskSettings {
  const none = { p20: false, p50: false, p200: false }
  const base: DeskSettings = { ...s, fib: 'off', fvg: false, sma: none, atr: 'off' }
  switch (layer) {
    case 'fib':
      return { ...base, fib: s.fib === 'off' ? 'key' : s.fib }
    case 'fvg':
      return { ...base, fvg: true }
    case 'sma':
      return { ...base, sma: { p20: true, p50: true, p200: true } }
    case 'atr':
      return { ...base, atr: 'on' }
  }
}

const anySma = (s: DeskSettings) => s.sma.p20 || s.sma.p50 || s.sma.p200

/** Plain click: fib off > key > all > off, FVG toggles, MA toggles between the default 50/200 pair and none, ATR off > auto > on > off. */
export function cycleLayer(s: DeskSettings, layer: DeskLayer): DeskSettings {
  switch (layer) {
    case 'fib':
      return { ...s, fib: s.fib === 'off' ? 'key' : s.fib === 'key' ? 'all' : 'off' }
    case 'fvg':
      return { ...s, fvg: !s.fvg }
    case 'sma':
      return { ...s, sma: anySma(s) ? { p20: false, p50: false, p200: false } : { ...DEFAULT_DESK_SETTINGS.sma } }
    case 'atr':
      return { ...s, atr: s.atr === 'off' ? 'auto' : s.atr === 'auto' ? 'on' : 'off' }
  }
}

/** True when at least one layer would draw something (ATR "auto" counts only through resolveAtr, so callers pass it in). */
export const anyLayer = (s: DeskSettings, atrShown: boolean): boolean => s.fib !== 'off' || s.fvg || anySma(s) || atrShown

/**
 * ATR levels follow the position: "auto" shows them only while the symbol has an open equity position and takes the side from the
 * sign of its quantity (the Pine's manual Long/Short input is gone); "on" always shows them (position side if any, else long).
 * Option positions are not considered (their side does not map to underlying direction).
 */
export function resolveAtr(mode: AtrMode, symbol: string, positions: readonly Pick<RhPosition, 'symbol' | 'quantity'>[]): { show: boolean; side: Side } {
  const p = positions.find((x) => x.symbol === symbol && typeof x.quantity === 'number' && Number.isFinite(x.quantity) && x.quantity !== 0)
  const side: Side = p && (p.quantity as number) < 0 ? 'short' : 'long'
  if (mode === 'off') return { show: false, side }
  if (mode === 'on') return { show: true, side }
  return { show: !!p, side }
}
