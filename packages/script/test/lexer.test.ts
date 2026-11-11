import { describe, expect, it } from 'vitest'
import { lex } from '../src/lexer'
import { ScriptError } from '../src/types'

const kinds = (src: string) => lex(src).map((t) => t.kind)
const texts = (src: string) => lex(src).filter((t) => t.kind !== 'newline' && t.kind !== 'eof').map((t) => t.text)

describe('lexer', () => {
  it('drops // comments', () => {
    expect(texts('a = 1 // trailing\n// whole line\nb = 2')).toEqual(['a', '=', '1', 'b', '=', '2'])
  })
  it('lexes #RRGGBB as color', () => {
    const t = lex('color=#0057FF')
    expect(t.find((x) => x.kind === 'color')?.text).toBe('#0057FF')
  })
  it('lexes multi-char operators as single tokens', () => {
    expect(texts('a := b <= c >= d == e != f')).toEqual(['a', ':=', 'b', '<=', 'c', '>=', 'd', '==', 'e', '!=', 'f'])
  })
  it('marks keywords', () => {
    const kws = ['and', 'or', 'not', 'if', 'else', 'for', 'to', 'by', 'while', 'break', 'continue', 'var', 'true', 'false']
    for (const k of kws) expect(lex(k)[0]).toMatchObject({ kind: 'kw', text: k })
  })
  it('emits indent and dedent for blocks', () => {
    expect(kinds('if x\n  y = 1\nz = 2')).toEqual([
      'kw', 'ident', 'newline', 'indent', 'ident', 'op', 'num', 'newline', 'dedent', 'ident', 'op', 'num', 'newline', 'eof',
    ])
  })
  it('ignores newlines inside parens and brackets', () => {
    const src = 'x = iff(a,\n   b,\n   iff(c, d, e)) // c\ny = 1'
    const nl = lex(src).filter((t) => t.kind === 'newline').length
    expect(nl).toBe(2)
    expect(lex(src).some((t) => t.kind === 'indent')).toBe(false)
  })
  it('lexes numbers incl decimals and strings', () => {
    expect(texts('x = 0.5 + 10 + "Fast EMA"')).toEqual(['x', '=', '0.5', '+', '10', '+', 'Fast EMA'])
  })
  it('rejects mixed tab and space indentation with a line number', () => {
    expect(() => lex('if x\n  a = 1\n\tb = 2')).toThrowError(ScriptError)
    try {
      lex('if x\n  a = 1\n\tb = 2')
    } catch (e) {
      expect((e as ScriptError).line).toBe(3)
    }
  })
  it('rejects unknown characters with line and col', () => {
    try {
      lex('a = 1\nb = @')
      throw new Error('no throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptError)
      expect((e as ScriptError).line).toBe(2)
    }
  })
})
