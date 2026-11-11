import { describe, expect, it } from 'vitest'
import type { TmSnapshot } from '../src/lib/api'
import {
  classifyTmError,
  fmtBand,
  fmtGexM,
  fmtHeld,
  fmtIvPct,
  fmtIvRank,
  fmtMovePct,
  gexTone,
  parseTmSettings,
  pctBar,
  snapshotCards,
  tmErrorText,
  tmPill,
  TM_DEFAULT_SETTINGS,
  validateTmKey,
} from '../src/lib/tmUi'

describe('validateTmKey', () => {
  const ok = 'td_live_TESTKEY' + '0'.repeat(10)
  it('accepts the prefix with length >= 20', () => expect(validateTmKey(ok)).toBeNull())
  it('rejects empty, wrong prefix and short values', () => {
    expect(validateTmKey('')).toMatch(/paste/i)
    expect(validateTmKey('sk_live_' + 'x'.repeat(30))).toMatch(/td_live_/)
    expect(validateTmKey('td_live_short')).toMatch(/short|20/)
  })
  it('trims whitespace before checking, rejects interior whitespace', () => {
    expect(validateTmKey(`  ${ok}  `)).toBeNull()
    expect(validateTmKey(ok.slice(0, 12) + ' ' + ok.slice(12))).not.toBeNull()
  })
  it('never echoes the value in the message', () => {
    for (const bad of ['sk_secretvalue_123456789012345', 'td_live_abc']) expect(validateTmKey(bad) ?? '').not.toContain(bad)
  })
})

describe('formatters', () => {
  it('ivRank is 0-100 and never multiplied by 100', () => {
    expect(fmtIvRank(37.86827855981068)).toBe('37.9 / 100')
    expect(fmtIvRank(0)).toBe('0.0 / 100')
    expect(fmtIvRank(null)).toBe('-')
  })
  it('expectedMovePct is a decimal fraction shown as percent', () => {
    expect(fmtMovePct(0.036)).toBe('3.6%')
    expect(fmtMovePct(0.019)).toBe('1.9%')
    expect(fmtMovePct(null)).toBe('-')
    expect(fmtMovePct(NaN)).toBe('-')
  })
  it('atm iv decimals', () => {
    expect(fmtIvPct(0.2443)).toBe('24.4%')
    expect(fmtIvPct(null)).toBe('-')
  })
  it('held rates are 0..1 shown as whole percent', () => {
    expect(fmtHeld(0.79)).toBe('79%')
    expect(fmtHeld(undefined as unknown as null)).toBe('-')
  })
  it('net GEX in $M with sign and tone', () => {
    expect(fmtGexM(232679707.1383302)).toBe('+$232.7M')
    expect(fmtGexM(-32773101.5)).toBe('-$32.8M')
    expect(fmtGexM(0)).toBe('$0.0M')
    expect(fmtGexM(null)).toBe('-')
    expect(gexTone(1)).toBe('bull')
    expect(gexTone(-1)).toBe('bear')
    expect(gexTone(0)).toBe('')
    expect(gexTone(null)).toBe('')
  })
  it('bands and bars', () => {
    expect(fmtBand({ low: 336, high: 362 })).toBe('336-362')
    expect(fmtBand({ low: 336.5, high: null })).toBe('-')
    expect(fmtBand(null)).toBe('-')
    expect(pctBar(0.04, 1)).toBe(4)
    expect(pctBar(37.87, 100)).toBeCloseTo(37.87)
    expect(pctBar(5, 1)).toBe(100)
    expect(pctBar(null, 1)).toBe(0)
    expect(pctBar(-1, 1)).toBe(0)
  })
})

describe('errors', () => {
  it('classifies each failure distinctly', () => {
    expect(classifyTmError('TraderMatrix key not set')).toBe('key_missing')
    expect(classifyTmError('vault locked: unlock it to use TraderMatrix')).toBe('locked')
    expect(classifyTmError('TraderMatrix rejected the key (invalid or revoked)')).toBe('rejected')
    expect(classifyTmError('tool error: Daily limit reached for your plan, upgrade to continue')).toBe('tier')
    expect(classifyTmError('transport error: error sending request: connection refused')).toBe('transport')
    expect(classifyTmError('protocol error: something odd')).toBe('other')
  })
  it('user text is distinct per kind and passes tier text through plainly', () => {
    const texts = [
      tmErrorText('TraderMatrix key not set'),
      tmErrorText('vault locked: unlock it to use TraderMatrix'),
      tmErrorText('TraderMatrix rejected the key (invalid or revoked)'),
      tmErrorText('transport error: timeout'),
    ]
    expect(new Set(texts).size).toBe(4)
    const tier = 'tool error: Daily limit reached for your plan'
    expect(tmErrorText(tier)).toContain('Daily limit reached for your plan')
  })
})

