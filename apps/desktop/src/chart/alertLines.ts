/**
 * Pure planner for alert lines on the chart (M17 task 6). Dashed line + a chip with a bell at the right edge; alerts within 6 px stack into one chip
 * with a count; zoomed out they collapse to a tick and a count. No canvas, no KLineChart types. Lines clip to the visible price range and add nothing
 * to the y-axis (the indicator has no figures). INFORM ONLY: this file never touches an order or the ticket.
 */
import { readCssVar } from './chartTheme'
import type { DrawOp } from './drawPlan'
import { CHIP_H, fmtLevel, spreadLabels } from './tmOverlay'

/** Alerts whose lines are this close (px) share one chip. */
export const STACK_PX = 6
/** Right edge offset of the chip from the pane edge (keeps clear of the left level chips and the axis). */
export const CHIP_OFFSET_PX = 14
export const BELL = '\u{1F514}'

export interface AlertLineItem {
  id: number
  price: number
  dir: 'up' | 'down' | 'either'
  state: 'armed' | 'snoozed' | 'off'
  /** Just fired: drawn heavier for a moment. */
  flash: boolean
  /** Short reference text for a by-reference alert ("APEX #2"), '' for a manual one. */
  tag: string
}

export interface AlertLineColors {
  gold: string
  up: string
  down: string
  muted: string
  ink: string
}

export const alertLineColors = (): AlertLineColors => ({
  gold: readCssVar('--tm-gold', '#d4a62a'),
  up: readCssVar('--tm-up', '#ffc93c'),
  down: readCssVar('--tm-down', '#9cb8e6'),
  muted: readCssVar('--tm-text-muted', '#6c7a92'),
  ink: readCssVar('--tm-chip-ink', '#070e1f'),
})

/** Linear price axis from two known (y, price) pairs: lets a drag and its tests convert both ways without the chart. */
export function axisFrom(y1: number, p1: number, y2: number, p2: number): { toY: (p: number) => number; toPrice: (y: number) => number } {
  const k = (p2 - p1) / (y2 - y1)
  return { toY: (p) => y1 + (p - p1) / k, toPrice: (y) => p1 + (y - y1) * k }
}

export interface Stack {
  y: number
  ids: number[]
  count: number
}

/** Greedy, top to bottom: an item within `tol` px of the group's first line joins the group. */
export function stackAlerts(items: readonly { id: number; y: number }[], tol: number = STACK_PX): Stack[] {
  const sorted = [...items].filter((i) => Number.isFinite(i.y)).sort((a, b) => a.y - b.y || a.id - b.id)
  const out: Stack[] = []
  for (const it of sorted) {
    const g = out[out.length - 1]
    if (g && it.y - g.y <= tol) {
      g.ids.push(it.id)
      g.count += 1
    } else out.push({ y: it.y, ids: [it.id], count: 1 })
  }
  return out
}

export interface AlertMapper {
  y: (price: number) => number
  left: number
  right: number
  top: number
  bottom: number
}

const colorOf = (i: AlertLineItem, c: AlertLineColors): string => (i.state === 'snoozed' ? c.muted : i.dir === 'up' ? c.up : i.dir === 'down' ? c.down : c.gold)

export function planAlertLines(items: readonly AlertLineItem[], m: AlertMapper, c: AlertLineColors, o: { collapsed: boolean }): DrawOp[] {
  const vis = items
    .filter((i) => i.state !== 'off' && Number.isFinite(i.price) && i.price > 0)
    .map((i) => ({ i, y: m.y(i.price) }))
    .filter((x) => Number.isFinite(x.y) && x.y >= m.top && x.y <= m.bottom)
  const byId = new Map(vis.map((x) => [x.i.id, x]))
  const stacks = stackAlerts(vis.map((x) => ({ id: x.i.id, y: x.y })))
  const ops: DrawOp[] = []
  const chips: { y: number; text: string; color: string }[] = []
  for (const g of stacks) {
    const first = byId.get(g.ids[0]!)!.i
    const flash = g.ids.some((id) => byId.get(id)!.i.flash)
    const color = colorOf(first, c)
    if (o.collapsed) {
      ops.push({ kind: 'hline', y: g.y, color, width: flash ? 3 : 1.5, dash: [], x0: m.right - 14, x1: m.right - 2 })
      ops.push({ kind: 'label', text: `x${g.count}`, x: m.right - 16, y: g.y + 4, color, align: 'right' })
      continue
    }
    ops.push({ kind: 'hline', y: g.y, color, width: flash ? 3 : 1.25, dash: [3, 3], x0: m.left, x1: m.right, alpha: flash ? 1 : 0.85 })
    const text = g.count > 1 ? `${BELL} x${g.count} ${fmtLevel(first.price)}` : `${BELL} ${first.tag ? `${first.tag} ` : ''}${fmtLevel(first.price)}`
    chips.push({ y: g.y, text, color })
  }
  const lo = m.top + CHIP_H / 2
  const hi = Math.max(lo, m.bottom - CHIP_H / 2)
  const ys = spreadLabels(chips.map((x) => x.y), CHIP_H + 1, lo, hi)
  chips.forEach((ch, k) => ops.push({ kind: 'chip', text: ch.text, x: m.right - CHIP_OFFSET_PX, y: ys[k]!, color: ch.color, ink: c.ink, align: 'right' }))
  return ops
}
