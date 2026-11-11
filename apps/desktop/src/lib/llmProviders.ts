/**
 * Provider cards for the Explain chat (M14b). Pure data and helpers, no network. The table mirrors `src-tauri/src/llm/provider.rs`
 * (a test compares ids and URLs); Rust is the source of truth and re-validates everything. Provider facts were checked against each
 * provider's current docs on 2026-11-11; model suggestions and prices below are SUGGESTIONS the user can edit, not verified catalogs.
 */
export type ProviderId = 'openrouter' | 'openai' | 'venice' | 'anthropic' | 'ollama' | 'lmstudio' | 'custom' | 'hermes' | 'claude_cli' | 'hermes_cli'

export interface ProviderInfo {
  id: ProviderId
  label: string
  /** One plain-English line. */
  blurb: string
  /** Shown as plain text (the user opens it themselves; the webview never opens links). */
  keyHelpUrl: string
  /** Fixed base URL (hosted) or the default (local presets); '' for custom and the CLI. */
  baseUrl: string
  /** The provider cannot work without a key. */
  needsKey: boolean
  /** The provider accepts a key at all (hosted presets and custom). Local presets and the CLI never do. */
  takesKey: boolean
  /** The base URL may be edited (local presets: loopback only; custom: https or loopback http). */
  urlEditable: boolean
  http: boolean
  defaultModel: string
  models: string[]
  /** Known only for OpenRouter; everything else says the price depends on the user's plan. */
  priceHint: string
}

const PLAN = 'price depends on your plan'
/** The vendor-terms line of the installed-Claude card (M19: exact wording; mirrors cli_registry.rs). */
export const CLAUDE_CLI_TERMS = "Uses your installed Claude (your own login). Usage counts against your own Claude plan and is subject to Anthropic's terms."

