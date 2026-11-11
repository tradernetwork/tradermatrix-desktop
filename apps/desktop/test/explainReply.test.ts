import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { buildReply, type RBlock, type Run } from '../src/lib/explainReply'
import { GLOSSARY } from '../src/lib/glossary'
import { ExplainReply } from '../src/workspace/ExplainReply'

const D = 'CHART: symbol=AAPL tf=15m bars=834 last=187.32\nLEVELS: apex=185,190 flip=185 em_lo=180 em_hi=194 em_pct=0.021\nIV: rank=72'
const runsOf = (bs: RBlock[]): Run[] => bs.flatMap((b) => (b.t === 'p' ? b.runs : b.t === 'list' ? b.items.flatMap((i) => i.runs) : [...b.head.flat(), ...b.rows.flat(2)]))

describe('reply pipeline: ground -> lint -> markdown -> glossary (A1,A2,A4,A7)', () => {
  it('a grounded plain reply has no flags and no notice', () => {
    const r = buildReply('It last traded at $187.3, close to the 185 level.', D)
    expect(r.lintNotice).toBe(false)
    expect(runsOf(r.blocks).some((x) => x.flagged)).toBe(false)
  })
  it('a number not in the digest is its own flagged run, nothing else is', () => {
    const r = buildReply('Price is near $412.50 with 185 below.', D)
    const flagged = runsOf(r.blocks).filter((x) => x.flagged)
    expect(flagged.map((x) => x.text)).toEqual(['$412.50'])
    expect(runsOf(r.blocks).map((x) => x.text).join('')).toBe('Price is near $412.50 with 185 below.')
  })
  it('flags survive markdown: inside bold the run stays bold and flagged; in a table cell too', () => {
    const r = buildReply('Look at **$412.50** now.\n\n| a | b |\n|---|---|\n| wall | $999 |', D)
    const f = runsOf(r.blocks).filter((x) => x.flagged)
    expect(f.map((x) => x.text).sort()).toEqual(['$412.50', '$999'])
    expect(f.find((x) => x.text === '$412.50')!.bold).toBe(true)
  })
  it('prescriptive wording only turns on the notice (text is kept, nothing is blocked)', () => {
    const t = 'You should buy the dip here.'
    const r = buildReply(t, D)
    expect(r.lintNotice).toBe(true)
    expect(runsOf(r.blocks).map((x) => x.text).join('')).toBe(t)
  })
  it('glossary terms get the static definition; a flagged number removes an overlapping term mark', () => {
    const r = buildReply('The gamma flip and IV rank matter; delta too.', D)
    const defs = runsOf(r.blocks).filter((x) => x.def)
    expect(defs.map((x) => x.text)).toEqual(['gamma flip', 'IV rank', 'delta'])
    for (const d of defs) expect(GLOSSARY.map((g) => g.def)).toContain(d.def)
  })
  it('inline code is not glossary-marked (it is literal)', () => {
    const r = buildReply('Run `delta` as typed.', D)
    expect(runsOf(r.blocks).filter((x) => x.def)).toEqual([])
  })
  it('hostile reply renders as inert text: no script, anchor, img or handler elements', () => {
    const hostile = ['# Title', '<script>alert(1)</script>', '[x](javascript:alert(1)) and ![i](http://x/a.png)', '<img src=x onerror=alert(1)>', '- **bold** item', '', '| a | b |', '|---|---|', '| <b>1</b> | `c` |'].join('\n')
    const html = renderToStaticMarkup(createElement(ExplainReply, { text: hostile, digest: D }))
    expect(html).not.toMatch(/<script|<img|<a[\s>]|<iframe|<b>|<[a-z][^>]*\son\w+=|<[a-z][^>]*href=/i)
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(html).toContain('javascript:alert(1)')
  })
  it('the rendered markup marks flags with the dotted-underline class and the tooltip text', () => {
    const html = renderToStaticMarkup(createElement(ExplainReply, { text: 'Near $412.50 today.', digest: D }))
    expect(html).toContain('num-flag')
    expect(html).toContain('not in the data I sent')
  })
  it('the notice is muted and appears only when needed', () => {
    expect(renderToStaticMarkup(createElement(ExplainReply, { text: 'You should buy.', digest: D }))).toContain('explain-notice')
    expect(renderToStaticMarkup(createElement(ExplainReply, { text: 'The delta is 0.30.', digest: D }))).not.toContain('explain-notice')
  })
})
