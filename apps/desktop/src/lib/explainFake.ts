/** Canned replies for the FAKE backend (dev page and tests). Built from the digest so the visual check shows the digest working. NO model is called. */
const field = (line: string | undefined, k: string): string => {
  const m = line?.match(new RegExp(`(?:^|\\s)${k}=(\\S+)`))
  return m?.[1] ?? 'NA'
}

/** Dev page `?reply=` values: each one exercises a stage of the reply pipeline (grounding, lint, safe markdown, glossary). */
export const explainVariants = ['grounded', 'ungrounded', 'prescriptive', 'hostile', 'glossary'] as const
export type ExplainVariant = (typeof explainVariants)[number]

function variantReply(digest: string, v: ExplainVariant): string {
  const lines = digest.split('\n')
  const get = (p: string) => lines.find((l) => l.startsWith(p))
  const chart = get('CHART:')
  const range = get('RANGE:')
  const lev = get('LEVELS:')
  const iv = get('IV:')
  const last = field(chart, 'last')
  const hi = field(range, 'hi')
  const lo = field(range, 'lo')
  const flip = field(lev, 'flip')
  const rank = field(iv, 'rank')
  const tag = '[FAKE reply, no model was called]'
  const grounded = `${tag} In plain terms, price is sitting inside its recent range. It last traded at ${last}, with a high of ${hi} and a low of ${lo} over the last 30 bars. The gamma flip is ${flip}, a positioning map and not a target. IV rank is ${rank}.\n\nUsed: CHART, RANGE, LEVELS, IV`
  switch (v) {
    case 'grounded':
      return grounded
    case 'ungrounded':
      return `${tag} Price last traded at ${last}. A data vendor quotes $412.50 for next quarter and a 14.2% jump, but neither number came from your screen. The gamma flip is ${flip}.\n\nUsed: CHART, LEVELS`
    case 'prescriptive':
      return `${tag} You should buy the dip near ${lo} and I recommend selling the 95 put if it gets close. The gamma flip is ${flip}.\n\nUsed: RANGE, LEVELS`
    case 'hostile':
      return [
        `${tag}`,
        '',
        '## Heads up',
        'Markdown shows as **text only**. Here is `inline code`, a link [x](javascript:alert(1)) and an image ![i](http://example.com/pic).',
        '',
        '<script>alert(1)</script> <img src=x onerror=alert(1)>',
        '',
        '- first item',
        '  - nested item',
        '',
        '| Level | Value |',
        '|---|---|',
        `| flip | ${flip} |`,
        `| last | ${last} |`,
      ].join('\n')
    case 'glossary':
      return `${tag} IV rank says how rich option prices are against their own history. The expected move is a range, not a forecast. The gamma flip and the Apex levels are positioning maps. Theta is time decay, delta is the share-like exposure, and DTE counts the days left. A short put collects premium and takes on the obligation if it finishes in the money.\n\nUsed: LEVELS, IV`
  }
}

export function fakeExplainReply(digest: string, question: string, variant?: ExplainVariant | string): string {
  if (variant && (explainVariants as readonly string[]).includes(variant)) return variantReply(digest, variant as ExplainVariant)
  const lines = digest.split('\n')
  const get = (p: string) => lines.find((l) => l.startsWith(p))
  const chart = get('CHART:')
  const lev = get('LEVELS:')
  const strike = get('STRIKE:')
  const q = question.toLowerCase()
  const head = `[FAKE reply, no model was called] I can see ${field(chart, 'symbol')} on ${field(chart, 'tf')}, last ${field(chart, 'last')}.`
  if (q.includes('strike') && strike) {
    return `${head} Strike check: ${field(strike, 'right')} at ${field(strike, 'strike')}, ${field(strike, 'dte')} days out, ${field(strike, 'em_units')} expected moves away, nearest wall ${field(strike, 'wall')}, verdict ${field(strike, 'verdict')}. The verdict describes positioning, it is not a prediction.`
  }
  if (q.includes('apex') || q.includes('level')) {
    return `${head} Apex levels in the digest: ${field(lev, 'apex')}, gamma flip ${field(lev, 'flip')}. They map where option positioning is concentrated, not where price must go.`
  }
  if (q.includes('expected') || q.includes('move')) {
    return `${head} Expected move band: ${field(lev, 'em_lo')} to ${field(lev, 'em_hi')} (${field(lev, 'em_pct')} of spot as a decimal). It is a statistical range, not a forecast.`
  }
  return `${head} ${get('RANGE:') ?? ''} ${get('OVERLAYS:') ?? ''} ${get('IV:') ?? ''}`.replace(/\s+/g, ' ').trim()
}
