/**
 * The reply pipeline (M16). Order is fixed: model text -> grounding check (A1, on the RAW text) -> lint notice (A2) -> safe markdown (A4)
 * -> glossary (A7). The result is plain data (runs of text with flags); the component only maps it to React text nodes.
 */
import { groundReply, type Flag } from './explainGround'
import { lintReply } from './explainLint'
import { findTerms } from './glossary'
import { parseMd, type Inline } from './mdSafe'

export interface Run {
  text: string
  bold: boolean
  code: boolean
  /** A number with no counterpart in the digest that was sent. */
  flagged: boolean
  /** Static glossary definition, or null. */
  def: string | null
}
export type RBlock = { t: 'p'; runs: Run[] } | { t: 'list'; ordered: boolean; items: { depth: number; runs: Run[] }[] } | { t: 'table'; head: Run[][]; rows: Run[][][] }
export interface Reply {
  blocks: RBlock[]
  lintNotice: boolean
}

function leaf(text: string, start: number | null, bold: boolean, code: boolean, flags: readonly Flag[], seen: Set<string>): Run[] {
  const plain = (t: string): Run => ({ text: t, bold, code, flagged: false, def: null })
  if (!text) return []
  const marks: { s: number; e: number; flagged: boolean; def: string | null }[] = []
  if (start !== null) for (const f of flags) if (f.start < start + text.length && f.end > start) marks.push({ s: Math.max(0, f.start - start), e: Math.min(text.length, f.end - start), flagged: true, def: null })
  if (!code) {
    for (const m of findTerms(text, seen)) {
      if (marks.some((x) => m.start < x.e && m.end > x.s)) continue
      marks.push({ s: m.start, e: m.end, flagged: false, def: m.def })
    }
  }
  marks.sort((a, b) => a.s - b.s)
  const out: Run[] = []
  let at = 0
  for (const m of marks) {
    if (m.s > at) out.push(plain(text.slice(at, m.s)))
    out.push({ text: text.slice(m.s, m.e), bold, code, flagged: m.flagged, def: m.def })
    at = m.e
  }
  if (at < text.length) out.push(plain(text.slice(at)))
  return out
}

function runs(xs: readonly Inline[], flags: readonly Flag[], seen: Set<string>, bold = false): Run[] {
  const out: Run[] = []
  for (const x of xs) {
    if (x.t === 'strong') out.push(...runs(x.children, flags, seen, true))
    else out.push(...leaf(x.text, x.start, bold, x.t === 'code', flags, seen))
  }
  return out
}

/** `digest` null = unknown (no grounding is done rather than flagging everything). */
export function buildReply(text: string, digest: string | null): Reply {
  const flags = digest === null ? [] : groundReply(text, digest).flagged
  const lintNotice = lintReply(text).prescriptive
  const seen = new Set<string>()
  const blocks: RBlock[] = parseMd(text).map((b): RBlock => {
    if (b.t === 'p') return { t: 'p', runs: runs(b.inline, flags, seen) }
    if (b.t === 'table') return { t: 'table', head: b.head.map((c) => runs(c, flags, seen, true)), rows: b.rows.map((r) => r.map((c) => runs(c, flags, seen))) }
    return { t: 'list', ordered: b.t === 'ol', items: b.items.map((i) => ({ depth: i.depth, runs: runs(i.inline, flags, seen) })) }
  })
  return { blocks, lintNotice }
}
