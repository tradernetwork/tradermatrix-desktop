import { describe, expect, it } from 'vitest'
import type { JournalNote, PnlBucket } from '../src/lib/api'
import { cleanTags, exportRowCount, NOTE_MAX_BODY, parseTags, validateBody, validateNoteInput } from '../src/lib/journalRules'
import { bucketBars, exportMessage, fmtSignedMoney, notesByTradeKey, pnlTone } from '../src/lib/journalUi'

describe('note validation (mirrors journal.rs)', () => {
  it('body: non-empty, 10,000 characters, no control characters except newline and tab', () => {
    expect(validateBody('ok')).toBe('')
    expect(validateBody('line\n\tline')).toBe('')
    expect(validateBody('x'.repeat(NOTE_MAX_BODY))).toBe('')
    expect(validateBody('é'.repeat(NOTE_MAX_BODY))).toBe('')
    for (const bad of ['', '   ', '\n\t', 'x'.repeat(NOTE_MAX_BODY + 1), 'a\u0000b', 'a\u0007b', 'a\u001bb', 'a\rb', 'a\u0085b']) {
      expect(validateBody(bad), JSON.stringify(bad.slice(0, 6))).not.toBe('')
    }
  })
  it('tags: at most 10, 1 to 32 characters, trimmed and de-duplicated', () => {
    expect(cleanTags([' Plan ', 'plan', 'x'])).toEqual({ tags: ['Plan', 'x'], error: '' })
    expect(cleanTags(Array.from({ length: 10 }, (_, i) => `t${i}`)).error).toBe('')
    expect(cleanTags(Array.from({ length: 11 }, (_, i) => `t${i}`)).error).not.toBe('')
    expect(cleanTags(['t'.repeat(32)]).error).toBe('')
    for (const bad of ['t'.repeat(33), '', '  ', 'a\nb']) expect(cleanTags([bad]).error, JSON.stringify(bad)).not.toBe('')
  })
  it('parseTags splits on commas', () => {
    expect(parseTags(' a, b ,,c ')).toEqual(['a', 'b', 'c'])
    expect(parseTags('')).toEqual([])
  })
  it('validateNoteInput names the failing part', () => {
    expect(validateNoteInput('ok', ['a'])).toBe('')
    expect(validateNoteInput('', [])).toMatch(/^Note:/)
    expect(validateNoteInput('ok', ['x'.repeat(40)])).toMatch(/^Tags:/)
  })
})

describe('P&L formatting', () => {
  it('signs and rounds', () => {
    expect(fmtSignedMoney(12.5)).toBe('+$12.50')
    expect(fmtSignedMoney(-3.25)).toBe('-$3.25')
    expect(fmtSignedMoney(0)).toBe('$0.00')
    expect(fmtSignedMoney(-0.004)).toBe('$0.00')
    expect(fmtSignedMoney(1234.5)).toBe('+$1,234.50')
    expect(fmtSignedMoney(null)).toBe('-')
    expect(fmtSignedMoney(Number.NaN)).toBe('-')
  })
  it('colour follows the rounded sign', () => {
    expect(pnlTone(0.01)).toBe('bull')
    expect(pnlTone(-0.01)).toBe('bear')
    expect(pnlTone(0.004)).toBe('')
    expect(pnlTone(-0.004)).toBe('')
    expect(pnlTone(null)).toBe('')
  })
  it('bucket bars scale to the largest bucket, colour by sign, null is empty', () => {
    const pts: PnlBucket[] = [
      { start_time: '2026-11-01T00:00:00Z', end_time: null, realized_gain: 100, rate_of_realized_gain: null, number_of_trades: 2 },
      { start_time: '2026-11-02T00:00:00Z', end_time: null, realized_gain: -50, rate_of_realized_gain: null, number_of_trades: 1 },
      { start_time: '2026-11-03T00:00:00Z', end_time: null, realized_gain: null, rate_of_realized_gain: null, number_of_trades: null },
      { start_time: '2026-11-04T00:00:00Z', end_time: null, realized_gain: 0.5, rate_of_realized_gain: null, number_of_trades: 1 },
      { start_time: '2026-11-05T00:00:00Z', end_time: null, realized_gain: 0, rate_of_realized_gain: null, number_of_trades: 0 },
    ]
    const b = bucketBars(pts)
    expect(b.map((x) => [x.height, x.tone])).toEqual([[100, 'bull'], [50, 'bear'], [0, ''], [3, 'bull'], [0, '']])
    expect(b[0]!.title).toBe('2026-11-01: +$100.00 (2 trades)')
    expect(b[1]!.title).toBe('2026-11-02: -$50.00 (1 trade)')
    expect(new Set(b.map((x) => x.key)).size).toBe(5)
    expect(bucketBars([])).toEqual([])
    expect(bucketBars([{ start_time: null, end_time: null, realized_gain: null, rate_of_realized_gain: null, number_of_trades: null }])[0]).toMatchObject({ height: 0, tone: '' })
  })
})

const note = (id: number, key: string | null): JournalNote => ({ id, created_at: '', updated_at: '', symbol: null, account_masked: null, trade_key: key, body: 'b', tags: [] })

describe('trade-note linking and export counts', () => {
  it('groups notes by trade_key in input order and skips unlinked notes', () => {
    const m = notesByTradeKey([note(3, 't_1'), note(2, null), note(1, 't_1'), note(0, 't_2')])
    expect(m.get('t_1')!.map((n) => n.id)).toEqual([3, 1])
    expect(m.get('t_2')!.map((n) => n.id)).toEqual([0])
    expect(m.size).toBe(2)
  })
  it('row count mirrors export_row_count: one per trade, one per linked note, plus unmatched notes', () => {
    const trades = [{ trade_key: 't_1' }, { trade_key: 't_2' }, { trade_key: 't_3' }]
    const notes = [note(1, 't_1'), note(2, 't_1'), note(3, null), note(4, 't_gone')]
    expect(exportRowCount(notes, trades)).toBe(2 + 1 + 1 + 2)
    expect(exportRowCount([], [])).toBe(0)
  })
  it('export message shows the path, rows and truncation', () => {
    expect(exportMessage({ path: '/x/a.csv', rows: 1, truncated: false })).toBe('Saved 1 row to /x/a.csv')
    expect(exportMessage({ path: '/x/a.csv', rows: 3, truncated: true })).toBe('Saved 3 rows to /x/a.csv (trade list truncated at 5 pages)')
  })
})
