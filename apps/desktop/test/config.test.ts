import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..', 'src-tauri')
const conf = JSON.parse(readFileSync(resolve(root, 'tauri.conf.json'), 'utf8'))
const caps = JSON.parse(readFileSync(resolve(root, 'capabilities/default.json'), 'utf8'))

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost"

describe('tauri.conf.json', () => {
  it('has the exact locked-down CSP', () => {
    expect(conf.app.security.csp).toBe(CSP)
  })
  it('has no wildcard, unsafe-eval or remote hosts', () => {
    const csp: string = conf.app.security.csp
    expect(csp).not.toContain('*')
    expect(csp).not.toContain('unsafe-eval')
    const hosts = csp.match(/https?:\/\/[^\s;]+/g) ?? []
    expect(hosts).toEqual(['http://ipc.localhost'])
  })
  it('has the right identifier and product name', () => {
    expect(conf.identifier).toBe('app.rebull.desktop')
    expect(conf.productName).toBe('TraderMatrix Desktop')
  })
  it('has the 1440x900 window with 1000x640 minimum', () => {
    const w = conf.app.windows[0]
    expect([w.width, w.height, w.minWidth, w.minHeight]).toEqual([1440, 900, 1000, 640])
  })
})

describe('capabilities/default.json', () => {
  it('grants core and window-state only', () => {
    const perms: string[] = caps.permissions.map((p: unknown) =>
      typeof p === 'string' ? p : (p as { identifier: string }).identifier,
    )
    expect(perms).toContain('core:default')
    expect(perms).toContain('window-state:default')
    for (const p of perms) expect(p).not.toMatch(/shell|^fs:|http|opener/)
  })
})
