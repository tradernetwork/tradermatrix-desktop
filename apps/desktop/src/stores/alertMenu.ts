/**
 * The alert items of the chart's right-click menu (M17 task 6). ALERTS ONLY: items create or edit alerts. The shared menu component
 * (AskAboutMenu) renders these next to the explain item, so there is one menu; this store knows nothing about the explain store.
 */
import { create } from 'zustand'

export interface AlertMenuItem {
  label: string
  title?: string
  run: () => void
}
export interface AlertMenu {
  x: number
  y: number
  items: AlertMenuItem[]
}

interface MenuStore {
  menu: AlertMenu | null
  setMenu: (m: AlertMenu | null) => void
}

export const useAlertMenu = create<MenuStore>((set) => ({ menu: null, setMenu: (menu) => set({ menu }) }))
