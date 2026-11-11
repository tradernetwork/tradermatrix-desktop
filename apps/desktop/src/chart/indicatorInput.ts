import type { InputDef } from '@rebull/script'

/**
 * Parses what the user has typed into an indicator number field. null while the text is not a finite number
 * yet ("", "-", ".", "1e"): the field keeps showing the text and nothing is committed. Otherwise clamps to
 * the definition's min/max and rounds integers.
 */
export function parseNumberDraft(text: string, d: InputDef): number | null {
  const t = text.trim()
  if (t === '' || !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t)) return null
  let x = Number(t)
  if (!Number.isFinite(x)) return null
  if (d.type === 'integer') x = Math.round(x)
  if (d.min !== undefined) x = Math.max(d.min, x)
  if (d.max !== undefined) x = Math.min(d.max, x)
  return x
}
