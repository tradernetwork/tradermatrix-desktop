import { beforeEach, describe, expect, it } from 'vitest'
import {
  clearTmRegistry,
  getTmEntry,
  registerTmIndicator,
  setTmEntry,
  TM_INDICATOR_ID,
  TM_INDICATOR_NAME,
} from '../src/chart/tmIndicator'
import type { ApexLevels } from '../src/lib/api'

const apex: ApexLevels = {
  symbol: 'AAPL', spot: 100, snapshot_time: null, gamma_flip: 90, net_gex: null,
  levels: [{ strike: 110, score: 80, rank: 1, net_gex: 1, total_oi: 1, is_above_spot: true }],
  expirations_used: [], available_expirations: [], open_url: null,
}

function fakeKlc() {
  const reg: { template?: Record<string, unknown> } = {}
  const klc = { registerIndicator: (t: Record<string, unknown>) => void (reg.template = t) }
  return { klc: klc as unknown as typeof import('klinecharts'), reg }
}

function fakeCtx() {
  const calls: string[] = []
  const ctx: Record<string, unknown> = { globalAlpha: 1, canvas: { width: 800, height: 400 }, measureText: (t: string) => ({ width: t.length * 6 }) }
  for (const fn of ['beginPath', 'moveTo', 'lineTo', 'stroke', 'fillRect', 'setLineDash', 'fillText', 'strokeText'])
    ctx[fn] = (...a: unknown[]) => calls.push(`${fn}(${a.join(',')})`)
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

beforeEach(() => clearTmRegistry())

describe('rebull-tm indicator', () => {
  it('registers once per klinecharts instance, adds NO figures and calcs empty rows', () => {
    const { klc, reg } = fakeKlc()
    registerTmIndicator(klc)
    registerTmIndicator(klc)
    expect(reg.template!.name).toBe(TM_INDICATOR_NAME)
    expect(reg.template!.figures).toEqual([])
    const calc = reg.template!.calc as (d: unknown[]) => unknown[]
    expect(calc([1, 2, 3])).toEqual([{}, {}, {}])
  })

  it('draw paints the planned overlay from the registry entry and returns true', () => {
    const { klc, reg } = fakeKlc()
    registerTmIndicator(klc)
    setTmEntry(TM_INDICATOR_ID, { data: { apex, horizon: '1 week', show: { apex: true, flip: true, move: false } } })
    const { ctx, calls } = fakeCtx()
    const draw = reg.template!.draw as (a: unknown) => boolean
    const chart = {
      getDataList: () => Array.from({ length: 50 }, (_, i) => ({ timestamp: i, close: 100 })),
      getVisibleRange: () => ({ from: 0, to: 49 }),
      getBarSpace: () => ({ gapBar: 8 }),
    }
    const ret = draw({
      ctx, chart, indicator: { id: TM_INDICATOR_ID }, bounding: { width: 800, height: 400 },
      xAxis: { convertToPixel: (i: number) => i * 10 + 5 },
      yAxis: { convertToPixel: (v: number) => 400 - (v - 50) * 4 },
    })
    expect(ret).toBe(true)
    expect(calls.filter((c) => c.startsWith('fillText')).map((c) => c.split(',')[0])).toEqual(
      expect.arrayContaining(['fillText(APEX 110 · 80', 'fillText(γ FLIP 90.00']),
    )
    expect(calls).toContain('setLineDash(6,4)')
    expect(calls.some((c) => c.startsWith('fillRect'))).toBe(true) // the filled chips
  })

  it('draw with no entry or no data paints nothing and still returns true', () => {
    const { klc, reg } = fakeKlc()
    registerTmIndicator(klc)
    const draw = reg.template!.draw as (a: unknown) => boolean
    const { ctx, calls } = fakeCtx()
    const args = {
      ctx, chart: { getDataList: () => [], getVisibleRange: () => ({ from: 0, to: 0 }), getBarSpace: () => ({ gapBar: 8 }) },
      indicator: { id: TM_INDICATOR_ID }, bounding: { width: 800, height: 400 },
      xAxis: { convertToPixel: () => 0 }, yAxis: { convertToPixel: () => 0 },
    }
    expect(draw(args)).toBe(true)
    setTmEntry(TM_INDICATOR_ID, { data: { horizon: 'x', show: { apex: true, flip: true, move: true } } })
    expect(draw(args)).toBe(true)
    expect(calls).toEqual([])
  })

  it('registry get/set/clear', () => {
    expect(getTmEntry(TM_INDICATOR_ID)).toBeUndefined()
    setTmEntry(TM_INDICATOR_ID, { data: { apex, horizon: 'x', show: { apex: true, flip: false, move: false } } })
    expect(getTmEntry(TM_INDICATOR_ID)?.data.apex?.symbol).toBe('AAPL')
    clearTmRegistry()
    expect(getTmEntry(TM_INDICATOR_ID)).toBeUndefined()
  })
})
