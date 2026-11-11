/** By-reference alerts (M17 task 7): a level that lives in Apex / gamma flip / expected move / Fibonacci / ATR data is re-resolved on every tick. Pure. INFORM ONLY. */
import type { ApexLevels, ExpectedMove } from '../lib/api'
import type { Alert, AlertRefKind } from './types'

/** What is known about one symbol's levels right now. `null` for a part means "not loaded", which is never the same as "the level is gone". */
export interface LevelSnap {
  apex: ApexLevels | null
  move: ExpectedMove | null
  desk: { fib: { ratio: number; price: number }[]; atr: { sl: number; tp1: number; tp2: number; tp3: number } | null } | null
}

export type Resolved = { state: 'ok'; level: number } | { state: 'gone' } | { state: 'unknown' }

const REF_KINDS: readonly AlertRefKind[] = ['apex', 'flip', 'em_hi', 'em_lo', 'fib', 'atr']
const fin = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0
const OK = (level: number): Resolved => ({ state: 'ok', level })
const GONE: Resolved = { state: 'gone' }
const UNKNOWN: Resolved = { state: 'unknown' }

export const isRefAlert = (a: Pick<Alert, 'kind' | 'ref_kind'>): boolean => a.kind === 'price' && REF_KINDS.includes(a.ref_kind)

/**
 * `gone` only when the source for this symbol IS loaded and no longer has the level; a source that is not loaded (layer off, other symbol,
 * request failed) is `unknown` and the alert keeps using its frozen price.
 */
export function resolveRef(a: Pick<Alert, 'ref_kind' | 'ref_param'>, snap: LevelSnap | null): Resolved {
  if (!snap) return UNKNOWN
  const param = a.ref_param ?? ''
  switch (a.ref_kind) {
    case 'apex': {
      if (!snap.apex) return UNKNOWN
      const rank = Number(param.replace(/^rank:/, ''))
      const l = snap.apex.levels.find((x) => x.rank === rank)
      return l && fin(l.strike) ? OK(l.strike) : GONE
    }
    case 'flip': {
      if (!snap.apex) return UNKNOWN
      return fin(snap.apex.gamma_flip) ? OK(snap.apex.gamma_flip) : GONE
    }
    case 'em_hi':
    case 'em_lo': {
      if (!snap.move) return UNKNOWN
      const [horizon, band] = param.split('|')
      const h = snap.move.horizons.find((x) => x.label === horizon)
      const b = band === '95' ? h?.band95 : h?.band68
      const v = a.ref_kind === 'em_hi' ? b?.high : b?.low
      return fin(v) ? OK(v) : GONE
    }
    case 'fib': {
      if (!snap.desk) return UNKNOWN
      const f = snap.desk.fib.find((x) => x.ratio === Number(param))
      return f && fin(f.price) ? OK(f.price) : GONE
    }
    case 'atr': {
      const t = snap.desk?.atr
      if (!t) return UNKNOWN
      const v = t[param as 'sl' | 'tp1' | 'tp2' | 'tp3']
      return fin(v) ? OK(v) : UNKNOWN
    }
    default:
      return UNKNOWN
  }
}

/** The ladder row shape (kept structural here so alerts code does not depend on the chart folder). */
export interface LevelLike {
  price: number
  label: string
  source: 'tm' | 'fib' | 'atr' | 'fvg' | 'flip' | 'em'
  rank: number
}

/** A stable reference for a clicked level, or null when the level has no stable identity (FVG edges): the alert is then a plain price alert. */
export function refFromLevel(l: LevelLike, ctx: { move: ExpectedMove | null; horizon: string }): { ref_kind: AlertRefKind; ref_param: string | null } | null {
  switch (l.source) {
    case 'tm':
      return { ref_kind: 'apex', ref_param: `rank:${l.rank}` }
    case 'flip':
      return { ref_kind: 'flip', ref_param: null }
    case 'em': {
      const band = l.label.startsWith('EM95') ? '95' : '68'
      const h = ctx.move?.horizons.find((x) => x.label === ctx.horizon)
      const b = band === '95' ? h?.band95 : h?.band68
      if (!b) return null
      if (b.high === l.price) return { ref_kind: 'em_hi', ref_param: `${ctx.horizon}|${band}` }
      if (b.low === l.price) return { ref_kind: 'em_lo', ref_param: `${ctx.horizon}|${band}` }
      return null
    }
    case 'fib':
      return { ref_kind: 'fib', ref_param: String(l.rank) }
    case 'atr': {
      const t = l.label.split(' ')[0]!.toLowerCase()
      return ['sl', 'tp1', 'tp2', 'tp3'].includes(t) ? { ref_kind: 'atr', ref_param: t } : null
    }
    default:
      return null
  }
}

export function refText(a: Pick<Alert, 'ref_kind' | 'ref_param'>): string {
  switch (a.ref_kind) {
    case 'apex':
      return `APEX #${(a.ref_param ?? '').replace('rank:', '')}`
    case 'flip':
      return 'FLIP'
    case 'em_hi':
    case 'em_lo':
      return `EM${(a.ref_param ?? '').split('|')[1] ?? ''} ${a.ref_kind === 'em_hi' ? 'hi' : 'lo'}`
    case 'fib':
      return `FIB ${a.ref_param ?? ''}`
    case 'atr':
      return (a.ref_param ?? 'ATR').toUpperCase()
    default:
      return ''
  }
}
