/**
 * Explain chat constants and pure helpers (M14). The system prompt itself lives in Rust (src-tauri/src/llm/client.rs): the webview
 * can neither read nor change it. Limits here mirror the Rust ones and are enforced on both sides.
 */
export const MAX_PROMPT_CHARS = 2000
export const MAX_USER_MESSAGES = 40
export const HISTORY_TURNS = 8

/** OpenRouter model suggestions (price = live OpenRouter output price per million tokens on 2026-11-11, cost ceiling $1.50/M out). */
export const EXPLAIN_MODELS: { id: string; label: string; price: string }[] = [
  { id: 'deepseek/deepseek-v4-flash', label: 'DeepSeek V4 Flash', price: '$0.18/M out' },
  { id: 'deepseek/deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', price: '$0.57/M out' },
]

/** Same rule as the Rust side: ^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,99}$ (local servers use mixed case and colons). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,99}$/
export const isValidModel = (m: unknown): m is string => typeof m === 'string' && MODEL_RE.test(m)

export const QUICK_PROMPTS = [
  'Explain this chart',
  'What do the Apex levels mean here?',
  'What is the expected move saying?',
  'Explain this strike check',
] as const

/** The nine fixed backend codes (llm/client.rs `LlmError::code`, `budget` added in M16 B2), plus three local ones (too_long, limit, key_like). */
export type ExplainErrorCode = 'no_key' | 'bad_key' | 'unreachable' | 'rate_limited' | 'timeout' | 'bad_reply' | 'bad_request' | 'not_installed' | 'budget' | 'too_long' | 'limit' | 'key_like'
export const ERROR_CODES: readonly ExplainErrorCode[] = ['no_key', 'bad_key', 'unreachable', 'rate_limited', 'timeout', 'bad_reply', 'bad_request', 'not_installed', 'budget', 'too_long', 'limit', 'key_like']

/** Plain-words messages only. Nothing from the provider is ever shown. */
export const ERROR_TEXT: Record<ExplainErrorCode, string> = {
  no_key: 'No provider is set up yet (or the vault is locked). Pick a provider and add its key.',
  bad_key: 'That key was rejected (or the account has no credit). Check the key and try again.',
  unreachable: "Can't reach that address. Check the internet connection, or that the local app is running.",
  rate_limited: 'The provider is rate limiting. Wait a moment and try again.',
  timeout: 'The provider took too long to answer. Try again.',
  bad_reply: 'The provider sent back something unusable. Try again.',
  bad_request: 'This provider rejected a setting or the model name. Check the model, or try Change provider > Advanced > Compatibility mode.',
  not_installed: "Claude isn't installed on this computer (or it isn't on the path the app can see).",
  budget: 'A usage budget is used up (tokens this session, or dollars this month). Nothing was sent. Raise the budget under Usage, or lock the vault to start a new session.',
  too_long: `Questions are limited to ${MAX_PROMPT_CHARS} characters.`,
  key_like: 'That looks like an API key. I did not send it.',
  limit: `This session reached ${MAX_USER_MESSAGES} questions. Lock the vault or Disconnect to start a new one.`,
}

/** Anything the backend returns that is not one of the fixed codes (a thrown Error, a plain string) collapses to bad_reply. */
export function toErrorCode(e: unknown): ExplainErrorCode {
  const m = (e instanceof Error ? e.message : String(e)).trim()
  return (ERROR_CODES as readonly string[]).includes(m) ? (m as ExplainErrorCode) : 'bad_reply'
}

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}
/** The last `n` earlier turns; the new question and the digest travel separately. */
export const trimHistory = (turns: readonly Turn[], n = HISTORY_TURNS): Turn[] => turns.slice(-n)

/** Older answers are cut to this many characters when a thread is replayed to the model (M16 B3). */
export const REPLAY_ASSISTANT_CHARS = 600
/**
 * What is replayed to the model: the last 8 turns as plain `{role, text}` (nothing else may ride along: Rust refuses unknown fields), with every
 * answer except the newest cut to 600 characters. Old digests are never part of it (only the current question carries one).
 */
export function replayHistory(turns: readonly Turn[], n = HISTORY_TURNS): Turn[] {
  const last = turns.slice(-n)
  const lastAssistant = last.map((t) => t.role).lastIndexOf('assistant')
  return last.map((t, i) => ({ role: t.role, text: t.role === 'assistant' && i !== lastAssistant ? [...t.text].slice(0, REPLAY_ASSISTANT_CHARS).join('') : t.text }))
}

let requestSeq = 0
/** A fresh id for one streamed ask: `^[A-Za-z0-9_-]{1,64}$` (checked again in Rust). */
export const newRequestId = (): string => `r${Date.now().toString(36)}${(++requestSeq).toString(36)}`

/** Settings (SQLite `settings` table, JSON values). */
export const CHAT_SAVE_HISTORY_KEY = 'chat.saveHistory'
export const BUDGET_SESSION_KEY = 'chat.budget.session_tokens'
export const BUDGET_MONTH_KEY = 'chat.budget.month_usd'

/** Mirrors `PROMPT_VERSION` in src-tauri/src/llm/client.rs (a test pins both). Shown in "What I sent". */
export const PROMPT_VERSION = 'm20b-1'
/** Rough token estimate: characters / 4, rounded up. Used for the "What I sent" drawer (the fixed instructions are not counted). */
export const estimateTokens = (chars: number): number => Math.ceil(Math.max(0, chars) / 4)

/** Teaching mode (A6): a closed enum. Rust maps each name to a fixed style clause; free text can never be sent. */
export type ExplainMode = 'beginner' | 'trader'
export const EXPLAIN_MODES: readonly ExplainMode[] = ['beginner', 'trader']
export const DEFAULT_MODE: ExplainMode = 'beginner'
export const CHAT_MODE_KEY = 'chat.mode'
export const serializeMode = (m: ExplainMode): string => JSON.stringify(m)
/** The stored setting is a JSON string; anything else (missing, bad JSON, unknown name) is the default. */
export function parseMode(raw: string | null | undefined): ExplainMode {
  if (!raw) return DEFAULT_MODE
  try {
    const v: unknown = JSON.parse(raw)
    return typeof v === 'string' && (EXPLAIN_MODES as readonly string[]).includes(v) ? (v as ExplainMode) : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}
