/** Volume pane mode (remembered through setting_get / setting_set under `chart.volume`). */
export type VolumeMode = 'vol' | 'split' | 'off'

export const VOLUME_SETTING_KEY = 'chart.volume'
export const DEFAULT_VOLUME_MODE: VolumeMode = 'split'

export const VOLUME_MODES: ReadonlyArray<{ id: VolumeMode; label: string; title: string }> = [
  { id: 'vol', label: 'Vol', title: 'Total volume, colored by the candle direction' },
  { id: 'split', label: 'Vol est. buy/sell', title: 'Estimated buy/sell split from each bar\'s close position in its range. Robinhood sends total volume only: this is a guess, not trade-side data.' },
  { id: 'off', label: 'Off', title: 'Hide the volume pane' },
]

export function parseVolumeMode(raw: string | null | undefined): VolumeMode {
  return raw === 'vol' || raw === 'split' || raw === 'off' ? raw : DEFAULT_VOLUME_MODE
}

/** Pane legend. The split is ALWAYS labeled "est.". */
export function volumeTitle(mode: VolumeMode): string {
  return mode === 'split' ? 'Volume (est. buy/sell split)' : mode === 'vol' ? 'Volume' : ''
}
