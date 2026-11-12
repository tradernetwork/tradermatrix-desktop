/**
 * M22 layout polish: pure sizing rules for the app shell. Nothing here touches the DOM, so the numbers are unit-tested in node.
 * The CSS in styles/app.css uses the same constants (rows are fixed heights, never two-row wraps), so `layoutBudget` predicts the
 * chart plot height; the real window is the final judge (the dev page workspace-dev.html is measured in a browser).
 */

export type Density = 'compact' | 'comfortable'
export type StripMode = 'line' | 'cards'

/** Local settings (setting_get / setting_set). Density absent = automatic by window width. */
export const UI_DENSITY_KEY = 'ui.density'
export const UI_STRIP_KEY = 'ui.metricsStrip'

/** Below this window width the automatic density is compact. */
export const COMPACT_BELOW_PX = 1300

export const parseDensity = (v: string | null | undefined): Density | null => {
  const s = (v ?? '').trim().toLowerCase()
  return s === 'compact' || s === 'comfortable' ? s : null
}
export const autoDensity = (width: number): Density => (width < COMPACT_BELOW_PX ? 'compact' : 'comfortable')
export const resolveDensity = (saved: Density | null, width: number): Density => saved ?? autoDensity(width)
export const parseStrip = (v: string | null | undefined): StripMode => ((v ?? '').trim().toLowerCase() === 'cards' ? 'cards' : 'line')

// ---- fixed row heights (px), mirrored by the CSS custom properties on .app[data-density] ----
export const BANNER_PX = 24
export const ROW_PX: Record<Density, { toolbar: number; header: number; strip: number; card: number; chartRow: number }> = {
  compact: { toolbar: 36, header: 32, strip: 26, card: 46, chartRow: 26 },
  comfortable: { toolbar: 44, header: 44, strip: 28, card: 54, chartRow: 30 },
}
export const CARD_MIN_PX = 110
export const CARD_COUNT = 7
const GAP_PX = 6
const CARD_PAD_PX = 8
export const DOCK_TAB_PX = 35
export const SASH_PX = 4
export const BOTTOM_DEFAULT_PX = 150
/** Initial height of the Positions / Orders / Alerts group: 150 px, or a quarter of a short dock. User-resizable. */
export const bottomHeight = (workspacePx: number): number => Math.min(BOTTOM_DEFAULT_PX, Math.round(workspacePx * 0.25))
/** The Positions / Orders / Alerts group shrinks to its tab strip when collapsed. */
export const BOTTOM_COLLAPSED_PX = DOCK_TAB_PX
/** The volume sub-pane (volumeIndicator.ts VOL_PANE_HEIGHT) and the time axis under it. */
export const VOL_PANE_PX = 110
export const AXIS_PX = 28
/** Side rails of the default layout: narrower under COMPACT_BELOW_PX so the chart keeps its width. */
export const railWidths = (width: number): { ticketPx: number; tmPx: number } => (width < COMPACT_BELOW_PX ? { ticketPx: 260, tmPx: 290 } : { ticketPx: 300, tmPx: 320 })

/** Estimated widths of the chart pane's toolbar groups (symbol+timeframes, volume mode, TM layers, desk layers, status). They wrap as whole groups. */
const CHART_HEAD_ITEMS_PX = [440, 300, 400, 120, 190]
const CHART_HEAD_GAP_PX = 8

/** Greedy row packing of flex-wrapped items (left to right, `gap` between neighbours). */
export function packRows(widths: readonly number[], avail: number, gap: number): number {
  if (widths.length === 0) return 0
  let rows = 1
  let used = 0
  for (const w of widths) {
    if (used === 0) used = w
    else if (used + gap + w <= avail) used += gap + w
    else {
      rows++
      used = w
    }
  }
  return rows
}

export interface BudgetInput {
  width: number
  height: number
  density?: Density
  strip?: StripMode
  /** FAKE DATA banner row present (dev page, tests); the shipped app has none. */
  banner?: boolean
}

