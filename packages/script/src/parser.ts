import type { Expr, Program, Stmt } from './ast'
import { lex } from './lexer'
import { ScriptError, type Token } from './types'

export function parse(src: string): Program {
  return new Parser(lex(src)).program()
}

class Parser {
  private p = 0
  private ids = 0
  constructor(private t: Token[]) {}

  private get cur(): Token {
    return this.t[this.p]
  }
  private peek(n = 1): Token {
    return this.t[Math.min(this.p + n, this.t.length - 1)]
  }
  private err(msg: string, tok: Token = this.cur): never {
    throw new ScriptError(msg, tok.line, tok.col)
  }
  private is(kind: Token['kind'], text?: string): boolean {
    return this.cur.kind === kind && (text === undefined || this.cur.text === text)
  }
  private eat(kind: Token['kind'], text?: string): Token {
    if (!this.is(kind, text)) this.err(`expected ${text ?? kind} but found '${this.cur.text || this.cur.kind}'`)
    return this.t[this.p++]
  }
  private accept(kind: Token['kind'], text?: string): boolean {
    if (this.is(kind, text)) {
      this.p++
      return true
    }
    return false
  }
  private loc(tok: Token) {
    return { id: this.ids++, line: tok.line, col: tok.col }
  }

  program(): Program {
    const body: Stmt[] = []
    while (!this.is('eof')) {
      if (this.accept('newline')) continue
      body.push(this.stmt())
    }
    return { body, nodeCount: this.ids }
  }

  private block(): Stmt[] {
    this.eat('newline')
    this.eat('indent')
    const out: Stmt[] = []
    while (!this.is('dedent') && !this.is('eof')) {
      if (this.accept('newline')) continue
      out.push(this.stmt())
    }
    this.accept('dedent')
    return out
  }

  private endStmt() {
    if (this.is('eof') || this.is('dedent')) return
    this.eat('newline')
  }

  private stmt(): Stmt {
    const tok = this.cur
    if (tok.kind === 'ident' && tok.text === 'def' && this.peek().kind === 'ident') this.err('user functions not supported')
    if (tok.kind === 'kw') {
      switch (tok.text) {
        case 'if':
          return this.ifStmt()
        case 'for': {
          this.p++
          const name = this.eat('ident').text
          this.eat('op', '=')
          const from = this.expr()
          this.eat('kw', 'to')
          const to = this.expr()
          const by = this.accept('kw', 'by') ? this.expr() : undefined
          return { type: 'For', ...this.loc(tok), name, from, to, by, body: this.block() }
        }
        case 'while': {
          this.p++
          const cond = this.expr()
          return { type: 'While', ...this.loc(tok), cond, body: this.block() }
        }
        case 'break':
          this.p++
          this.endStmt()
          return { type: 'Break', ...this.loc(tok) }
        case 'continue':
          this.p++
          this.endStmt()
          return { type: 'Continue', ...this.loc(tok) }
        case 'var': {
          this.p++
          const name = this.eat('ident').text
          this.eat('op', '=')
          const e = this.expr()
          this.endStmt()
          return { type: 'Assign', ...this.loc(tok), targets: [name], tuple: false, expr: e, isVar: true, reassign: false }
        }
      }
    }
    // tuple assignment: [a, b] = expr
    if (tok.kind === 'op' && tok.text === '[') {
      const save = this.p
      this.p++
      const names: string[] = []
      let ok = true
      while (true) {
        if (!this.is('ident')) {
          ok = false
          break
        }
        names.push(this.t[this.p++].text)
        if (this.accept('op', ',')) continue
        break
      }
      if (ok && this.accept('op', ']') && this.accept('op', '=')) {
        const e = this.expr()
        this.endStmt()
        return { type: 'Assign', ...this.loc(tok), targets: names, tuple: true, expr: e, isVar: false, reassign: false }
      }
      this.p = save
    }
    // name = expr | name := expr
    if (tok.kind === 'ident' && this.peek().kind === 'op' && (this.peek().text === '=' || this.peek().text === ':=')) {
      this.p++
      const op = this.t[this.p++].text
      const e = this.expr()
      this.endStmt()
      return { type: 'Assign', ...this.loc(tok), targets: [tok.text], tuple: false, expr: e, isVar: false, reassign: op === ':=' }
    }
    const e = this.expr()
    this.endStmt()
    return { type: 'ExprStmt', ...this.loc(tok), expr: e }
  }

