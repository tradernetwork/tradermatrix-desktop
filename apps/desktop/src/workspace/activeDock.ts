import type { DockviewApi } from 'dockview-react'

let dock: DockviewApi | null = null

/** The workspace's dockview api, for recovery actions that live outside the toolbar (error boundary "Reset layout"). */
export function setActiveDock(d: DockviewApi | null): void {
  dock = d
}
export function getActiveDock(): DockviewApi | null {
  return dock
}
