import type { Program } from './ast'
import { Machine } from './interp'
import type { Bar, RunOptions, ScriptOutput } from './types'

export { compile } from './interp'
export { parse } from './parser'
export { lex } from './lexer'
export { createSession, type Session } from './session'
export { BUILTINS } from './builtins'
export { KERNELS } from './ta/index'
export type { Program } from './ast'
export * from './types'

export function run(p: Program, bars: Bar[], opts: RunOptions = {}): ScriptOutput {
  const m = new Machine(p, bars, opts)
  m.runAll()
  return m.output()
}
