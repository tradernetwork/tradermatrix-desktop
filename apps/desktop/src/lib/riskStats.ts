/**
 * R-multiple statistics (M18). Standard definitions only (mean, sample standard deviation, cumulative sum); no tables, no thresholds.
 * INFORMATIONAL ONLY: nothing here may gate or change an order. Trades without a recorded R never reach this file (the caller counts "N of M").
 */

export const SQN_MIN_TRADES = 30

export interface HistBin {
  /** Lower edge (inclusive), null for the open lower bucket. */
  lo: number | null
  /** Upper edge (exclusive), null for the open upper bucket. */
  hi: number | null
  count: number
  label: string
}

export interface RStats {
  n: number
  /** Mean R. */
  expectancy: number | null
  /** Wins (R > 0) over n; breakeven trades count in n only. */
  winRate: number | null
  avgWinR: number | null
  avgLossR: number | null
  /** mean / sample stdev (n-1) x sqrt(n). Null below 30 trades or when the stdev is zero. */
  sqn: number | null
  histogram: HistBin[]
  /** Cumulative sum of R in the order given. */
  curve: number[]
}

const HIST_LO = -3
const HIST_HI = 5
const STEP = 0.5

function edge(n: number): string {
  return `${n}R`
}

function emptyHistogram(): HistBin[] {
  const bins: HistBin[] = [{ lo: null, hi: HIST_LO, count: 0, label: `< ${edge(HIST_LO)}` }]
  for (let lo = HIST_LO; lo < HIST_HI; lo += STEP) {
    bins.push({ lo, hi: lo + STEP, count: 0, label: `${edge(lo)} to ${edge(lo + STEP)}` })
  }
  bins.push({ lo: HIST_HI, hi: null, count: 0, label: `>= ${edge(HIST_HI)}` })
  return bins
}

function histogram(rs: number[]): HistBin[] {
  const bins = emptyHistogram()
  const last = bins.length - 1
  for (const r of rs) {
    let i: number
    if (r < HIST_LO) i = 0
    else if (r >= HIST_HI) i = last
    else i = 1 + Math.floor((r - HIST_LO) / STEP + 1e-9)
    const b = bins[Math.min(Math.max(i, 0), last)]
    if (b) b.count += 1
  }
  return bins
}

export function rStats(input: readonly number[]): RStats {
  const rs = input.filter((r) => typeof r === 'number' && Number.isFinite(r))
  const n = rs.length
  const curve: number[] = []
  let run = 0
  for (const r of rs) {
    run += r
    curve.push(run)
  }
  if (n === 0) return { n, expectancy: null, winRate: null, avgWinR: null, avgLossR: null, sqn: null, histogram: histogram(rs), curve }
  const mean = run / n
  const wins = rs.filter((r) => r > 0)
  const losses = rs.filter((r) => r < 0)
  const avg = (a: number[]): number | null => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null)
  let sqn: number | null = null
  if (n >= SQN_MIN_TRADES) {
    const sd = Math.sqrt(rs.reduce((s, r) => s + (r - mean) * (r - mean), 0) / (n - 1))
    if (sd > 0 && Number.isFinite(sd)) sqn = (mean / sd) * Math.sqrt(n)
  }
  return { n, expectancy: mean, winRate: wins.length / n, avgWinR: avg(wins), avgLossR: avg(losses), sqn, histogram: histogram(rs), curve }
}

/** What the panel prints for SQN: the sample-size caveat below 30 trades, "-" for a zero spread, else two decimals. */
export function sqnText(n: number, sqn: number | null): string {
  if (n < SQN_MIN_TRADES) return `n=${n}, too few to rank`
  return sqn === null || !Number.isFinite(sqn) ? '-' : sqn.toFixed(2)
}

export interface DatedR {
  r: number
  /** ISO string or epoch milliseconds. Undated entries sort last, in input order. */
  closedAt?: string | number | null
}

/** R values ordered by close time (stable), ready for the equity curve. */
export function orderByClose(items: readonly DatedR[]): number[] {
  const t = (d: DatedR): number => {
    const v = typeof d.closedAt === 'number' ? d.closedAt : d.closedAt ? Date.parse(d.closedAt) : Number.NaN
    return Number.isFinite(v) ? v : Number.POSITIVE_INFINITY
  }
  return items
    .map((d, i) => ({ d, i, t: t(d) }))
    .sort((a, b) => (a.t === b.t ? a.i - b.i : a.t < b.t ? -1 : 1))
    .map((x) => x.d.r)
}
