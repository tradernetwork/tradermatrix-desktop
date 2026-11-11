import { fakeBannerVisible } from '../lib/fakeBanner'

/** Persistent red strip while the in-memory fake backend is active (no Tauri): none of the data is real. */
export function FakeBanner() {
  if (!fakeBannerVisible()) return null
  return (
    <div className="fake-banner" role="status" data-testid="fake-banner">
      FAKE DATA: no Tauri backend, nothing here is real and no order can be sent
    </div>
  )
}
