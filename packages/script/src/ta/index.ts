import type { Kernel } from './kernel'
import { sma, ema, wma, rma, hma, vwma, alma, swma } from './ma'
import { rsi, cmo, cci, cog, mfi, tsi, macd, stoch } from './osc'
import { tr, atr, bb, kc, dmi } from './vol'
import { highest, lowest, sum, std, variance, dev, highestOffset, lowestOffset, correlation } from './stat'
import { cumsum, diff, accdist, upTrend, downTrend } from './flow'

export * from './kernel'

export interface KernelSpec {
  name: string
  /** per-bar series inputs, in step() order: src, high, low, close, volume, src2 */
  inputs: string[]
  params: { name: string; default?: number }[]
  /** 1 = scalar; n = tuple returned as number[] */
  outputs: number
  kernel: Kernel<any, any[], any[], number | number[]>
}

const p = (name: string, d?: number) => (d === undefined ? { name } : { name, default: d })
const spec = (
  name: string, inputs: string[], params: { name: string; default?: number }[], outputs: number, kernel: any,
): [string, KernelSpec] => [name, { name, inputs, params, outputs, kernel }]
const len = [p('len')]

export const KERNELS: Record<string, KernelSpec> = Object.fromEntries([
  spec('sma', ['src'], len, 1, sma),
  spec('ema', ['src'], len, 1, ema),
  spec('wma', ['src'], len, 1, wma),
  spec('rma', ['src'], len, 1, rma),
  spec('hma', ['src'], len, 1, hma),
  spec('vwma', ['src', 'volume'], len, 1, vwma),
  spec('alma', ['src'], [p('len'), p('offset', 0.85), p('sigma', 6)], 1, alma),
  spec('swma', ['src'], [], 1, swma),
  spec('rsi', ['src'], len, 1, rsi),
  spec('cmo', ['src'], len, 1, cmo),
  spec('cci', ['src'], len, 1, cci),
  spec('cog', ['src'], len, 1, cog),
  spec('mfi', ['src', 'volume'], len, 1, mfi),
  spec('tsi', ['src'], [p('short'), p('long')], 1, tsi),
  spec('macd', ['src'], [p('fast'), p('slow'), p('sig')], 3, macd),
  spec('stoch', ['src', 'high', 'low'], len, 1, stoch),
  spec('tr', ['high', 'low', 'close'], [], 1, tr),
  spec('atr', ['high', 'low', 'close'], len, 1, atr),
  spec('bb', ['src'], [p('len'), p('mult')], 3, bb),
  spec('kc', ['src', 'high', 'low', 'close'], [p('len'), p('mult')], 3, kc),
  spec('dmi', ['high', 'low', 'close'], [p('diLen'), p('adxLen')], 3, dmi),
  spec('highest', ['src'], len, 1, highest),
  spec('lowest', ['src'], len, 1, lowest),
  spec('sum', ['src'], len, 1, sum),
  spec('std', ['src'], len, 1, std),
  spec('variance', ['src'], len, 1, variance),
  spec('dev', ['src'], len, 1, dev),
  spec('highestOffset', ['src'], len, 1, highestOffset),
  spec('lowestOffset', ['src'], len, 1, lowestOffset),
  spec('correlation', ['src', 'src2'], len, 1, correlation),
  spec('cumsum', ['src'], [], 1, cumsum),
  spec('diff', ['src'], [p('n', 1)], 1, diff),
  spec('accdist', ['high', 'low', 'close', 'volume'], [], 1, accdist),
  spec('upTrend', ['src'], len, 1, upTrend),
  spec('downTrend', ['src'], len, 1, downTrend),
])
