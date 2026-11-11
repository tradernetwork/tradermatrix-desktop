import type { Program } from './ast'
import { Machine, type Checkpoint } from './interp'
import type { Bar, RunOptions, ScriptOutput } from './types'

export interface Session {
  output(): ScriptOutput
  /** A new bar closed or opened. */
  append(bar: Bar): ScriptOutput
  /** The last bar changed (live tick). Re-runs only that bar from the saved state. */
  updateLast(bar: Bar): ScriptOutput
}

export function createSession(p: Program, bars: Bar[], opts: RunOptions = {}): Session {
  const m = new Machine(p, bars, opts)
  let cp: Checkpoint = m.checkpoint()
  if (bars.length) {
    m.runAll(bars.length - 1)
    cp = m.checkpoint() // state before the last bar
    m.runAll()
  }
  return {
    output: () => m.output(),
    append(bar) {
      cp = m.checkpoint()
      m.append(bar)
      return m.output()
    },
    updateLast(bar) {
      m.replaceLast(cp, bar)
      return m.output()
    },
  }
}
