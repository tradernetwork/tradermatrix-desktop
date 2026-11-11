/** Toast spam control (M17 task 5): at most 20 toasts an hour overall and 5 an hour per symbol, then ONE "N more alerts" summary. The events themselves are always stored. */
export const HOUR_MS = 3_600_000
export const MAX_PER_HOUR = 20
export const MAX_PER_SYMBOL_PER_HOUR = 5

export interface Admission {
  /** Show a toast for this fire. */
  show: boolean
  /** When held back: how many alerts the summary toast counts so far (0 when shown). */
  more: number
}

export class SpamGate {
  private shown: { symbol: string; t: number }[] = []
  private more = 0

  /** A toast shown exactly one hour ago is out of the window. Held-back fires never use up the window. */
  admit(symbol: string, now: number): Admission {
    this.shown = this.shown.filter((s) => s.t > now - HOUR_MS)
    const perSymbol = this.shown.filter((s) => s.symbol === symbol).length
    if (this.shown.length < MAX_PER_HOUR && perSymbol < MAX_PER_SYMBOL_PER_HOUR) {
      this.shown.push({ symbol, t: now })
      this.more = 0
      return { show: true, more: 0 }
    }
    this.more += 1
    return { show: false, more: this.more }
  }

  reset(): void {
    this.shown = []
    this.more = 0
  }
}
