import { describe, expect, it } from 'vitest'
import { parseMd, plainText, type Block, type Inline } from '../src/lib/mdSafe'

const walkInline = (xs: Inline[], f: (n: Inline) => void) => {
  for (const n of xs) {
    f(n)
    if (n.t === 'strong') walkInline(n.children, f)
  }
}
const allInline = (bs: Block[]): Inline[][] => bs.flatMap((b) => (b.t === 'p' ? [b.inline] : b.t === 'table' ? [...b.head, ...b.rows.flat()] : b.items.map((i) => i.inline)))
const KINDS = new Set(['text', 'strong', 'code'])

describe('parseMd (A4)', () => {
  it('paragraphs, bold, inline code', () => {
    const b = parseMd('First **bold** and `code` here.\n\nSecond paragraph.')
    expect(b.map((x) => x.t)).toEqual(['p', 'p'])
    const first = (b[0] as Extract<Block, { t: 'p' }>).inline
    expect(first.map((n) => n.t)).toEqual(['text', 'strong', 'text', 'code', 'text'])
    expect(plainText(b)).toContain('First bold and code here.')
  })
  it('lists (ordered, unordered, nested)', () => {
    const b = parseMd('- a\n  - b\n    - c\n- d')
    expect(b).toHaveLength(1)
    const l = b[0] as Extract<Block, { t: 'ul' | 'ol' }>
    expect(l.t).toBe('ul')
    expect(l.items.map((i) => i.depth)).toEqual([0, 1, 2, 0])
    const o = parseMd('1. one\n2. two')[0] as Extract<Block, { t: 'ul' | 'ol' }>
    expect(o.t).toBe('ol')
    expect(o.items).toHaveLength(2)
  })
  it('simple tables', () => {
    const b = parseMd('| Level | Value |\n| --- | --- |\n| Flip | 185 |\n| Wall | **97** |')
    expect(b).toHaveLength(1)
    const t = b[0] as Extract<Block, { t: 'table' }>
    expect(t.t).toBe('table')
    expect(t.head).toHaveLength(2)
    expect(t.rows).toHaveLength(2)
    expect(plainText(b)).toContain('Flip')
  })
  it('hostile markup stays text: <script>, <img onerror>', () => {
    const src = '<script>alert(1)</script>\n<img src=x onerror=alert(1)>\n<a href="javascript:alert(1)">x</a>'
    const b = parseMd(src)
    expect(plainText(b)).toContain('<script>alert(1)</script>')
    expect(plainText(b)).toContain('<img src=x onerror=alert(1)>')
    for (const xs of allInline(b)) walkInline(xs, (n) => expect(KINDS.has(n.t)).toBe(true))
  })
  it('links are inert text with the URL visible; images never become images', () => {
    const b = parseMd('See [x](javascript:alert(1)) and ![i](http://x/y.png) now.')
    const txt = plainText(b)
    expect(txt).toContain('x (javascript:alert(1))')
    expect(txt).toContain('(http://x/y.png)')
    for (const xs of allInline(b)) walkInline(xs, (n) => expect(['text', 'strong', 'code']).toContain(n.t))
  })
  it('text offsets point into the source exactly', () => {
    const src = 'Alpha **beta $190** gamma `c1`\n\n- item 185\n\n| a | b |\n|---|---|\n| 1 | $2 |'
    const b = parseMd(src)
    let seen = 0
    for (const xs of allInline(b))
      walkInline(xs, (n) => {
        if ((n.t === 'text' || n.t === 'code') && n.start !== null) {
          seen++
          expect(src.slice(n.start, n.start + n.text.length)).toBe(n.text)
        }
      })
    expect(seen).toBeGreaterThan(5)
  })
  it('adversarial 8000 char inputs finish fast and never throw', () => {
    const cases = ['*'.repeat(8000), '['.repeat(8000), '`'.repeat(8000), '**a'.repeat(2666), '|'.repeat(8000), '- '.repeat(4000), '[a](' .repeat(2000), '![', '\n'.repeat(8000), '  - x\n'.repeat(1300), '| a |\n|---|\n'.repeat(600)]
    for (const c of cases) {
      const t0 = Date.now()
      const b = parseMd(c.slice(0, 8000))
      expect(Date.now() - t0, c.slice(0, 8)).toBeLessThan(500)
      expect(Array.isArray(b)).toBe(true)
    }
  })
  it('empty input is no blocks', () => {
    expect(parseMd('')).toEqual([])
    expect(parseMd('   \n\n ')).toEqual([])
  })
})
