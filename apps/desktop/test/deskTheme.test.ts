import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { chartStyles, CHART_PALETTE } from '../src/chart/chartTheme'

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8')
const tokens = read('../src/styles/tokens.css')
const tokenValue = (name: string): string | null => new RegExp(`${name}:\\s*([^;]+);`).exec(tokens)?.[1]?.trim().toLowerCase() ?? null

describe('M9 TM desk palette', () => {
  it('chart styles default to the desk palette: gold up, steel down, light down wick, grey flat', () => {
    const s = chartStyles((_n, fb) => fb)
    const bar = s.candle!.bar as Record<string, string>
    expect(bar.upColor).toBe('#FFC93C')
    expect(bar.upBorderColor).toBe('#FFC93C')
    expect(bar.upWickColor).toBe('#FFC93C')
    expect(bar.downColor).toBe('#9CB8E6')
    expect(bar.downBorderColor).toBe('#9CB8E6')
    expect(bar.downWickColor).toBe('#E4EEFF')
    expect(bar.noChangeColor).toBe('#8D9BB4')
  })
  it('grid, axis and chart text follow the desk', () => {
    const s = chartStyles((_n, fb) => fb)
    expect(s.grid!.horizontal!.color).toBe('rgba(200,216,238,.07)')
    expect(s.grid!.vertical!.color).toBe('rgba(200,216,238,.07)')
    expect(s.xAxis!.axisLine!.color).toBe('#1A2238')
    expect(s.yAxis!.axisLine!.color).toBe('#1A2238')
    expect(s.yAxis!.tickText!.color).toBe('#6C7A92')
    expect(s.xAxis!.tickText!.color).toBe('#6C7A92')
    expect(CHART_PALETTE.up).toBe('#FFC93C')
  })
  it('the CSS variables override the defaults', () => {
    const s = chartStyles((n, fb) => (n === '--tm-up' ? '#111111' : fb))
    const bar = s.candle!.bar as Record<string, string>
    expect(bar.upColor).toBe('#111111')
    expect(bar.downColor).toBe('#9CB8E6')
  })
  it('chartTheme.ts has no leftover green/red candle hexes', () => {
    const src = read('../src/chart/chartTheme.ts').toLowerCase()
    for (const old of ['#10b981', '#ef4444', '--tm-bull', '--tm-bear']) expect(src).not.toContain(old)
  })
})

describe('M9 tokens.css', () => {
  it.each([
    ['--tm-up', '#ffc93c'],
    ['--tm-down', '#9cb8e6'],
    ['--tm-down-wick', '#e4eeff'],
    ['--tm-flat', '#8d9bb4'],
    ['--tm-hot', '#ff8000'],
    ['--tm-support', '#00e070'],
    ['--tm-flip', '#b45bff'],
    ['--tm-range', '#4f86ff'],
    ['--tm-ground-base', '#070e1f'],
    ['--tm-bull', '#22c55e'],
    ['--tm-bear', '#f43f5e'],
    ['--tm-text-primary', '#f2f5fa'],
    ['--tm-text-secondary', '#8ea3c4'],
    ['--tm-text-muted', '#6c7a92'],
  ])('%s = %s', (name, v) => {
    expect(tokenValue(name)).toBe(v)
  })
  it('keeps the names the code already uses and ONE gold variable', () => {
    for (const n of ['--tm-gold', '--tm-ground-brand', '--tm-ground-raised', '--tm-surface-1', '--tm-surface-2', '--tm-surface-3', '--tm-border-hair', '--tm-border-line', '--tm-warn', '--font-sans', '--font-mono']) {
      expect(tokens).toContain(`${n}:`)
    }
    expect(tokens.match(/--tm-gold:/g)).toHaveLength(1)
  })
  it('fonts are local files: Inter and JetBrains Mono, no external URL', () => {
    const css = read('../src/styles/fonts.css')
    expect(css).toContain("font-family: 'Inter'")
    expect(css).toContain("font-family: 'JetBrains Mono'")
    expect(css).not.toMatch(/https?:/)
    expect(tokens).toMatch(/--font-mono:\s*'JetBrains Mono'/)
    expect(tokens).toMatch(/--font-sans:\s*'Inter'/)
  })
})
