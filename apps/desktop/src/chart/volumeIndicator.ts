/**
 * Volume pane indicators for KLineChart. Two templates, registered once per klinecharts module:
 *  - 'rebull-vol'     total volume, colored by candle direction
 *  - 'rebull-vol-est' ESTIMATED buy/sell split stacked (buy from the base, sell on top); the legend says "est."
 * `calc` only supplies the values the legend and the y-axis range need; `draw` paints the planned columns itself and
 * returns true (suppresses the default figures). Option charts never get one: option bars carry no volume.
 */
import type { Chart, KLineData } from 'klinecharts'
import type { Candle } from './bars'
import { CHART_PALETTE, readCssVar } from './chartTheme'
import { planVolume } from './volumePlan'
import { splitVolume } from './volumeSplit'
import type { VolumeMode } from './volumeMode'

export const VOL_INDICATOR = 'rebull-vol'
export const VOL_EST_INDICATOR = 'rebull-vol-est'
export const VOL_ID = 'rebull-volume'
const VOL_PANE_HEIGHT = 110
const registered = new WeakSet<object>()

const toCandles = (d: KLineData[]): Candle[] =>
  d.map((x) => ({ timestamp: x.timestamp, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume ?? 0 }))

function colors() {
  const up = readCssVar('--tm-up', CHART_PALETTE.up)
  const down = readCssVar('--tm-down', CHART_PALETTE.down)
  return { up, down, buy: up, sell: down }
}

export function registerVolumeIndicators(klinecharts: typeof import('klinecharts')): void {
  if (registered.has(klinecharts)) return
  registered.add(klinecharts)
  const make = (name: string, shortName: string, mode: 'vol' | 'split') =>
    klinecharts.registerIndicator<Record<string, number>, string, string>({
      name,
      shortName,
      series: 'normal',
      precision: 0,
      figures:
        mode === 'split'
          ? [
              { key: 'total', title: 'Total: ', type: 'bar', baseValue: 0 },
              { key: 'buy', title: 'Buy est.: ', type: 'bar', baseValue: 0 },
              { key: 'sell', title: 'Sell est.: ', type: 'bar', baseValue: 0 },
            ]
          : [{ key: 'total', title: 'Vol: ', type: 'bar', baseValue: 0 }],
      calcParams: [],
      calc: (dataList: KLineData[]) =>
        dataList.map((d): Record<string, number> => {
          const s = splitVolume({ high: d.high, low: d.low, close: d.close, volume: d.volume ?? 0 })
          return mode === 'split' ? { total: s.total, buy: s.buy, sell: s.sell } : { total: s.total }
        }),
      draw: ({ ctx, chart, bounding, xAxis, yAxis }) => {
        try {
          const bars = toCandles(chart.getDataList())
          if (bars.length === 0) return true
          const r = chart.getVisibleRange()
          const yBase = Math.min(bounding.height, Math.max(0, yAxis.convertToPixel(0)))
          const rects = planVolume(
            bars,
            mode,
            {
              x: (i) => xAxis.convertToPixel(i),
              y: (v) => yAxis.convertToPixel(v),
              yBase: Number.isFinite(yBase) ? yBase : bounding.height,
              barW: Math.max(1, Math.round(chart.getBarSpace().gapBar)),
              from: r.from,
              to: r.to,
            },
            colors(),
          )
          ctx.save()
          ctx.globalAlpha = 0.85
          for (const q of rects) {
            ctx.fillStyle = q.color
            ctx.fillRect(q.x, q.y, q.w, q.h)
          }
          ctx.restore()
        } catch {
          /* a bad volume pane must never break the chart */
        }
        return true
      },
    })
  make(VOL_INDICATOR, 'Vol', 'vol')
  make(VOL_EST_INDICATOR, 'Vol est. buy/sell', 'split')
}

export function removeVolume(chart: Chart | null): void {
  chart?.removeIndicator({ id: VOL_ID })
}

/** Create the volume pane under the price pane for 'vol' or 'split'; 'off' only removes. */
export function applyVolume(chart: Chart, mode: VolumeMode): void {
  removeVolume(chart)
  if (mode === 'off') return
  const id = chart.createIndicator({ name: mode === 'split' ? VOL_EST_INDICATOR : VOL_INDICATOR, id: VOL_ID }, false)
  if (!id) return
  try {
    const pane = chart.getIndicators({ id: VOL_ID })[0]?.paneId
    if (pane) chart.setPaneOptions({ id: pane, height: VOL_PANE_HEIGHT })
  } catch {
    /* default pane height is fine */
  }
}
