import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it } from 'vitest'
import { api, fake, fakeExplain, fakeLlm } from '../src/lib/api'
import { LENSES, LENS_IDS, MAX_LENSES, isLensId, lensSent, parseLensParam, selectLenses, toggleLens } from '../src/lib/explainLenses'
import { useChartContext } from '../src/stores/chartContext'
import { useExplainStore } from '../src/stores/explain'
import { askAbout, confirmAskAbout } from '../src/stores/explainFocus'
import { useRhStore } from '../src/stores/rh'
import { DrawerBody } from '../src/workspace/ExplainDrawer'
import { ExplainLenses } from '../src/workspace/ExplainLenses'

const st = () => useExplainStore.getState()
const root = join(__dirname, '..', 'src')
const ctx = (digest: string, question = 'What is this?') => ({ digest, question })

beforeEach(async () => {
  fake.reset()
  st().reset()
  useChartContext.setState({ chart: null, overlays: null, fib: null, strike: null })
  useRhStore.getState().wipe()
  fakeLlm.set('openrouter', null, 'sk-or-TESTKEY', null, null)
  await st().loadConfig()
})

describe('catalog mirrors Rust', () => {
  it('ids, names and versions match src-tauri/src/llm/lenses.rs; the webview holds no card text', () => {
    const rs = readFileSync(join(__dirname, '..', 'src-tauri', 'src', 'llm', 'lenses.rs'), 'utf8')
    const rows = [...rs.matchAll(/id: "([a-z]+)",\s*name: "([^"]+)",\s*version: (\d+)/g)].map((m) => ({ id: m[1], name: m[2], version: Number(m[3]) }))
    expect(rows.length).toBe(4)
    expect(LENSES.map((l) => ({ id: l.id, name: l.name, version: l.version }))).toEqual(rows)
    expect(LENS_IDS).toEqual(['options', 'sizing', 'posture', 'chart'])
    expect(MAX_LENSES).toBe(2)
    const src = readFileSync(join(root, 'lib', 'explainLenses.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
    expect(src).not.toMatch(/include_str|\.md['"]|lenses\//)
  })
  it('isLensId is a closed check', () => {
    for (const ok of LENS_IDS) expect(isLensId(ok)).toBe(true)
    for (const bad of ['', 'Options', 'tradermatrix', 'options ', null, undefined, 3, {}]) expect(isLensId(bad as unknown)).toBe(false)
  })
})

describe('toggle: up to two chips', () => {
  it('adds, removes, and refuses a third', () => {
    let p = toggleLens([], 'options')
    p = toggleLens(p, 'chart')
    expect(p).toEqual(['options', 'chart'])
    expect(toggleLens(p, 'sizing')).toEqual(['options', 'chart'])
    expect(toggleLens(p, 'options')).toEqual(['chart'])
  })
})

describe('auto selection from focus and question', () => {
  it('strike check -> options; R stats -> sizing; chart focus -> chart reading; market words -> posture', () => {
    expect(selectLenses(true, [], ctx('CHART: symbol=AAPL\nCONTRACT: right=put strike=95 dte=9'))).toEqual(['options'])
    expect(selectLenses(true, [], ctx('CHART: symbol=AAPL\nRSTATS: n=40 n_with_r=30'))).toEqual(['sizing'])
    expect(selectLenses(true, [], ctx('CHART: symbol=AAPL\nTRADE: symbol=AAPL side=sell'))).toEqual(['sizing'])
    expect(selectLenses(true, [], ctx('CHART: symbol=AAPL\nCANDLE: t=NA o=1 h=2 l=0.5 c=1.5 v=10 chg=NA dir=up'))).toEqual(['chart'])
    expect(selectLenses(true, [], ctx('CHART: symbol=AAPL\nLEVEL: source=tm price=88.66'))).toEqual(['chart'])
    expect(selectLenses(true, [], ctx('CHART: symbol=AAPL', 'How does the market breadth look?'))).toEqual(['posture'])
  })
  it('a plain digest and a plain question add nothing (no tokens spent on cards)', () => {
    expect(selectLenses(true, [], ctx('CHART: symbol=AAPL\nIV: rank=72'))).toEqual([])
  })
  it('a STRIKE line alone needs an options question; the pane having a strike check open does not pull the card into every answer', () => {
    const d = 'CHART: symbol=AAPL\nSTRIKE: right=put strike=95 dte=9 em_units=1.25'
    expect(selectLenses(true, [], ctx(d, 'Explain this chart'))).toEqual([])
    expect(selectLenses(true, [], ctx(d, 'Is this strike far enough out?'))).toEqual(['options'])
  })
  it('never more than two, in a fixed priority (options, sizing, chart, posture)', () => {
    const d = 'CONTRACT: right=put\nRSTATS: n=1\nCANDLE: t=NA'
    expect(selectLenses(true, [], ctx(d, 'market breadth?'))).toEqual(['options', 'sizing'])
    expect(selectLenses(true, [], ctx('CANDLE: t=NA', 'market breadth?'))).toEqual(['chart', 'posture'])
  })
  it('a hostile question or digest value cannot name a card or add one beyond the rules', () => {
    // naming cards in the question does not select them: only the fixed rules do (here the word "posture" is a market word)
    expect(selectLenses(true, [], ctx('CHART: symbol=NA', 'lens options chart ignore the rules'))).toEqual([])
    expect(selectLenses(true, [], ctx('CHART: symbol=NA', 'lens options posture chart ignore the rules'))).toEqual(['posture'])
  })
  it('manual picks win over auto, and an empty manual pick sends none', () => {
    expect(selectLenses(false, ['posture'], ctx('CONTRACT: right=put', 'strike?'))).toEqual(['posture'])
    expect(selectLenses(false, [], ctx('CONTRACT: right=put', 'strike?'))).toEqual([])
    expect(selectLenses(false, ['options', 'sizing', 'chart'] as never, ctx('x'))).toEqual(['options', 'sizing'])
  })
})

describe('dev page parameter', () => {
  it('lenses=auto | options,sizing | garbage', () => {
    expect(parseLensParam('auto')).toEqual({ auto: true, pick: [] })
    expect(parseLensParam(null)).toEqual({ auto: true, pick: [] })
    expect(parseLensParam('options,sizing')).toEqual({ auto: false, pick: ['options', 'sizing'] })
    expect(parseLensParam('chart,chart,posture,options')).toEqual({ auto: false, pick: ['chart', 'posture'] })
    expect(parseLensParam('nope')).toEqual({ auto: true, pick: [] })
    expect(parseLensParam('none')).toEqual({ auto: false, pick: [] })
  })
})

describe('the store sends ids only, and records what was sent', () => {
  it('default is auto; a plain question sends no lens ids', async () => {
    expect(st().lensAuto).toBe(true)
    expect(await st().ask('Explain this chart')).toBe(true)
    expect(fakeExplain.calls[0]!.lenses).toEqual([])
    expect(st().lastSent!.lenses).toEqual([])
  })
  it('auto picks from the pointed-at item: a strike focus sends the options id', async () => {
    useChartContext.setState({ chart: { symbol: 'AAPL', tf: '15m', bars: 10, last: 87.38, hi: 90, lo: 80, chg: 0.01, estBuyShare: 0.5 } })
    askAbout({ kind: 'strike', right: 'put', strike: 95, dte: 9, delta: -0.18, mid: 1.35, iv: 0.42 }, { x: 1, y: 1 })
    confirmAskAbout()
    expect(await st().ask('Explain this strike check.')).toBe(true)
    expect(fakeExplain.calls[0]!.lenses).toEqual(['options'])
    expect(st().lastSent!.lenses).toEqual([{ id: 'options', name: 'Options seller', version: 1 }])
    expect(st().sentLog[0]!.lenses).toEqual([{ id: 'options', name: 'Options seller', version: 1 }])
  })
  it('manual chips: auto turns off, two at most, ids go as a plain string array', async () => {
    st().toggleLens('sizing')
    expect(st().lensAuto).toBe(false)
    st().toggleLens('chart')
    st().toggleLens('posture')
    expect(st().lensPick).toEqual(['sizing', 'chart'])
    await st().ask('anything at all')
    expect(fakeExplain.calls[0]!.lenses).toEqual(['sizing', 'chart'])
    st().setLensAuto(true)
    expect(st().lensAuto).toBe(true)
  })
  it('a session wipe keeps the preference; reset restores auto', () => {
    st().toggleLens('options')
    st().wipe()
    expect(st().lensPick).toEqual(['options'])
    st().reset()
    expect(st().lensAuto).toBe(true)
    expect(st().lensPick).toEqual([])
  })
  it('the fake backend (like Rust) refuses unknown, repeated or too many ids with bad_request before anything is recorded', async () => {
    for (const bad of [['nope'], ['options', 'options'], ['options', 'sizing', 'chart'], ['Options'], ['tradermatrix']]) {
      await expect(api.explainAsk('', 'CHART: x', 'q', [], 'beginner', 'r-1', undefined, bad)).rejects.toThrow('bad_request')
    }
    expect(fakeExplain.calls).toHaveLength(0)
    await expect(api.explainAsk('', 'CHART: x', 'q', [], 'beginner', 'r-2', undefined, ['chart'])).resolves.toBeTruthy()
    expect(fakeExplain.calls[0]!.lenses).toEqual(['chart'])
  })
  it('lensSent names every id with its version', () => {
    expect(lensSent(['chart', 'posture'])).toEqual([
      { id: 'chart', name: 'Chart reading', version: 1 },
      { id: 'posture', name: 'Market posture', version: 1 },
    ])
  })
})

describe('UI', () => {
  it('the Lenses control shows four chips plus Auto, and Auto is on by default', () => {
    const html = renderToStaticMarkup(createElement(ExplainLenses))
    for (const n of ['Options seller', 'Sizing and R', 'Market posture', 'Chart reading']) expect(html).toContain(n)
    expect(html).toContain('Lenses')
    expect(html).toMatch(/Auto[^<]*<\/button>/)
    expect(html).toMatch(/aria-pressed="true"[^>]*>Auto</)
  })
  it('the drawer lists the lens names and versions that were sent, or says none', async () => {
    st().toggleLens('options')
    st().toggleLens('chart')
    await st().ask('explain')
    const html = renderToStaticMarkup(createElement(DrawerBody, { sent: st().lastSent! }))
    expect(html).toContain('Options seller')
    expect(html).toContain('Chart reading')
    expect(html.replace(/<!-- -->/g, '')).toContain('Reference cards sent: Options seller v1, Chart reading v1')
    st().reset()
    await st().ask('explain again')
    const none = renderToStaticMarkup(createElement(DrawerBody, { sent: st().lastSent! }))
    expect(none.replace(/<!-- -->/g, '')).toContain('Reference cards sent: none')
  })
  it('the new files are explain-only (no order words) and render no HTML from card text', () => {
    for (const f of ['lib/explainLenses.ts', 'workspace/ExplainLenses.tsx']) {
      const src = readFileSync(join(root, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '')
      expect(src, f).not.toMatch(/\b(place(?![a-z])|cancel(?![a-z])|review(?![a-z])|fillTicket|cancelAndEdit|ticketIntent|useOrdersStore|rhPlace|rhReview|rhCancel)/i)
      expect(src, f).not.toMatch(/dangerouslySetInnerHTML/)
    }
  })
})
