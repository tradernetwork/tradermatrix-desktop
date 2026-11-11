/** Sampled snapshots (quotes, TraderMatrix responses) for the local database. Fire-and-forget; never affects the UI. */
export const MAX_SNAPSHOT_JSON = 16 * 1024
export const SNAPSHOT_EVERY_MS = 60_000

const KIND_RE = /^[a-z][a-z0-9_]{0,23}$/
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** JSON text for a snapshot, or null when it cannot be serialized or exceeds 16 KB (Rust rejects larger). */
export function snapshotJson(v: unknown): string | null {
  try {
    const s = JSON.stringify(v)
    return typeof s === 'string' && s.length <= MAX_SNAPSHOT_JSON && new TextEncoder().encode(s).length <= MAX_SNAPSHOT_JSON ? s : null
  } catch {
    return null
  }
}

type Sink = (kind: string, key: string, json: string) => Promise<unknown>

/** At most one snapshot per kind+key per `everyMs`. Errors become one console.warn. */
export class SnapshotSampler {
  private last = new Map<string, number>()
  constructor(
    private sink: Sink,
    private everyMs = SNAPSHOT_EVERY_MS,
    private warn: (m: string, e?: unknown) => void = (m, e) => console.warn(m, e),
  ) {}

  /** True when a snapshot was handed to the sink. */
  offer(kind: string, key: string, value: unknown, now = Date.now()): boolean {
    if (!KIND_RE.test(kind) || !KEY_RE.test(key)) return false
    const id = `${kind}:${key}`
    const prev = this.last.get(id)
    if (prev !== undefined && now - prev < this.everyMs) return false
    const json = snapshotJson(value)
    if (json === null) return false
    this.last.set(id, now)
    try {
      void Promise.resolve(this.sink(kind, key, json)).catch((e) => this.warn('snapshot storage failed (ignored)', e))
    } catch (e) {
      this.warn('snapshot storage failed (ignored)', e)
    }
    return true
  }
}
