/** Header stats derived from the chart's bars (ATR and range position). Market-derived only; ChartPane writes it, DeskHeader reads it. */
import { create } from 'zustand'
import type { DeskStats } from '../lib/deskUi'

interface DeskStatsState {
  stats: DeskStats | null
  set: (s: DeskStats) => void
  clear: () => void
}

export const useDeskStatsStore = create<DeskStatsState>((set) => ({
  stats: null,
  set: (stats) => set({ stats }),
  clear: () => set({ stats: null }),
}))
