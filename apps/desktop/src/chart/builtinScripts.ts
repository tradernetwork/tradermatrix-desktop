import tmEmaRibbon from './scripts/tm_ema_ribbon.webull?raw'

export interface BuiltinScript {
  id: string
  label: string
  source: string
}

/** Built-in scripts shipped with the app. Original work, MIT like the rest of the repo. */
export const BUILTIN_SCRIPTS: BuiltinScript[] = [
  { id: 'tm_ema_ribbon', label: 'EMA Ribbon (9, 21, 50)', source: tmEmaRibbon },
]

export function builtinById(id: string): BuiltinScript | undefined {
  return BUILTIN_SCRIPTS.find((s) => s.id === id)
}
