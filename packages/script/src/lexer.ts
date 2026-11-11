import { ScriptError, type Token, type TokKind } from './types'

const KEYWORDS = new Set(['and', 'or', 'not', 'if', 'else', 'for', 'to', 'by', 'while', 'break', 'continue', 'var', 'true', 'false'])
const OPS2 = [':=', '<=', '>=', '==', '!=']
const OPS1 = '+-*/%<>=(),.[]?:'

const isDigit = (c: string) => c >= '0' && c <= '9'
const isIdStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
const isIdPart = (c: string) => isIdStart(c) || isDigit(c)
const isHex = (c: string) => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')

/** Lex a Webull script. Python-style significant indentation, only outside ( ) and [ ]. */
export function lex(src: string): Token[] {
  const out: Token[] = []
  const indents = [0]
  let depth = 0
  let line = 1
  let i = 0
  let atLineStart = true
  let indentChar: ' ' | '\t' | null = null // first indentation char seen; the other is an error
  const push = (kind: TokKind, text: string, l: number, col: number) => out.push({ kind, text, line: l, col })

  while (i < src.length) {
    if (atLineStart && depth === 0) {
      // measure indentation
      let j = i
      let width = 0
      let sawTab = false
      let sawSpace = false
      while (j < src.length && (src[j] === ' ' || src[j] === '\t')) {
        if (src[j] === '\t') sawTab = true
        else sawSpace = true
        width += src[j] === '\t' ? 4 : 1
        j++
      }
      if (sawTab && sawSpace) throw new ScriptError('mixed tabs and spaces in indentation', line, 1)
      if (sawTab || sawSpace) {
        const used = sawTab ? '\t' : ' '
        if (indentChar === null) indentChar = used
        else if (indentChar !== used) throw new ScriptError('mixed tabs and spaces in indentation', line, 1)
      }
      // blank or comment-only line: no indentation change
      if (j >= src.length || src[j] === '\n' || src[j] === '\r' || (src[j] === '/' && src[j + 1] === '/')) {
        while (j < src.length && src[j] !== '\n') j++
        i = j
        if (i < src.length) {
          i++
          line++
        }
        continue
      }
      const cur = indents[indents.length - 1]
      if (width > cur) {
        indents.push(width)
        push('indent', '', line, 1)
      } else if (width < cur) {
        while (indents[indents.length - 1] > width) {
          indents.pop()
          push('dedent', '', line, 1)
        }
        if (indents[indents.length - 1] !== width) throw new ScriptError('inconsistent dedent', line, 1)
      }
      i = j
      atLineStart = false
    }

    const c = src[i]
    const col = i - src.lastIndexOf('\n', i - 1)
    if (c === '\n') {
      if (depth === 0) {
        const last = out[out.length - 1]
        if (last && last.kind !== 'newline' && last.kind !== 'indent' && last.kind !== 'dedent') push('newline', '', line, col)
        atLineStart = true
      }
      line++
      i++
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      continue
    }
    if (c === '#') {
      let j = i + 1
      while (j < src.length && isHex(src[j])) j++
      const len = j - i - 1
      if (len !== 6 && len !== 8) throw new ScriptError(`bad color literal`, line, col)
      push('color', src.slice(i, j), line, col)
      i = j
      continue
    }
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      let j = i
      while (j < src.length && isDigit(src[j])) j++
      if (src[j] === '.' && isDigit(src[j + 1] ?? '')) {
        j++
        while (j < src.length && isDigit(src[j])) j++
      }
      push('num', src.slice(i, j), line, col)
      i = j
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < src.length && src[j] !== c && src[j] !== '\n') j++
      if (src[j] !== c) throw new ScriptError('unterminated string', line, col)
      push('str', src.slice(i + 1, j), line, col)
      i = j + 1
      continue
    }
    if (isIdStart(c)) {
      let j = i
      while (j < src.length && isIdPart(src[j])) j++
      const word = src.slice(i, j)
      push(KEYWORDS.has(word) ? 'kw' : 'ident', word, line, col)
      i = j
      continue
    }
    const two = src.slice(i, i + 2)
    if (OPS2.includes(two)) {
      push('op', two, line, col)
      i += 2
      continue
    }
    if (OPS1.includes(c)) {
      if (c === '(' || c === '[') depth++
      if (c === ')' || c === ']') depth = Math.max(0, depth - 1)
      push('op', c, line, col)
      i++
      continue
    }
    throw new ScriptError(`unexpected character '${c}'`, line, col)
  }

  const last = out[out.length - 1]
  if (last && last.kind !== 'newline' && last.kind !== 'dedent') push('newline', '', line, 1)
  while (indents.length > 1) {
    indents.pop()
    push('dedent', '', line, 1)
  }
  push('eof', '', line, 1)
  return out
}
