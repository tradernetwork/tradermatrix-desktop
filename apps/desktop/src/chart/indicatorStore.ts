import { create } from 'zustand'
import { api } from '../lib/api'
import type { ActiveIndicator } from './scriptIndicator'

export const SETTING_KEY = 'chart.indicators'
const MAX_ACTIVE = 20
const MAX_SOURCE = 200_000

type InputVal = number | boolean | string

function validInputs(v: unknown): Record<string, InputVal> | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const out: Record<string, InputVal> = {}
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'number' ? !Number.isFinite(x) : typeof x !== 'boolean' && typeof x !== 'string') return null
    out[k] = x as InputVal
  }
  return out
}

/** Garbage in, empty list out. Entries that fail validation are dropped individually. */
export function parseStoredIndicators(raw: string | null | undefined): ActiveIndicator[] {
  if (!raw) return []
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(v)) return []
  const out: ActiveIndicator[] = []
  const seen = new Set<string>()
  for (const x of v) {
    if (typeof x !== 'object' || x === null) continue
    const o = x as Record<string, unknown>
    const inputs = validInputs(o.inputs)
    if (
      typeof o.id !== 'string' ||
      !o.id ||
      seen.has(o.id) ||
      typeof o.scriptId !== 'string' ||
      typeof o.label !== 'string' ||
      typeof o.source !== 'string' ||
      o.source.length > MAX_SOURCE ||
      !inputs
    )
      continue
    seen.add(o.id)
    out.push({ id: o.id, scriptId: o.scriptId, label: o.label, source: o.source, inputs })
    if (out.length >= MAX_ACTIVE) break
  }
  return out
}

interface IndicatorState {
  active: ActiveIndicator[]
  loaded: boolean
  load: () => Promise<void>
  add: (scriptId: string, source: string, label?: string) => string
  remove: (id: string) => void
  setInput: (id: string, key: string, value: InputVal) => void
}

export const useIndicatorStore = create<IndicatorState>((set, get) => {
  const persist = () => {
    void api.settingSet(SETTING_KEY, JSON.stringify(get().active)).catch(() => undefined)
  }
  return {
    active: [],
    loaded: false,
    load: async () => {
      let raw: string | null = null
      try {
        raw = await api.settingGet(SETTING_KEY)
      } catch {
        raw = null
      }
      set({ active: parseStoredIndicators(raw), loaded: true })
    },
    add: (scriptId, source, label) => {
      const taken = new Set(get().active.map((a) => a.id))
      let n = 1
      while (taken.has(`${scriptId}-${n}`)) n++
      const id = `${scriptId}-${n}`
      if (get().active.length >= MAX_ACTIVE) return ''
      set({ active: [...get().active, { id, scriptId, label: label ?? scriptId, source, inputs: {} }] })
      persist()
      return id
    },
    remove: (id) => {
      set({ active: get().active.filter((a) => a.id !== id) })
      persist()
    },
    setInput: (id, key, value) => {
      set({ active: get().active.map((a) => (a.id === id ? { ...a, inputs: { ...a.inputs, [key]: value } } : a)) })
      persist()
    },
  }
})
