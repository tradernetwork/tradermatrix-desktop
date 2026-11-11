import type { DockviewApi } from 'dockview-react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, fake } from '../src/lib/api'
import * as defaults from '../src/workspace/defaultLayout'
import { useLayoutStore } from '../src/workspace/layoutStore'

vi.mock('../src/workspace/defaultLayout', () => ({
  AUTOSAVE_NAME: '__autosave',
  applyDefaultLayout: vi.fn(),
}))

const fakeDock = (over: Partial<Record<'fromJSON' | 'clear', () => void>> = {}) =>
  ({ fromJSON: vi.fn(), clear: vi.fn(), ...over }) as unknown as DockviewApi & {
    fromJSON: ReturnType<typeof vi.fn>
  }

const GOOD = JSON.stringify({
  grid: { root: {}, width: 1, height: 1, orientation: 'HORIZONTAL' },
  panels: { chart: { id: 'chart', contentComponent: 'chart', title: 'Chart' } },
})

beforeEach(() => {
  fake.reset()
  vi.mocked(defaults.applyDefaultLayout).mockClear()
  useLayoutStore.setState({ layouts: [], active: '' })
})
afterEach(() => vi.useRealTimers())

describe('layoutStore', () => {
  it('saveAs adds to layouts and sets active', async () => {
    await useLayoutStore.getState().saveAs('mine', GOOD)
    const s = useLayoutStore.getState()
    expect(s.layouts.map((l) => l.name)).toEqual(['mine'])
    expect(s.active).toBe('mine')
  })

  it('hides the autosave slot from the list', async () => {
    await api.layoutSave('__autosave', GOOD)
    await useLayoutStore.getState().refresh()
    expect(useLayoutStore.getState().layouts).toEqual([])
  })

  it('hides every versioned autosave slot (old __autosave and the current one) from the list', async () => {
    await api.layoutSave('__autosave', GOOD)
    await api.layoutSave('__autosave_v2', GOOD)
    await api.layoutSave('mine', GOOD)
    await useLayoutStore.getState().refresh()
    expect(useLayoutStore.getState().layouts.map((l) => l.name)).toEqual(['mine'])
  })

  it('loads a valid layout', async () => {
    await api.layoutSave('ok', GOOD)
    const dock = fakeDock()
    await useLayoutStore.getState().load('ok', dock)
    expect(dock.fromJSON).toHaveBeenCalledOnce()
    expect(defaults.applyDefaultLayout).not.toHaveBeenCalled()
    expect(useLayoutStore.getState().active).toBe('ok')
  })

  it.each([
    ['unparseable', '{oops'],
    ['not a dockview layout', '{"a":1}'],
    ['json null', 'null'],
    ['unknown panel component', JSON.stringify({ grid: {}, panels: { x: { contentComponent: 'evil' } } })],
    ['array', '[]'],
  ])('falls back to default for corrupt layout (%s)', async (_n, json) => {
    // seed straight into the backend: the validated save path would (rightly) refuse unparseable JSON
    fake.layouts.set('bad', { name: 'bad', json, updated_at: '', seq: 1 })
    const dock = fakeDock()
    await expect(useLayoutStore.getState().load('bad', dock)).resolves.toBeUndefined()
    expect(defaults.applyDefaultLayout).toHaveBeenCalledWith(dock)
    expect(dock.fromJSON).not.toHaveBeenCalled()
  })

  it('falls back to default for a missing layout', async () => {
    const dock = fakeDock()
    await useLayoutStore.getState().load('absent', dock)
    expect(defaults.applyDefaultLayout).toHaveBeenCalledWith(dock)
  })

  it('falls back to default when fromJSON throws', async () => {
    await api.layoutSave('boom', GOOD)
    const dock = fakeDock({ fromJSON: () => { throw new Error('boom') } })
    await useLayoutStore.getState().load('boom', dock)
    expect(defaults.applyDefaultLayout).toHaveBeenCalledWith(dock)
  })

  it('autosave debounces to one save at 800 ms with the last json', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(api, 'layoutSave').mockResolvedValue({ name: '__autosave', updated_at: '' })
    for (let i = 1; i <= 5; i++) useLayoutStore.getState().autosave(`{"n":${i}}`)
    vi.advanceTimersByTime(799)
    expect(spy).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(spy).toHaveBeenCalledOnce()
    expect(spy).toHaveBeenCalledWith('__autosave', '{"n":5}')
    spy.mockRestore()
  })

  it('reset applies the default layout', () => {
    const dock = fakeDock()
    useLayoutStore.getState().reset(dock)
    expect(defaults.applyDefaultLayout).toHaveBeenCalledWith(dock)
  })

  it('remove deletes and clears active', async () => {
    await useLayoutStore.getState().saveAs('gone', GOOD)
    await useLayoutStore.getState().remove('gone')
    expect(useLayoutStore.getState().layouts).toEqual([])
    expect(useLayoutStore.getState().active).toBe('')
  })
})