describe('tmPill', () => {
  it('maps status to the three required states plus vault locked', () => {
    expect(tmPill(null).text).toBe('TM: not set')
    expect(tmPill({ key_present: false, last_error: 'TraderMatrix key not set' }).text).toBe('TM: not set')
    expect(tmPill({ key_present: true, last_error: null }).text).toBe('TM: key saved')
    expect(tmPill({ key_present: true, last_error: 'TraderMatrix rejected the key (invalid or revoked)' }).text).toBe('TM: rejected')
    expect(tmPill({ key_present: false, last_error: 'vault locked: unlock it to use TraderMatrix' }).text).toBe('TM: vault locked')
    expect(tmPill({ key_present: true, last_error: null }).cls).toBe('ok')
    expect(tmPill({ key_present: true, last_error: 'TraderMatrix rejected the key (invalid or revoked)' }).cls).toBe('warn')
  })
})

describe('parseTmSettings', () => {
  it('defaults when absent, garbage, or wrong shape', () => {
    for (const raw of [null, undefined, '', '{nope', '[]', '"x"', '123', 'null']) expect(parseTmSettings(raw)).toEqual(TM_DEFAULT_SETTINGS)
  })
  it('restores valid fields and ignores invalid ones individually', () => {
    expect(parseTmSettings(JSON.stringify({ apex: true, flip: 'yes', move: true, horizon: '2 weeks' }))).toEqual({
      apex: true, flip: TM_DEFAULT_SETTINGS.flip, move: true, horizon: '2 weeks',
    })
    expect(parseTmSettings(JSON.stringify({ horizon: 42 })).horizon).toBe(TM_DEFAULT_SETTINGS.horizon)
    expect(parseTmSettings(JSON.stringify({ horizon: 'x'.repeat(100) })).horizon).toBe(TM_DEFAULT_SETTINGS.horizon)
  })
})

describe('snapshotCards', () => {
  const full: TmSnapshot = {
    symbol: 'AAPL',
    quality: { quality_score: 82, quality_score_out_of: 100, quality_label: 'High quality', sector: 'Technology' },
    gamma: { regime: 'positive_gamma', regime_summary: 's', gamma_flip_level: 342.18, spot_vs_flip: 'above_flip', spot_vs_flip_distance: '1_to_3pct', gamma_pocket: 'Positive Gamma Pocket' },
    apex: { nearest_level: { strike: 350, score: 73, score_out_of: 100, side: 'above_spot', distance_from_spot: 'within_1pct' }, dominant_level_strike: 355, level_count: 8 },
    flow: { bias: 'balanced', conviction: 0.04, conviction_out_of: 1, basis: 'b', updated_at: null },
    iv_rank: { iv_rank: 37.86827855981068, iv_rank_out_of: 100, iv_rank_zone: 'mid', interpretation: 'i', source: 'cboe', as_of: '2026-11-10' },
    market_health: { composite_score: 3.5, composite_score_max: 5, composite_unit: 'u', label: 'HIGH', alert_count: 3, watch_count: 1, as_of: null },
    missing: [],
    open_url: null,
  }
  it('builds six cards from a full snapshot with the right numbers', () => {
    const c = snapshotCards(full)
    expect(c.map((x) => x.key)).toEqual(['quality', 'gamma', 'apex', 'flow', 'iv_rank', 'market_health'])
    expect(c.find((x) => x.key === 'iv_rank')!.headline).toBe('37.9 / 100')
    expect(c.find((x) => x.key === 'iv_rank')!.bar).toBeCloseTo(37.87, 1)
    expect(c.find((x) => x.key === 'flow')!.bar).toBe(4)
    expect(c.find((x) => x.key === 'quality')!.headline).toBe('82 / 100')
    expect(c.find((x) => x.key === 'gamma')!.sub.join(' ')).toContain('342.18')
    expect(c.find((x) => x.key === 'apex')!.headline).toContain('350')
    expect(c.find((x) => x.key === 'market_health')!.headline).toContain('3.5 / 5')
  })
  it('tolerates null legs and a missing list: the card says unavailable instead of throwing', () => {
    const c = snapshotCards({ ...full, gamma: null, flow: null, iv_rank: null, missing: ['gamma', 'flow'] })
    expect(c).toHaveLength(6)
    const g = c.find((x) => x.key === 'gamma')!
    expect(g.headline).toBe('unavailable')
    expect(g.bar).toBeUndefined()
    expect(c.find((x) => x.key === 'quality')!.headline).toBe('82 / 100')
  })
  it('null snapshot gives no cards', () => expect(snapshotCards(null)).toEqual([]))
  it('a leg with all-null fields does not throw', () => {
    const c = snapshotCards({ ...full, quality: { quality_score: null, quality_score_out_of: null, quality_label: null, sector: null }, apex: { nearest_level: null, dominant_level_strike: null, level_count: null } })
    expect(c.find((x) => x.key === 'quality')!.headline).toBe('-')
    expect(c.find((x) => x.key === 'apex')!.headline).toBe('-')
  })
})
