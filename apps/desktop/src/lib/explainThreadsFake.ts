/**
 * Fake chat-thread store for the dev page and tests (M16 B3). Same rules as src-tauri/src/explain_threads.rs: validation, 200 messages per thread,
 * 50 threads, 2 MB of text (oldest first), a delete takes the partner message, saveHistory off writes nothing. It only ever holds what the Rust
 * command would hold: texts, token counts, model, prompt version, grounding flags and the digest HASH (a test scans it for the key and digest lines).
 */
export interface NewMessage {
  role: 'user' | 'assistant'
  text: string
  prompt_tok?: number | null
  completion_tok?: number | null
  model?: string | null
  digest_hash?: string | null
  had_positions?: boolean
  prompt_version?: string | null
  flagged_json?: string | null
}
export interface StoredMessage {
  id: number
  role: 'user' | 'assistant'
  text: string
  ts: number
  prompt_tok: number | null
  completion_tok: number | null
  model: string | null
  digest_hash: string | null
  had_positions: boolean
  prompt_version: string | null
  flagged_json: string | null
}
export interface ThreadMeta {
  id: number
  symbol: string
  title: string
  created_at: number
  updated_at: number
  messages: number
}
export interface AppendOut {
  thread_id: number
  message_ids: number[]
}

export const MAX_THREAD_MESSAGES = 200
export const MAX_THREADS = 50
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024
export const MAX_MESSAGE_CHARS = 8000

const SYMBOL = /^[A-Za-z0-9.-]{1,12}$/
const HASH = /^[0-9a-f]{64}$/
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,99}$/
const VERSION = /^[A-Za-z0-9._-]{1,32}$/
const bytes = (s: string) => new TextEncoder().encode(s).length

function bad(m: string): never {
  throw new Error(`invalid input: ${m}`)
}

function title(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
    .slice(0, 60)
}

function check(m: NewMessage): void {
  if (m.role !== 'user' && m.role !== 'assistant') bad('role must be user or assistant')
  if (typeof m.text !== 'string' || !m.text.trim() || [...m.text].length > MAX_MESSAGE_CHARS) bad('message text must be 1 to 8000 characters')
  for (const t of [m.prompt_tok, m.completion_tok]) if (t != null && !(Number.isInteger(t) && t >= 0 && t <= 10_000_000)) bad('token count out of range')
  if (m.model != null && !MODEL.test(m.model)) bad('bad model name')
  if (m.digest_hash != null && !HASH.test(m.digest_hash)) bad('digest hash must be 64 lowercase hex characters')
  if (m.prompt_version != null && !VERSION.test(m.prompt_version)) bad('bad prompt version')
  if (m.flagged_json != null) {
    let ok = false
    try {
      ok = m.flagged_json.length <= 4096 && Array.isArray(JSON.parse(m.flagged_json))
    } catch {
      ok = false
    }
    if (!ok) bad('flagged_json must be a JSON array of at most 4 KB')
  }
}

interface Row extends StoredMessage {
  thread_id: number
}

export class FakeThreads {
  private threads: { id: number; symbol: string; title: string; created_at: number; updated_at: number }[] = []
  private rows: Row[] = []
  private tid = 0
  private mid = 0
  private clock = 1_700_000_000_000
  /** Markdown of every export, in order. */
  exports: string[] = []
  constructor(private readonly setting: (k: string) => string | null) {}

  reset(): void {
    this.threads = []
    this.rows = []
    this.tid = 0
    this.mid = 0
    this.exports = []
  }

  private saveOn(): boolean {
    const v = this.setting('chat.saveHistory')
    if (v == null) return true
    try {
      return JSON.parse(v.trim()) !== false
    } catch {
      return true
    }
  }