  private ifStmt(): Stmt {
    const tok = this.eat('kw', 'if')
    const cond = this.expr()
    const then = this.block()
    let els: Stmt[] | undefined
    if (this.is('kw', 'else')) {
      this.p++
      els = this.is('kw', 'if') ? [this.ifStmt()] : this.block()
    }
    return { type: 'If', ...this.loc(tok), cond, then, else: els }
  }

  // ---- expressions (precedence, low to high): ternary, or, and, not, comparison, + -, * / %, unary -, postfix
  expr(): Expr {
    return this.ternary()
  }
  private ternary(): Expr {
    const cond = this.or()
    if (this.is('op', '?')) {
      const tok = this.t[this.p++]
      const a = this.ternary()
      this.eat('op', ':')
      const b = this.ternary()
      return { type: 'Ternary', ...this.loc(tok), cond, a, b }
    }
    return cond
  }
  private bin(next: () => Expr, ops: string[], kw = false): Expr {
    let left = next()
    while ((kw ? this.cur.kind === 'kw' : this.cur.kind === 'op') && ops.includes(this.cur.text)) {
      const tok = this.t[this.p++]
      const right = next()
      left = { type: 'Binary', ...this.loc(tok), op: tok.text, left, right }
    }
    return left
  }
  private or = (): Expr => this.bin(() => this.and(), ['or'], true)
  private and = (): Expr => this.bin(() => this.not(), ['and'], true)
  private not(): Expr {
    if (this.is('kw', 'not')) {
      const tok = this.t[this.p++]
      return { type: 'Unary', ...this.loc(tok), op: 'not', expr: this.not() }
    }
    return this.cmp()
  }
  private cmp = (): Expr => this.bin(() => this.add(), ['<', '>', '<=', '>=', '==', '!='])
  private add = (): Expr => this.bin(() => this.mul(), ['+', '-'])
  private mul = (): Expr => this.bin(() => this.unary(), ['*', '/', '%'])
  private unary(): Expr {
    if (this.is('op', '-')) {
      const tok = this.t[this.p++]
      return { type: 'Unary', ...this.loc(tok), op: '-', expr: this.unary() }
    }
    return this.postfix()
  }
  private postfix(): Expr {
    let e = this.primary()
    while (true) {
      if (this.is('op', '(')) {
        const tok = this.t[this.p++]
        const args: Expr[] = []
        const kwargs: { name: string; value: Expr }[] = []
        if (!this.is('op', ')')) {
          do {
            if (this.is('ident') && this.peek().kind === 'op' && this.peek().text === '=') {
              const name = this.t[this.p].text
              this.p += 2
              kwargs.push({ name, value: this.expr() })
            } else {
              if (kwargs.length) this.err('positional argument after keyword argument')
              args.push(this.expr())
            }
          } while (this.accept('op', ','))
        }
        this.eat('op', ')')
        e = { type: 'Call', ...this.loc(tok), callee: e, args, kwargs }
      } else if (this.is('op', '[')) {
        const tok = this.t[this.p++]
        const index = this.expr()
        this.eat('op', ']')
        e = { type: 'Index', ...this.loc(tok), expr: e, index }
      } else if (this.is('op', '.')) {
        const tok = this.t[this.p++]
        const name = this.eat('ident').text
        e = { type: 'Member', ...this.loc(tok), obj: e, name }
      } else return e
    }
  }
  private primary(): Expr {
    const tok = this.cur
    switch (tok.kind) {
      case 'num':
        this.p++
        return { type: 'Num', ...this.loc(tok), value: Number(tok.text) }
      case 'str':
        this.p++
        return { type: 'Str', ...this.loc(tok), value: tok.text }
      case 'color':
        this.p++
        return { type: 'Color', ...this.loc(tok), value: tok.text }
      case 'ident':
        this.p++
        return { type: 'Ident', ...this.loc(tok), name: tok.text }
      case 'kw':
        if (tok.text === 'true' || tok.text === 'false') {
          this.p++
          return { type: 'Bool', ...this.loc(tok), value: tok.text === 'true' }
        }
        break
      case 'op':
        if (tok.text === '(') {
          this.p++
          const e = this.expr()
          this.eat('op', ')')
          return e
        }
        if (tok.text === '[') {
          this.p++
          const items: Expr[] = []
          if (!this.is('op', ']')) {
            do items.push(this.expr())
            while (this.accept('op', ','))
          }
          this.eat('op', ']')
          return { type: 'Tuple', ...this.loc(tok), items }
        }
        break
    }
    this.err(`unexpected '${tok.text || tok.kind}'`)
  }
}
