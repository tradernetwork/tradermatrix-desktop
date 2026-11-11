/** TraderMatrix Desktop brand constants and the small pure helpers behind the brand surfaces (M15). No assets are imported here. */

export const PRODUCT_NAME = 'TraderMatrix Desktop'
/** Keep in step with tauri.conf.json and Cargo.toml (a test pins all three). */
export const APP_VERSION = '0.1.0'
/** M19: said on the Connect Robinhood screen and in About. */
export const RH_SCOPE_NOTE = 'Robinhood read access reaches all your accounts; trading is limited to the dedicated agentic account.'
export const NOT_AFFILIATED = 'Works with the Robinhood MCP. Not affiliated with or endorsed by Robinhood.'
/** Arya's one-line introduction. It lives here, not in the pane, so the pane source stays free of order vocabulary (explain-only guard). */
export const ARYA_INTRO = "I'm Arya. I explain what's on your screen. I don't place or suggest orders."

/** Local setting: art behind the unlock screen and empty panes. Default on; only an explicit off turns it off. */
export const UI_BACKGROUNDS_KEY = 'ui.backgrounds'
export function parseBackgrounds(v: string | null | undefined): boolean {
  const s = (v ?? '').trim().toLowerCase()
  return !(s === 'off' || s === 'false' || s === '0')
}
export const serializeBackgrounds = (on: boolean): string => (on ? 'on' : 'off')

/** M16 B6 added streaming (answer arriving), check (numbers to double check) and error. The pane derives them in `lib/explainStates.ts`. */
export type AryaState = 'idle' | 'thinking' | 'streaming' | 'check' | 'error'
export type AryaLookName = 'calm' | 'focused' | 'wry'
export const aryaState = (busy: boolean): AryaState => (busy ? 'thinking' : 'idle')
/** Idle and error are the calm still; thinking, streaming and check are the focused one; `wry` is the greeting still (empty state). */
export const aryaLook = (s: AryaState): AryaLookName => (s === 'thinking' || s === 'streaming' || s === 'check' ? 'focused' : 'calm')
