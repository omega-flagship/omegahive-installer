/**
 * The work on the person's request, as it happens: one quiet, living sequence of glass steps (asking → the helper mind
 * thinking → its change → testing on a copy → review → ready), with a soft orb on the step that is moving, the test's
 * decisive line in mono, and, when it is ready, exactly three actions: Apply, Ask for changes, Discard.
 *
 * Presentation only: the stages come from ./stages (pure); the actions arrive already routed (./actions: the engine's
 * person routes, or the canvas's existing paths where no controller drives the request). Reduced motion: nothing
 * pulses or glides.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { cx } from '../../../../lib/cx'
import { Icon, type IconName } from '../../../../ui/Icon'
import { guardComposing } from '../../../ask/keys'
import { liveWords, type Stage, type StageKey, type Work } from './stages'
import './workStream.css'

export interface WorkActions {
  /** each decision's handler; null: shown, but not offered now (disabled) */
  onApply: (() => void) | null
  onDiscard: (() => void) | null
  onAskChanges: ((note: string) => void) | null
  applyLabel: string
  /** a decision is on its way (every action waits) */
  busy: boolean
  /** one calm line under the actions (what is not offered now, and why) */
  line?: string | null
  /** a decision that didn't go through, in plain words (shown instead of the calm line, as an alert) */
  alert?: string | null
  /** the longest change note this path takes (default 600) */
  noteMax?: number
}

const ICON: Record<StageKey, IconName> = { ask: 'chat', mind: 'mind', change: 'edit', test: 'play', review: 'shield', ready: 'check' }
const STATE_WORDS: Record<Stage['state'], string> = { waiting: 'still to come', active: 'happening now', done: 'done', failed: 'needs a look', skipped: 'not this time' }

export function WorkStream({ work, body, actions, reduced }: { work: Work; body?: Partial<Record<StageKey, ReactNode>>; actions: WorkActions | null; reduced: boolean }) {
  const headId = useId()
  const live = liveWords(work)
  return (
    <section className="ws" aria-label="The work on your request" data-reduced={reduced || undefined}>
      <header className="ws-head">
        <h2 id={headId} className="ws-title">
          {work.asked ? <>“{work.asked}”</> : 'Your request'}
        </h2>
        {work.round > 1 && <span className="ws-round">Round {work.round}</span>}
      </header>
      {work.changesAsked && <p className="ws-changes-asked">Changes asked for: {work.changesAsked}</p>}
      <ol className="ws-steps">
        {work.stages.map((s, n) => (
          <li key={s.key} className="ws-step" data-state={s.state} data-key={s.key} aria-current={s.state === 'active' ? 'step' : undefined}>
            <span className="ws-rail" aria-hidden="true">
              <span className={cx('ws-orb', s.state === 'active' && !reduced && 'ws-orb-live')}>
                {s.state === 'done' ? <Icon name="check" size={11} /> : s.state === 'failed' ? <Icon name="info" size={11} /> : s.state === 'active' ? null : <Icon name={ICON[s.key]} size={11} />}
              </span>
              {n < work.stages.length - 1 && <span className="ws-line" />}
            </span>
            <div className="ws-body">
              <p className="ws-words">
                <span className="sr-only">{STATE_WORDS[s.state]}: </span>
                {s.words}
              </p>
              {s.line && <p className="ws-out">{s.line}</p>}
              {s.detail && <p className="ws-detail">{s.detail}</p>}
              {body?.[s.key] && s.state !== 'waiting' && <div className="ws-slot">{body[s.key]}</div>}
              {s.key === 'ready' && actions && <Decision actions={actions} />}
            </div>
          </li>
        ))}
      </ol>
      <p className="sr-only" aria-live="polite">
        {live}
      </p>
    </section>
  )
}

/** The decision at the end of the stream; its note field folds away whenever the decision closes (it unmounts). */
function Decision({ actions }: { actions: WorkActions }) {
  const [asking, setAsking] = useState(false)
  const [note, setNote] = useState('')
  const field = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (asking) field.current?.focus()
  }, [asking])
  const [hint, setHint] = useState<string | null>(null)
  const max = actions.noteMax ?? 600
  const send = () => {
    const n = note.trim()
    if (!actions.onAskChanges || actions.busy) return
    if (!n || n.length > max) return void setHint(`Say what should change in a few words (up to ${max} characters).`)
    setHint(null)
    setAsking(false)
    setNote('')
    actions.onAskChanges(n)
  }
  return (
    <div className="ws-ready">
      {asking ? (
        <form
          className="ws-ask"
          onSubmit={(e) => {
            e.preventDefault()
            send()
          }}
        >
          <label className="ws-ask-label">
            What should change?
            <input
              ref={field}
              className="ws-ask-input"
              value={note}
              aria-invalid={hint ? true : undefined}
              onChange={(e) => {
                setNote(e.target.value)
                if (hint) setHint(null)
              }}
              placeholder="e.g. keep the old name, just fix the sum"
              onKeyDown={(e) => {
                if (guardComposing(e)) return
                if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  setAsking(false)
                }
              }}
            />
          </label>
          {hint && <p className="ws-line-note">{hint}</p>}
          <div className="ws-acts">
            <button type="button" className="cc-btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button type="submit" className="cc-btn cc-btn-primary" disabled={!note.trim() || actions.busy || !actions.onAskChanges}>
              Ask again
            </button>
          </div>
        </form>
      ) : (
        <div className="ws-acts" role="group" aria-label="Your decision">
          <button type="button" className="cc-btn" onClick={actions.onDiscard ?? undefined} disabled={actions.busy || !actions.onDiscard} title="Discard this change">
            Discard
          </button>
          <button type="button" className="cc-btn" onClick={() => setAsking(true)} disabled={actions.busy || !actions.onAskChanges} title="Say what should be different; the mind tries again">
            Ask for changes
          </button>
          <button type="button" className="cc-btn cc-btn-primary" onClick={actions.onApply ?? undefined} disabled={actions.busy || !actions.onApply} title="Apply to your copy">
            {actions.applyLabel}
          </button>
        </div>
      )}
      {actions.alert ? (
        <p className="ws-line-note ws-line-alert" role="alert">
          {actions.alert}
        </p>
      ) : (
        actions.line && (
          <p className="ws-line-note" role="status">
            {actions.line}
          </p>
        )
      )}
    </div>
  )
}
