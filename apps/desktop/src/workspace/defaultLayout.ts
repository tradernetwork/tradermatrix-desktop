import type { DockviewApi } from 'dockview-react'
import { PANEL_TITLES } from './panelIds'
import { DEFAULT_ORDER, PLACEMENT } from './panelPlacement'

/** Versioned slot: the pre-M9 arrangement saved under '__autosave' is not restored over the TM desk default (named layouts are untouched). Bump when the default changes. */
export const AUTOSAVE_NAME = '__autosave_v2'

/** TM desk arrangement (see panelPlacement.ts): ticket left, chart centre, TM Insight right with the watchlist below it, positions and orders below the chart. */
export function applyDefaultLayout(api: DockviewApi): void {
  for (const id of DEFAULT_ORDER) {
    const p = PLACEMENT[id]
    api.addPanel({
      id,
      component: id,
      title: PANEL_TITLES[id],
      ...p.extra,
      ...(p.ref ? { position: { referencePanel: p.ref, direction: p.direction } } : {}),
    } as Parameters<DockviewApi['addPanel']>[0])
  }
}

/** Maximizes the chart's group (or restores the layout if something is already maximized). Returns true when the chart is now maximized. */
export function toggleChartFocus(api: DockviewApi): boolean {
  if (api.hasMaximizedGroup()) {
    api.exitMaximizedGroup()
    return false
  }
  const chart = api.getPanel('chart')
  if (!chart) return false
  api.maximizeGroup(chart)
  return true
}
