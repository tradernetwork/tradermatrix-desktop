import { useState } from 'react'
import { useMask } from './useMask'
import type { JournalNote, RhPnlTrade } from '../lib/api'
import { parseTags, validateNoteInput } from '../lib/journalRules'
import { whenShort } from '../lib/journalUi'
import { useJournalStore } from '../stores/journal'

/** Textarea + comma separated tags. `trade` attaches the note to that trade; without it the note is free-form. */
export function NoteComposer({ trade, onSaved }: { trade?: RhPnlTrade | null; onSaved?: () => void }) {
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')
  const check = body === '' ? '' : validateNoteInput(body, parseTags(tags))
  return (
    <form
      className="note-form"
      onSubmit={(e) => {
        e.preventDefault()
        if (body.trim() === '' || check) return
        void useJournalStore.getState().addNote({ body, tags: parseTags(tags), trade: trade ?? null }).then((ok) => {
          if (ok) {
            setBody('')
            setTags('')
            onSaved?.()
          }
        })
      }}
    >
      <textarea
        aria-label={trade ? `Note on ${trade.symbol} trade` : 'New note'}
        placeholder={trade ? `Note on this ${trade.symbol} trade` : 'What happened, what did you do, what would you change?'}
        value={body}
        rows={3}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="note-row">
        <input aria-label="Tags" placeholder="tags, comma separated" value={tags} onChange={(e) => setTags(e.target.value)} />
        <button type="submit" disabled={body.trim() === '' || !!check}>Save note</button>
      </div>
      {check && <div className="err">{check}</div>}
    </form>
  )
}

function NoteItem({ n }: { n: JournalNote }) {
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(n.body)
  const [tags, setTags] = useState(n.tags.join(', '))
  const check = validateNoteInput(body, parseTags(tags))
  return (
    <li className="note">
      <div className="note-meta">
        <span>{whenShort(n.created_at)}</span>
        {n.symbol && <span className="tag gold">{n.symbol}</span>}
        {n.trade_key && <span className="muted" title="Linked to a trade">trade</span>}
        {n.account_masked && <span className="muted">{n.account_masked}</span>}
        {n.tags.map((t) => (
          <span key={t} className="tag">{t}</span>
        ))}
        <span className="spacer" />
        {!editing && (
          <>
            <button onClick={() => { setBody(n.body); setTags(n.tags.join(', ')); setEditing(true) }}>Edit</button>
            <button onClick={() => void useJournalStore.getState().removeNote(n.id)}>Delete</button>
          </>
        )}
      </div>
      {editing ? (
        <form
          className="note-form"
          onSubmit={(e) => {
            e.preventDefault()
            if (check) return
            void useJournalStore.getState().editNote(n.id, body, parseTags(tags)).then((ok) => {
              if (ok) setEditing(false)
            })
          }}
        >
          <textarea aria-label="Edit note" value={body} rows={3} onChange={(e) => setBody(e.target.value)} />
          <div className="note-row">
            <input aria-label="Edit tags" value={tags} onChange={(e) => setTags(e.target.value)} />
            <button type="submit" disabled={!!check}>Save</button>
            <button type="button" onClick={() => setEditing(false)}>Cancel</button>
          </div>
          {check && <div className="err">{check}</div>}
        </form>
      ) : (
        <div className="note-body">{n.body}</div>
      )}
    </li>
  )
}

/** The notes attached to one trade plus a composer for a new one. */
export function TradeNotes({ trade, notes }: { trade: RhPnlTrade; notes: JournalNote[] }) {
  return (
    <div className="trade-notes">
      {notes.length > 0 && (
        <ul className="notes">
          {notes.map((n) => (
            <NoteItem key={n.id} n={n} />
          ))}
        </ul>
      )}
      <NoteComposer trade={trade} />
    </div>
  )
}

/** Free-form feed: search, symbol filter, add, edit, delete. Local data only. */
export function NotesFeed() {
  const { notes, notesError, filterSymbol, filterText } = useJournalStore()
  const { setFilter } = useJournalStore.getState()
  const mask = useMask()
  return (
    <div className="notes-feed">
      <div className="pane-head">
        <strong>Notes</strong>
        <input aria-label="Filter by symbol" className="sym" placeholder="Symbol" value={filterSymbol} onChange={(e) => void setFilter(e.target.value.toUpperCase(), filterText)} />
        <input aria-label="Search notes" placeholder="Search notes" value={filterText} onChange={(e) => void setFilter(filterSymbol, e.target.value)} />
      </div>
      {notesError && <div className="err" role="alert">{mask(notesError)}</div>}
      <NoteComposer />
      {notes.length === 0 && !notesError ? (
        <div className="pane-empty">{filterSymbol || filterText ? 'No notes match.' : 'No notes yet. Click a trade above or write one here.'}</div>
      ) : (
        <ul className="notes">
          {notes.map((n) => (
            <NoteItem key={n.id} n={n} />
          ))}
        </ul>
      )}
    </div>
  )
}
