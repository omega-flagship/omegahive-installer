/**
 * "Your open threads" (j0-fixes r1, J0 live P2): a person could not see or end their own open Ask sessions on a mind,
 * so a session that pins that mind's limit could not be cleared. Shown in the Ask's "Earlier": the person's OWN open
 * sessions (GET /api/sessions; an admin's list carries others' too, and they are never shown here) on the mind the
 * current thread answers through (or every mind, when no thread is open), each with End (POST /api/sessions/{id}/end).
 * Ending is not deleting: "Ends the thread; its words stay." The current thread is left to New thread, which ends it.
 * Every end is one bound write (lib/boundOperation): a sign-in change or an unmount stops it, and nothing after it acts.
 * Each thread's figures come from the limits payload's `ask_threads` where present (ask-limits r1: the thread's own cap
 * and own spend; that route is admins'), else from the session list.
 */
import { useEffect, useState } from 'react'
import type { WorkSession } from '../../api/types'
import { bindOperation, stopped, useAlive, OPERATION_STOPPED_WORDS } from '../../lib/boundOperation'
import { ago } from '../../lib/format'
import { errorMessage } from '../../lib/useResource'
import { useAskStore } from '../../store/ask'
import { useAdminView } from '../../lib/useAdmin'
import { useIdentityEpoch } from '../../lib/epochBound'
import { useHive } from '../../store/store'
import { money, shownMind } from './words'
import { askThreadFigures, END_SAYS, openThreadsOf, withThreadFigures, type AskThreadFigures } from './threadList'

export function OpenThreads() {
  const client = useHive((s) => s.client)
  const me = useAskStore((s) => s.bound?.principal ?? null)
  const thread = useAskStore((s) => s.thread)
  const alive = useAlive()
  const { adminView } = useAdminView()
  // per-person state dies with the sign-in (identity epoch): the list is read again, never shown across people
  const epoch = useIdentityEpoch()
  const [rows, setRows] = useState<WorkSession[] | null>(null)
  const [figures, setFigures] = useState<Map<string, AskThreadFigures> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ending, setEnding] = useState<string | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const mind = thread?.mind ?? null
  useEffect(() => {
    if (!client?.sessions) return
    // read again on a sign-in change (the epoch); rows are filtered to the bound person below, so none shows across people
    const op = bindOperation(alive)
    client
      .sessions()
      .then((all) => op.current() && (setRows(all), setError(null)))
      .catch((e) => op.current() && setError(errorMessage(e)))
    // the thread's own figures, when this person may read the Limits model; any failure leaves the session figures
    if (adminView && client.budgetLimitsView)
      client
        .budgetLimitsView()
        .then((p) => op.current() && setFigures(askThreadFigures(p)))
        .catch(() => op.current() && setFigures(null))
  }, [client, alive, tick, adminView, epoch])
  if (!client?.sessions || !client.endSession) return null
  const mine = rows ? withThreadFigures(openThreadsOf(rows, me, { mind: mind?.id, current: thread?.id }), figures) : []

  const end = async (s: WorkSession) => {
    if (ending) return
    const op = bindOperation(alive)
    setEnding(s.id)
    setSaid(null)
    try {
      await op.write(() => client.endSession!(s.id))
      setSaid(`Ended. ${END_SAYS}`)
      setTick((n) => n + 1)
    } catch (e) {
      if (stopped(e)) return setSaid(op.current() ? OPERATION_STOPPED_WORDS : null)
      setSaid(`It could not be ended: ${errorMessage(e)}. Nothing changed.`)
    } finally {
      if (op.current()) setEnding(null)
    }
  }

  return (
    <section className="ask-open-threads" aria-label="Your open threads" data-open-threads="">
      <div className="ask-row-text">
        <strong>{mind ? `Your other open threads with ${shownMind(mind.name)}` : 'Your open threads'}</strong>
      </div>
      <p className="ask-row-note">An open thread can hold part of a mind’s limit while it is open. {END_SAYS}</p>
      {error && <p className="ask-row-note" role="alert">Could not load them: {error}</p>}
      {!error && rows === null && <p className="ask-muted">Loading…</p>}
      {rows && mine.length === 0 && <p className="ask-muted">{thread ? 'None besides this one.' : 'None open.'}</p>}
      {mine.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {mine.map((s) => (
            <li key={s.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid rgb(255 255 255 / 0.06)' }}>
              <span className="ask-row-note" style={{ flex: '1 1 12rem', minWidth: 0 }}>
                {shownMind(s.mind?.name)} · started {ago(s.created_at)} · {money(s.spent_usd)} of {money(s.budget_usd)}
              </span>
              <button type="button" className="ask-btn" data-takeover="" disabled={!!ending} aria-label={`End this thread with ${shownMind(s.mind?.name)}, started ${ago(s.created_at)}. ${END_SAYS}`} onClick={() => void end(s)}>
                {ending === s.id ? 'Ending…' : 'End'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {said && <p className="ask-row-note" role="status">{said}</p>}
    </section>
  )
}
