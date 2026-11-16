/**
 * The drawer's Iterations: a quiet history of checkpoints (phase 2, row 27). Record this attempt (what ran, the
 * evidence, what you report), list the ones kept for this work, open one read-only. See ./iterations for the routes and
 * what a record is (and is not).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { askConfirm } from '../../../ui/confirm'
import { localWhen } from '../../../lib/format'
import { commandArgs } from '../commandArgs'
import { describeFailure, newOperationId } from '../suggestions/model'
import { iterationRequest, IterationsReader, outcomeWords, parseIteration, type IterationView } from './iterations'
import { identity } from './features'

type Call = <T>(method: 'GET' | 'POST', p: string, body?: unknown, query?: Record<string, string>) => Promise<T>

export function Iterations({ call, ws, ctxKey }: { call: Call; ws: { id: string; generation: number; tree_digest: string }; ctxKey: string }) {
  // the list and the opened record belong to one context (call, capability key, workspace); paged and fenced (p2r2)
  const reader = useMemo(() => new IterationsReader(), [])
  const recordSeq = useRef(0)
  const ctx = `${identity(call)}|${ctxKey}|${ws.id}`
  const [note, setNote] = useState<{ bad: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  // a context switch drops the previous context's busy flag and note (render-time reset, not an effect)
  const [seenCtx, setSeenCtx] = useState(ctx)
  if (seenCtx !== ctx) {
    setSeenCtx(ctx)
    setBusy(false)
    setNote(null)
  }
  // this context's lifetime: a switch or unmount answers an open record confirm "no" by itself (Kimi p2r3 hardening),
  // so the fence never relies on the drawer staying mounted while closed
  const life = useRef<AbortController | null>(null)
  useLayoutEffect(() => {
    recordSeq.current++
    reader.setContext(ctx)
    const c = new AbortController()
    life.current = c
    return () => {
      recordSeq.current++
      c.abort()
    }
  }, [reader, ctx])
  const st = useSyncExternalStore(reader.subscribe, reader.getState, reader.getState)
  const items = st.ctx === ctx ? st.items : null
  const open = st.ctx === ctx ? st.open : null
  const setOpen = (v: IterationView | null) => reader.show(ctx, v)
  const [command, setCommand] = useState('python3 -m pytest -q')
  const [evidence, setEvidence] = useState('')
  const [attempts, setAttempts] = useState(1)

  const load = useCallback(() => reader.load(ctx, call, ws.id), [reader, ctx, call, ws.id])
  useEffect(() => {
    void Promise.resolve().then(load)
  }, [load, ws.generation])

  const parsed = (() => {
    try {
      return { argv: commandArgs(command), error: null }
    } catch (e) {
      return { argv: null, error: e instanceof Error ? e.message : String(e) }
    }
  })()
  const ids = evidence.split(/[\s,]+/).filter(Boolean)

  const record = async () => {
    if (!parsed.argv || busy) return
    const mine = ++recordSeq.current
    const current = () => mine === recordSeq.current && reader.getState().ctx === ctx
    if (!(await askConfirm(`Keep a record of this attempt on generation ${ws.generation}: “${command}”${ids.length ? ` with ${ids.length} piece(s) of evidence` : ''}? It runs nothing and changes no code.`, 'Keep the record', { signal: life.current?.signal }))) return
    if (!current()) return
    setBusy(true)
    setNote(null)
    try {
      const r = await call<unknown>('POST', `/v1/workspaces/${ws.id}/iterations`, iterationRequest({ command: parsed.argv, evidence: ids, attempts }, ws, newOperationId('iteration')))
      if (!current()) return
      setOpen(parseIteration({ ...(r as object), currency: 'current' }))
      await load()
    } catch (e) {
      if (!current()) return
      setNote({ bad: true, text: `No record was kept: ${describeFailure(e).text}` })
    } finally {
      if (current()) setBusy(false)
    }
  }
  const view = (id: string) => reader.open(ctx, call, ws.id, id)

  return (
    <div className="cc-iter">
      <p className="cc-iter-lede">A record of each attempt: what ran, its evidence, and where the code stood. It schedules and runs nothing.</p>
      <form
        className="cc-iter-form"
        onSubmit={(e) => {
          e.preventDefault()
          void record()
        }}
      >
        <label>
          What ran
          <input value={command} onChange={(e) => setCommand(e.target.value)} className="cc-input" spellCheck={false} />
        </label>
        {parsed.error && <p className="cc-prompt-note">{parsed.error}</p>}
        <label>
          Evidence (verification ids, optional)
          <input value={evidence} onChange={(e) => setEvidence(e.target.value)} className="cc-input" placeholder="from Evidence: ver_…" spellCheck={false} />
        </label>
        <label className="cc-iter-small">
          Attempts so far
          <input type="number" min={0} max={100} value={attempts} onChange={(e) => setAttempts(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className="cc-input" />
        </label>
        <button type="submit" className="cc-btn cc-btn-primary" disabled={!parsed.argv || busy}>
          {busy ? 'Keeping…' : 'Record this attempt'}
        </button>
      </form>
      {st.ctx === ctx && st.error && (
        <p className="cc-card-bad" role="alert">
          The history did not load fully: {st.error}
        </p>
      )}
      {note && (
        <p className={note.bad ? 'cc-card-bad' : 'cc-card-fine'} role={note.bad ? 'alert' : 'status'}>
          {note.text}
        </p>
      )}
      {open && (
        <section className="cc-iter-open" aria-label="An attempt, read-only">
          <h3>
            {localWhen(new Date(open.created_at * 1000).toISOString())} · generation {open.generation} {open.currency === 'historical' && <span className="cc-pill-note">(the code has moved on since)</span>}
          </h3>
          <p>{outcomeWords(open.outcome)}</p>
          <dl>
            <dt>What ran</dt>
            <dd>
              {open.commands.map((c, i) => (
                <code key={i} className="cc-code">
                  {c.join(' ')}
                </code>
              ))}
            </dd>
            <dt>Evidence</dt>
            <dd>{open.verification_ids.length ? open.verification_ids.join(', ') : 'none recorded'}</dd>
            <dt>Reported</dt>
            <dd>
              {open.reported.attempts ?? '?'} attempt(s); time and cost not known. Reported by {open.author}, not verified.
            </dd>
          </dl>
          <button type="button" className="cc-btn" onClick={() => setOpen(null)}>
            Close
          </button>
        </section>
      )}
      <h3 className="cc-iter-h">Kept for this work{st.partial ? ' (the journal is very long; the oldest are not listed)' : ''}</h3>
      {items === null ? (
        <p className="cc-card-fine">Reading…</p>
      ) : !items.length ? (
        <p className="cc-card-fine">None yet.</p>
      ) : (
        <ul className="cc-iter-list">
          {items.map((it) => (
            <li key={it.id}>
              <button type="button" onClick={() => void view(it.id)} aria-pressed={open?.id === it.id}>
                <span>{localWhen(new Date(it.created_at * 1000).toISOString())}</span>
                <span className="cc-cmp-detail">{it.id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
