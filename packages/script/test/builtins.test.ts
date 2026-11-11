import { describe, expect, it } from 'vitest'
import { BUILTINS, compile, run } from '../src/index'
import { LEGACY } from './fixtures/scripts'
import { fromCloses } from './fixtures/walk'

const NAMES = [
  'bar_check.highest_offset',
  'bar_check.lowest_offset',
  'define',
  'fill_none',
  'hline',
  'iff',
  'none',
  'plt',
  'plt.fill_between',
  'ind.alma',
  'ind.atr',
  'ind.bb',
  'ind.cci',
  'ind.cmo',
  'ind.cog',
  'ind.correlation',
  'ind.dmi',
  'ind.down_trend',
  'ind.ema',
  'ind.hma',
  'ind.kc',
  'ind.macd',
  'ind.mfi',
  'ind.rma',
  'ind.rsi',
  'ind.sma',
  'ind.swma',
  'ind.tsi',
  'ind.up_trend',
  'ind.vwma',
  'ind.wma',
  'math.abs',
  'math.acos',
  'math.asin',
  'math.atan',
  'math.avg',
  'math.ceil',
  'math.cos',
  'math.cumsum',
  'math.dev',
  'math.diff',
  'math.exp',
  'math.floor',
  'math.highest',
  'math.log',
  'math.log10',
  'math.lowest',
  'math.max',
  'math.min',
  'math.pow',
  'math.round',
  'math.sign',
  'math.sin',
  'math.sqrt',
  'math.std',
  'math.stoch',
  'math.sum',
  'math.tan',
  'math.variance',
  'time.current',
  'time.current_bar',
  'time.friday',
  'time.get_day',
  'time.get_hour',
  'time.get_minute',
  'time.get_month',
  'time.get_week',
  'time.get_weekday',
  'time.get_year',
  'time.monday',
  'time.saturday',
  'time.sunday',
  'time.thursday',
  'time.tuesday',
  'time.utc',
  'time.wednesday',
  'bar_check.is_first',
  'bar_check.is_historical',
  'bar_check.is_last',
  'bar_check.is_last_update',
  'bar_check.is_new',
  'bar_check.is_real_time',
  'close',
  'high',
  'hl2',
  'hlc3',
  'hlcc4',
  'low',
  'ohlc4',
  'open',
  'volume',
  'color.aqua',
  'color.black',
  'color.blue',
  'color.fuchsia',
  'color.gray',
  'color.green',
  'color.lime',
  'color.maroon',
  'color.navy',
  'color.olive',
  'color.orange',
  'color.purple',
  'color.red',
  'color.silver',
  'color.sys_down',
  'color.sys_up',
  'color.teal',
  'color.white',
  'color.yellow',
  'define.bool',
  'define.float',
  'define.integer',
  'define.source',
  'define.string',
  'display.all',
  'display.none',
  'hline.type_dashed',
  'hline.type_dotted',
  'hline.type_solid',
  'plt.type_area',
  'plt.type_circles',
  'plt.type_columns',
  'plt.type_cross',
  'plt.type_histogram',
  'plt.type_line',
  'plt.type_linebr',
  'plt.type_stepline',
]
const v = (src: string, closes: number[]) => Array.from(run(compile(src), fromCloses(closes)).plots[0].values).map((x) => (Number.isNaN(x) ? null : x))

describe('registry', () => {
  it('every documented function name resolves', () => {
    const names = NAMES
    expect(names.length).toBeGreaterThan(90)
    const missing = names.filter((n) => !(n in BUILTINS) && !['close', 'high', 'low', 'open', 'volume', 'hl2', 'hlc3', 'hlcc4', 'ohlc4'].includes(n) && !n.startsWith('bar_check.is_'))
    expect(missing).toEqual([])
  })
  it('extras present: accdist crossover crossunder na nz fixnan', () => {
    for (const n of ['ind.accdist', 'crossover', 'crossunder', 'na', 'nz', 'fixnan', 'iff', 'none', 'fill_none']) expect(n in BUILTINS, n).toBe(true)
  })
})

describe('behaviour', () => {
  it('nz replaces none', () => {
    expect(v('plt(nz(close[1], 5))', [1, 2, 3])).toEqual([5, 1, 2])
  })
  it('fixnan carries the last non-none value', () => {
    expect(v('plt(fixnan(iff(close > 1, close, none)))', [1, 2, 1, 3])).toEqual([null, 2, 2, 3])
  })
  it('iff on a none condition takes the else branch', () => {
    expect(v('plt(iff(close[1] > 0, 1, 2))', [1, 1, 1])).toEqual([2, 1, 1])
  })
  it('crossover is true only on the crossing bar', () => {
    expect(v('plt(iff(crossover(close, 5), 1, 0))', [4, 6, 7, 3, 6])).toEqual([0, 1, 0, 0, 1])
    expect(v('plt(iff(crossunder(close, 5), 1, 0))', [4, 6, 7, 3, 6])).toEqual([0, 0, 0, 1, 0])
  })
  it('comparisons with none are false', () => {
    expect(v('plt(iff(close[1] < 100, 1, 0))', [1, 1])).toEqual([0, 1])
  })
  it('math namespace', () => {
    expect(v('plt(math.max(close, 2) + math.abs(-1) + math.sqrt(9))', [1, 5])).toEqual([6, 9])
  })
  it('legacy aliases: study, input, bare ema, plot, fill', () => {
    const src = LEGACY
    const o = run(compile(src), fromCloses(Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 4) * 5)))
    expect(o.plots).toHaveLength(3)
    expect(o.fills).toHaveLength(2)
    expect(o.inputs.map((i) => i.default)).toEqual([8, 21, 34])
  })
  it('colors: css names, sys_up/sys_down are TM bull/bear', () => {
    expect(BUILTINS['color.green']).toMatchObject({ kind: 'const', value: '#008000' })
    expect(BUILTINS['color.sys_up']).toMatchObject({ value: '#10b981' })
    expect(BUILTINS['color.sys_down']).toMatchObject({ value: '#ef4444' })
  })
  it('bar_check flags', () => {
    expect(v('plt(iff(bar_check.is_first, 1, 0))', [1, 2, 3])).toEqual([1, 0, 0])
    expect(v('plt(iff(bar_check.is_last, 1, 0))', [1, 2, 3])).toEqual([0, 0, 1])
  })
})
