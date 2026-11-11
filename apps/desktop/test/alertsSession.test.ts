import { describe, expect, it } from 'vitest'
import { sessionAt } from '../src/alerts/session'

describe('sessionAt (US equities, Eastern time)', () => {
  it('regular, extended and closed', () => {
    expect(sessionAt(Date.UTC(2026, 10, 12, 15, 30))).toEqual({ open: true, extendedOnly: false }) // Thu 10:30 ET
    expect(sessionAt(Date.UTC(2026, 10, 12, 14, 29))).toEqual({ open: true, extendedOnly: true }) // 09:29 ET
    expect(sessionAt(Date.UTC(2026, 10, 12, 14, 30))).toEqual({ open: true, extendedOnly: false }) // 09:30 ET
    expect(sessionAt(Date.UTC(2026, 10, 12, 21, 0))).toEqual({ open: true, extendedOnly: true }) // 16:00 ET
    expect(sessionAt(Date.UTC(2026, 10, 13, 1, 0))).toEqual({ open: false, extendedOnly: false }) // 20:00 ET
    expect(sessionAt(Date.UTC(2026, 10, 12, 8, 0))).toEqual({ open: false, extendedOnly: false }) // 03:00 ET
    expect(sessionAt(Date.UTC(2026, 10, 14, 15, 30))).toEqual({ open: false, extendedOnly: false }) // Saturday
  })
})
