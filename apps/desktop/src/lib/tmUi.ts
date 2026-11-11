/** Pure helpers for the TraderMatrix key panel, Insight pane and chart toggles. Units: see the fixtures README. */
import { fmtNum } from './format'
import type { TmBand, TmSnapshot, TmStatus } from './api'
import { fmtLevel } from '../chart/tmOverlay'

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

// ---- key ----

export const TM_KEY_PREFIX = 'td_live_'
export const TM_KEY_MIN_LEN = 20

/** Local check before anything is sent to the secret store. The message never contains the value. */
export function validateTmKey(raw: string): string | null {
  const k = raw.trim()
  if (!k) return 'Paste your TraderMatrix API key first.'
  if (/\s/.test(k)) return 'The key must not contain spaces.'
  if (!k.startsWith(TM_KEY_PREFIX)) return `TraderMatrix keys start with ${TM_KEY_PREFIX}.`
  if (k.length < TM_KEY_MIN_LEN) return `That key looks too short (expected at least ${TM_KEY_MIN_LEN} characters).`
  return null
}

// ---- formatters ----

/** ivRank is already 0-100: never multiplied by 100. */
export const fmtIvRank = (v: number | null | undefined): string => (fin(v) ? `${v.toFixed(1)} / 100` : '-')
/** expectedMovePct is a decimal fraction: 0.036 is 3.6%. */
export const fmtMovePct = (v: number | null | undefined): string => (fin(v) ? `${(v * 100).toFixed(1)}%` : '-')
/** held68Pct / held95Pct are decimals 0..1. */
export const fmtHeld = (v: number | null | undefined): string => (fin(v) ? `${Math.round(v * 100)}%` : '-')
/** Net gamma exposure in millions of dollars, signed. */
export function fmtGexM(n: number | null | undefined): string {
  if (!fin(n)) return '-'
  const m = Math.abs(n) / 1e6
  return `${n > 0 ? '+' : n < 0 ? '-' : ''}$${m.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`
}
export const gexTone = (n: number | null | undefined): 'bull' | 'bear' | '' => (!fin(n) || n === 0 ? '' : n > 0 ? 'bull' : 'bear')
/** atmIv / fromIv / toIv are decimals: 0.2443 is 24.4%. */
export const fmtIvPct = (v: number | null | undefined): string => (fin(v) ? `${(v * 100).toFixed(1)}%` : '-')
export const fmtBand = (b: TmBand | null | undefined): string => (b && fin(b.low) && fin(b.high) ? `${fmtLevel(b.low)}-${fmtLevel(b.high)}` : '-')
/** Bar width in percent, clamped to 0..100. */
export const pctBar = (v: number | null | undefined, outOf: number | null | undefined): number => {
  const d = fin(outOf) && outOf > 0 ? outOf : 1
  return fin(v) ? Math.min(100, Math.max(0, (v / d) * 100)) : 0
}
const human = (s: string | null | undefined): string => (s ? s.replace(/_/g, ' ') : '')

// ---- errors ----

export type TmErrorKind = 'key_missing' | 'locked' | 'rejected' | 'tier' | 'transport' | 'other'

export function classifyTmError(msg: string): TmErrorKind {
  const m = msg.toLowerCase()
  if (m.includes('key not set')) return 'key_missing'
  if (m.includes('vault locked')) return 'locked'
  if (m.includes('rejected the key')) return 'rejected'
  if (m.startsWith('transport error')) return 'transport'
  if (/\b(tier|plan|upgrade|limit|quota|subscription|forbidden|429)\b/.test(m)) return 'tier'
  if (/time ?out|timed out|connection|network|dns|unreachable|error sending request/.test(m)) return 'transport'
  return 'other'
}

const strip = (m: string) => m.replace(/^(tool error|transport error|protocol error|invalid input):\s*/i, '')

/** One distinct, plain message per failure kind. TraderMatrix's own tier or limit text is passed through. */
export function tmErrorText(msg: string): string {
  switch (classifyTmError(msg)) {
    case 'key_missing':
      return 'TraderMatrix key not set. Add it with the TM key button in the toolbar.'
    case 'locked':
      return 'The secret vault is locked. Unlock it to use TraderMatrix.'
    case 'rejected':
      return 'TraderMatrix rejected the key (invalid or revoked). Replace it with the TM key button in the toolbar.'
    case 'transport':
      return `Could not reach TraderMatrix (${strip(msg)}). Try Refresh.`
    case 'tier':
      return `TraderMatrix says: ${strip(msg)}`
    default:
      return msg
  }
}

export function tmPill(s: TmStatus | null): { text: string; cls: 'ok' | 'warn' | ''; title: string } {
  const err = s?.last_error ?? ''
  const kind = err ? classifyTmError(err) : null
  if (kind === 'locked') return { text: 'TM: vault locked', cls: 'warn', title: 'Unlock the vault to use TraderMatrix' }
  if (!s || !s.key_present) return { text: 'TM: not set', cls: '', title: 'No TraderMatrix API key stored' }
  if (kind === 'rejected') return { text: 'TM: rejected', cls: 'warn', title: err }
  return { text: 'TM: key saved', cls: 'ok', title: err || 'TraderMatrix API key stored (value hidden)' }
}

// ---- chart settings ----

