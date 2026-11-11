import type { DockviewApi } from 'dockview-react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake } from '../src/lib/api'
import { AUTOSAVE_NAME } from '../src/workspace/defaultLayout'
import { flushAutosave, parseLayout, useLayoutStore } from '../src/workspace/layoutStore'
import { savedChartSymbol } from '../src/workspace/panelParams'
import { PANEL_IDS } from '../src/workspace/panelIds'
import { addMissingPanels, missingPanels } from '../src/workspace/restoreLayout'

beforeEach(() => {
  fake.reset()
  useLayoutStore.setState({ layouts: [], active: '' })
})

const layout = (panels: Record<string, unknown>) => JSON.stringify({ grid: { root: {} }, panels })

describe('F4 parseLayout sanitises params', () => {
  it('drops a non-string chart symbol and non-object params', () => {
    const v = parseLayout(
      layout({
        chart: { id: 'chart', contentComponent: 'chart', params: { symbol: 5, keep: 1 } },
        watchlist: { id: 'watchlist', contentComponent: 'watchlist', params: 'oops' },
        tm: { id: 'tm', contentComponent: 'tm', params: { symbol: 'AAPL' } },
      }),
    ) as { panels: Record<string, { params?: Record<string, unknown> }> }
    expect(v.panels.chart!.params).toEqual({ keep: 1 })
    expect(v.panels.watchlist!.params).toBeUndefined()
    expect(v.panels.tm!.params).toEqual({ symbol: 'AAPL' })
  })
  it('still rejects unknown components and bad shapes', () => {
    expect(parseLayout(layout({ x: { contentComponent: 'nope' } }))).toBeNull()
    expect(parseLayout('{')).toBeNull()
    expect(parseLayout(null)).toBeNull()
  })
})

describe('F4 saved chart symbol guard', () => {
  it('only accepts a valid string', () => {
    expect(savedChartSymbol({ symbol: 'aapl' })).toBe('AAPL')
    expect(savedChartSymbol({ symbol: 5 })).toBeNull()
    expect(savedChartSymbol({ symbol: { a: 1 } })).toBeNull()
    expect(savedChartSymbol({ symbol: '../x' })).toBeNull()
    expect(savedChartSymbol(undefined)).toBeNull()
    expect(savedChartSymbol(null)).toBeNull()
  })
})

describe('F4 restore adds missing default panels', () => {
  it('computes the missing ids', () => {
    expect(missingPanels(['chart', 'watchlist'])).toEqual(PANEL_IDS.filter((p) => p !== 'chart' && p !== 'watchlist'))
    expect(missingPanels([...PANEL_IDS])).toEqual([])
  })
  it('adds each absent panel next to a present reference, else next to any panel', () => {
    // stateful dock: a panel added earlier counts as open for the next one, like the real dockview
    const panels: Array<{ id: string }> = [{ id: 'chart' }, { id: 'positions' }]
    const added: Array<{ id: string; position?: { referencePanel: string; direction: string } }> = []
    const addPanel = vi.fn((o: { id: string; position?: { referencePanel: string; direction: string } }) => {
      added.push(o)
      panels.push({ id: o.id })
    })
    addMissingPanels({ panels, addPanel } as unknown as DockviewApi)
    expect(added.map((o) => o.id).sort()).toEqual(PANEL_IDS.filter((p) => p !== 'chart' && p !== 'positions').sort())
    expect(added.find((o) => o.id === 'ticket')!.position).toEqual({ referencePanel: 'chart', direction: 'left' })
    expect(added.find((o) => o.id === 'tm')!.position).toEqual({ referencePanel: 'chart', direction: 'right' })
    expect(added.find((o) => o.id === 'watchlist')!.position).toEqual({ referencePanel: 'tm', direction: 'below' })
    expect(added.find((o) => o.id === 'options')!.position).toEqual({ referencePanel: 'chart', direction: 'within' })
    expect(added.find((o) => o.id === 'orders')!.position).toEqual({ referencePanel: 'positions', direction: 'within' })
  })
  it('a lone missing watchlist goes below TM Insight when that is open, else tabbed with an open panel', () => {
    const a = vi.fn()
    addMissingPanels({ panels: PANEL_IDS.filter((p) => p !== 'watchlist').map((id) => ({ id })), addPanel: a } as unknown as DockviewApi)
    expect((a.mock.calls[0]![0] as { position: unknown }).position).toEqual({ referencePanel: 'tm', direction: 'below' })
    const b = vi.fn()
    addMissingPanels({ panels: [{ id: 'chart' }], addPanel: b } as unknown as DockviewApi)
    // dockview adds panels one at a time; with a static mock the watchlist's reference (tm) is not open yet
    const wl = (b.mock.calls.map((c) => c[0]) as Array<{ id: string; position?: { referencePanel: string; direction: string } }>).find((o) => o.id === 'watchlist')!
    expect(wl.position).toEqual({ referencePanel: 'chart', direction: 'within' })
  })
  it('falls back to any present panel when the reference is also missing, and to no position on an empty dock', () => {
    const a = vi.fn()
    addMissingPanels({ panels: [{ id: 'journal' }], addPanel: a } as unknown as DockviewApi)
    const ticket = (a.mock.calls.map((c) => c[0]) as Array<{ id: string; position?: { referencePanel: string } }>).find((o) => o.id === 'ticket')!
    expect(ticket.position?.referencePanel).toBeDefined()
    const b = vi.fn()
    addMissingPanels({ panels: [], addPanel: b } as unknown as DockviewApi)
    const first = b.mock.calls[0]![0] as { position?: unknown }
    expect(first.position).toBeUndefined()
  })
})

describe('F4 autosave flush', () => {
  it('flushAutosave writes the pending layout now, once', async () => {
    const json = layout({ chart: { contentComponent: 'chart' } })
    useLayoutStore.getState().autosave(json)
    expect(fake.layoutLoad(AUTOSAVE_NAME)).toBeNull()
    flushAutosave()
    await Promise.resolve()
    expect(fake.layoutLoad(AUTOSAVE_NAME)).toBe(json)
    const spy = vi.spyOn(api, 'layoutSave')
    flushAutosave()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
