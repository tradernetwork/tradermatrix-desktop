import { useEffect, useRef, useState } from 'react'
import type { InputDef } from '@rebull/script'
import { BUILTIN_SCRIPTS } from './builtinScripts'
import { parseNumberDraft } from './indicatorInput'
import type { ActiveIndicator } from './scriptIndicator'

const SOURCES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'hlcc4', 'ohlc4', 'volume']

export interface IndicatorMenuProps {
  active: ActiveIndicator[]
  /** Input definitions per active indicator id (from the last script run). */
  defs: Record<string, InputDef[]>
  errors: Record<string, string>
  onAdd: (scriptId: string) => void
  onRemove: (id: string) => void
  onInput: (id: string, key: string, value: number | boolean | string) => void
}

/** Keeps what is being typed in a local draft, so clearing the field or typing "1" on the way to "14" never snaps back; valid numbers commit as you type, the field re-syncs on blur. */
function NumberField({ a, d, cur, onInput }: { a: ActiveIndicator; d: InputDef; cur: unknown; onInput: IndicatorMenuProps['onInput'] }) {
  const committed = typeof cur === 'number' ? cur : Number(cur)
  const [draft, setDraft] = useState<string | null>(null)
  const focused = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(null)
  }, [committed])
  return (
    <input
      type="text"
      inputMode={d.type === 'integer' ? 'numeric' : 'decimal'}
      aria-label={d.name}
      value={draft ?? String(committed)}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => {
        setDraft(e.target.value)
        const n = parseNumberDraft(e.target.value, d)
        if (n !== null) onInput(a.id, d.key, n)
      }}
      onBlur={() => {
        focused.current = false
        setDraft(null)
      }}
    />
  )
}

function InputField({ a, d, onInput }: { a: ActiveIndicator; d: InputDef; onInput: IndicatorMenuProps['onInput'] }) {
  const cur = a.inputs[d.key] ?? d.default
  if (d.type === 'bool')
    return <input type="checkbox" aria-label={d.name} checked={cur === true} onChange={(e) => onInput(a.id, d.key, e.target.checked)} />
  if (d.type === 'integer' || d.type === 'float') return <NumberField a={a} d={d} cur={cur} onInput={onInput} />
  if (d.type === 'source')
    return (
      <select aria-label={d.name} value={String(cur)} onChange={(e) => onInput(a.id, d.key, e.target.value)}>
        {[...new Set([String(cur), ...SOURCES])].map((s) => (
          <option key={s}>{s}</option>
        ))}
      </select>
    )
  return <input type="text" aria-label={d.name} value={String(cur)} onChange={(e) => onInput(a.id, d.key, e.target.value)} />
}

export function IndicatorMenu({ active, defs, errors, onAdd, onRemove, onInput }: IndicatorMenuProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="ind-wrap">
      <button onClick={() => setOpen(!open)} aria-expanded={open}>
        Indicators{active.length ? ` (${active.length})` : ''}
      </button>
      {open && (
        <div className="ind-menu" role="dialog" aria-label="Indicators">
          <div className="ind-add">
            <span className="muted">Add</span>
            {BUILTIN_SCRIPTS.map((s) => (
              <button key={s.id} onClick={() => onAdd(s.id)} title={s.label}>
                {s.label}
              </button>
            ))}
          </div>
          {active.length === 0 && <div className="muted">No indicators on the chart.</div>}
          {active.map((a) => (
            <div key={a.id} className="ind-row">
              <div className="ind-title">
                <b>{a.label}</b>
                <button onClick={() => onRemove(a.id)} aria-label={`Remove ${a.label}`}>
                  Remove
                </button>
              </div>
              {errors[a.id] && <div className="err">{errors[a.id]}</div>}
              <div className="ind-inputs">
                {(defs[a.id] ?? []).map((d) => (
                  <label key={d.key}>
                    <span>{d.name}</span>
                    <InputField a={a} d={d} onInput={onInput} />
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