export const PROVIDERS: readonly ProviderInfo[] = [
  { id: 'openrouter', label: 'OpenRouter', blurb: 'One key, many models, pay as you go. Cheap models cost cents.', keyHelpUrl: 'https://openrouter.ai/keys', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true, takesKey: true, urlEditable: false, http: true, defaultModel: 'deepseek/deepseek-v4-flash', models: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4.1-flash'], priceHint: 'from $0.18 per million output tokens (DeepSeek V4 Flash), a question is a fraction of a cent' },
  { id: 'openai', label: 'OpenAI', blurb: "ChatGPT's maker. Needs an API key with billing set up.", keyHelpUrl: 'https://platform.openai.com/api-keys', baseUrl: 'https://api.openai.com/v1', needsKey: true, takesKey: true, urlEditable: false, http: true, defaultModel: 'gpt-4.1-mini', models: ['gpt-4.1-mini', 'gpt-5-mini'], priceHint: PLAN },
  { id: 'venice', label: 'Venice', blurb: 'Privacy-focused hosted models.', keyHelpUrl: 'https://venice.ai/settings/api', baseUrl: 'https://api.venice.ai/api/v1', needsKey: true, takesKey: true, urlEditable: false, http: true, defaultModel: 'llama-3.3-70b', models: ['llama-3.3-70b'], priceHint: PLAN },
  { id: 'anthropic', label: 'Anthropic', blurb: 'Use your own Anthropic API key.', keyHelpUrl: 'https://console.anthropic.com', baseUrl: 'https://api.anthropic.com', needsKey: true, takesKey: true, urlEditable: false, http: true, defaultModel: 'claude-haiku-5-5', models: ['claude-haiku-5-5', 'claude-sonnet-5-5'], priceHint: PLAN },
  { id: 'ollama', label: 'Ollama (this computer)', blurb: 'Runs a model on your own machine. Free, private, no key.', keyHelpUrl: '', baseUrl: 'http://127.0.0.1:11434/v1', needsKey: false, takesKey: false, urlEditable: true, http: true, defaultModel: 'llama3.2', models: ['llama3.2', 'qwen3'], priceHint: 'free, uses your computer' },
  { id: 'lmstudio', label: 'LM Studio (this computer)', blurb: 'Runs a model on your own machine. Free, private, no key.', keyHelpUrl: '', baseUrl: 'http://127.0.0.1:1234/v1', needsKey: false, takesKey: false, urlEditable: true, http: true, defaultModel: '', models: [], priceHint: 'free, uses your computer' },
  { id: 'custom', label: 'Custom endpoint', blurb: 'Any OpenAI-compatible address you already use.', keyHelpUrl: '', baseUrl: '', needsKey: false, takesKey: true, urlEditable: true, http: true, defaultModel: '', models: [], priceHint: PLAN },
  { id: 'hermes', label: 'Hermes (self-hosted)', blurb: 'Your own Hermes agent, reached over HTTPS. You set it up and secure it.', keyHelpUrl: '', baseUrl: '', needsKey: false, takesKey: true, urlEditable: true, http: true, defaultModel: '', models: [], priceHint: 'runs on your own server, no price shown here' },
  { id: 'claude_cli', label: 'Claude (installed on this computer)', blurb: 'Uses the Claude app you already signed in to. No key to paste.', keyHelpUrl: '', baseUrl: '', needsKey: false, takesKey: false, urlEditable: false, http: false, defaultModel: '', models: [], priceHint: PLAN },
  { id: 'hermes_cli', label: 'Hermes agent (installed on this computer)', blurb: 'Experimental. Runs the Hermes you installed here, text only. Off unless you turn it on in Advanced.', keyHelpUrl: '', baseUrl: '', needsKey: false, takesKey: false, urlEditable: false, http: false, defaultModel: '', models: [], priceHint: PLAN },
]

export const providerInfo = (id: string | null | undefined): ProviderInfo | null => PROVIDERS.find((p) => p.id === id) ?? null

export interface Detect {
  claude_cli: boolean
  ollama: boolean
  lmstudio: boolean
}
export type CliSupport = 'usable' | 'experimental' | 'unsupported'
/** One agent CLI found on this computer (`llm_cli_detect`): a binary NAME, never a path. */
export interface CliFound {
  id: string
  label: string
  binary: string
  support: CliSupport
  reason: string
  terms: string
  provider: string | null
}
export interface CliDetect {
  /** A public (distributed) build: every CLI card is hidden unless the user turns on Advanced > "Show installed-CLI options" (`llm.advancedCli`). */
  public_build: boolean
  found: CliFound[]
}

const NO_SWITCH = 'It has no verified way to turn its tools off, so it could act on your computer.'
const NOTE = 'This app does not use it. It is listed only so you can see it was found.'
interface CliFake extends Omit<CliFound, 'binary'> {
  binaries: string[]
}
const fe = (id: string, label: string, binaries: string[], reason: string): CliFake => ({ id, label, binaries, support: 'unsupported', reason, terms: NOTE, provider: null })
/** Static roster, mirrors `src-tauri/src/llm/cli_registry.rs` (a test compares ids, binaries, reasons and terms). Used only by the FAKE backend. */
export const CLI_FAKE_REGISTRY: readonly CliFake[] = [
  { id: 'claude', label: 'Claude', binaries: ['claude'], support: 'usable', reason: '', terms: CLAUDE_CLI_TERMS, provider: 'claude_cli' },
  { id: 'codex', label: 'Codex', binaries: ['codex'], support: 'unsupported', reason: 'Even in its read-only mode it can still run commands, so it cannot be made text-only.', terms: 'OpenAI says automating a ChatGPT login is not meant for public or open-source apps.', provider: null },
  { id: 'gemini', label: 'Gemini', binaries: ['gemini'], support: 'unsupported', reason: 'It has no switch that turns all its tools off, and its terms do not allow other apps to use it.', terms: "Google's terms do not allow third-party tools to use its backend.", provider: null },
  { id: 'agy', label: 'Antigravity', binaries: ['agy'], support: 'unsupported', reason: 'It only offers a read-only mode, not a text-only one, and its terms do not allow other apps to use it.', terms: "Antigravity's terms do not allow third-party software to drive it.", provider: null },
  { id: 'opencode', label: 'OpenCode', binaries: ['opencode'], support: 'unsupported', reason: 'Your question would have to be typed on its command line, where other programs on this computer can read it, and it cannot turn its tools off.', terms: NOTE, provider: null },
  { id: 'hermes', label: 'Hermes agent', binaries: ['hermes'], support: 'experimental', reason: 'Experimental and untested here: it stays off until you turn it on in Advanced.', terms: 'Runs your own Hermes install under its own settings. You are responsible for what that install is allowed to do.', provider: 'hermes_cli' },
  { id: 'openclaw', label: 'OpenClaw', binaries: ['openclaw', 'clawdbot', 'moltbot'], support: 'unsupported', reason: 'It runs as a background gateway and takes your question on its command line, with no way to turn its tools off.', terms: NOTE, provider: null },
  fe('qwen', 'Qwen Code', ['qwen'], NO_SWITCH),
  fe('goose', 'Goose', ['goose'], 'It is built to run tools on your computer and has no verified way to turn them off.'),
  fe('cursor-agent', 'Cursor Agent', ['cursor-agent'], NO_SWITCH),
  fe('kimi', 'Kimi', ['kimi'], NO_SWITCH),
  fe('auggie', 'Auggie', ['auggie'], NO_SWITCH),
  fe('copilot', 'GitHub Copilot CLI', ['copilot'], NO_SWITCH),
  fe('droid', 'Droid', ['droid'], NO_SWITCH),
  fe('kiro', 'Kiro', ['kiro-cli', 'kiro'], NO_SWITCH),
  fe('codebuddy', 'CodeBuddy', ['codebuddy'], NO_SWITCH),
  fe('aider', 'Aider', ['aider'], 'It edits files in your project and has no text-only mode.'),
  fe('amp', 'Amp', ['amp'], NO_SWITCH),
  fe('crush', 'Crush', ['crush'], NO_SWITCH),
  fe('cline', 'Cline', ['cline'], NO_SWITCH),
  fe('qoder', 'Qoder', ['qodercli', 'qoder'], NO_SWITCH),
  fe('nanobot', 'Nanobot', ['nanobot'], NO_SWITCH),
  fe('zeroclaw', 'ZeroClaw', ['zeroclaw'], NO_SWITCH),
  fe('picoclaw', 'PicoClaw', ['picoclaw'], NO_SWITCH),
  fe('nullclaw', 'NullClaw', ['nullclaw'], NO_SWITCH),
]

/** The fake registry scan: the given roster ids "found", in registry order. */
export function fakeCliDetect(ids: readonly string[], publicBuild = false): CliDetect {
  const found = CLI_FAKE_REGISTRY.filter((e) => ids.includes(e.id)).map(({ binaries, ...e }) => ({ ...e, binary: binaries[0]! }))
  return { public_build: publicBuild, found }
}

const CLI_PROVIDERS: readonly string[] = ['claude_cli', 'hermes_cli']
const cliFoundFor = (id: ProviderId, cli: CliDetect | null): boolean => !!cli?.found.some((f) => f.provider === id)
const foundOf = (id: ProviderId, d: Detect | null, cli: CliDetect | null): boolean =>
  (!!d && ((id === 'claude_cli' && d.claude_cli) || (id === 'ollama' && d.ollama) || (id === 'lmstudio' && d.lmstudio))) || (id === 'hermes_cli' && cliFoundFor(id, cli))

export interface Card {
  info: ProviderInfo
  /** "Found on this computer" */
  found: boolean
}
/** M19: in a public build the CLI options stay hidden until the user switches on Advanced > "Show installed-CLI options". The personal build ignores the switch. */
export const cliHidden = (cli: CliDetect | null, advanced: boolean): boolean => !!cli?.public_build && !advanced
/**
 * Detected providers first (stable, table order inside each group), then the rest in table order. The CLI cards follow the M21/M19 rules: in a public
 * build with Advanced off neither CLI card exists; `hermes_cli` exists only when it was found AND the experimental switch is on.
 */
export function orderProviders(detect: Detect | null, cli: CliDetect | null = null, experimental = false, advanced = false): Card[] {
  const hide = (id: string) => (CLI_PROVIDERS.includes(id) && cliHidden(cli, advanced)) || (id === 'hermes_cli' && !(experimental && cliFoundFor('hermes_cli', cli)))
  const cards = PROVIDERS.filter((p) => !hide(p.id)).map((info) => ({ info, found: foundOf(info.id, detect, cli) }))
  return [...cards.filter((c) => c.found), ...cards.filter((c) => !c.found)]
}

/** A found CLI that has no usable provider card: shown as a disabled note with no key box. */
export interface CliCard {
  id: string
  label: string
  binary: string
  state: 'unsupported' | 'experimental_off'
  reason: string
  terms: string
}
export function cliCards(cli: CliDetect | null, experimental: boolean, advanced = false): CliCard[] {
  if (!cli || cliHidden(cli, advanced)) return []
  const out: CliCard[] = []
  for (const f of cli.found) {
    if (f.support === 'usable' || (f.support === 'experimental' && experimental)) continue
    out.push({ id: f.id, label: f.label, binary: f.binary, state: f.support === 'experimental' ? 'experimental_off' : 'unsupported', reason: f.reason, terms: f.terms })
  }
  return out
}
export const foundLine = (c: CliCard): string => (c.state === 'experimental_off' ? 'Found, experimental (off)' : `Found, not supported: ${c.reason}`)
/** The vendor-terms line for a CLI provider card ('' for any other provider). */
export const cliTerms = (providerId: string, cli: CliDetect | null): string => cli?.found.find((f) => f.provider === providerId)?.terms ?? (providerId === 'claude_cli' ? CLAUDE_CLI_TERMS : '')
/** A key-help address shown as plain text: no scheme (the user types it into their own browser). */
export const keyHelpText = (url: string): string => url.replace(/^https?:\/\//, '')

/** Mirrors url_guard.rs: https anywhere, http only to a loopback host (parsed, not prefix-matched), no userinfo/query/fragment. Returns null when fine. */
export function validateBaseUrlText(raw: string): string | null {
  const s = raw.trim()
  if (!s) return 'Enter the address (for example http://127.0.0.1:11434/v1).'
  if (s.length > 200) return 'That address is too long.'
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return 'That does not look like an address. Start with https:// (or http://127.0.0.1 for a model on this computer).'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The address must start with https://.'
  if (u.username || u.password) return 'The address must not contain a user name or password.'
  if (u.search || u.hash) return 'The address must not contain ? or # parts.'
  if (u.protocol === 'http:') {
    const h = u.hostname
    const loop = h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h)
    if (!loop) return 'Plain http:// is only allowed for a model on this computer (127.0.0.1 or localhost). Use https:// for anything else.'
  }
  return null
}

/** Setup card text for Hermes (M16 B5). The app cannot see or control the Hermes side, so the card says so plainly. */
export const HERMES_SETUP_STEPS: readonly string[] = [
  'On the Hermes host, create a dedicated profile just for this app (for example tm-explain).',
  'Turn every tool off in that profile: terminal, browser, file and MCP toolsets all disabled. This app only needs text answers, so a tool-less profile is the safe shape.',
  'Give the profile its own API key (its own API_SERVER_KEY), not one that opens anything else.',
  'Serve it over HTTPS, for example with tailscale serve, and paste that https:// address below.',
]
export const HERMES_WARNING =
  'TraderMatrix Desktop cannot verify or enforce what the Hermes side does, including whether your profile really is tool-less. If that profile has tools turned on, the agent could act on your computer or accounts. Everything you ask goes to your Hermes host together with the numbers from your chart.'
export const HERMES_POSITIONS_WARNING = 'Your open positions (symbol, quantity, average price) would go to your Hermes host, which this app cannot see into or control. Tick this only if you trust that host with them.'
export const HERMES_LOOPBACK_SUGGESTION = 'http://127.0.0.1:8642'
export const positionsWarning = (provider: string | null | undefined): string | null => (provider === 'hermes' ? HERMES_POSITIONS_WARNING : null)

const PRIVATE_V4 = (h: string): boolean => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!m) return false
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}
/**
 * Mirrors `validate_hermes_url` in url_guard.rs: https to any host; plain http to loopback, or (only with `lan`, the "I accept plain LAN http"
 * box) to an IP-address host in 10/8, 172.16/12, 192.168/16 or 100.64/10. Hostnames never qualify for non-loopback http. Returns null when fine.
 */