  append(threadId: number | null, symbol: string, msgs: NewMessage[]): AppendOut | null {
    if (!SYMBOL.test(symbol)) bad('symbol must be 1 to 12 characters: A-Z, 0-9, . or -')
    const sym = symbol.toUpperCase()
    if (msgs.length < 1 || msgs.length > 8) bad('append takes 1 to 8 messages')
    for (const m of msgs) check(m)
    if (!this.saveOn()) return null
    const now = (this.clock += 1000)
    let t = this.threads.find((x) => x.id === threadId)
    if (threadId != null) {
      if (!t) throw new Error('not found: thread')
      if (t.symbol !== sym) bad('that thread belongs to another symbol')
      t.updated_at = now
    } else {
      const first = msgs.find((m) => m.role === 'user') ?? msgs[0]!
      t = { id: ++this.tid, symbol: sym, title: title(first.text), created_at: now, updated_at: now }
      this.threads.push(t)
    }
    const ids: number[] = []
    for (const m of msgs) {
      const id = ++this.mid
      ids.push(id)
      this.rows.push({
        id,
        thread_id: t.id,
        role: m.role,
        text: m.text,
        ts: now,
        prompt_tok: m.prompt_tok ?? null,
        completion_tok: m.completion_tok ?? null,
        model: m.model ?? null,
        digest_hash: m.digest_hash ?? null,
        had_positions: !!m.had_positions,
        prompt_version: m.prompt_version ?? null,
        flagged_json: m.flagged_json ?? null,
      })
    }
    // limits: 200 per thread, 50 threads, 2 MB (oldest first, never the thread being written)
    const mine = this.rows.filter((r) => r.thread_id === t.id)
    for (const r of mine.slice(0, Math.max(0, mine.length - MAX_THREAD_MESSAGES))) this.rows = this.rows.filter((x) => x !== r)
    const byRecent = [...this.threads].sort((a, b) => b.updated_at - a.updated_at || b.id - a.id)
    for (const old of byRecent.slice(MAX_THREADS)) this.drop(old.id)
    const total = () => this.rows.reduce((n, r) => n + bytes(r.text), 0)
    while (total() > MAX_TOTAL_BYTES) {
      const victim = [...this.threads].filter((x) => x.id !== t.id).sort((a, b) => a.updated_at - b.updated_at || a.id - b.id)[0]
      if (victim) this.drop(victim.id)
      else {
        const first = this.rows.find((r) => r.thread_id === t.id)
        if (!first) break
        this.rows = this.rows.filter((r) => r !== first)
      }
    }
    return { thread_id: t.id, message_ids: ids }
  }

  private drop(id: number): void {
    this.threads = this.threads.filter((t) => t.id !== id)
    this.rows = this.rows.filter((r) => r.thread_id !== id)
  }

  list(symbol: string | null): ThreadMeta[] {
    if (symbol != null && !SYMBOL.test(symbol)) bad('symbol must be 1 to 12 characters: A-Z, 0-9, . or -')
    const sym = symbol?.toUpperCase() ?? null
    return this.threads
      .filter((t) => sym == null || t.symbol === sym)
      .sort((a, b) => b.updated_at - a.updated_at || b.id - a.id)
      .map((t) => ({ ...t, messages: this.rows.filter((r) => r.thread_id === t.id).length }))
  }

  load(threadId: number): StoredMessage[] {
    return this.rows.filter((r) => r.thread_id === threadId).map(({ thread_id: _t, ...m }) => ({ ...m }))
  }

  delete(threadId: number, messageId: number | null): void {
    if (messageId == null) return this.drop(threadId)
    const mine = this.rows.filter((r) => r.thread_id === threadId)
    const i = mine.findIndex((r) => r.id === messageId)
    if (i < 0) return
    const m = mine[i]!
    const partner = m.role === 'user' ? (mine[i + 1]?.role === 'assistant' ? mine[i + 1] : undefined) : mine[i - 1]?.role === 'user' ? mine[i - 1] : undefined
    this.rows = this.rows.filter((r) => r !== m && r !== partner)
    if (!this.rows.some((r) => r.thread_id === threadId)) this.drop(threadId)
  }

  deleteAll(): void {
    this.threads = []
    this.rows = []
  }

  exportMarkdown(threadId: number | null): string {
    const ts = threadId == null ? [...this.threads].sort((a, b) => a.updated_at - b.updated_at) : this.threads.filter((t) => t.id === threadId)
    if (threadId != null && ts.length === 0) throw new Error('not found: thread')
    if (ts.length === 0) bad('there is no chat history to export')
    let out = ''
    for (const t of ts) {
      out += `# Explain chat: ${t.symbol}\n\nThread: ${t.title}\n\n`
      for (const r of this.rows.filter((x) => x.thread_id === t.id)) out += `## ${r.role === 'user' ? 'You' : 'Arya'}\n\n${r.text.trimEnd()}\n\n`
    }
    this.exports.push(out)
    return `/fake/app-data/exports/tradermatrix-explain-${threadId == null ? 'all' : ts[0]!.symbol}-2026-11-12-${this.exports.length}.md`
  }

  /** Test and dev-page seeding: one thread of turns, written like real history (no digest, no key). */
  seed(symbol: string, turns: { role: 'user' | 'assistant'; text: string }[], titleText?: string): number {
    const out = this.append(null, symbol, turns.slice(0, 8))
    if (!out) return -1
    for (let i = 8; i < turns.length; i += 8) this.append(out.thread_id, symbol, turns.slice(i, i + 8))
    if (titleText) this.threads.find((t) => t.id === out.thread_id)!.title = titleText
    return out.thread_id
  }

  messages(): StoredMessage[] {
    return this.rows.map(({ thread_id: _t, ...m }) => ({ ...m }))
  }

  /** Every stored cell as text (to scan for secrets). Empty string when nothing is stored. */
  dump(): string {
    return [...this.threads.map((t) => JSON.stringify(t)), ...this.rows.map((r) => JSON.stringify(r))].join('\n')
  }
}
