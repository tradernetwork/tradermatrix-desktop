import { describe, expect, it } from 'vitest'
import { alertLineColors, axisFrom, planAlertLines, stackAlerts, STACK_PX, type AlertLineItem } from '../src/chart/alertLines'
import { ALERT_INDICATOR_NAME, registerAlertIndicator } from '../src/chart/alertIndicator'

const item = (over: Partial<AlertLineItem> = {}): AlertLineItem => ({ id: 1, price: 100, dir: 'up', state: 'armed', flash: false, tag: '', ...over })
const mapper = { y: (p: number) => 400 - p * 2, left: 0, right: 800, top: 0, bottom: 400 }
const COLORS = alertLineColors()

describe('alert line geometry (task 6)', () => {
  it('pixel -> price -> pixel round trips within 0.005', () => {
    const ax = axisFrom(120, 190, 320, 150)
    for (const p of [150, 163.37, 171.011, 190, 188.99]) expect(Math.abs(ax.toPrice(ax.toY(p)) - p)).toBeLessThan(0.005)
    expect(Math.abs(ax.toY(ax.toPrice(237)) - 237)).toBeLessThan(0.005)
  })
  it('two alerts 4 px apart stack into one chip with a count; 7 px apart stay separate', () => {
    const g = stackAlerts([{ id: 1, y: 100 }, { id: 2, y: 104 }, { id: 3, y: 111 }], STACK_PX)
    expect(g.map((x) => x.ids)).toEqual([[1, 2], [3]])
    expect(g[0]!.count).toBe(2)
  })
  it('the plan draws a dashed line and one chip per group, with the count in the chip text', () => {
    const ops = planAlertLines([item({ id: 1, price: 100 }), item({ id: 2, price: 99 })], mapper, COLORS, { collapsed: false })
    expect(ops.filter((o) => o.kind === 'hline').length).toBe(1)
    const chips = ops.filter((o) => o.kind === 'chip')
    expect(chips.length).toBe(1)
    expect((chips[0] as { text: string }).text).toContain('x2')
  })
  it('lines outside the visible price range are not drawn (they never stretch the axis, they clip)', () => {
    expect(planAlertLines([item({ price: 1000 })], mapper, COLORS, { collapsed: false })).toEqual([])
    expect(planAlertLines([item({ price: -5 })], mapper, COLORS, { collapsed: false })).toEqual([])
  })
  it('zoomed out: a tick and a count, no full line', () => {
    const ops = planAlertLines([item()], mapper, COLORS, { collapsed: true })
    expect(ops.some((o) => o.kind === 'chip' || o.kind === 'label')).toBe(true)
    expect(ops.filter((o) => o.kind === 'hline').every((o) => ((o as { x1: number; x0: number }).x1 - (o as { x0: number }).x0) <= 16)).toBe(true)
  })
  it('colors: gold for either, up/down tokens by direction, muted when snoozed, flash is heavier', () => {
    const color = (i: AlertLineItem) => (planAlertLines([i], mapper, COLORS, { collapsed: false }).find((o) => o.kind === 'hline') as { color: string; width: number })
    expect(color(item({ dir: 'either' })).color).toBe(COLORS.gold)
    expect(color(item({ dir: 'up' })).color).toBe(COLORS.up)
    expect(color(item({ dir: 'down' })).color).toBe(COLORS.down)
    expect(color(item({ state: 'snoozed' })).color).toBe(COLORS.muted)
    expect(color(item({ flash: true })).width).toBeGreaterThan(color(item()).width)
  })
  it('the indicator has no figures (the y-axis never stretches) and registers once', () => {
    const reg: { template?: Record<string, unknown>; n: number } = { n: 0 }
    const klc = { registerIndicator: (t: Record<string, unknown>) => ((reg.template = t), (reg.n += 1)) } as unknown as typeof import('klinecharts')
    registerAlertIndicator(klc)
    registerAlertIndicator(klc)
    expect(reg.n).toBe(1)
    expect(reg.template!.name).toBe(ALERT_INDICATOR_NAME)
    expect((reg.template!.figures as unknown[]).length).toBe(0)
  })
})
