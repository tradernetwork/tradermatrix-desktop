import type { DockviewApi } from 'dockview-react'
import { PANEL_IDS, PANEL_TITLES, type PanelId } from './panelIds'
import { DEFAULT_ORDER, PLACEMENT, RESTORE_OVERRIDE } from './panelPlacement'

/** Panel ids that are not in `present`, in the default creation order. */
export function missingPanels(present: readonly string[]): PanelId[] {
  return PANEL_IDS.filter((id) => !present.includes(id))
}

/**
 * Adds one panel (used by the Panels menu and by restore). Placed next to its usual neighbour when that panel is
 * open, else tabbed with any open panel, else on its own. Returns false when it is already open.
 */
export function addPanelById(dock: DockviewApi, id: PanelId, restore = true): boolean {
  const open = dock.panels.map((p) => p.id)
  if (open.includes(id)) return false
  const place = restore && RESTORE_OVERRIDE[id] ? RESTORE_OVERRIDE[id]! : { ref: PLACEMENT[id].ref, direction: PLACEMENT[id].direction }
  const opts: Record<string, unknown> = { id, component: id, title: PANEL_TITLES[id], ...PLACEMENT[id].extra }
  if (place.ref && open.includes(place.ref)) opts.position = { referencePanel: place.ref, direction: place.direction }
  else if (open.length > 0) opts.position = { referencePanel: open[0]!, direction: 'within' }
  dock.addPanel(opts as unknown as Parameters<DockviewApi['addPanel']>[0])
  return true
}

/** After ANY saved layout is restored: bring back default panels that are absent (an old layout may predate a panel, or one was closed). */
export function addMissingPanels(dock: DockviewApi): void {
  for (const id of DEFAULT_ORDER) addPanelById(dock, id, true)
}
