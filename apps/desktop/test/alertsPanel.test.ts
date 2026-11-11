import type { DockviewApi } from 'dockview-react'
import { describe, expect, it, vi } from 'vitest'
import { rollupInputs } from '../devPages'
import { applyDefaultLayout } from '../src/workspace/defaultLayout'
import { PANEL_IDS, PANEL_TITLES } from '../src/workspace/panelIds'
import { PLACEMENT } from '../src/workspace/panelPlacement'
import { addMissingPanels } from '../src/workspace/restoreLayout'

describe('Alerts panel registration (M17 task 5)', () => {
  it('is a known panel, titled Alerts, tabbed with Positions/Orders by default (inactive)', () => {
    expect(PANEL_IDS).toContain('alerts')
    expect(PANEL_TITLES.alerts).toBe('Alerts')
    expect(PLACEMENT.alerts).toMatchObject({ ref: 'positions', direction: 'within' })
    expect(PLACEMENT.alerts.extra).toMatchObject({ inactive: true })
    const addPanel = vi.fn()
    applyDefaultLayout({ addPanel } as unknown as DockviewApi)
    const o = addPanel.mock.calls.map((c) => c[0]).find((x) => x.id === 'alerts')
    expect(o.position).toEqual({ referencePanel: 'positions', direction: 'within' })
  })

  it('an old saved layout without it gets it through addMissingPanels', () => {
    const add = vi.fn()
    const present = PANEL_IDS.filter((p) => p !== 'alerts')
    addMissingPanels({ panels: present.map((id) => ({ id })), addPanel: add } as unknown as DockviewApi)
    expect(add).toHaveBeenCalledTimes(1)
    expect(add.mock.calls[0]![0]).toMatchObject({ id: 'alerts', component: 'alerts', position: { referencePanel: 'positions', direction: 'within' } })
  })

  it('the alerts dev page is built only with REBULL_DEV_PAGES=1', () => {
    expect(Object.keys(rollupInputs({}))).toEqual(['main'])
    expect(rollupInputs({ REBULL_DEV_PAGES: '1' }).alertsDev).toBe('alerts-dev.html')
  })
})
