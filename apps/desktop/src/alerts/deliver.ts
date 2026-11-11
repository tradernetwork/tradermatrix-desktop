/** Alert delivery beyond the toast (M17 task 8): a sound and a best-effort OS notification. Never throws, never retries, never fires for a missed-while-closed event. INFORM ONLY. */
import type { AlertEvent } from './types'

export interface DeliverDeps {
  /** `shown` or `unavailable` (the Rust command never errors on a missing daemon); a thrown error counts as unavailable. */
  notify: (title: string, body: string) => Promise<string>
  playSound: () => void
  /** Called exactly once, the first time the OS notice fails. */
  onUnavailable: () => void
  prefs: () => { sound: boolean; os: boolean }
}

export class Deliverer {
  private dead = false
  constructor(private readonly d: DeliverDeps) {}

  async deliver(e: AlertEvent): Promise<void> {
    if (e.missed || e.kind === 'missed') return
    const p = this.d.prefs()
    if (p.sound) {
      try {
        this.d.playSound()
      } catch {
        /* a blocked sound is not an error */
      }
    }
    if (!p.os || this.dead) return
    try {
      const r = await this.d.notify(e.label, `last ${e.trigger_px.toFixed(2)}`)
      if (r !== 'shown') this.fail()
    } catch {
      this.fail()
    }
  }

  private fail(): void {
    if (this.dead) return
    this.dead = true
    this.d.onUnavailable()
  }

  reset(): void {
    this.dead = false
  }
}
