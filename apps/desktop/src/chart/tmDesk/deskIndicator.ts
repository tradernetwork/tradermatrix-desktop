/**
 * KLineChart indicator for the desk overlay: ONE template 'rebull-tmdesk' with NO figures (the y-axis range is never stretched),
 * `calc` returns empty rows and `draw` plans and paints. The overlay math is memoized on (options, timeframe, bar count,
 * first timestamp, last OHLC) so panning never recomputes and a live last-bar update does. Per-instance state lives in a module
 * registry keyed by the indicator id (the tmIndicator / scriptIndicator pattern).
 */
import type { Chart } from 'klinecharts'
import type { Candle, TimeframeId } from '../bars'
import { readCssVar } from '../chartTheme'
import { paintOps } from '../paint'
import type { Side } from './atr'
import type { DeskSettings } from './deskSettings'
import { createOverlayMemo, type OverlayOptions } from './overlay'
import { DESK_COLORS, planDesk, type DeskColors } from './plan'

export const DESK_INDICATOR_NAME = 'rebull-tmdesk'
const CANDLE_PANE_ID = 'candle_pane'

export interface DeskEntry {
  settings: DeskSettings
  /** The timeframe the bars on the chart belong to. */
  tf: TimeframeId
  /** ATR levels resolved from off/auto/on and the position. */
  atrOn: boolean
  atrSide: Side
}

const registry = new Map<string, DeskEntry & { memo: ReturnType<typeof createOverlayMemo> }>()
const registered = new WeakSet<object>()
let version = 0

export const getDeskEntry = (id: string): DeskEntry | undefined => registry.get(id)
export const clearDeskRegistry = (): void => registry.clear()

export function deskOptions(e: DeskEntry): OverlayOptions {
  return { lookbackOverride: e.settings.lookbackOverride, narrow: e.settings.narrow, side: e.atrSide, fvg: e.settings.fvg }
}

function readColors(): DeskColors {
  const d = DESK_COLORS
  return {
    cyan: readCssVar('--tm-cyan', d.cyan),
    textSecondary: readCssVar('--tm-text-secondary', d.textSecondary),
    textMuted: readCssVar('--tm-text-muted', d.textMuted),
    purple: readCssVar('--tm-purple', d.purple),
    bear: readCssVar('--tm-bear', d.bear),
    bull: readCssVar('--tm-bull', d.bull),
    warn: readCssVar('--tm-warn', d.warn),
    halo: readCssVar('--tm-surface-1', d.halo),
  }
}

export function registerDeskIndicator(klinecharts: typeof import('klinecharts')): void {
  if (registered.has(klinecharts)) return
  registered.add(klinecharts)
  klinecharts.registerIndicator<Record<string, number>, string, string>({
    name: DESK_INDICATOR_NAME,
    shortName: 'Desk overlay',
    series: 'normal',
    precision: 2,
    figures: [],
    calcParams: [],
    calc: (dataList) => dataList.map(() => ({})),
    draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
      const e = registry.get(indicator.id)
      if (!e) return true
      try {
        const bars = chart.getDataList() as unknown as Candle[]
        const n = bars.length
        if (n === 0) return true
        const r = chart.getVisibleRange()
        const out = e.memo.get(bars, e.tf, deskOptions(e))
        const ops = planDesk(
          out,
          {
            x: (i) => xAxis.convertToPixel(i),
            y: (v) => yAxis.convertToPixel(v),
            from: Math.max(0, r.from),
            to: Math.min(n - 1, r.to),
            last: n - 1,
            left: 0,
            right: bounding.width,
            top: 0,
            bottom: bounding.height,
            barSpace: chart.getBarSpace().bar,
          },
          readColors(),
          { fib: e.settings.fib, fvg: e.settings.fvg, sma: e.settings.sma, atrOn: e.atrOn, paneHeight: bounding.height },
        )
        paintOps(ctx, ops)
      } catch {
        /* a bad overlay must never break the chart */
      }
      return true
    },
  })
}

/** Create the overlay on the candle pane, or refresh its entry if it exists, and redraw. */
export function attachDesk(chart: Chart, id: string, e: DeskEntry): void {
  const have = registry.get(id)
  registry.set(id, { ...e, memo: have?.memo ?? createOverlayMemo() })
  if (!have || !chart.getIndicators({ id }).length) chart.createIndicator({ name: DESK_INDICATOR_NAME, id, paneId: CANDLE_PANE_ID }, true)
  else chart.overrideIndicator({ name: DESK_INDICATOR_NAME, id, calcParams: [String(++version)] })
}

export function detachDesk(chart: Chart | null, id: string): void {
  registry.delete(id)
  chart?.removeIndicator({ id })
}