export interface Budget {
  density: Density
  bannerPx: number
  toolbarPx: number
  headerPx: number
  stripPx: number
  /** Height left for the dock (chart group + bottom group). */
  workspacePx: number
  bottomPx: number
  chartGroupPx: number
  ticketPx: number
  tmPx: number
  chartWidthPx: number
  chartHeadRows: number
  chartHeadPx: number
  /** Chart canvas (candle pane + volume pane + time axis). */
  chartCanvasPx: number
  /** Candle pane only: where the candles and the TM level chips live. */
  plotPx: number
}

/** Number of rows the metric cards take at this width (wrapping flex row, 110 px minimum, 6 px gap, 10 px side padding, 24 px collapse toggle). */
export function cardRows(width: number): number {
  const per = Math.max(1, Math.floor((width - 20 - 30 + GAP_PX) / (CARD_MIN_PX + GAP_PX)))
  return Math.ceil(CARD_COUNT / per)
}

export function layoutBudget(i: BudgetInput): Budget {
  const density = i.density ?? autoDensity(i.width)
  const r = ROW_PX[density]
  const bannerPx = i.banner ? BANNER_PX : 0
  const stripPx = (i.strip ?? 'line') === 'cards' ? cardRows(i.width) * r.card + (cardRows(i.width) - 1) * GAP_PX + CARD_PAD_PX : r.strip
  const toolbarPx = r.toolbar
  const headerPx = r.header
  const workspacePx = Math.max(0, i.height - bannerPx - toolbarPx - headerPx - stripPx)
  const bottomPx = bottomHeight(workspacePx)
  const chartGroupPx = Math.max(0, workspacePx - bottomPx - SASH_PX)
  const { ticketPx, tmPx } = railWidths(i.width)
  const chartWidthPx = Math.max(0, i.width - ticketPx - tmPx - 2 * SASH_PX)
  const chartHeadRows = packRows(CHART_HEAD_ITEMS_PX, chartWidthPx - 20, CHART_HEAD_GAP_PX)
  const chartHeadPx = chartHeadRows * r.chartRow + (chartHeadRows - 1) * 4 + 8
  const chartCanvasPx = Math.max(0, chartGroupPx - DOCK_TAB_PX - chartHeadPx)
  const plotPx = Math.max(0, chartCanvasPx - VOL_PANE_PX - AXIS_PX)
  return { density, bannerPx, toolbarPx, headerPx, stripPx, workspacePx, bottomPx, chartGroupPx, ticketPx, tmPx, chartWidthPx, chartHeadRows, chartHeadPx, chartCanvasPx, plotPx }
}

// ---- toolbar: what stays, what collapses, as a pure function of the toolbar width ----

export const TOOLBAR_MIN_PX = 1000
export type ToolbarOverflowId = 'secrets' | 'about' | 'lock' | 'density' | 'bottom'
export interface ToolbarPlan {
  /** Robinhood scope note next to Connect. */
  scope: boolean
  /** Wordmark text and "DESKTOP" next to the mark. */
  brandText: boolean
  /** TM key / quota pills as dots with tooltips. */
  tmDots: boolean
  /** Items moved into the "..." menu, in menu order. */
  overflow: ToolbarOverflowId[]
  /** Estimated width the plan needs; always <= the width it was planned for (from TOOLBAR_MIN_PX). */
  usedPx: number
}

// fixed part: padding 20 + mark 24 + layouts 96 + focus chart 92 + panels 72 + TM key button 62 + two TM pills 230 + Connect 150, with 8 px gaps
const FIXED_PX = 20 + 24 + 96 + 92 + 72 + 62 + 230 + 150 + 8 * 8
const DOTS_SAVING_PX = 2 * (112 - 22)
const OVERFLOW_BTN_PX = 36 + 8
const SCOPE_PX = 260 + 8
const BRAND_TEXT_PX = 150 + 8
const OVERFLOW_ITEMS: ReadonlyArray<{ id: ToolbarOverflowId; px: number }> = [
  { id: 'secrets', px: 160 },
  { id: 'about', px: 68 },
  { id: 'lock', px: 92 },
  { id: 'density', px: 104 },
  { id: 'bottom', px: 84 },
]

