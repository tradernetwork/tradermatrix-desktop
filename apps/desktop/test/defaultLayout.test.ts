import type { DockviewApi } from 'dockview-react'
import { describe, expect, it, vi } from 'vitest'
import { applyDefaultLayout, AUTOSAVE_NAME, toggleChartFocus } from '../src/workspace/defaultLayout'
import { PANEL_IDS } from '../src/workspace/panelIds'

type Opt = { id: string; initialWidth?: number; initialHeight?: number; inactive?: boolean; position?: { referencePanel: string; direction: string } }
const defaults = () => {
  const addPanel = vi.fn()
  applyDefaultLayout({ addPanel } as unknown as DockviewApi)
  return addPanel.mock.calls.map((c) => c[0] as Opt)
}

describe('applyDefaultLayout (M9 TM desk arrangement)', () => {
  it('adds all panels; the chart is the anchor and every reference exists before it is used', () => {
    const opts = defaults()
    expect(opts.map((o) => o.id).sort()).toEqual([...PANEL_IDS].sort())
    expect(opts.find((o) => o.id === 'chart')!.position).toBeUndefined() // dockview ignores initialWidth on the first panel
    const seen = new Set<string>()
    for (const o of opts) {
      if (o.position) expect(seen.has(o.position.referencePanel)).toBe(true)
      seen.add(o.id)
    }
  })

  it('order ticket LEFT of the chart, TM Insight RIGHT of it, watchlist BELOW TM Insight', () => {
    const opts = defaults()
    expect(opts.find((o) => o.id === 'ticket')!.position).toEqual({ referencePanel: 'chart', direction: 'left' })
    expect(opts.find((o) => o.id === 'tm')!.position).toEqual({ referencePanel: 'chart', direction: 'right' })
    expect(opts.find((o) => o.id === 'watchlist')!.position).toEqual({ referencePanel: 'tm', direction: 'below' })
  })

  it('options and journal stay tabbed with the chart; positions below it with orders tabbed in', () => {
    const opts = defaults()
    expect(opts.find((o) => o.id === 'options')!.position).toEqual({ referencePanel: 'chart', direction: 'within' })
    expect(opts.find((o) => o.id === 'journal')!.position).toEqual({ referencePanel: 'chart', direction: 'within' })
    expect(opts.find((o) => o.id === 'positions')!.position).toEqual({ referencePanel: 'chart', direction: 'below' })
    expect(opts.find((o) => o.id === 'orders')!.position).toEqual({ referencePanel: 'positions', direction: 'within' })
  })

  it('sizes: ticket 300, TM 320, watchlist ~260 high, bottom group 210', () => {
    const opts = defaults()
    expect(opts.find((o) => o.id === 'ticket')!.initialWidth).toBe(300)
    expect(opts.find((o) => o.id === 'tm')!.initialWidth).toBe(320)
    expect(opts.find((o) => o.id === 'watchlist')!.initialHeight).toBe(260)
    expect(opts.find((o) => o.id === 'positions')!.initialHeight).toBe(210)
  })
})

describe('R-stats panel (M18b)', () => {
  it('is tabbed with the journal by default (inactive) and old layouts pick it up through DEFAULT_ORDER', async () => {
    const opts = defaults()
    expect(opts.find((o) => o.id === 'rstats')!.position).toEqual({ referencePanel: 'journal', direction: 'within' })
    expect(opts.find((o) => o.id === 'rstats')!.inactive).toBe(true)
    const { DEFAULT_ORDER } = await import('../src/workspace/panelPlacement')
    expect(DEFAULT_ORDER).toContain('rstats')
    expect(DEFAULT_ORDER.indexOf('rstats')).toBeGreaterThan(DEFAULT_ORDER.indexOf('journal'))
  })
})

describe('layout key version', () => {
  it('the autosave slot is versioned so the pre-M9 arrangement is not restored over the new default', () => {
    expect(AUTOSAVE_NAME).toBe('__autosave_v2')
  })
})

describe('toggleChartFocus', () => {
  it('maximizes the chart group, and a second call restores the layout', () => {
    const chart = { id: 'chart' }
    let maxed = false
    const api = {
      getPanel: (id: string) => (id === 'chart' ? chart : undefined),
      hasMaximizedGroup: () => maxed,
      maximizeGroup: vi.fn(() => { maxed = true }),
      exitMaximizedGroup: vi.fn(() => { maxed = false }),
    } as unknown as DockviewApi
    expect(toggleChartFocus(api)).toBe(true)
    expect(api.maximizeGroup).toHaveBeenCalledWith(chart)
    expect(toggleChartFocus(api)).toBe(false)
    expect(api.exitMaximizedGroup).toHaveBeenCalled()
  })
  it('does nothing when there is no chart panel', () => {
    const api = { getPanel: () => undefined, hasMaximizedGroup: () => false, maximizeGroup: vi.fn(), exitMaximizedGroup: vi.fn() } as unknown as DockviewApi
    expect(toggleChartFocus(api)).toBe(false)
    expect(api.maximizeGroup).not.toHaveBeenCalled()
  })
})
