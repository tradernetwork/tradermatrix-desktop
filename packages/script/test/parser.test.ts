import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Expr, Stmt } from '../src/ast'
import { parse } from '../src/parser'
import { ScriptError } from '../src/types'
import { LEGACY, RIBBON, SUBCHART } from './fixtures/scripts'

const expr = (src: string): Expr => {
  const s = parse(src).body[0] as Stmt
  if (s.type === 'Assign') return s.expr
  if (s.type === 'ExprStmt') return s.expr
  throw new Error('not an expression statement')
}
const BUILTIN = new URL('../../../apps/desktop/src/chart/scripts/tm_ema_ribbon.webull', import.meta.url)

describe('parser', () => {
  it('respects precedence: a = b + c * 2', () => {
    const e = expr('a = b + c * 2')
    expect(e).toMatchObject({ type: 'Binary', op: '+', right: { type: 'Binary', op: '*' } })
  })
  it('parses history index and logic', () => {
    const e = expr('t = (rsi_value[1] <= 10) and (rsi_value > 10)')
    expect(e).toMatchObject({ type: 'Binary', op: 'and', left: { type: 'Binary', op: '<=', left: { type: 'Index' } } })
  })
  it('parses call with positional args and kwargs', () => {
    const e = expr('x = define(8, name="Fast EMA", min=1)')
    expect(e).toMatchObject({ type: 'Call' })
    if (e.type !== 'Call') throw new Error()
    expect(e.args).toHaveLength(1)
    expect(e.kwargs.map((k) => k.name)).toEqual(['name', 'min'])
  })
  it('parses dotted callee plt.fill_between and member constants', () => {
    const e = expr('plt.fill_between(a, b, type=plt.type_circles)')
    if (e.type !== 'Call') throw new Error()
    expect(e.callee).toMatchObject({ type: 'Member', name: 'fill_between', obj: { type: 'Ident', name: 'plt' } })
    expect(e.kwargs[0].value).toMatchObject({ type: 'Member', name: 'type_circles' })
  })
  it('parses tuple assignment', () => {
    const s = parse('[m, u, l] = ind.bb(close, 20, 2)').body[0]
    expect(s).toMatchObject({ type: 'Assign', tuple: true, targets: ['m', 'u', 'l'] })
  })
  it('parses var and :=', () => {
    const [a, b] = parse('var x = 0\nx := x + 1').body
    expect(a).toMatchObject({ type: 'Assign', isVar: true, reassign: false })
    expect(b).toMatchObject({ type: 'Assign', isVar: false, reassign: true })
  })
  it('parses for with by, and while, if/else if/else', () => {
    const p = parse('for i = 0 to 10 by 2\n  s = s + i\nwhile s < 5\n  s = s + 1\nif a\n  x = 1\nelse if b\n  x = 2\nelse\n  x = 3')
    expect(p.body[0]).toMatchObject({ type: 'For', name: 'i', by: { type: 'Num', value: 2 } })
    expect(p.body[1]).toMatchObject({ type: 'While' })
    const iff = p.body[2]
    if (iff.type !== 'If') throw new Error()
    expect(iff.else?.[0]).toMatchObject({ type: 'If' })
  })
  it('parses ternary and unary', () => {
    expect(expr('x = a > 1 ? -b : not c')).toMatchObject({ type: 'Ternary', a: { type: 'Unary', op: '-' }, b: { type: 'Unary', op: 'not' } })
  })
  it('gives every node a unique id', () => {
    const p = parse('x = (a + b) * c')
    expect(p.nodeCount).toBeGreaterThan(5)
  })
  it('parses the built-in script and every inline fixture script', () => {
    expect(() => parse(readFileSync(BUILTIN, 'utf8')), 'tm_ema_ribbon').not.toThrow()
    for (const [name, src] of Object.entries({ RIBBON, SUBCHART, LEGACY })) expect(() => parse(src), name).not.toThrow()
  })
  it('reports unclosed paren with line 1', () => {
    try {
      parse('plt(close')
      throw new Error('no throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptError)
      expect((e as ScriptError).line).toBe(1)
    }
  })
  it('rejects user functions explicitly', () => {
    expect(() => parse('def f(x)\n  return x')).toThrowError(/user functions not supported/)
  })
})