export function planToolbar(width: number): ToolbarPlan {
  const plan: ToolbarPlan = { scope: true, brandText: true, tmDots: false, overflow: [], usedPx: 0 }
  const used = () => {
    const inline = OVERFLOW_ITEMS.filter((o) => !plan.overflow.includes(o.id)).reduce((a, o) => a + o.px + 8, 0)
    return (
      FIXED_PX +
      inline +
      (plan.scope ? SCOPE_PX : 0) +
      (plan.brandText ? BRAND_TEXT_PX : 0) -
      (plan.tmDots ? DOTS_SAVING_PX : 0) +
      (plan.overflow.length > 0 ? OVERFLOW_BTN_PX : 0)
    )
  }
  // drop order: scope note, wordmark text, TM pills to dots, then items into the "..." menu (least important first)
  const steps: Array<() => void> = [
    () => (plan.scope = false),
    () => (plan.brandText = false),
    () => (plan.tmDots = true),
    ...(['secrets', 'about', 'density', 'lock', 'bottom'] as ToolbarOverflowId[]).map((id) => () => plan.overflow.push(id)),
  ]
  for (const step of steps) {
    if (used() <= width) break
    step()
  }
  plan.overflow = OVERFLOW_ITEMS.map((o) => o.id).filter((id) => plan.overflow.includes(id))
  plan.usedPx = used()
  return plan
}

// ---- desk header chips: full pills -> dots -> "..." popover ----

export interface ChipsPlan {
  mode: 'full' | 'dots'
  /** Status chips shown inline (the rest are in the popover). */
  visible: number
  /** ATR / range stats shown inline as plain text. */
  showStats: boolean
  /** Items in the popover (a "..." button is drawn when > 0). */
  moreCount: number
  usedPx: number
}

const CHIP_GAP_PX = 6
const MORE_BTN_PX = 30
export const chipFullPx = (text: string): number => Math.ceil(text.length * 6.3) + 30
export const chipDotPx = 14
export const statTextPx = (text: string): number => Math.ceil(text.length * 6.3) + 4

const sumGap = (ws: number[]): number => (ws.length === 0 ? 0 : ws.reduce((a, b) => a + b, 0) + (ws.length - 1) * CHIP_GAP_PX)

export function planChips(avail: number, statusTexts: readonly string[], statTexts: readonly string[]): ChipsPlan {
  const n = statusTexts.length
  const total = n + statTexts.length
  if (total === 0) return { mode: 'full', visible: 0, showStats: true, moreCount: 0, usedPx: 0 }
  const fullW = [...statusTexts.map(chipFullPx), ...statTexts.map(chipFullPx)]
  if (sumGap(fullW) <= avail) return { mode: 'full', visible: n, showStats: true, moreCount: 0, usedPx: sumGap(fullW) }
  const dotW = statusTexts.map(() => chipDotPx)
  const statW = statTexts.map(statTextPx)
  const withStats = sumGap([...dotW, ...statW])
  if (withStats <= avail) return { mode: 'dots', visible: n, showStats: true, moreCount: 0, usedPx: withStats }
  // stats move into the popover; then fewer and fewer dots stay
  for (let v = n; v >= 0; v--) {
    const more = n - v + statTexts.length
    const w = sumGap([...dotW.slice(0, v), ...(more > 0 ? [MORE_BTN_PX] : [])])
    if (w <= avail) return { mode: 'dots', visible: v, showStats: false, moreCount: more, usedPx: w }
  }
  return { mode: 'dots', visible: 0, showStats: false, moreCount: total, usedPx: MORE_BTN_PX }
}

// ---- condensed metrics line ----

export interface StripValues {
  equity: string
  buyingPower: string
  cash: string
  pnl: string
  orders: string
  approvals: string
  /** CSS class for the P&L value (bull / bear / empty). */
  pnlCls?: string
}

/** 'Equity $x . BP $x . Cash $x . P&L $x . Orders n . Approvals n' as label/value pairs (the component prints the separators). */
export function stripLine(v: StripValues): Array<{ k: string; v: string; cls?: string }> {
  return [
    { k: 'Equity', v: v.equity },
    { k: 'BP', v: v.buyingPower },
    { k: 'Cash', v: v.cash },
    { k: 'P&L', v: v.pnl, cls: v.pnlCls },
    { k: 'Orders', v: v.orders },
    { k: 'Approvals', v: v.approvals },
  ]
}
