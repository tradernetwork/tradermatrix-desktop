import type { DockviewApi } from 'dockview-react'
import { create } from 'zustand'
import { api, type LayoutMeta } from '../lib/api'
import { AUTOSAVE_NAME, applyDefaultLayout } from './defaultLayout'
import { PANEL_IDS } from './panelIds'
import { addMissingPanels } from './restoreLayout'

export interface LayoutState {
  layouts: LayoutMeta[]
  active: string
  refresh(): Promise<void>
  saveAs(name: string, json: string): Promise<void>
  load(name: string, api: DockviewApi): Promise<void>
  remove(name: string): Promise<void>
  autosave(json: string): void
  reset(api: DockviewApi): void
}

/** Every autosave slot ('__autosave' from before M9 and the current versioned one) is hidden from the layouts list. */
export const isAutosaveName = (name: string): boolean => name.startsWith('__autosave')

const AUTOSAVE_MS = 800
let timer: ReturnType<typeof setTimeout> | undefined
/** The layout the timer is about to write; flushAutosave() writes it now. */
let pendingJson: string | null = null

/** Writes a pending autosave immediately (window closing or hidden). Best effort: the webview may die before the write lands. */
export function flushAutosave(): void {
  if (timer !== undefined) clearTimeout(timer)
  timer = undefined
  const json = pendingJson
  pendingJson = null
  if (json === null) return
  api.layoutSave(AUTOSAVE_NAME, json).catch(() => {
    /* autosave is best effort */
  })
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Shape check; DB content is untrusted, so also require every panel to be one we know how to render, and strip
 * panel params that are not what the panel expects (params must be an object, a chart `symbol` must be a string).
 */
export function parseLayout(json: string | null): unknown | null {
  if (json === null) return null
  let v: unknown
  try {
    v = JSON.parse(json)
  } catch {
    return null
  }
  if (!isRecord(v) || !isRecord(v.grid) || !isRecord(v.panels)) return null
  for (const p of Object.values(v.panels)) {
    if (!isRecord(p) || typeof p.contentComponent !== 'string' || !(PANEL_IDS as readonly string[]).includes(p.contentComponent)) {
      return null
    }
    if ('params' in p) {
      if (!isRecord(p.params)) delete p.params
      else if ('symbol' in p.params && typeof p.params.symbol !== 'string') delete p.params.symbol
    }
  }
  return v
}

function fallbackToDefault(dock: DockviewApi): void {
  try {
    dock.clear()
  } catch {
    /* nothing to clear */
  }
  applyDefaultLayout(dock)
}

export const useLayoutStore = create<LayoutState>((set) => ({
  layouts: [],
  active: '',

  async refresh() {
    const all = await api.layoutList()
    set({ layouts: all.filter((l) => !isAutosaveName(l.name)) })
  },

  async saveAs(name, json) {
    await api.layoutSave(name, json)
    const all = await api.layoutList()
    set({ layouts: all.filter((l) => !isAutosaveName(l.name)), active: name })
  },

  async load(name, dock) {
    let raw: string | null = null
    try {
      raw = await api.layoutLoad(name)
    } catch {
      raw = null
    }
    const parsed = parseLayout(raw)
    if (parsed === null) {
      fallbackToDefault(dock)
      set({ active: '' })
      return
    }
    try {
      dock.fromJSON(parsed as Parameters<DockviewApi['fromJSON']>[0])
      try {
        addMissingPanels(dock)
      } catch {
        /* the layout itself restored; a panel that cannot be added stays reachable from the Panels menu */
      }
      set({ active: name })
    } catch {
      fallbackToDefault(dock)
      set({ active: '' })
    }
  },

  async remove(name) {
    await api.layoutDelete(name)
    const all = await api.layoutList()
    set((s) => ({ layouts: all.filter((l) => !isAutosaveName(l.name)), active: s.active === name ? '' : s.active }))
  },

  autosave(json) {
    if (timer !== undefined) clearTimeout(timer)
    pendingJson = json
    timer = setTimeout(flushAutosave, AUTOSAVE_MS)
  },

  reset(dock) {
    fallbackToDefault(dock)
    set({ active: '' })
  },
}))
