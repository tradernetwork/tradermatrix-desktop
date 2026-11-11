import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = join(__dirname, '..', 'src')
const files = (): string[] => {
  const dir = join(SRC, 'alerts')
  const own = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f)).map((f) => join(dir, f))
  const extra = ['stores/alerts.ts', 'stores/alertLevels.ts', 'stores/alertFeeds.ts', 'stores/alertMenu.ts', 'chart/alertLines.ts', 'chart/alertIndicator.ts', 'chart/alertChartHooks.ts', 'workspace/AlertsPane.tsx', 'workspace/AlertToast.tsx', 'workspace/alertsDev.tsx', 'lib/alertsFake.ts'].map((f) => join(SRC, f))
  return [...own, ...extra]
}

describe('alerts are INFORM ONLY (M17)', () => {
  it('scans every alerts file (a missing file is a failing test, not a skipped one)', () => {
    const f = files()
    expect(f.length).toBeGreaterThanOrEqual(20)
    for (const p of f) expect(() => readFileSync(p, 'utf8'), p).not.toThrow()
  })

  it('no alerts file imports orders, the ticket, fill helpers or any rh_ order command', () => {
    const banned = [/from ['"][^'"]*stores\/orders['"]/, /ticketIntent/, /fillTicket/, /cancelAndEdit/, /orderUi/, /orderValidation/, /OrderTicket/, /OrderReview/, /OrdersPane/, /rh_place/, /rh_review/, /rh_cancel/, /rh_decline/, /rhPlaceOrder/, /rhReview/, /rhCancel/, /rhDecline/, /\bplaceOrder\b/]
    for (const p of files()) {
      // comments may say "no orders"; code may not reach them
      const code = readFileSync(p, 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')
      for (const b of banned) expect(code, `${p} matches ${b}`).not.toMatch(b)
    }
  })

  it('the alerts store talks to the alert commands only', () => {
    const code = readFileSync(join(SRC, 'stores', 'alerts.ts'), 'utf8')
    const calls = [...code.matchAll(/api\.(\w+)/g)].map((m) => m[1])
    expect(calls.length).toBeGreaterThan(0)
    // the alert commands, plus the prefs (settings table), stored candles and quotes for the app-closed pass: all read-only or local
    for (const c of calls) expect(c, c).toMatch(/^(alert[A-Z]|settingGet|settingSet|candlesLoad|rhQuotes)/)
  })
})
