import { useEffect, useRef, useState } from 'react'
import { ERROR_TEXT } from '../lib/explainPrompt'
import { cliCards, cliHidden, cliTerms, effectiveUrl, foundLine, HERMES_LOOPBACK_SUGGESTION, HERMES_SETUP_STEPS, HERMES_WARNING, keyHelpText, needsKeyAgain, orderProviders, providerInfo, validateSetup, type ProviderId } from '../lib/llmProviders'
import { configNeedsSetup, useExplainStore } from '../stores/explain'

/**
 * Provider cards for the Explain chat (M14b). Picking a card shows ONLY what that provider needs. The key lives in the password input's
 * DOM value while the user types, is cleared the moment Save is pressed, goes to Rust in the single `llm_config_set` call (sealed with
 * the address) and is never rendered, kept in a store, persisted or logged. Links are shown as plain text: the webview opens nothing.
 */
export function ExplainSetup() {
  const config = useExplainStore((s) => s.config)
  const detect = useExplainStore((s) => s.detect)
  const saving = useExplainStore((s) => s.saving)
  const testing = useExplainStore((s) => s.testing)
  const testResult = useExplainStore((s) => s.testResult)
  const cliDetect = useExplainStore((s) => s.cliDetect)
  const experimental = useExplainStore((s) => s.experimental)
  const advancedCli = useExplainStore((s) => s.advancedCli)
  const versions = useExplainStore((s) => s.versions)
  const orLogin = useExplainStore((s) => s.orLogin)
  const cards = orderProviders(detect, cliDetect, experimental, advancedCli)
  const notUsed = cliCards(cliDetect, experimental, advancedCli)
  const cliGated = cliHidden(cliDetect, advancedCli)
  const [sel, setSel] = useState<ProviderId>(() => {
    const saved = providerInfo(config?.provider)?.id
    return saved && cards.some((c) => c.info.id === saved) ? saved : cards[0]!.info.id
  })
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [compat, setCompat] = useState(false)
  const [lan, setLan] = useState(() => (config?.provider === 'hermes' ? config.lan_http : false))
  const [err, setErr] = useState('')
  const [note, setNote] = useState('')
  const [, bump] = useState(0)
  const keyRef = useRef<HTMLInputElement>(null)
  const p = providerInfo(sel)!
  const canClose = !configNeedsSetup(config)
  const isSaved = config?.provider === sel

  useEffect(() => {
    void useExplainStore.getState().runDetect()
    void useExplainStore.getState().runCliDetect()
    void useExplainStore.getState().loadExperimental()
    void useExplainStore.getState().loadAdvancedCli()
  }, [])

  const pick = (id: ProviderId) => {
    setSel(id)
    setBaseUrl('')
    setModel('')
    setCompat(config?.provider === id ? config.compat : false)
    setLan(config?.provider === id ? config.lan_http : false)
    setErr('')
    setNote('')
    if (keyRef.current) keyRef.current.value = ''
  }

  const save = async () => {
    const el = keyRef.current
    const typed = el?.value ?? ''
    const bad = validateSetup(p, { key: typed, baseUrl, model, lanHttp: p.id === 'hermes' ? lan : undefined }, config)
    if (bad) {
      setErr(bad)
      setNote('')
      return
    }
    if (el) el.value = '' // cleared before anything else happens, success or not
    bump((n) => n + 1)
    setErr('')
    const e = await useExplainStore.getState().saveConfig({
      provider: p.id,
      baseUrl: p.urlEditable ? baseUrl.trim() || null : null,
      apiKey: p.takesKey && typed.trim() ? typed.trim() : null,
      model: model.trim() || null,
      compat,
      lanHttp: p.id === 'hermes' ? lan : null,
    })
    setErr(e)
    setNote(e ? '' : 'Saved. Press Test to check it works.')
  }
  const remove = async () => {
    const e = await useExplainStore.getState().clearConfig()
    setErr(e)
    setNote(e ? '' : 'Removed the saved provider and key.')
  }

  const status = config ? { provider: config.provider, base_url: config.base_url, model: config.model, key_present: config.key_present, lan_http: config.lan_http } : null
  const again = needsKeyAgain(p, { baseUrl }, status)
  const found = cards.find((c) => c.info.id === sel)?.found ?? false
  const localLike = p.id === 'ollama' || p.id === 'lmstudio' || p.id === 'claude_cli' || p.id === 'hermes_cli'
  const isCli = p.id === 'claude_cli' || p.id === 'hermes_cli'
  const terms = cliTerms(p.id, cliDetect)
  const cliFoundId = cliDetect?.found.find((f) => f.provider === p.id)?.id

  return (
    <div className="explain-setup" aria-label="Choose how the explainer thinks">
      <div className="small muted">Pick where the answers come from. You can change this any time.</div>
      <div className="explain-cards" role="radiogroup" aria-label="Providers">
        {cards.map(({ info, found: f }) => (
          <button key={info.id} type="button" role="radio" aria-checked={info.id === sel} className={`explain-card ${info.id === sel ? 'sel' : ''}`} onClick={() => pick(info.id)}>
            <span className="explain-card-title">
              {info.label}
              {f && <span className="pill ok">Found on this computer</span>}
              {config?.provider === info.id && <span className="pill">In use</span>}
            </span>
            <span className="small muted">{info.blurb}</span>
            <span className="small muted">{info.priceHint}</span>
          </button>
        ))}
      </div>

      {notUsed.length > 0 && (
        <div className="explain-cli-found" aria-label="Other programs found on this computer">
          <div className="small muted">Also found on this computer (not used by this app):</div>
          <ul className="small">
            {notUsed.map((c) => (
              <li key={c.id}>
                <strong>{c.label}</strong> <span className="pill">{c.state === 'experimental_off' ? 'Found, experimental (off)' : 'Found, not supported'}</span>
                <div className="muted">{foundLine(c)}</div>
                <div className="muted">{c.terms}</div>
                <button type="button" className="link" onClick={() => void useExplainStore.getState().checkVersion(c.id)} aria-label={`Check version of ${c.label}`}>
                  Check version
                </button>
                {versions[c.id] && <span className="muted"> {versions[c.id]}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <form
        className="explain-setup-form"
        autoComplete="off"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        {p.id === 'hermes' && (
          <div className="explain-hermes">
            <ol className="small">
              {HERMES_SETUP_STEPS.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ol>
            <div className="explain-warn small" role="note">
              {HERMES_WARNING}
            </div>
            <label className="small">
              Address
              <input type="text" value={baseUrl} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} placeholder={isSaved && config?.base_url ? config.base_url : 'https://your-hermes-host'} aria-label="Hermes address" />
            </label>
            <span className="small muted">
              Only for Hermes running on this computer:{' '}
              <button type="button" className="chip" onClick={() => setBaseUrl('http://127.0.0.1:8642')} title={HERMES_LOOPBACK_SUGGESTION}>
                use {HERMES_LOOPBACK_SUGGESTION}
              </button>
            </span>
            <label className="small">
              <input type="checkbox" checked={lan} onChange={(e) => setLan(e.target.checked)} /> I accept plain LAN http (no encryption) to a private IP address such as 192.168.x.x or 100.x.x.x on my own network
            </label>
          </div>
        )}
        {p.takesKey && (
          <div className="explain-setup-row">
            <label className="small">
              {p.label} key{p.id === 'custom' || p.id === 'hermes' ? ' (optional)' : ''}
              <input ref={keyRef} type="password" autoComplete="off" spellCheck={false} placeholder={isSaved && config?.key_present ? 'saved (hidden), type to replace' : 'paste key (hidden)'} aria-label={`${p.label} API key`} />
            </label>
            {p.keyHelpUrl && (
              <span className="small muted">
                Get a key at <code>{keyHelpText(p.keyHelpUrl)}</code> (open it in your browser, then paste the key here).
              </span>
            )}
            {again && <span className="small err">This is a different address than the saved key was entered for, so paste the key again.</span>}
            {p.id === 'openrouter' && (
              <div className="explain-signin small">
                <button type="button" onClick={() => void useExplainStore.getState().startOrLogin()} disabled={orLogin.phase === 'pending' || saving}>
                  Sign in with OpenRouter
                </button>{' '}
                <span className="muted">or paste a key above. Signing in opens your browser; no key to copy.</span>
                {orLogin.phase === 'pending' && (
                  <div role="status">
                    Waiting for you to finish signing in, in your browser.{orLogin.url && ' If it did not open, open this link yourself:'} {orLogin.url && <code>{orLogin.url}</code>}{' '}
                    <button type="button" className="link" onClick={() => useExplainStore.getState().stopOrLogin()}>
                      Stop waiting
                    </button>
                  </div>
                )}
                {orLogin.phase === 'done' && (
                  <div className="note" role="status">
                    Signed in. Your OpenRouter key is saved (hidden). Press Test to check it works.
                  </div>
                )}
                {orLogin.phase === 'failed' && (
                  <div className="err" role="alert">
                    {orLogin.note || 'Sign-in did not finish. Try again, or paste a key instead.'}
                  </div>
                )}
                {orLogin.phase === 'expired' && (
                  <div className="err" role="alert">
                    Sign-in took too long (over 10 minutes). Try again, or paste a key instead.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {!p.takesKey && p.http && (
          <div className="small muted">
            Nothing to enter. {found ? 'It is running on this computer.' : detect ? 'It does not look like it is running right now. Start it, then press Test.' : 'Checking...'}
          </div>
        )}
        {p.id === 'claude_cli' && (
          <div className="small muted">
            Nothing to enter. {found ? 'Claude was found on this computer.' : detect ? "Claude wasn't found on this computer." : 'Checking...'} It runs with every tool turned off, so it can only write text.
          </div>
        )}
        {p.id === 'hermes_cli' && (
          <div className="small muted">
            Nothing to enter. {found ? 'Hermes was found on this computer.' : "Hermes wasn't found on this computer."} Experimental: it asks Hermes for text only, but this app has not been able to confirm on a real install that no tool can run.
          </div>
        )}
        {isCli && terms && <div className="small muted explain-terms">{terms}</div>}
        {isCli && found && cliFoundId && (
          <div className="small">
            <button type="button" className="link" onClick={() => void useExplainStore.getState().checkVersion(cliFoundId)}>
              Check version
            </button>
            {versions[cliFoundId] && <span className="muted"> {versions[cliFoundId]}</span>}
          </div>
        )}

        <details className="explain-adv" open={p.id === 'custom' || p.id === 'hermes'}>
          <summary className="small">Advanced</summary>
          {p.http && p.urlEditable && p.id !== 'hermes' && (
            <label className="small">
              Address
              <input type="text" value={baseUrl} spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} placeholder={effectiveUrl(p, { baseUrl: '' }, status) || 'https://example.com/v1'} aria-label="Base URL" />
            </label>
          )}
          {p.http && (
            <label className="small">
              Model
              <input type="text" list="explain-models" value={model} spellCheck={false} onChange={(e) => setModel(e.target.value)} placeholder={(isSaved && config?.model) || p.defaultModel || (p.id === 'hermes' ? 'profile name, for example tm-explain' : 'model name')} aria-label="Model" />
              <datalist id="explain-models">
                {p.models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>
          )}
          {p.http && (
            <label className="small">
              <input type="checkbox" checked={compat} onChange={(e) => setCompat(e.target.checked)} /> Compatibility mode (sends only the bare minimum; use it if the provider rejects a setting)
            </label>
          )}
          {!p.http && <span className="small muted">Nothing to adjust for this one.</span>}
          {cliDetect?.public_build && (
            <label className="small">
              <input type="checkbox" checked={advancedCli} onChange={(e) => void useExplainStore.getState().setAdvancedCli(e.target.checked)} /> Show installed-CLI options
              <span className="muted"> (off by default; programs already installed on this computer can be used as the explainer)</span>
            </label>
          )}
          {advancedCli && cliDetect?.public_build && p.id !== 'claude_cli' && <span className="small muted explain-terms">{cliTerms('claude_cli', cliDetect)}</span>}
          {!cliGated && (
            <label className="small">
              <input type="checkbox" checked={experimental} onChange={(e) => void useExplainStore.getState().setExperimental(e.target.checked)} /> Allow experimental agent programs (currently only Hermes). They are untested and off by default.
            </label>
          )}
        </details>

        <div className="explain-setup-actions">
          <button type="submit" disabled={saving}>
            Save
          </button>
          <button type="button" onClick={() => void useExplainStore.getState().runTest()} disabled={testing || saving || !isSaved}>
            {testing ? 'Testing...' : 'Test'}
          </button>
          {canClose && (
            <button type="button" onClick={() => useExplainStore.getState().openSetup(false)}>
              Done
            </button>
          )}
          {config?.provider && (
            <button type="button" onClick={() => void remove()} disabled={saving}>
              Remove saved provider and key
            </button>
          )}
        </div>
        {note && <span className="note small">{note}</span>}
        {err && (
          <span className="err small" role="alert">
            {err}
          </span>
        )}
        {testResult && (
          <span className={`small ${testResult.ok ? 'note' : 'err'}`} role="status">
            {testResult.ok ? (p.id === 'hermes' ? 'The host answered a bare check. No chart data was sent. Your key is checked on the first question.' : 'It works. The provider answered a short test message (no chart data was sent).') : ERROR_TEXT[testResult.code]}
          </span>
        )}
        {localLike && !isSaved && <span className="small muted">Press Save first, then Test.</span>}
      </form>
    </div>
  )
}
