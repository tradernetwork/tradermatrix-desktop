import { describe, expect, it } from 'vitest'
import {
  autoDensity,
  layoutBudget,
  parseDensity,
  parseStrip,
  planChips,
  planToolbar,
  stripLine,
  TOOLBAR_MIN_PX,
} from '../src/lib/layoutBudget'

describe('M22 settings parsing', () => {
  it('density: only the two names parse, everything else is "auto" (null)', () => {
    expect(parseDensity('compact')).toBe('compact')
    expect(parseDensity('comfortable')).toBe('comfortable')
    expect(parseDensity('')).toBeNull()
    expect(parseDensity(null)).toBeNull()
    expect(parseDensity('huge')).toBeNull()
  })
  it('auto density: compact below 1300 px, comfortable from 1300', () => {
    expect(autoDensity(1172)).toBe('compact')
    expect(autoDensity(1299)).toBe('compact')
    expect(autoDensity(1300)).toBe('comfortable')
    expect(autoDensity(1536)).toBe('comfortable')
  })
  it('metrics strip: default is the one-line mode, only an explicit "cards" gives cards', () => {
    expect(parseStrip(null)).toBe('line')
    expect(parseStrip('garbage')).toBe('line')
    expect(parseStrip('cards')).toBe('cards')
    expect(parseStrip('line')).toBe('line')
  })
})

describe('M22 layout budget (plot height of the chart pane)', () => {
  const base = { strip: 'line' as const, banner: true }
  it('1172 x 982 (compact, line strip, FAKE banner on): plot >= 260', () => {
    const b = layoutBudget({ width: 1172, height: 982, density: autoDensity(1172), ...base })
    expect(b.plotPx).toBeGreaterThanOrEqual(260)
    expect(b.bottomPx).toBeLessThanOrEqual(150)
  })
  it('1536 x 864 (comfortable, line strip, FAKE banner on): plot >= 300', () => {
    const b = layoutBudget({ width: 1536, height: 864, density: autoDensity(1536), ...base })
    expect(b.plotPx).toBeGreaterThanOrEqual(300)
  })
  it('the same two sizes without the banner (real app) have even more room', () => {
    const a = layoutBudget({ width: 1172, height: 982, strip: 'line', banner: false })
    const b = layoutBudget({ width: 1172, height: 982, strip: 'line', banner: true })
    expect(a.plotPx).toBe(b.plotPx + 24)
  })
  it('the cards strip costs plot height; the header never exceeds one row', () => {
    const line = layoutBudget({ width: 1172, height: 982, strip: 'line', banner: false })
    const cards = layoutBudget({ width: 1172, height: 982, strip: 'cards', banner: false })
    expect(cards.stripPx).toBeGreaterThan(line.stripPx)
    expect(cards.plotPx).toBeLessThan(line.plotPx)
    expect(line.headerPx).toBeLessThanOrEqual(44)
    expect(line.toolbarPx).toBeLessThanOrEqual(44)
  })
  it('old layout (two header rows, 7 cards, 210 px bottom) would have been below the goal: the budget is a real improvement', () => {
    const b = layoutBudget({ width: 1172, height: 982, strip: 'line', banner: false })
    // screenshot evidence: ~60 px plot with ~280 px of header chrome and a 230 px bottom group
    expect(b.toolbarPx + b.headerPx + b.stripPx).toBeLessThan(120)
  })
  it('the rows add up: workspace = group heights; nothing negative at small windows', () => {
    for (const [w, h] of [[1000, 640], [1172, 982], [1280, 720], [1536, 864], [1920, 1080], [2560, 1440]] as const) {
      const b = layoutBudget({ width: w, height: h, strip: 'line', banner: true })
      expect(b.toolbarPx + b.headerPx + b.stripPx + b.bannerPx + b.workspacePx).toBe(h)
      expect(b.plotPx).toBeGreaterThanOrEqual(0)
      expect(b.ticketPx + b.tmPx).toBeLessThan(w)
    }
  })
  it('bigger windows never give a smaller plot', () => {
    let last = 0
    for (let h = 600; h <= 1400; h += 50) {
      const p = layoutBudget({ width: 1500, height: h, strip: 'line', banner: false }).plotPx
      expect(p).toBeGreaterThanOrEqual(last)
      last = p
    }
  })
})

