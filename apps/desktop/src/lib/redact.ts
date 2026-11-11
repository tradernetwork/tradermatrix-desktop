/**
 * Secret redaction (M16 B7), the webview half of `src-tauri/src/redact.rs` (same rules, same test vectors). A question that looks like it
 * holds an API key is never sent: the store refuses it with a plain message, so a pasted key never reaches the provider. Rust redacts again
 * before anything is stored or exported.
 * Matches: `sk-` / `sk-or-` + 16 or more key characters, `Bearer <20+ chars>`, `td_live_<8+>`, and a 32+ character hex/base64-ish run (with at
 * least one digit) right after the word key, token or secret. A price, a plain git sha in prose and ordinary words are left alone.
 * Pure, one pass, bounded scans (no regex backtracking), idempotent.
 */
const MARKER = '[redacted]'
const SK_MIN = 16
const BEARER_MIN = 20
const TD_MIN = 8
const RUN_MIN = 32
const RUN_PEEK = 512

const alnum = (c: string): boolean => /^[A-Za-z0-9]$/.test(c)
const isWord = (c: string): boolean => alnum(c) || c === '_'
const isKeyChar = (c: string): boolean => alnum(c) || c === '_' || c === '-'
const isTokenChar = (c: string): boolean => alnum(c) || '._~+/=-'.includes(c)
const isB64Char = (c: string): boolean => alnum(c) || '+/=_-'.includes(c)
const isFiller = (c: string): boolean => /\s/.test(c) || ':="\'`('.includes(c)

function starts(c: readonly string[], i: number, lit: string, ci: boolean): boolean {
  if (i + lit.length > c.length) return false
  for (let k = 0; k < lit.length; k++) {
    const a = c[i + k]!
    const b = lit[k]!
    if (ci ? a.toLowerCase() !== b.toLowerCase() : a !== b) return false
  }
  return true
}
function runEnd(c: readonly string[], from: number, cap: number, f: (ch: string) => boolean): number {
  let j = from
  while (j < c.length && j - from < cap && f(c[j]!)) j++
  return j
}
const runAll = (c: readonly string[], from: number, f: (ch: string) => boolean): number => runEnd(c, from, Infinity, f)

function secretAt(c: readonly string[], i: number): [number, number] | null {
  const boundary = i === 0 || !isWord(c[i - 1]!)
  if (boundary && starts(c, i, 'sk-', false)) {
    const from = i + 3
    if (runEnd(c, from, SK_MIN, isKeyChar) - from >= SK_MIN) return [i, runAll(c, from, isKeyChar)]
  }
  if (boundary && starts(c, i, 'bearer', true)) {
    let k = i + 6
    const ws = k
    while (k < c.length && (c[k] === ' ' || c[k] === '\t')) k++
    if (k > ws && runEnd(c, k, BEARER_MIN, isTokenChar) - k >= BEARER_MIN) return [i, runAll(c, k, isTokenChar)]
  }
  if (boundary && starts(c, i, 'td_live_', false)) {
    const from = i + 8
    if (runEnd(c, from, TD_MIN, isWord) - from >= TD_MIN) return [i, runAll(c, from, isWord)]
  }
  for (const w of ['key', 'token', 'secret']) {
    if (!starts(c, i, w, true)) continue
    let k = i + w.length
    if (k < c.length && alnum(c[k]!)) continue // keyboard, tokens, secretary
    while (k < c.length && isFiller(c[k]!)) k++
    for (const lead of ['is', 'was']) {
      const nx = c[k + lead.length]
      if (starts(c, k, lead, true) && nx !== undefined && (/\s/.test(nx) || nx === ':' || nx === '=')) {
        k += lead.length
        while (k < c.length && isFiller(c[k]!)) k++
        break
      }
    }
    const peek = runEnd(c, k, RUN_PEEK, isB64Char)
    if (peek - k >= RUN_MIN && c.slice(k, peek).some((x) => x >= '0' && x <= '9')) return [k, runAll(c, k, isB64Char)]
  }
  return null
}

export function redactSecrets(s: string): string {
  const c = Array.from(s)
  const out: string[] = []
  let i = 0
  let emitted = 0
  while (i < c.length) {
    const hit = secretAt(c, i)
    if (hit && hit[1] > hit[0]) {
      out.push(c.slice(emitted, hit[0]).join(''), MARKER)
      i = Math.max(hit[1], i + 1)
      emitted = i
    } else i++
  }
  out.push(c.slice(emitted).join(''))
  return out.join('')
}

/** True when {@link redactSecrets} would change the text: the store refuses to send it. */
export const looksLikeSecret = (s: string): boolean => redactSecrets(s) !== s
