/**
 * What the chart and the strike check are showing right now, for the explain chat (M14). Market-derived numbers only (no account data,
 * no server text); ChartPane and StrikeCheckPanel write it, the explain store reads it. Not session data, but cleared when the chart
 * has nothing to show.
 */
import { create } from 'zustand'
import type { Candle } from '../chart/bars'
import type { ChartDigest, FibDigest, OverlaysDigest, StrikeDigest } from '../lib/explainDigest'

interface ChartContextState {
  chart: ChartDigest | null
  overlays: OverlaysDigest | null
  fib: FibDigest | null
  strike: StrikeDigest | null
  /** The last <= 30 bars on screen, for the optional BARS section (M16 B4). */
  recentBars: Candle[] | null
  /** When the chart data last arrived (epoch ms); null = nothing on screen. Feeds Arya's freshness stamp. */
  asOf: number | null
  setRecentBars: (b: Candle[] | null) => void
  setChart: (chart: ChartDigest | null, fib: FibDigest | null) => void
  setOverlays: (o: OverlaysDigest | null) => void
  setStrike: (s: StrikeDigest | null) => void
}

export const useChartContext = create<ChartContextState>((set) => ({
  chart: null,
  overlays: null,
  fib: null,
  strike: null,
  recentBars: null,
  asOf: null,
  setRecentBars: (recentBars) => set({ recentBars }),
  setChart: (chart, fib) => set({ chart, fib, asOf: chart ? Date.now() : null }),
  setOverlays: (overlays) => set({ overlays }),
  setStrike: (strike) => set({ strike }),
}))
