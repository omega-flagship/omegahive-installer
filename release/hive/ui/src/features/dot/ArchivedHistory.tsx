import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { Agent, Trace } from '../../api/types'
import { errorMessage } from '../../lib/useResource'
import { useHive } from '../../store/store'
import { Button, ErrorState } from '../../ui/primitives'
import { HISTORY_PAGE, TraceHistory } from './traceHistory'
import { shown } from '../../lib/displayName'

/** Uses the same host session and trace renderer; no app identity, action or extra authority. */
export function ArchivedHistory({ agent, renderTrace }: { agent: Agent; renderTrace: (trace: Trace) => ReactNode }) {
  const client = useHive(s => s.client)
  const history = useMemo(() => new TraceHistory(client, agent.id), [client, agent.id])
  const state = useSyncExternalStore(history.subscribe, history.getState, history.getState)
  useEffect(() => {
    history.start()
    const offConnection = client?.onConnection(connection => { if (connection === 'unauthorized') history.clear() })
    const offEvent = client?.subscribe(event => {
      // Visibility and ownership can change while an old page is displayed.
      if (event.type === 'agent.updated' || event.type === 'agent.deleted' || event.type === 'swarm.updated') history.clear()
    })
    return () => { history.stop(); offConnection?.(); offEvent?.() }
  }, [client, history])
  const busy = state.phase === 'loading'
  return <section className="mt-5 space-y-3 border-t border-line pt-4" aria-label={`${shown(agent.name)} archived history`}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-body font-semibold">Older history</h3>
      <Button disabled={busy} onClick={() => void history.index()}>{state.phase === 'idle' ? 'Browse archived traces' : 'Refresh archive index'}</Button>
    </div>
    <p className="text-small text-ink-3">The timeline above is a recent window. Older traces are read separately in this mind’s current access scope. No action is repeated.</p>
    {busy && <p role="status" className="text-small text-ink-3">Loading archived history…</p>}
    {state.phase === 'unsupported' && <p role="status" className="text-small text-ink-3">Archived history is not available in this hive or demo.</p>}
    {state.phase === 'error' && <ErrorState title="Could not read archived history" body={errorMessage(state.error)} onRetry={() => void history.retry()} />}
    {state.days.length > 0 && <label className="block text-small">Archive day (UTC)
      <select className="ml-2 max-w-full rounded-lg border border-control bg-abyss p-2" value={state.day ?? ''} disabled={busy} onChange={e => { if (e.target.value) void history.page(e.target.value) }}>
        <option value="" disabled>Choose a day</option>
        {state.days.map(d => <option key={d.day} value={d.day}>{d.day} · {d.entries} archived traces</option>)}
      </select>
    </label>}
    {state.phase === 'empty' && <p role="status" className="text-small text-ink-3">{state.day ? 'No entries at this page offset. Return to an earlier page or refresh the index.' : 'No archived trace days were reported. This does not describe other app or receipt history.'}</p>}
    {state.day && !busy && (state.phase === 'ready' || state.phase === 'empty') && <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Archive pages">
      <Button disabled={state.offset === 0} onClick={() => void history.page(state.day!, Math.max(0, state.offset - HISTORY_PAGE))}>Previous page</Button>
      <span className="text-small text-ink-3">{state.rows.length ? `Entries ${state.offset + 1}–${state.offset + state.rows.length}` : `Offset ${state.offset}`} · {state.day} UTC · newest first within this page</span>
      <Button disabled={state.rows.length < HISTORY_PAGE} onClick={() => void history.page(state.day!, state.offset + HISTORY_PAGE)}>Next page</Button>
    </div>}
    {state.rows.length > 0 && <ol aria-label={`${shown(agent.name)} archived traces, newest first within page`}>{[...state.rows].reverse().map(renderTrace)}</ol>}
  </section>
}
