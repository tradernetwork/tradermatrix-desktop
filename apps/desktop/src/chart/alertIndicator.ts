/**
 * KLineChart indicator for alert lines: ONE template 'rebull-alerts' with NO figures (the y-axis range is never stretched), draw-only
 * (the same pattern as tmIndicator). INFORM ONLY. Per-instance data lives in a module registry keyed by the chart's indicator id.
 */
import type { Chart } from 'klinecharts'
import { alertLineColors, planAlertLines, type AlertLineItem } from './alertLines'
import { paintOps } from './paint'

export const ALERT_INDICATOR_NAME = 'rebull-alerts'
export const ALERT_INDICATOR_ID = 'rebull-alerts-overlay'
const CANDLE_PANE_ID = 'candle_pane'
/** Below this bar width (px) the lines collapse to a tick and a count. */
export const COLLAPSE_BAR_SPACE = 2.5

export interface AlertEntry {
  items: AlertLineItem[]
}

const registry = new Map<string, AlertEntry>()
const registered = new WeakSet<object>()
let version = 0

export const getAlertEntry = (id: string): AlertEntry | undefined => registry.get(id)

export function registerAlertIndicator(klinecharts: typeof import('klinecharts')): void {
  if (registered.has(klinecharts)) return
  registered.add(klinecharts)
  klinecharts.registerIndicator<Record<string, number>, string, string>({
    name: ALERT_INDICATOR_NAME,
    shortName: 'Alerts',
    series: 'normal',
    precision: 2,
    figures: [],
    calcParams: [],
    calc: (dataList) => dataList.map(() => ({})),
    draw: ({ ctx, chart, indicator, bounding, yAxis }) => {
      const e = registry.get(indicator.id)
      if (!e || e.items.length === 0) return true
      try {
        const ops = planAlertLines(e.items, { y: (v) => yAxis.convertToPixel(v), left: 0, right: bounding.width, top: 0, bottom: bounding.height }, alertLineColors(), {
          collapsed: chart.getBarSpace().bar < COLLAPSE_BAR_SPACE,
        })
        paintOps(ctx, ops)
      } catch {
        /* a bad overlay must never break the chart */
      }
      return true
    },
  })
}

export function attachAlerts(chart: Chart, items: AlertLineItem[]): void {
  const have = registry.has(ALERT_INDICATOR_ID)
  registry.set(ALERT_INDICATOR_ID, { items })
  if (!have || !chart.getIndicators({ id: ALERT_INDICATOR_ID }).length) chart.createIndicator({ name: ALERT_INDICATOR_NAME, id: ALERT_INDICATOR_ID, paneId: CANDLE_PANE_ID }, true)
  else chart.overrideIndicator({ name: ALERT_INDICATOR_NAME, id: ALERT_INDICATOR_ID, calcParams: [String(++version)] })
}

export function detachAlerts(chart: Chart | null): void {
  registry.delete(ALERT_INDICATOR_ID)
  chart?.removeIndicator({ id: ALERT_INDICATOR_ID })
}
