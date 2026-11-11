/** Mirrors src-tauri/src/journal.rs validation (the Rust core is the authority; the fake backend uses this so tests see the same refusals). */
export const NOTE_MAX_BODY = 10_000
export const NOTE_MAX_TAGS = 10
export const NOTE_MAX_TAG = 32
export const NOTE_MAX_LIMIT = 500
export const NOTE_DEFAULT_LIMIT = 200

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
// eslint-disable-next-line no-control-regex
const BODY_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/ // everything except \t and \n

/** '' when valid. Non-empty, at most 10,000 characters, no control characters except newline and tab. */
export function validateBody(body: string): string {
  if (body.trim() === '') return 'note is empty'
  if ([...body].length > NOTE_MAX_BODY) return 'note is longer than 10,000 characters'
  if (BODY_CONTROL.test(body)) return 'note contains control characters'
  return ''
}

/** Trimmed, case-insensitively de-duplicated tags, or an error message. */
export function cleanTags(tags: string[]): { tags: string[]; error: string } {
  if (tags.length > NOTE_MAX_TAGS) return { tags: [], error: 'at most 10 tags' }
  const out: string[] = []
  for (const raw of tags) {
    const t = raw.trim()
    if (t === '' || [...t].length > NOTE_MAX_TAG || CONTROL.test(t)) return { tags: [], error: 'each tag must be 1 to 32 printable characters' }
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t)
  }
  return { tags: out, error: '' }
}

/** "a, b ,,c" -> ['a','b','c'] (not validated; use cleanTags). */
export function parseTags(input: string): string[] {
  return input
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Body and tags together, for inline feedback. '' when the note can be saved. */
export function validateNoteInput(body: string, tags: string[]): string {
  const b = validateBody(body)
  if (b) return `Note: ${b}.`
  const t = cleanTags(tags)
  return t.error ? `Tags: ${t.error}.` : ''
}

export function likeContains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

/** Data rows the CSV export writes: one per trade (one per linked note when it has notes) plus every note that matches no trade. Mirrors `export_row_count`. */
export function exportRowCount(notes: Array<{ trade_key: string | null }>, trades: Array<{ trade_key: string }>): number {
  const keys = new Set(trades.map((t) => t.trade_key))
  const linked = new Map<string, number>()
  let loose = 0
  for (const n of notes) {
    if (n.trade_key !== null && keys.has(n.trade_key)) linked.set(n.trade_key, (linked.get(n.trade_key) ?? 0) + 1)
    else loose += 1
  }
  return trades.reduce((a, t) => a + Math.max(1, linked.get(t.trade_key) ?? 0), 0) + loose
}
