import type { DockviewApi } from 'dockview-react'
import { BOTTOM_COLLAPSED_PX, BOTTOM_DEFAULT_PX, bottomHeight, railWidths } from '../lib/layoutBudget'
import { PANEL_TITLES, type PanelId } from './panelIds'
import { DEFAULT_ORDER, PLACEMENT } from './panelPlacement'

/** Versioned slot: the pre-M9 arrangement saved under '__autosave' is not restored over the TM desk default (named layouts are untouched). Bump when the default changes.
 *  M22 moved to _v3 (shorter bottom group, narrower rails on small windows): the old _v2 slot is ignored, not migrated. */
export const AUTOSAVE_NAME = '__autosave_v3'

/** TM desk arrangement (see panelPlacement.ts): ticket left, chart centre, TM Insight right with the watchlist below it, positions and orders below the chart. */
export function applyDefaultLayout(api: DockviewApi): void {
  // M22: size the rails and the bottom group from the dock when it is measured; unknown size (tests, first paint) keeps the static placement
  const w = Number(api.width) || 0
  const h = Number(api.height) || 0
  const sized: Partial<Record<PanelId, Record<string, number>>> = {}
  if (w > 0) {
    const r = railWidths(w)
    sized.ticket = { initialWidth: r.ticketPx }
    sized.tm = { initialWidth: r.tmPx }
  }
  if (h > 0) sized.positions = { initialHeight: bottomHeight(h) }
  for (const id of DEFAULT_ORDER) {
    const p = PLACEMENT[id]
    api.addPanel({
      id,
      component: id,
      title: PANEL_TITLES[id],
      ...p.extra,
      ...sized[id],
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

let savedBottom: number | null = null

/**
 * One-click collapse of the Positions / Orders / Alerts group to its tab strip, and back to the height it had (M22). Returns true when it is
 * collapsed now. Does nothing (false) when the group is missing or shares a group with the chart (the user rearranged the panes).
 */
export function toggleBottomPanel(api: DockviewApi): boolean {
  const g = api.getPanel('positions')?.group
  const chart = api.getPanel('chart')?.group
  if (!g || g === chart) return false
  const h = g.height
  if (h > BOTTOM_COLLAPSED_PX + 12) {
    savedBottom = h
    g.api.setConstraints({ minimumHeight: BOTTOM_COLLAPSED_PX })
    g.api.setSize({ height: BOTTOM_COLLAPSED_PX })
    return true
  }
  g.api.setSize({ height: savedBottom ?? BOTTOM_DEFAULT_PX })
  return false
}

/** True when the bottom group is currently at (or near) its collapsed height. */
export function bottomCollapsed(api: DockviewApi): boolean {
  const g = api.getPanel('positions')?.group
  return !!g && g.height <= BOTTOM_COLLAPSED_PX + 12
}
