import { afterEach, describe, expect, it } from 'vitest'
import { rollupInputs } from '../devPages'
import { fakeBannerVisible } from '../src/lib/fakeBanner'

describe('F8 dev pages only on request', () => {
  it('production build has just the app entry', () => {
    expect(Object.keys(rollupInputs({}))).toEqual(['main'])
    expect(Object.keys(rollupInputs({ REBULL_DEV_PAGES: '0' }))).toEqual(['main'])
    expect(Object.keys(rollupInputs({ REBULL_DEV_PAGES: 'true' }))).toEqual(['main'])
  })
  it('REBULL_DEV_PAGES=1 adds the nine dev pages', () => {
    const k = Object.keys(rollupInputs({ REBULL_DEV_PAGES: '1' })).sort()
    expect(k).toEqual(['alertsDev', 'chartDev', 'chatDev', 'journalDev', 'main', 'riskDev', 'syncDev', 'ticketDev', 'tmDev', 'workspaceDev'])
    expect(rollupInputs({ REBULL_DEV_PAGES: '1' }).chartDev).toBe('chart-dev.html')
    expect(rollupInputs({ REBULL_DEV_PAGES: '1' }).syncDev).toBe('sync-dev.html')
    expect(rollupInputs({ REBULL_DEV_PAGES: '1' }).chatDev).toBe('chat-dev.html')
    expect(rollupInputs({ REBULL_DEV_PAGES: '1' }).workspaceDev).toBe('workspace-dev.html')
  })
})

describe('F8 fake data banner', () => {
  const g = globalThis as { window?: unknown }
  afterEach(() => {
    delete g.window
  })
  it('shows outside Tauri, hides inside it', () => {
    expect(fakeBannerVisible()).toBe(true)
    g.window = { __TAURI_INTERNALS__: {} }
    expect(fakeBannerVisible()).toBe(false)
  })
})
