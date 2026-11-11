/** M15: TraderMatrix Desktop rename, brand assets, Arya, backgrounds. Pure helpers plus file-level checks (vitest runs in node, no DOM). */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { fake } from '../src/lib/api'
import {
  APP_VERSION,
  ARYA_INTRO,
  aryaLook,
  aryaState,
  NOT_AFFILIATED,
  parseBackgrounds,
  PRODUCT_NAME,
  serializeBackgrounds,
  UI_BACKGROUNDS_KEY,
} from '../src/lib/brand'
import { useUiStore } from '../src/stores/ui'

const desktop = join(__dirname, '..')
const repo = join(desktop, '..', '..')
const src = join(desktop, 'src')
const brandDir = join(src, 'assets', 'brand')
const read = (...p: string[]) => readFileSync(join(...p), 'utf8')

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

describe('brand constants', () => {
  it('product name, version and required lines', () => {
    expect(PRODUCT_NAME).toBe('TraderMatrix Desktop')
    expect(NOT_AFFILIATED).toBe('Works with the Robinhood MCP. Not affiliated with or endorsed by Robinhood.')
    expect(ARYA_INTRO).toBe("I'm Arya. I explain what's on your screen. I don't place or suggest orders.")
    expect(ARYA_INTRO).not.toMatch(/advice/i)
  })
  it('APP_VERSION matches tauri.conf.json and Cargo.toml', () => {
    const conf = JSON.parse(read(desktop, 'src-tauri', 'tauri.conf.json'))
    expect(APP_VERSION).toBe(conf.version)
    expect(read(desktop, 'src-tauri', 'Cargo.toml')).toMatch(new RegExp(`^version = "${APP_VERSION}"`, 'm'))
  })
})

describe('ui.backgrounds setting', () => {
  beforeEach(() => {
    fake.settings.clear()
    useUiStore.setState({ backgrounds: true, loaded: false })
  })
  it('parses: default on, only an explicit off turns it off', () => {
    expect(UI_BACKGROUNDS_KEY).toBe('ui.backgrounds')
    expect(parseBackgrounds(null)).toBe(true)
    expect(parseBackgrounds(undefined)).toBe(true)
    expect(parseBackgrounds('')).toBe(true)
    expect(parseBackgrounds('on')).toBe(true)
    expect(parseBackgrounds('garbage')).toBe(true)
    expect(parseBackgrounds('off')).toBe(false)
    expect(parseBackgrounds('false')).toBe(false)
    expect(parseBackgrounds('0')).toBe(false)
  })
  it('serialises and round-trips', () => {
    expect(serializeBackgrounds(true)).toBe('on')
    expect(serializeBackgrounds(false)).toBe('off')
    for (const v of [true, false]) expect(parseBackgrounds(serializeBackgrounds(v))).toBe(v)
  })
  it('the store loads the saved value and writes changes under the setting key', async () => {
    fake.settings.set('ui.backgrounds', 'off')
    await useUiStore.getState().load()
    expect(useUiStore.getState().backgrounds).toBe(false)
    await useUiStore.getState().setBackgrounds(true)
    expect(useUiStore.getState().backgrounds).toBe(true)
    expect(fake.settings.get('ui.backgrounds')).toBe('on')
  })
  it('a failed read keeps the default (on)', async () => {
    const orig = fake.settingGet
    fake.settingGet = () => {
      throw new Error('boom')
    }
    try {
      await useUiStore.getState().load()
      expect(useUiStore.getState().backgrounds).toBe(true)
    } finally {
      fake.settingGet = orig
    }
  })
})