export const TM_SETTING_KEY = 'chart.tm'
export interface TmSettings {
  apex: boolean
  flip: boolean
  move: boolean
  horizon: string
}
export const TM_DEFAULT_HORIZON = '1 week'
export const TM_DEFAULT_SETTINGS: TmSettings = { apex: false, flip: false, move: false, horizon: TM_DEFAULT_HORIZON }
export const TM_DEFAULT_HORIZONS = ['tomorrow', '1 week', '2 weeks', '1 month', '6 weeks']

/** Garbage in, defaults out; a bad field falls back on its own. */
export function parseTmSettings(raw: string | null | undefined): TmSettings {
  const d = { ...TM_DEFAULT_SETTINGS }
  if (!raw) return d
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return d
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return d
  const o = v as Record<string, unknown>
  for (const k of ['apex', 'flip', 'move'] as const) if (typeof o[k] === 'boolean') d[k] = o[k] as boolean
  if (typeof o.horizon === 'string' && o.horizon.length > 0 && o.horizon.length <= 32) d.horizon = o.horizon
  return d
}

// ---- snapshot cards (view model, tolerant of null legs) ----

export interface TmCard {
  key: 'quality' | 'gamma' | 'apex' | 'flow' | 'iv_rank' | 'market_health'
  title: string
  headline: string
  sub: string[]
  /** 0..100 when the card shows a bar. */
  bar?: number
}

const outOf = (n: number | null | undefined, d: number) => (fin(n) ? n : d)

export function snapshotCards(s: TmSnapshot | null): TmCard[] {
  if (!s) return []
  const gone = (key: TmCard['key'], title: string): TmCard => ({
    key,
    title,
    headline: 'unavailable',
    sub: [s.missing.includes(key) ? 'TraderMatrix lists this section as missing' : 'not in this response'],
  })
  const cards: TmCard[] = []

  const q = s.quality
  cards.push(
    q
      ? { key: 'quality', title: 'Quality', headline: fin(q.quality_score) ? `${fmtNum(q.quality_score, 0)} / ${outOf(q.quality_score_out_of, 100)}` : '-', sub: [q.quality_label, q.sector].filter((x): x is string => !!x) }
      : gone('quality', 'Quality'),
  )

  const g = s.gamma
  cards.push(
    g
      ? {
          key: 'gamma',
          title: 'Gamma',
          headline: human(g.regime) || '-',
          sub: [
            fin(g.gamma_flip_level) ? `Flip level ${fmtNum(g.gamma_flip_level)}` : '',
            g.spot_vs_flip ? `Spot ${human(g.spot_vs_flip)}${g.spot_vs_flip_distance ? ` (${human(g.spot_vs_flip_distance)})` : ''}` : '',
            g.gamma_pocket ?? '',
          ].filter(Boolean),
        }
      : gone('gamma', 'Gamma'),
  )

  const a = s.apex
  cards.push(
    a
      ? {
          key: 'apex',
          title: 'Nearest Apex level',
          headline: a.nearest_level && fin(a.nearest_level.strike) ? `${fmtLevel(a.nearest_level.strike)}${fin(a.nearest_level.score) ? ` (score ${fmtLevel(a.nearest_level.score)})` : ''}` : '-',
          sub: [
            a.nearest_level?.side ? `${human(a.nearest_level.side)}${a.nearest_level.distance_from_spot ? `, ${human(a.nearest_level.distance_from_spot)}` : ''}` : '',
            fin(a.dominant_level_strike) ? `Dominant ${fmtLevel(a.dominant_level_strike)}` : '',
            fin(a.level_count) ? `${a.level_count} levels` : '',
          ].filter(Boolean),
        }
      : gone('apex', 'Nearest Apex level'),
  )

  const f = s.flow
  cards.push(
    f
      ? {
          key: 'flow',
          title: 'Options flow',
          headline: f.bias ?? '-',
          sub: [fin(f.conviction) ? `Conviction ${f.conviction.toFixed(2)} / ${outOf(f.conviction_out_of, 1)}` : ''].filter(Boolean),
          ...(fin(f.conviction) ? { bar: pctBar(f.conviction, outOf(f.conviction_out_of, 1)) } : {}),
        }
      : gone('flow', 'Options flow'),
  )

  const iv = s.iv_rank
  cards.push(
    iv
      ? {
          key: 'iv_rank',
          title: 'IV rank',
          headline: fmtIvRank(iv.iv_rank),
          sub: [iv.iv_rank_zone ? `Zone ${human(iv.iv_rank_zone)}` : '', iv.as_of ? `as of ${iv.as_of}` : ''].filter(Boolean),
          ...(fin(iv.iv_rank) ? { bar: pctBar(iv.iv_rank, outOf(iv.iv_rank_out_of, 100)) } : {}),
        }
      : gone('iv_rank', 'IV rank'),
  )

  const mh = s.market_health
  cards.push(
    mh
      ? {
          key: 'market_health',
          title: 'Market health',
          headline: fin(mh.composite_score) ? `${mh.label ?? ''} (${fmtNum(mh.composite_score, 1)} / ${outOf(mh.composite_score_max, 5)})`.trim() : (mh.label ?? '-'),
          sub: [fin(mh.alert_count) ? `${mh.alert_count} alert` : '', fin(mh.watch_count) ? `${mh.watch_count} watch` : ''].filter(Boolean),
        }
      : gone('market_health', 'Market health'),
  )
  return cards
}
