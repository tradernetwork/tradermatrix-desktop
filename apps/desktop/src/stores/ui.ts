import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../lib/api'
import { parseBackgrounds, serializeBackgrounds, UI_BACKGROUNDS_KEY } from '../lib/brand'
import { parseDensity, parseStrip, UI_DENSITY_KEY, UI_STRIP_KEY, type Density, type StripMode } from '../lib/layoutBudget'

interface UiState {
  /** Art behind the unlock screen and empty panes (never behind data). */
  backgrounds: boolean
  /** M22: saved density, null = automatic by window width (compact under 1300 px). */
  density: Density | null
  /** M22: the metrics strip under the header: one condensed line (default) or the seven cards. */
  strip: StripMode
  loaded: boolean
  load: () => Promise<void>
  setBackgrounds: (on: boolean) => Promise<void>
  setDensity: (d: Density) => Promise<void>
  setStrip: (m: StripMode) => Promise<void>
}

export const useUiStore = create<UiState>((set, get) => ({
  backgrounds: true,
  density: null,
  strip: 'line',
  loaded: false,
  load: async () => {
    if (get().loaded) return
    set({ loaded: true })
    try {
      set({ backgrounds: parseBackgrounds(await api.settingGet(UI_BACKGROUNDS_KEY)) })
    } catch {
      /* keeps the default (on) */
    }
    try {
      const [d, s] = await Promise.all([api.settingGet(UI_DENSITY_KEY), api.settingGet(UI_STRIP_KEY)])
      set({ density: parseDensity(d), strip: parseStrip(s) })
    } catch {
      /* keeps automatic density and the one-line strip */
    }
  },
  setBackgrounds: async (on) => {
    set({ backgrounds: on })
    try {
      await api.settingSet(UI_BACKGROUNDS_KEY, serializeBackgrounds(on))
    } catch {
      /* the choice still holds for this session */
    }
  },
  setDensity: async (d) => {
    set({ density: d })
    try {
      await api.settingSet(UI_DENSITY_KEY, d)
    } catch {
      /* the choice still holds for this session */
    }
  },
  setStrip: async (m) => {
    set({ strip: m })
    try {
      await api.settingSet(UI_STRIP_KEY, m)
    } catch {
      /* the choice still holds for this session */
    }
  },
}))

/** Loads the saved choice once, returns the current one. */
export function useBackgrounds(): boolean {
  const on = useUiStore((s) => s.backgrounds)
  useEffect(() => {
    void useUiStore.getState().load()
  }, [])
  return on
}
