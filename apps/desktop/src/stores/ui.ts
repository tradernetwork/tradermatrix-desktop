import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../lib/api'
import { parseBackgrounds, serializeBackgrounds, UI_BACKGROUNDS_KEY } from '../lib/brand'

interface UiState {
  /** Art behind the unlock screen and empty panes (never behind data). */
  backgrounds: boolean
  loaded: boolean
  load: () => Promise<void>
  setBackgrounds: (on: boolean) => Promise<void>
}

export const useUiStore = create<UiState>((set, get) => ({
  backgrounds: true,
  loaded: false,
  load: async () => {
    if (get().loaded) return
    set({ loaded: true })
    try {
      set({ backgrounds: parseBackgrounds(await api.settingGet(UI_BACKGROUNDS_KEY)) })
    } catch {
      /* keeps the default (on) */
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
}))

/** Loads the saved choice once, returns the current one. */
export function useBackgrounds(): boolean {
  const on = useUiStore((s) => s.backgrounds)
  useEffect(() => {
    void useUiStore.getState().load()
  }, [])
  return on
}