export function validateHermesUrlText(raw: string, lan: boolean): string | null {
  const s = raw.trim()
  if (!s) return 'Enter your Hermes address (https://...).'
  if (s.length > 200) return 'That address is too long.'
  let u: URL
  try {
    u = new URL(s)
  } catch {
    return 'That does not look like an address. Start with https://.'
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'The address must start with https://.'
  if (u.username || u.password) return 'The address must not contain a user name or password.'
  if (u.search || u.hash) return 'The address must not contain ? or # parts.'
  if (u.protocol === 'http:') {
    const h = u.hostname
    const loop = h === 'localhost' || h === '[::1]' || /^127(\.\d{1,3}){3}$/.test(h)
    if (loop) return null
    if (PRIVATE_V4(h)) return lan ? null : 'Plain http:// to a LAN address is off. Use https://, or tick "I accept plain LAN http" for a private address on your own network.'
    return 'Plain http:// is only allowed for this computer or (with the LAN box ticked) a private IP address such as 192.168.x.x or 100.x.x.x. Use https:// for anything else.'
  }
  return null
}

const norm = (u: string) => u.trim().replace(/\/+$/, '')
/** Hermes addresses are stored with a trailing /v1 (Rust adds it); compare without it. */
const normFor = (p: ProviderInfo, u: string) => (p.id === 'hermes' ? norm(u).replace(/\/v1$/, '') : norm(u))

export interface SetupStatus {
  provider: string | null
  base_url: string | null
  model: string | null
  key_present: boolean
  lan_http?: boolean
}
export interface SetupForm {
  key: string
  baseUrl: string
  model: string
  /** Hermes: "I accept plain LAN http". */
  lanHttp?: boolean
}

/** The address a save would use: the typed one for editable providers, otherwise the fixed one. */
export function effectiveUrl(p: ProviderInfo, form: Pick<SetupForm, 'baseUrl'>, status: SetupStatus | null): string {
  if (!p.http) return ''
  if (!p.urlEditable) return p.baseUrl
  const typed = form.baseUrl.trim()
  if (typed) return normFor(p, typed)
  if (status?.provider === p.id && status.base_url) return normFor(p, status.base_url)
  return p.baseUrl
}

/** Mirrors the Rust seal: a saved key may only follow an address it was supplied for, so changing the address means typing the key again. */
export function needsKeyAgain(p: ProviderInfo, form: Pick<SetupForm, 'baseUrl'>, status: SetupStatus | null): boolean {
  if (!p.takesKey || !status?.key_present) return false
  const prev = status.provider ? providerInfo(status.provider) : null
  const prevUrl = prev?.http ? (prev.urlEditable ? normFor(prev, status.base_url ?? prev.baseUrl) : prev.baseUrl) : ''
  return effectiveUrl(p, form, status) !== prevUrl
}

export const keyShapeError = (p: ProviderInfo, raw: string): string | null => {
  const k = raw.trim()
  if (!k) return `Paste your ${p.label} key first.`
  if (/\s/.test(k)) return 'The key must not contain spaces.'
  if (k.length > 256) return 'That key is too long.'
  if (p.id === 'openrouter' && (!k.startsWith('sk-or-') || k.length <= 'sk-or-'.length)) return 'OpenRouter keys start with sk-or-.'
  if (p.id === 'anthropic' && (!k.startsWith('sk-ant-') || k.length <= 'sk-ant-'.length)) return 'Anthropic keys start with sk-ant-.'
  return null
}

const LOOPBACK_HTTP = /^http:\/\/(localhost|127(\.\d{1,3}){3}|\[::1\])([:/]|$)/i
const MODEL_OK = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,99}$/

