import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aryaLook, type AryaState } from '../src/lib/brand'
import { aryaStateFor, DAILY_FACTS, factForDay, flaggedCountFor, freshness, naNotes } from '../src/lib/explainStates'
import { buildExplainDigest, EMPTY_EXPLAIN_STATE } from '../src/lib/explainDigest'
import { useChartContext } from '../src/stores/chartContext'

const src = join(__dirname, '..', 'src')
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')
const F = { busy: false, streamingText: false, flagged: 0, error: false }

describe('Arya state mapping (M16 B6)', () => {
  it('maps the store flags to idle / thinking / streaming / check / error, error first', () => {
    expect(aryaStateFor(F)).toBe('idle')
    expect(aryaStateFor({ ...F, busy: true })).toBe('thinking')
    expect(aryaStateFor({ ...F, busy: true, streamingText: true })).toBe('streaming')
    expect(aryaStateFor({ ...F, flagged: 2 })).toBe('check')
    expect(aryaStateFor({ ...F, error: true })).toBe('error')
    expect(aryaStateFor({ busy: true, streamingText: true, flagged: 3, error: true })).toBe('error')
    // an answer streaming in is "streaming" even when the previous answer was flagged
    expect(aryaStateFor({ ...F, busy: true, streamingText: true, flagged: 3 })).toBe('streaming')
    expect(aryaStateFor({ ...F, busy: true, flagged: 3 })).toBe('thinking')
  })
  it('every state has a look', () => {
    const all: AryaState[] = ['idle', 'thinking', 'streaming', 'check', 'error']
    for (const s of all) expect(['calm', 'focused', 'wry']).toContain(aryaLook(s))
    expect(aryaLook('streaming')).toBe('focused')
    expect(aryaLook('error')).toBe('calm')
  })
  it('counts grounding flags for one answer against the digest it was sent with', () => {
    const digest = buildExplainDigest({ ...EMPTY_EXPLAIN_STATE, chart: { symbol: 'AAPL', tf: '15m', bars: 100, last: 87.38, hi: 89.1, lo: 85.25, chg: 0.01, estBuyShare: 0.4 } }, { includePositions: false })
    expect(flaggedCountFor('Price last traded at 87.38.', digest)).toBe(0)
    expect(flaggedCountFor('A vendor quotes $412.50 and a 14.2% jump.', digest)).toBeGreaterThan(0)
    expect(flaggedCountFor('No numbers here at all.', digest)).toBe(0)
    expect(flaggedCountFor('anything 412.50', null)).toBe(0)
  })
})

