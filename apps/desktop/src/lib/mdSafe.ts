/**
 * Safe markdown (M16 A4). A tiny in-house parser: paragraphs, headings (as bold paragraphs), bold, inline code, lists (up to 3 levels,
 * flat items with a depth), and simple tables. It produces a tree of plain text nodes ONLY: there is no HTML passthrough, links are
 * inert text with the URL visible, images are text. Every text node carries `start`, its offset in the source (null when the text
 * was synthesised), so the grounding flags (computed on the raw reply) can be laid over it. Input is capped; every scan is bounded.
 */
export type Inline = { t: 'text'; text: string; start: number | null } | { t: 'code'; text: string; start: number | null } | { t: 'strong'; children: Inline[] }
export interface ListItem {
  depth: number
  inline: Inline[]
}
export type Block = { t: 'p'; inline: Inline[] } | { t: 'ul' | 'ol'; items: ListItem[] } | { t: 'table'; head: Inline[][]; rows: Inline[][][] }

const MAX_SRC = 20000
const MAX_ITEMS = 400
const MAX_ROWS = 60
const MAX_COLS = 8
const MAX_DEPTH = 3
const MAX_URL = 2000

/** Index of the `)` that closes the `(` before `from`, counting nested parens; -1 if none within `to`, a newline, or MAX_URL chars. */
function closeParen(src: string, from: number, to: number): number {
  let depth = 1
  const lim = Math.min(to, from + MAX_URL)
  for (let k = from; k < lim; k++) {
    const c = src[k]
    if (c === '\n') return -1
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) return k
  }
  return -1
}

function parseInline(src: string, from: number, to: number, allowStrong = true): Inline[] {
  const out: Inline[] = []
  let ts = from
  let i = from
  const flush = (end: number) => {
    if (end > ts) out.push({ t: 'text', text: src.slice(ts, end), start: ts })
  }
  while (i < to) {
    const c = src[i]
    if (c === '`') {
      const j = src.indexOf('`', i + 1)
      if (j > i + 1 && j < to) {
        flush(i)
        out.push({ t: 'code', text: src.slice(i + 1, j), start: i + 1 })
        i = ts = j + 1
        continue
      }
    } else if (c === '*' && allowStrong && src[i + 1] === '*') {
      const j = src.indexOf('**', i + 2)
      if (j > i + 2 && j < to) {
        flush(i)
        out.push({ t: 'strong', children: parseInline(src, i + 2, j, false) })
        i = ts = j + 2
        continue
      }
    } else if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const image = c === '!'
      const open = image ? i + 1 : i
      const j = src.indexOf(']', open + 1)
      if (j > open && j < to && src[j + 1] === '(') {
        const k = closeParen(src, j + 2, to)
        if (k > j + 1) {
          flush(i)
          const label = src.slice(open + 1, j)
          if (image) out.push({ t: 'text', text: 'image: ', start: null })
          if (label) out.push({ t: 'text', text: label, start: open + 1 })
          out.push({ t: 'text', text: ` (${src.slice(j + 2, k)})`, start: null })
          i = ts = k + 1
          continue
        }
      }
    }
    i++
  }
  flush(to)
  return out
}

interface Line {
  s: number
  e: number
}
function splitLines(src: string): Line[] {
  const out: Line[] = []
  let s = 0
  while (s <= src.length) {
    let e = src.indexOf('\n', s)
    if (e === -1) e = src.length
    out.push({ s, e: e > s && src[e - 1] === '\r' ? e - 1 : e })
    s = e + 1
  }
  return out
}

const LIST = /^([ \t]*)([-*•]|\d{1,3}[.)])[ \t]+/
const SEP = /^[ \t]*\|?[ \t]*:?-{2,}:?[ \t]*(?:\|[ \t]*:?-{2,}:?[ \t]*)*\|?[ \t]*$/
const HEAD = /^#{1,6}[ \t]+/

function cells(src: string, l: Line): Inline[][] {
  let s = l.s
  let e = l.e
  while (s < e && (src[s] === ' ' || src[s] === '\t')) s++
  while (e > s && (src[e - 1] === ' ' || src[e - 1] === '\t')) e--
  if (src[s] === '|') s++
  if (e > s && src[e - 1] === '|') e--
  const out: Inline[][] = []
  let from = s
  while (from <= e && out.length < MAX_COLS) {
    let to = src.indexOf('|', from)
    if (to === -1 || to > e) to = e
    let a = from
    let b = to
    while (a < b && (src[a] === ' ' || src[a] === '\t')) a++
    while (b > a && (src[b - 1] === ' ' || src[b - 1] === '\t')) b--
    out.push(parseInline(src, a, b))
    from = to + 1
  }
  return out
}

export function parseMd(input: string): Block[] {
  const src = input.length > MAX_SRC ? input.slice(0, MAX_SRC) : input
  const lines = splitLines(src)
  const blocks: Block[] = []
  let para: Inline[] = []
  const endPara = () => {
    if (para.length) blocks.push({ t: 'p', inline: para })
    para = []
  }
  const text = (l: Line) => src.slice(l.s, l.e)
  const blank = (l: Line) => text(l).trim() === ''
  for (let n = 0; n < lines.length; n++) {
    const l = lines[n]!
    if (blank(l)) {
      endPara()
      continue
    }
    const t = text(l)
    const next = lines[n + 1]
    if (t.includes('|') && next && SEP.test(text(next))) {
      endPara()
      const head = cells(src, l)
      const rows: Inline[][][] = []
      n += 2
      while (n < lines.length && text(lines[n]!).includes('|') && !blank(lines[n]!)) {
        if (rows.length < MAX_ROWS) rows.push(cells(src, lines[n]!))
        n++
      }
      n--
      blocks.push({ t: 'table', head, rows })
      continue
    }
    const lm = LIST.exec(t)
    if (lm) {
      endPara()
      const ordered = /\d/.test(lm[2]!)
      const items: ListItem[] = []
      while (n < lines.length) {
        const cur = lines[n]!
        const m = LIST.exec(text(cur))
        if (!m) break
        if (items.length < MAX_ITEMS) items.push({ depth: Math.min(MAX_DEPTH - 1, Math.floor(m[1]!.replace(/\t/g, '  ').length / 2)), inline: parseInline(src, cur.s + m[0].length, cur.e) })
        n++
      }
      n--
      blocks.push({ t: ordered ? 'ol' : 'ul', items })
      continue
    }
    const hm = HEAD.exec(t)
    if (hm) {
      endPara()
      blocks.push({ t: 'p', inline: [{ t: 'strong', children: parseInline(src, l.s + hm[0].length, l.e, false) }] })
      continue
    }
    if (para.length) para.push({ t: 'text', text: '\n', start: lines[n - 1]!.e })
    para.push(...parseInline(src, l.s, l.e))
  }
  endPara()
  return blocks
}

const inlineText = (xs: Inline[]): string => xs.map((x) => (x.t === 'strong' ? inlineText(x.children) : x.text)).join('')
/** Flattened text of a parse (for tests and copy). */
export function plainText(bs: Block[]): string {
  return bs
    .map((b) => (b.t === 'p' ? inlineText(b.inline) : b.t === 'table' ? [b.head, ...b.rows].map((r) => r.map(inlineText).join(' | ')).join('\n') : b.items.map((i) => `${'  '.repeat(i.depth)}${inlineText(i.inline)}`).join('\n')))
    .join('\n')
}
