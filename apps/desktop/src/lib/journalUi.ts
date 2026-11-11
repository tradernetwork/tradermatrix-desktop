import type { JournalExport, JournalNote, PnlBucket, PnlSpan } from './api'
import { fmtMoney, pnlClass } from './format'

export const SPAN_LABELS: Record<PnlSpan, string> = { week: 'Week', month: 'Month', '3month': '3 months', ytd: 'YTD', all: 'All' }

const cents = (n: number) => Math.round(n * 100) / 100

/** Colour class for a realized figure; amounts that round to $0.00 are neutral. */
export function pnlTone(n: number | null | undefined): 'bull' | 'bear' | '' {
  return n === null || n === undefined || !Number.isFinite(n) ? '' : pnlClass(cents(n))
}

/** +$12.50 / -$3.25 / $0.00 / '-' for a missing value. */
export function fmtSignedMoney(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '-'
  const c = cents(n)
  if (c === 0) return '$0.00'
  return (c > 0 ? '+' : '') + fmtMoney(c)
}

export interface Bar {
  key: string
  /** 0 to 100, relative to the largest bucket in the window. Non-zero buckets are at least 3. */
  height: number
  tone: 'bull' | 'bear' | ''
  title: string
}

/** One bar per P&L bucket: height by magnitude, colour by sign; a null gain is an empty bar. */
export function bucketBars(points: PnlBucket[]): Bar[] {
  const max = points.reduce((m, p) => (p.realized_gain !== null && Number.isFinite(p.realized_gain) ? Math.max(m, Math.abs(p.realized_gain)) : m), 0)
  return points.map((p, i) => {
    const g = p.realized_gain !== null && Number.isFinite(p.realized_gain) ? p.realized_gain : null
    const day = (p.start_time ?? '').slice(0, 10) || `#${i + 1}`
    const n = p.number_of_trades
    const title = `${day}: ${fmtSignedMoney(g)}${n !== null ? ` (${n} trade${n === 1 ? '' : 's'})` : ''}`
    const height = g === null || g === 0 || max === 0 ? 0 : Math.max(3, Math.round((Math.abs(g) / max) * 100))
    return { key: `${p.start_time ?? i}-${i}`, height, tone: pnlTone(g), title }
  })
}

/** trade_key -> notes attached to it (input order). */
export function notesByTradeKey(notes: JournalNote[]): Map<string, JournalNote[]> {
  const m = new Map<string, JournalNote[]>()
  for (const n of notes) if (n.trade_key) m.set(n.trade_key, [...(m.get(n.trade_key) ?? []), n])
  return m
}

export function exportMessage(r: JournalExport): string {
  const rows = `${r.rows} row${r.rows === 1 ? '' : 's'}`
  return `Saved ${rows} to ${r.path}${r.truncated ? ' (trade list truncated at 5 pages)' : ''}`
}

export function whenShort(iso: string | null): string {
  if (!iso) return '-'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
}