describe('M22 toolbar plan (no overlap at any width from 1000 px)', () => {
  it('everything fits: nothing is dropped', () => {
    const p = planToolbar(2400)
    expect(p).toMatchObject({ scope: true, brandText: true, tmDots: false, overflow: [] })
  })
  it('never needs more than the available width, 1000..2600 px', () => {
    for (let w = TOOLBAR_MIN_PX; w <= 2600; w++) {
      const p = planToolbar(w)
      expect(p.usedPx).toBeLessThanOrEqual(w)
    }
  })
  it('degrades in order: scope note, brand text, pill text, then overflow items', () => {
    const widths = [2400, 1700, 1500, 1350, 1250, 1100, 1000]
    const ps = widths.map(planToolbar)
    // monotone: a narrower window never shows something a wider one hid
    for (let i = 1; i < ps.length; i++) {
      const a = ps[i - 1]!
      const b = ps[i]!
      if (!a.scope) expect(b.scope).toBe(false)
      if (!a.brandText) expect(b.brandText).toBe(false)
      if (a.tmDots) expect(b.tmDots).toBe(true)
      expect(b.overflow.length).toBeGreaterThanOrEqual(a.overflow.length)
    }
    expect(ps[ps.length - 1]!.scope).toBe(false)
    expect(ps[ps.length - 1]!.brandText).toBe(false)
  })
  it('the wordmark text is gone at 1172 px (the mark stays); the scope note is gone too', () => {
    const p = planToolbar(1172)
    expect(p.brandText).toBe(false)
    expect(p.scope).toBe(false)
  })
})

describe('M22 header chips plan (one row, never wraps, never runs off)', () => {
  const statuses = ['Robinhood: connected', 'Approvals: OFF', 'TM key: ok', 'Vault: unlocked']
  const stats = ['ATR(34) 1.29', 'range pos 0.45']
  it('plenty of room: full text pills', () => {
    const p = planChips(1200, statuses, stats)
    expect(p).toMatchObject({ mode: 'full', visible: 4, showStats: true, moreCount: 0 })
  })
  it('tight: status dots, stats as plain text', () => {
    const p = planChips(330, statuses, stats)
    expect(p.mode).toBe('dots')
    expect(p.visible).toBe(4)
  })
  it('very tight: overflow button lists the rest', () => {
    const p = planChips(60, statuses, stats)
    expect(p.mode).toBe('dots')
    expect(p.moreCount).toBeGreaterThan(0)
  })
  it('used width never exceeds the available one (from 40 px up)', () => {
    for (let a = 40; a <= 1400; a++) {
      const p = planChips(a, statuses, stats)
      expect(p.usedPx).toBeLessThanOrEqual(a)
      expect(p.visible + (p.mode === 'full' ? 0 : p.moreCount - (p.showStats ? 0 : stats.length))).toBeLessThanOrEqual(statuses.length + stats.length)
    }
  })
  it('no chips at all: nothing to place', () => {
    expect(planChips(100, [], [])).toMatchObject({ visible: 0, moreCount: 0, usedPx: 0 })
  })
})

describe('M22 condensed metrics line', () => {
  it('Equity $x . BP $x . Cash $x . P&L $x . Orders n . Approvals n', () => {
    const s = stripLine({ equity: '$1,000.00', buyingPower: '$500.00', cash: '$250.00', pnl: '$12.00', orders: '2', approvals: '0' })
    expect(s.map((x) => x.k)).toEqual(['Equity', 'BP', 'Cash', 'P&L', 'Orders', 'Approvals'])
    expect(s[0]!.v).toBe('$1,000.00')
  })
})
