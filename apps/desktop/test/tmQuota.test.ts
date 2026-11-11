import { describe, expect, it } from 'vitest'
import type { QuotaStatus } from '../src/lib/api'
import { deskChips } from '../src/lib/deskUi'
import { FakeQuota } from '../src/lib/tmFake'
import { classifyTmError, tmErrorText } from '../src/lib/tmUi'
import { degradedText, fmtClock, isPaused, parseBudgetInput, pausedMessage, previewChip, quotaChip, throttleChip, untilOf, untilText } from '../src/lib/tmQuota'

const NOW = Date.UTC(2026, 11 - 1, 11, 15, 0, 0)
const MIDNIGHT = Date.UTC(2026, 11 - 1, 12, 0, 0, 0)
const q = (o: Partial<QuotaStatus> = {}): QuotaStatus => ({
  day: '2026-11-11', used: 37, limit: 200, remaining: 163, per_min: 10, per_day: 200, limit_seen: null, window_used: 0,
  throttled_until_ms: null, paused: false, paused_until_ms: null, preview: false, now_ms: NOW, ...o,
})

describe('header chip', () => {
  it('"TM 37/200 today", neutral below 80%', () => {
    const c = quotaChip(q(), NOW)!
    expect(c.text).toBe('TM 37/200 today')
    expect(c.tone).toBe('ok')
  })
  it('amber from 80% (159 is not, 160 is), red when the day is used up', () => {
    expect(quotaChip(q({ used: 159, remaining: 41 }), NOW)!.tone).toBe('ok')
    expect(quotaChip(q({ used: 160, remaining: 40 }), NOW)!.tone).toBe('warn')
    expect(quotaChip(q({ used: 199, remaining: 1 }), NOW)!.tone).toBe('warn')
    const red = quotaChip(q({ used: 200, remaining: 0, paused: true, paused_until_ms: MIDNIGHT }), NOW, 'UTC')!
    expect(red.tone).toBe('bad')
    expect(red.text).toBe('TM 200/200 today')
    expect(red.title).toContain('TM paused until 00:00 tomorrow')
  })
  it('no chip before the first status; a learned smaller limit is explained', () => {
    expect(quotaChip(null, NOW)).toBeNull()
    expect(quotaChip(q({ used: 25, limit: 25, remaining: 0, limit_seen: 25, paused: true, paused_until_ms: MIDNIGHT }), NOW)!.title).toContain('limit is 25')
  })
  it('per-minute throttle chip only while it applies', () => {
    expect(throttleChip(q(), NOW)).toBeNull()
    expect(throttleChip(q({ throttled_until_ms: NOW - 1 }), NOW)).toBeNull()
    expect(throttleChip(q({ throttled_until_ms: NOW + 45_000 }), NOW, 'UTC')!.text).toBe('TM slow until 15:00:45')
  })
  it('preview chip says upgrade for full lists', () => {
    expect(previewChip(q())).toBeNull()
    expect(previewChip(q({ preview: true }))!.title).toContain('preview: upgrade for full lists')
  })
})

describe('degraded text', () => {
  it('paused: HH:MM in the viewer zone, "tomorrow" when it is not today', () => {
    expect(untilText(MIDNIGHT, NOW, 'UTC')).toBe('00:00 tomorrow')
    expect(untilText(NOW + 3_600_000, NOW, 'UTC')).toBe('16:00')
    expect(untilText(MIDNIGHT, NOW, 'America/New_York')).toBe('19:00')
    expect(fmtClock(MIDNIGHT, { timeZone: 'UTC' })).toBe('00:00')
  })
  it('turns the core\'s message into "TM paused until ..." with the reason', () => {
    const msg = 'TM paused until 2026-11-12T00:00:00Z: daily budget used (200 of 200 calls)'
    expect(untilOf(msg)).toBe(MIDNIGHT)
    expect(degradedText(msg, NOW, 'UTC')).toBe('TM paused until 00:00 tomorrow (daily budget used (200 of 200 calls))')
    expect(degradedText('TM throttled until 2026-11-11T15:01:00Z: 10 calls per minute used', NOW, 'UTC')).toBe('TM throttled until 15:01:00 (10 calls per minute used)')
    expect(untilOf('no time here')).toBeNull()
  })
  it('classify + display: a paused or throttled call is its own kind, never an error wall', () => {
    expect(classifyTmError('TM paused until 2026-11-12T00:00:00Z: daily budget used (200 of 200 calls)')).toBe('paused')
    expect(classifyTmError('TM throttled until 2026-11-11T15:01:00Z: 10 calls per minute used')).toBe('throttled')
    expect(tmErrorText('TM paused until 2026-11-12T00:00:00Z: daily budget used (200 of 200 calls)')).toMatch(/^TM paused until \d\d:\d\d/)
    // TM's own words still read as tier text
    expect(classifyTmError('tool error: Daily limit reached')).toBe('tier')
    expect(classifyTmError('tool error: Premium feature')).toBe('other')
  })
  it('pausedMessage round-trips through the parser', () => {
    const m = pausedMessage(q({ used: 200, remaining: 0, paused: true, paused_until_ms: MIDNIGHT }))
    expect(m).toBe('TM paused until 2026-11-12T00:00:00Z: daily budget used (200 of 200 calls)')
    expect(untilOf(m)).toBe(MIDNIGHT)
  })
  it('isPaused ends when the pause does', () => {
    const p = q({ paused: true, paused_until_ms: MIDNIGHT })
    expect(isPaused(p, NOW)).toBe(true)
    expect(isPaused(p, MIDNIGHT)).toBe(false)
    expect(isPaused(null, NOW)).toBe(false)
    expect(isPaused(q(), NOW)).toBe(false)
  })
})