describe('the avatar renders every state in CSS only and respects reduced motion', () => {
  const css = read(src, 'styles', 'app.css')
  it('has a pulsing gold ring for streaming and calmer rings for check and error', () => {
    expect(css).toMatch(/\.arya-avatar\[data-state=['"]streaming['"]\]\s*\{[^}]*animation:/)
    expect(css).toMatch(/\.arya-avatar\[data-state=['"]check['"]\]\s*\{[^}]*box-shadow/)
    expect(css).toMatch(/\.arya-avatar\[data-state=['"]error['"]\]\s*\{[^}]*box-shadow/)
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g) ?? []
    const block = m.find((b) => /\.arya-avatar/.test(b) && /animation:\s*none/.test(b))!
    expect(block).toBeTruthy()
    for (const st of ['thinking', 'streaming']) expect(block).toMatch(new RegExp(`data-state=['"]${st}['"]`))
  })
  it('the component takes a state and stays timer-free', () => {
    const t = read(src, 'workspace', 'ArayaAvatar.tsx')
    expect(t).toMatch(/state\??:/)
    expect(t).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/)
    const pane = read(src, 'workspace', 'ExplainPane.tsx')
    for (const w of ['aryaStateFor', 'freshness', 'naNotes', 'factForDay', 'flaggedCountFor']) expect(pane, w).toContain(w)
  })
})

describe('freshness stamp', () => {
  const at = (h: number, m: number) => new Date(2026, 10, 11, h, m, 0).getTime()
  const hhmm = (ts: number) => `${String(new Date(ts).getHours()).padStart(2, '0')}:${String(new Date(ts).getMinutes()).padStart(2, '0')}`
  it('says when the data arrived and how long ago, in plain words', () => {
    const t = at(14, 32)
    expect(freshness(t, t + 3 * 60_000)).toBe(`data as of ${hhmm(t)}, 3 min ago`)
    expect(freshness(t, t + 10_000)).toBe(`data as of ${hhmm(t)}, just now`)
    expect(freshness(t, t + 44_000)).toBe(`data as of ${hhmm(t)}, just now`)
    expect(freshness(t, t + 60_000)).toBe(`data as of ${hhmm(t)}, 1 min ago`)
    expect(freshness(t, t + 59 * 60_000)).toBe(`data as of ${hhmm(t)}, 59 min ago`)
    expect(freshness(t, t + 60 * 60_000)).toBe(`data as of ${hhmm(t)}, 1 h ago`)
    expect(freshness(t, t + 5 * 3600_000 + 59_000)).toBe(`data as of ${hhmm(t)}, 5 h ago`)
    expect(freshness(t, t + 26 * 3600_000)).toBe(`data as of ${hhmm(t)}, 1 d ago`)
  })
  it('is null without a timestamp and never shows a negative age', () => {
    expect(freshness(null, Date.now())).toBeNull()
    expect(freshness(Number.NaN, Date.now())).toBeNull()
    expect(freshness(0, Date.now())).toBeNull()
    const t = at(9, 5)
    expect(freshness(t, t - 5000)).toBe(`data as of ${hhmm(t)}, just now`)
  })
  it('the chart context stamps when the chart data arrived', () => {
    const before = Date.now()
    useChartContext.getState().setChart({ symbol: 'AAPL', tf: '15m', bars: 1, last: 1, hi: 1, lo: 1, chg: 0, estBuyShare: 0.5 }, null)
    const t = useChartContext.getState().asOf
    expect(t).toBeGreaterThanOrEqual(before)
    useChartContext.getState().setChart(null, null)
    expect(useChartContext.getState().asOf).toBeNull()
  })
})

describe('"I do not see that on your screen"', () => {
  const dig = (o: Partial<Parameters<typeof buildExplainDigest>[0]>) => buildExplainDigest({ ...EMPTY_EXPLAIN_STATE, chart: { symbol: 'AAPL', tf: '15m', bars: 100, last: 87.38, hi: 89.1, lo: 85.25, chg: 0.01, estBuyShare: 0.4 }, ...o }, { includePositions: false })
  it('names each asked-about value that is NA in the digest', () => {
    const d = dig({})
    expect(naNotes('Is IV rank high?', d)).toEqual(['IV rank'])
    expect(naNotes('what is the gamma flip and the Apex walls', d)).toEqual(['Apex levels', 'gamma flip'])
    expect(naNotes('explain the expected move', d)).toEqual(['expected move'])
    expect(naNotes('what about the fib levels', d)).toEqual(['Fibonacci levels'])
    expect(naNotes('explain this strike check', d)).toEqual(['strike check'])
  })
  it('says nothing when the value is there or the question is about something else', () => {
    const d = dig({ ivRank: 72, levels: { apex: [88.66], flip: 85.81, emLo: 83.6, emHi: 91.16, emPct: 0.043 }, fib: { up: true, r382: 86.1, r500: 85.9, r618: 85.4 }, strike: { right: 'put', strike: 95, dte: 9, emUnits: 1, wall: 97, earningsInside: false, verdict: 'protected' } })
    for (const q of ['Is IV rank high?', 'gamma flip and apex', 'expected move', 'fib levels', 'explain this strike check', 'Explain this chart', 'what is a candle']) expect(naNotes(q, d), q).toEqual([])
    expect(naNotes('Explain this chart', dig({}))).toEqual([])
    expect(naNotes('', dig({}))).toEqual([])
  })
})

describe('daily fact', () => {
  it('is a static list of plain sentences: no emoji, no advice, no dashes, rotates by day', () => {
    expect(DAILY_FACTS.length).toBeGreaterThanOrEqual(7)
    expect(new Set(DAILY_FACTS).size).toBe(DAILY_FACTS.length)
    for (const f of DAILY_FACTS) {
      expect(f.length).toBeGreaterThan(30)
      expect(f.length).toBeLessThan(220)
      expect(f, f).not.toMatch(/\p{Extended_Pictographic}/u)
      expect(f, f).not.toMatch(/[–—]/)
      expect(f, f).not.toMatch(/\b(should|buy|sell|place|cancel|review|profit|get rich|money)\b/i)
      expect(f.endsWith('.')).toBe(true)
    }
    const d0 = new Date(2026, 0, 1)
    const seen = new Set(Array.from({ length: DAILY_FACTS.length }, (_, i) => factForDay(new Date(2026, 0, 1 + i))))
    expect(seen.size).toBe(DAILY_FACTS.length)
    expect(factForDay(d0)).toBe(factForDay(new Date(2026, 0, 1, 23, 59)))
    expect(DAILY_FACTS).toContain(factForDay(new Date()))
  })
})
