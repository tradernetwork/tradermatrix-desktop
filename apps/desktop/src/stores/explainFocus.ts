/**
 * "Ask about this" state (M16 B4). EXPLAIN ONLY: this store opens a one-item menu and holds the chosen focus. It NEVER sends: the explain
 * pane prefills its question box from `focus` and the user presses Send. It does not import the explain store or any order module.
 * Host panes (chart, ladder, positions, journal, strike check) call only `askAbout` from here.
 */
import { create } from 'zustand'
import { buildFocus, type AskSpec, type Focus } from '../lib/explainFocus'
import { useChartContext } from './chartContext'

export type PendingFocus = Focus & { id: number }
export interface AskMenu {
  x: number
  y: number
  focus: Focus
}
interface FocusStore {
  /** The menu waiting for a click (null = closed). */
  menu: AskMenu | null
  /** The chosen focus: prefilled into the question box, attached to the next question. */
  focus: PendingFocus | null
  setMenu: (m: AskMenu | null) => void
  setFocus: (f: Focus | null) => void
  clearFocus: () => void
  reset: () => void
}

let seq = 0
export const useFocusStore = create<FocusStore>((set) => ({
  menu: null,
  focus: null,
  setMenu: (menu) => set({ menu }),
  setFocus: (f) => set({ focus: f ? { ...f, id: ++seq } : null, menu: null }),
  clearFocus: () => set({ focus: null }),
  reset: () => set({ menu: null, focus: null }),
}))

/** Right click handler body for a host: describes what was clicked and opens the menu at the pointer. Opens nothing when there is nothing to describe. */
export function askAbout(spec: AskSpec, at: { x: number; y: number }): void {
  const cc = useChartContext.getState().chart
  const focus = buildFocus(spec, { symbol: cc?.symbol ?? null, tf: cc?.tf ?? null, last: cc?.last ?? null })
  if (!focus || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return
  useFocusStore.getState().setMenu({ x: at.x, y: at.y, focus })
}

/** The menu item: keeps the focus (the pane prefills the question). Sends nothing. */
export function confirmAskAbout(): void {
  const m = useFocusStore.getState().menu
  if (m) useFocusStore.getState().setFocus(m.focus)
}
export function dismissAskAbout(): void {
  useFocusStore.getState().setMenu(null)
}
