import { isTauri } from './api'

/** True when the app runs on the in-memory fake backend (no Tauri): nothing on screen is real data. */
export function fakeBannerVisible(): boolean {
  return !isTauri()
}
