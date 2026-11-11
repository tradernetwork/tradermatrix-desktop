/**
 * Soft output linter (M16 A2). Flags prescriptive wording in a model reply so the pane can show a muted notice. It never blocks or
 * rewrites anything. Pure; every pattern is linear (no nested quantifiers).
 */
const PATTERNS: RegExp[] = [
  /\byou\s+(?:should|must|ought\s+to|need\s+to|might\s+want\s+to|may\s+want\s+to|had\s+better)\b/gi,
  /\b(?:I|we)(?:'d|’d|\s+would|\s+will)?\s+(?:recommend|suggest|advise)\b/gi,
  /\bmy\s+(?:advice|recommendation)\b/gi,
  /\b(?:consider|try|think\s+about)\s+(?:buying|selling|opening|closing|holding|hedging|adding|trimming|rolling|entering|exiting|shorting)\b/gi,
  /\b(?:should|would|could|must|let's|let’s|lets|please|I'd|I’d|you'd|you’d)\s+(?:buy|sell)(?![-\w])/gi,
  /(?:^|[.!?:;]\s+|\n[ \t]*[-*•]?[ \t]*)(?:buy|sell)(?![-\w])/gi,
  /\bgo\s+(?:long|short)\b/gi,
  /\btake\s+profits?\b/gi,
]

export const LINT_NOTICE = 'Some wording here may read like advice. Arya only describes what the data shows; any decision is yours.'

export function lintReply(text: string): { prescriptive: boolean; matches: string[] } {
  const matches: string[] = []
  for (const re of PATTERNS) {
    re.lastIndex = 0
    for (const m of text.matchAll(re)) matches.push(m[0].trim())
  }
  return { prescriptive: matches.length > 0, matches }
}
