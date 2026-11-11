/**
 * KLineChart indicator that paints the TraderMatrix overlay. ONE template, 'rebull-tm', with NO figures, so the
 * y-axis range is never stretched by overlay values. Per-instance data lives in a module registry keyed by the
 * chart's indicator id (the same pattern as 'rebull-script').
 */
import type { Chart } from 'klinecharts'
import { readCssVar } from './chartTheme'
import { paintOps } from './paint'
import { planTmOverlay, type TmOverlayData } from './tmOverlay'

export const TM_INDICATOR_NAME = 'rebull-tm'
export const TM_INDICATOR_ID = 'rebull-tm-overlay'
const CANDLE_PANE_ID = 'candle_pane'

export interface TmEntry {
  data: TmOverlayData
}

const registry = new Map<string, TmEntry>()
const registered = new WeakSet<object>()
let version = 0

export const getTmEntry = (id: string): TmEntry | undefined => registry.get(id)
export const setTmEntry = (id: string, e: TmEntry): void => void registry.set(id, e)
export const clearTmRegistry = (): void => registry.clear()

export function registerTmIndicator(klinecharts: typeof import('klinecharts')): void {
  if (registered.has(klinecharts)) return
  registered.add(klinecharts)
  klinecharts.registerIndicator<Record<string, number>, string, string>({
    name: TM_INDICATOR_NAME,
    shortName: 'TM positioning',
    series: 'normal',
    precision: 2,
    figures: [],
    calcParams: [],
    calc: (dataList) => dataList.map(() => ({})),
    draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
      const e = registry.get(indicator.id)
      if (!e) return true
      try {
        const list = chart.getDataList()
        const n = list.length
        if (n === 0) return true
        const r = chart.getVisibleRange()
        const from = Math.max(0, r.from)
        const to = Math.min(n - 1, r.to)
        const spot = list[n - 1]?.close ?? e.data.apex?.spot ?? NaN
        const ops = planTmOverlay(
          {
            ...e.data,
            colors: {
              hot: readCssVar('--tm-hot', '#ff8000'),
              support: readCssVar('--tm-support', '#00e070'),
              flip: readCssVar('--tm-flip', '#b45bff'),
              range: readCssVar('--tm-range', '#4f86ff'),
              ink: readCssVar('--tm-chip-ink', '#070E1F'),
              ...e.data.colors,
            },
          },
          { x: (i) => xAxis.convertToPixel(i), y: (v) => yAxis.convertToPixel(v), yBase: bounding.height, from, to, left: 0, right: bounding.width, top: 0, bottom: bounding.height, last: n - 1 },
          spot,
        )
        paintOps(ctx, ops)
      } catch {
        /* a bad overlay must never break the chart */
      }
      return true
    },
  })
}

/** Create the overlay on the candle pane (or just refresh its data if it already exists) and redraw. */
export function attachTm(chart: Chart, data: TmOverlayData): void {
  const have = registry.has(TM_INDICATOR_ID)
  setTmEntry(TM_INDICATOR_ID, { data })
  if (!have || !chart.getIndicators({ id: TM_INDICATOR_ID }).length) {
    chart.createIndicator({ name: TM_INDICATOR_NAME, id: TM_INDICATOR_ID, paneId: CANDLE_PANE_ID }, true)
  } else {
    // a changed calcParam forces a redraw without touching the data or the axis
    chart.overrideIndicator({ name: TM_INDICATOR_NAME, id: TM_INDICATOR_ID, calcParams: [String(++version)] })
  }
}

export function detachTm(chart: Chart | null): void {
  registry.delete(TM_INDICATOR_ID)
  chart?.removeIndicator({ id: TM_INDICATOR_ID })
}