describe('Arya avatar state', () => {
  it('maps from busy', () => {
    expect(aryaState(false)).toBe('idle')
    expect(aryaState(true)).toBe('thinking')
  })
  it('picks a look per state; thinking is the focused one', () => {
    expect(aryaLook('idle')).toBe('calm')
    expect(aryaLook('thinking')).toBe('focused')
  })
  it('the thinking glow is disabled under prefers-reduced-motion', () => {
    const css = read(src, 'styles', 'app.css')
    expect(css).toMatch(/\[data-state=['"]?thinking['"]?\][^{]*\{[^}]*animation:/)
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\n\}/g) ?? []
    expect(m.some((b) => /\.arya-avatar/.test(b) && /animation:\s*none/.test(b))).toBe(true)
  })
  it('Arya is CSS only: no script timers or animation libraries in the avatar component', () => {
    const t = read(src, 'workspace', 'ArayaAvatar.tsx')
    expect(t).not.toMatch(/setInterval|setTimeout|requestAnimationFrame|<video|\.gif|\.mp4/)
  })
})

describe('asset hygiene', () => {
  const files = readdirSync(brandDir)
  const nonDocs = files.filter((f) => !/\.(txt|md)$/.test(f))
  const code = walk(src).filter((f) => /\.(tsx?|css|html)$/.test(f)).map((f) => read(f)).join('\n') + readdirSync(desktop).filter((f) => f.endsWith('.html')).map((f) => read(desktop, f)).join('\n')

  it('LICENSE-BRAND.txt and SOURCES.md exist, the brand license is not MIT', () => {
    expect(files).toContain('LICENSE-BRAND.txt')
    expect(files).toContain('SOURCES.md')
    const lic = read(brandDir, 'LICENSE-BRAND.txt')
    expect(lic).toMatch(/all rights reserved/i)
    expect(lic).toMatch(/not licensed under the MIT/i)
  })
  it('every asset is referenced by code and listed in SOURCES.md', () => {
    const sources = read(brandDir, 'SOURCES.md')
    for (const f of nonDocs) {
      expect(code, `${f} not referenced`).toContain(f)
      expect(sources, `${f} not in SOURCES.md`).toContain(f)
    }
  })
  it('total weight <= 1.5 MB and each background <= 250 KB', () => {
    const total = files.reduce((n, f) => n + statSync(join(brandDir, f)).size, 0)
    expect(total).toBeLessThanOrEqual(1.5 * 1024 * 1024)
    const bgs = files.filter((f) => f.startsWith('bg-'))
    expect(bgs.length).toBeGreaterThanOrEqual(2)
    for (const f of bgs) expect(statSync(join(brandDir, f)).size, f).toBeLessThanOrEqual(250 * 1024)
  })
  it('no video, no gif, and nothing from the hand-made section of the brand album', () => {
    for (const f of files) expect(f).not.toMatch(/\.(mp4|webm|mov|gif)$/i)
    expect(read(brandDir, 'SOURCES.md')).toMatch(/hand-made.*not copied/is)
  })
  it('no remote URL for any brand image in CSS/TSX/HTML', () => {
    for (const f of walk(src).filter((x) => /\.(tsx?|css)$/.test(x))) {
      const t = read(f)
      expect(t, f).not.toMatch(/https?:\/\/[^\s'"`)]*\.(png|webp|jpe?g|svg|gif)/i)
    }
  })
  it('CSP is unchanged: self + ipc only', () => {
    const csp = JSON.parse(read(desktop, 'src-tauri', 'tauri.conf.json')).app.security.csp as string
    expect(csp).toBe("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ipc: http://ipc.localhost")
  })
})

describe('backgrounds never sit behind data', () => {
  it('only VaultGate (unlock) and EmptyState import a bg-* asset', () => {
    const hits = walk(src)
      .filter((f) => /\.(tsx?|css)$/.test(f))
      .filter((f) => /assets\/brand\/bg-|bg-gold-arcs|bg-wide-navy/.test(read(f)))
      .map((f) => f.slice(src.length + 1))
      .sort()
    expect(hits).toEqual(['workspace/EmptyState.tsx', 'workspace/VaultGate.tsx'])
  })
  it('the data panes only get art through EmptyState', () => {
    for (const f of ['JournalPane', 'PositionsPane', 'OrdersPane', 'ExplainPane']) {
      expect(read(src, 'workspace', `${f}.tsx`), f).toContain("from './EmptyState'")
    }
    for (const f of ['DeskHeader', 'OrderTicketPane', 'WatchlistPane', 'TmInsightPane']) {
      expect(read(src, 'workspace', `${f}.tsx`), f).not.toMatch(/EmptyState|assets\/brand/)
    }
    expect(walk(join(src, 'chart')).map((f) => read(f)).join('\n')).not.toMatch(/assets\/brand/)
  })
})

describe('rename completeness (user-visible only)', () => {
  const visible = (s: string) => expect(s).not.toMatch(/rebull/i)
  it('tauri productName and window title, index.html and dev page titles', () => {
    const conf = JSON.parse(read(desktop, 'src-tauri', 'tauri.conf.json'))
    expect(conf.productName).toBe('TraderMatrix Desktop')
    expect(conf.app.windows[0].title).toBe('TraderMatrix Desktop')
    for (const f of readdirSync(desktop).filter((x) => x.endsWith('.html'))) {
      const title = read(desktop, f).match(/<title>(.*)<\/title>/)![1]!
      visible(title)
      expect(title, f).toContain('TraderMatrix Desktop')
    }
  })
  it('README title, toolbar, error boundary label', () => {
    expect(read(repo, 'README.md').split('\n')[0]).toBe('# TraderMatrix Desktop')
    expect(read(repo, 'README.md')).toContain(NOT_AFFILIATED)
    visible(read(src, 'App.tsx').match(/label="([^"]*)"/)![1]!)
    expect(read(src, 'workspace', 'Toolbar.tsx')).not.toMatch(/>\s*REBULL\s*</)
  })
  it('unlock footer and About carry the not-affiliated line', () => {
    expect(read(src, 'workspace', 'VaultGate.tsx')).toContain('NOT_AFFILIATED')
    expect(read(src, 'workspace', 'AboutDialog.tsx')).toContain('NOT_AFFILIATED')
  })
  it('the Cargo package is renamed, the crate lib and identifier are not', () => {
    const cargo = read(desktop, 'src-tauri', 'Cargo.toml')
    expect(cargo).toMatch(/^name = "tradermatrix-desktop"/m)
    expect(cargo).toMatch(/^name = "rebull_lib"/m)
    expect(JSON.parse(read(desktop, 'src-tauri', 'tauri.conf.json')).identifier).toBe('app.rebull.desktop')
  })
  it('scripts point at the new binary name', () => {
    expect(read(repo, 'scripts', 'smoke-desktop.sh')).toContain('rebull-bin/tradermatrix-desktop')
    expect(read(repo, 'scripts', 'smoke-desktop.sh')).not.toMatch(/rebull-bin\/rebull\b/)
  })
  it('NOTICE has a brand section excluded from the MIT grant', () => {
    const n = read(repo, 'NOTICE')
    expect(n).toMatch(/BRAND ASSETS/)
    expect(n).toContain('apps/desktop/src/assets/brand/')
    expect(n).toMatch(/NOT covered by the MIT/i)
    expect(read(repo, 'README.md')).toContain('apps/desktop/src/assets/brand/')
  })
  it('app icons exist and were regenerated from the brand mark', () => {
    for (const f of ['icon.png', 'icon.ico', '32x32.png', '128x128.png', '128x128@2x.png', 'icon.icns']) expect(existsSync(join(desktop, 'src-tauri', 'icons', f)), f).toBe(true)
    expect(statSync(join(desktop, 'src-tauri', 'icons', 'icon.png')).size).toBeGreaterThan(5000) // the old placeholder was ~2 KB
  })
})
