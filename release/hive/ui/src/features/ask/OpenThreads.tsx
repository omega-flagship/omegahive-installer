/** Purpose: list and end the signed-in person’s open Ask threads.
 * "Your open threads" (j0-fixes r1, J0 live P2): a person could not see or end their own open Ask sessions on a mind.
 * Shown in the Ask's "Earlier": the person's OWN open sessions (GET /api/sessions; an admin's list carries others' too,
 * and they are never shown here) on the mind the current thread answers through (or every mind, when no thread is
 * open), each with what it has spent and End (POST /api/sessions/{id}/end). An Ask thread has no cap of its own (Jon on
 * #294), so only its spend is shown. Ending is not deleting: "Ends the thread; its words stay." The current thread is
 * left to New thread, which ends it. Every end is one bound write (lib/boundOperation): a sign-in change or an unmount
 * stops it, and nothing after it acts.
 */
import { useEffect, useState } from 'react'
import type { WorkSession } from '../../api/types'
import { bindOperation, stopped, useAlive, OPERATION_STOPPED_WORDS } from '../../lib/boundOperation'
import { ago } from '../../lib/format'
import { errorMessage } from '../../lib/useResource'
import { useAskStore } from '../../store/ask'
import { useIdentityEpoch } from '../../lib/epochBound'
import { useHive } from '../../store/store'
import { money, shownMind } from './words'
import { END_SAYS, openThreadsOf } from './threadList'

export function OpenThreads() {
  const client = useHive((s) => s.client)
  const me = useAskStore((s) => s.bound?.principal ?? null)
  const thread = useAskStore((s) => s.thread)
  const alive = useAlive()
  // per-person state dies with the sign-in (identity epoch): the list is read again, never shown across people
  const epoch = useIdentityEpoch()
  const [rows, setRows] = useState<WorkSession[] | null>(null)
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
  }, [client, alive, tick, epoch])
  if (!client?.sessions || !client.endSession) return null
  const mine = rows ? openThreadsOf(rows, me, { mind: mind?.id, current: thread?.id }) : []

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
        <strong>{mind ? `Your other open threads with ${shownMind(mind.name, mind.id)}` : 'Your open threads'}</strong>
      </div>
      <p className="ask-row-note">{END_SAYS}</p>
      {error && <p className="ask-row-note" role="alert">Could not load them: {error}</p>}
      {!error && rows === null && <p className="ask-muted">Loading…</p>}
      {rows && mine.length === 0 && <p className="ask-muted">{thread ? 'None besides this one.' : 'None open.'}</p>}
      {mine.length > 0 && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {mine.map((s) => (
            <li key={s.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid color-mix(in oklab, var(--color-ink) 6%, transparent)' }}>
              <span className="ask-row-note" style={{ flex: '1 1 12rem', minWidth: 0 }}>
                {shownMind(s.mind?.name, s.mind?.id)} · started {ago(s.created_at)} · {money(s.spent_usd)} spent
              </span>
              <button type="button" className="ask-btn" data-takeover="" disabled={!!ending} aria-label={`End this thread with ${shownMind(s.mind?.name, s.mind?.id)}, started ${ago(s.created_at)}. ${END_SAYS}`} onClick={() => void end(s)}>
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