/** What is wrong with the form, in plain words, or null. Nothing here is sent anywhere. */
export function validateSetup(p: ProviderInfo, form: SetupForm, status: SetupStatus | null): string | null {
  const same = status?.provider === p.id
  if (p.http) {
    if (p.urlEditable) {
      const candidate = form.baseUrl.trim() || (same ? (status?.base_url ?? '') : p.baseUrl)
      if (p.id === 'hermes') {
        // a newly typed address must be accepted again; an unchanged one keeps the saved acceptance (same rule as config.rs)
        const lan = form.lanHttp ?? (same && !form.baseUrl.trim() ? !!status?.lan_http : false)
        const badH = validateHermesUrlText(candidate, lan)
        if (badH) return badH
      } else {
        const bad = validateBaseUrlText(candidate)
        if (bad) return bad
      }
      if (p.id !== 'custom' && p.id !== 'hermes' && !LOOPBACK_HTTP.test(candidate)) return 'This provider runs on your own computer, so the address must be 127.0.0.1 or localhost.'
    }
    const model = form.model.trim()
    if (model && !MODEL_OK.test(model)) return 'Model names use letters, digits and . _ / : @ + - only.'
    if (!model && !p.defaultModel && !(same && status?.model)) return `Type the model name (${p.id === 'lmstudio' ? 'the one loaded in LM Studio' : 'as your provider lists it'}).`
  }
  if (p.takesKey) {
    const typed = form.key.trim()
    if (typed) return keyShapeError(p, typed)
    if (needsKeyAgain(p, form, status)) return 'A saved key only follows the address it was entered for. Paste the key again for this one (or Remove the saved key first if this address needs none).'
    if (p.needsKey && !(same && status?.key_present)) return keyShapeError(p, '')
  }
  return null
}
