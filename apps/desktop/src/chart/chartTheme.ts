import type { DeepPartial, Styles } from 'klinecharts'

type VarReader = (name: string, fallback: string) => string

/** Read a CSS custom property from :root, falling back when it is missing (tests, SSR). */
export const readCssVar: VarReader = (name, fallback) => {
  if (typeof document === 'undefined') return fallback
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

/** The TraderMatrix desk chart palette (ProjectX Desk `desk.js` C): gold up, steel down, light down wick. Mirrors tokens.css. */
export const CHART_PALETTE = {
  up: '#FFC93C',
  down: '#9CB8E6',
  downWick: '#E4EEFF',
  flat: '#8D9BB4',
  grid: 'rgba(200,216,238,.07)',
  axis: '#1A2238',
  text: '#6C7A92',
  /** Derived (not in the plan): the desk's dimmest text tone. */
  crosshair: '#56637A',
} as const

/** Mono face for axis numbers (the face is bundled, see styles/fonts.css). */
export const CHART_FONT = "'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace"

/** KLineChart styles from the theme tokens in src/styles/tokens.css (--tm-up / --tm-down / --tm-down-wick / --tm-flat ...). */
export function chartStyles(v: VarReader = readCssVar): DeepPartial<Styles> {
  const up = v('--tm-up', CHART_PALETTE.up)
  const down = v('--tm-down', CHART_PALETTE.down)
  const downWick = v('--tm-down-wick', CHART_PALETTE.downWick)
  const flat = v('--tm-flat', CHART_PALETTE.flat)
  const grid = v('--tm-grid', CHART_PALETTE.grid)
  const axis = v('--tm-axis', CHART_PALETTE.axis)
  const text = v('--tm-chart-text', CHART_PALETTE.text)
  const cross = v('--tm-crosshair', CHART_PALETTE.crosshair)
  const mono = v('--font-mono', CHART_FONT)
  return {
    grid: { horizontal: { color: grid }, vertical: { color: grid } },
    candle: {
      bar: {
        upColor: up,
        downColor: down,
        noChangeColor: flat,
        upBorderColor: up,
        downBorderColor: down,
        noChangeBorderColor: flat,
        upWickColor: up,
        downWickColor: downWick,
        noChangeWickColor: flat,
      },
      priceMark: { last: { upColor: up, downColor: down, noChangeColor: flat } },
    },
    xAxis: { axisLine: { color: axis }, tickLine: { color: axis }, tickText: { color: text, family: mono } },
    yAxis: { axisLine: { color: axis }, tickLine: { color: axis }, tickText: { color: text, family: mono } },
    separator: { color: axis },
    crosshair: { horizontal: { line: { color: cross } }, vertical: { line: { color: cross } } },
  }
}
