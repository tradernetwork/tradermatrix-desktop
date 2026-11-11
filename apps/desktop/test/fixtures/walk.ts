import type { Bar } from '@rebull/script'

/** Seeded random walk, n weekdays ending 2026-10-16 (generator adapted from tradermatrix-charts/engine.test.ts). Never touches vendor data. */
export function walk(n = 600, seed = 7): Bar[] {
  let a = seed >>> 0
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const d = new Date(Date.UTC(2026, 9, 16, 14, 30))
  const times: number[] = []
  while (times.length < n) {
    if (d.getUTCDay() % 6) times.unshift(d.getTime())
    d.setUTCDate(d.getUTCDate() - 1)
  }
  let c = 100
  return times.map((time) => {
    const open = c
    c = open * (1 + (rnd() - 0.48) * 0.03)
    return {
      time,
      open,
      high: Math.max(open, c) * (1 + rnd() * 0.01),
      low: Math.min(open, c) * (1 - rnd() * 0.01),
      close: c,
      volume: 1e6 * (0.5 + rnd()),
    }
  })
}

/** Bars from a list of closes (open = previous close, high/low = max/min of open and close, volume 1000). */
export function fromCloses(closes: number[], t0 = Date.UTC(2026, 0, 5, 14, 30), stepMs = 86_400_000): Bar[] {
  return closes.map((close, i) => {
    const open = i ? closes[i - 1] : close
    return { time: t0 + i * stepMs, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1000 }
  })
}