describe('desk header', () => {
  const base = { rh: 'connected' as const, account: 'A', approvalOn: true, tm: { key_present: true, last_error: null }, vault: null, fake: false }
  it('adds "TM paused until HH:MM" only while paused; existing chips are untouched', () => {
    const keys = (quota?: QuotaStatus | null) => deskChips({ ...base, ...(quota !== undefined ? { quota } : {}), now: NOW }).map((c) => c.key)
    expect(keys()).toEqual(['rh', 'approvals', 'tm', 'vault'])
    expect(keys(q())).toEqual(['rh', 'approvals', 'tm', 'vault'])
    expect(keys(q({ paused: true, paused_until_ms: MIDNIGHT }))).toEqual(['rh', 'approvals', 'tm', 'tm-paused', 'vault'])
    const chip = deskChips({ ...base, quota: q({ paused: true, paused_until_ms: MIDNIGHT }), now: NOW }).find((c) => c.key === 'tm-paused')!
    expect(chip.text).toMatch(/^TM paused until \d\d:\d\d/)
    expect(chip.tone).toBe('warn')
  })
})

describe('budget fields', () => {
  it('whole numbers: 1 to 12 per minute, 1 to 10000 per day', () => {
    expect(parseBudgetInput('10', '200')).toEqual({ ok: true, perMin: 10, perDay: 200 })
    expect(parseBudgetInput(' 12 ', '10000')).toEqual({ ok: true, perMin: 12, perDay: 10000 })
    for (const [a, b] of [['0', '200'], ['13', '200'], ['x', '200'], ['10.5', '200'], ['10', '0'], ['10', '10001'], ['10', ''], ['-1', '200']] as const) {
      expect(parseBudgetInput(a, b).ok, `${a} ${b}`).toBe(false)
    }
  })
})

describe('the fake budget mirrors the Rust core', () => {
  const clock = (start: number) => {
    let t = start
    return { now: () => t, set: (v: number) => (t = v) }
  }
  it('10 a minute (background leaves 2 free), 200 a day, background dropped under 20%', () => {
    const f = new FakeQuota()
    const c = clock(NOW)
    f.now = c.now
    f.enforce = true
    for (let i = 0; i < 10; i++) f.charge('interactive')
    expect(() => f.charge('interactive')).toThrow(/^TM throttled until 2026-11-11T15:01:00Z: 10 calls per minute used/)
    c.set(NOW + 60_001)
    for (let i = 0; i < 8; i++) f.charge('background')
    expect(() => f.charge('background')).toThrow(/TM throttled/)
    f.charge('interactive')
    f.reset()
    f.now = c.now
    f.enforce = true
    f.used = 190
    f.perMin = 12
    expect(() => f.charge('opportunistic')).toThrow(/^TM paused until .*: daily budget nearly used \(10 of 200 calls left/)
    f.charge('interactive')
    f.used = 200
    expect(() => f.charge('interactive')).toThrow(/^TM paused until 2026-11-12T00:00:00Z: daily budget used \(200 of 200 calls\)/)
    // the day rolls over
    c.set(MIDNIGHT + 1000)
    f.charge('interactive')
    expect(f.status()).toMatchObject({ used: 1, paused: false, day: '2026-11-12' })
  })
  it('set() validates like the core', () => {
    const f = new FakeQuota()
    expect(() => f.set(13, 200)).toThrow(/invalid input/)
    expect(() => f.set(10, 0)).toThrow(/invalid input/)
    expect(f.set(6, 80)).toMatchObject({ per_min: 6, per_day: 80, limit: 80 })
  })
})
