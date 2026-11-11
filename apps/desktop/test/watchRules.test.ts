import { describe, expect, it } from 'vitest'
import { parseWatchSymbols, validateDescription, validateEmoji, validateListName, watchlistWritable } from '../src/lib/watchRules'

describe('parseWatchSymbols (mirrors normalize_symbols in Rust)', () => {
  it('splits on commas and whitespace, uppercases and de-duplicates', () => {
    expect(parseWatchSymbols(' aapl, MSFT  brk.b\nbf-b aapl ')).toEqual({ symbols: ['AAPL', 'MSFT', 'BRK.B', 'BF-B'], error: '' })
  })
  it('empty input is not an error and yields nothing', () => {
    expect(parseWatchSymbols('')).toEqual({ symbols: [], error: '' })
    expect(parseWatchSymbols(' , ,  ')).toEqual({ symbols: [], error: '' })
  })
  it('rejects anything outside ^[A-Z][A-Z0-9.-]{0,9}$ (crypto and index ids included)', () => {
    for (const bad of ['1ABC', 'AAPL!', 'TOOLONGSYMB', '-X', '.X', 'BTC/USD', 'aaaaaaaa-0000-4000-8000-0000000000a1', 'ÀB', '$AAPL']) {
      const r = parseWatchSymbols(`AAA ${bad}`)
      expect(r.symbols, bad).toEqual([])
      expect(r.error, bad).toMatch(/not a stock symbol/)
    }
    expect(parseWatchSymbols('ABCDEFGHIJ').error).toBe('')
  })
  it('caps a call at 50 symbols', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `S${i}`).join(' ')
    expect(parseWatchSymbols(fifty).symbols).toHaveLength(50)
    expect(parseWatchSymbols(`${fifty} S50`).error).toMatch(/At most 50/)
  })
})

describe('list name, emoji, description', () => {
  it('name: 1 to 50 printable characters after trim', () => {
    expect(validateListName('  Tech ')).toBe('')
    expect(validateListName('n'.repeat(50))).toBe('')
    for (const bad of ['', '   ', 'n'.repeat(51), 'a\nb', 'a\tb', 'a\u0000b']) expect(validateListName(bad), JSON.stringify(bad)).not.toBe('')
  })
  it('emoji: empty ok, at most 8 bytes, no control characters', () => {
    expect(validateEmoji('')).toBe('')
    expect(validateEmoji('\u{1F680}')).toBe('')
    expect(validateEmoji('\u{1F680}\u{1F680}')).toBe('')
    expect(validateEmoji('\u{1F680}\u{1F680}x')).not.toBe('')
    expect(validateEmoji('a\nb')).not.toBe('')
  })
  it('description: at most 200 characters', () => {
    expect(validateDescription('d'.repeat(200))).toBe('')
    expect(validateDescription('d'.repeat(201))).not.toBe('')
    expect(validateDescription('a\u0007b')).not.toBe('')
  })
})

describe('watchlistWritable', () => {
  it('only custom, non-options lists take symbol writes', () => {
    expect(watchlistWritable({ owner_type: 'custom', allowed_object_types: ['instrument'] })).toBe(true)
    expect(watchlistWritable({ owner_type: 'custom', allowed_object_types: [] })).toBe(true)
    expect(watchlistWritable({ owner_type: 'robinhood', allowed_object_types: ['instrument'] })).toBe(false)
    expect(watchlistWritable({ owner_type: null, allowed_object_types: ['instrument'] })).toBe(false)
    expect(watchlistWritable({ owner_type: 'custom', allowed_object_types: ['option_strategy'] })).toBe(false)
    expect(watchlistWritable(null)).toBe(false)
    expect(watchlistWritable(undefined)).toBe(false)
  })
})
