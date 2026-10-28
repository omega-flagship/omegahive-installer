import { plural } from '../../lib/plural'
import { useEffect, useRef, useState } from 'react'
import { askConfirm, ConfirmHost } from '../../ui/confirm'
import { Button } from '../../ui/primitives'
import { useUnsaved } from '../ask/dirty'
import { OutputReader, type OutputPage } from './runOutput'
import { SnapshotAssembler } from './symbolicSnapshot'
import { decodeRecovery, recoveryKey, type PendingSymbolic, type SymbolicRecovery } from './symbolicRecovery'
import { activeSymbolicRun, symbolicFrame, symbolicOps, SymbolicTranscript, verifySymbolicRun, type SymbolicOp, type SymbolicRun } from './symbolicSession'

type Call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) => Promise<T>
interface Workspace { id: string; generation: number; tree_digest: string }
interface Runtime { id: string; available: boolean; kind: string; capabilities: string[]; session_argv?: string[]; limitations?: string }
type Pending = PendingSymbolic
const message = (error: unknown) => error instanceof Error ? error.message : String(error)

/** Keep mounted under the workspace ID, including while its Workbench pane is hidden. */
export function SymbolicPanel({ call, ws, dirty, active = true }: { call: Call; ws: Workspace; dirty: boolean; active?: boolean }) {
  const [runtimes, setRuntimes] = useState<Runtime[]>([])
  const [runtime, setRuntime] = useState('')
  const [run, setRun] = useState<SymbolicRun | null>(null)
  const [attach, setAttach] = useState('')
  const [op, setOp] = useState<SymbolicOp>('eval')
  const [source, setSource] = useState('!(+ 2 3)')
  const [label, setLabel] = useState('')
  const [snapshot, setSnapshot] = useState('')
  const [base, setBase] = useState('')
  const [incoming, setIncoming] = useState('')
  const [after, setAfter] = useState(0)
  const [limit, setLimit] = useState(50)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [pending, setPending] = useState<Pending | null>(null)
  // a request retained for an exact retry (only a manual Save recovery keeps it past a reload): a reload must not drop it
  useUnsaved(!!pending)
  const [control, setControl] = useState<{ run: string; id: string } | null>(null)
  const [verified, setVerified] = useState<{ id: string; atoms: string[] } | null>(null)
  const [view, setView] = useState<{ events: SymbolicTranscript['events']; diagnostics: string[]; ready: boolean; raw: string }>({ events: [], diagnostics: [], ready: false, raw: '' })
  const alive = useRef(true)
  const current = useRef({ ws, dirty })
  const reader = useRef<OutputReader | null>(null)
  const transcript = useRef<SymbolicTranscript | null>(null)
  const snapshots = useRef(new Map<string, SnapshotAssembler>())
  const seenResults = useRef(new Set<string>())
  useEffect(() => { current.current = { ws, dirty } }, [ws, dirty])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const job = async (work: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await work() } catch (error) { if (alive.current) setError(message(error)) }
    finally { if (alive.current) setBusy(false) }
  }
  const select = (selected: SymbolicRun) => {
    verifySymbolicRun(selected, current.current.ws.id)
    if (!alive.current) return
    reader.current = new OutputReader(selected.id, selected.workspace_id)
    transcript.current = new SymbolicTranscript(selected)
    snapshots.current.clear(); seenResults.current.clear(); setVerified(null)
    setRun(selected); setAttach(selected.id); setControl(null)
    setView({ events: [], diagnostics: [], ready: false, raw: '' })
  }
  const loadRuntimes = () => job(async () => {
    const result = await call<{ toolchains: Runtime[] }>('GET', `/v1/workspaces/${ws.id}/toolchains`)
    if (alive.current) setRuntimes(result.toolchains.filter(r => r.kind === 'hyperon'))
  })
  const attachRun = () => job(async () => {
    if (!/^run_[A-Za-z0-9_-]+$/.test(attach)) throw new Error('Enter a run ID')
    select(await call<SymbolicRun>('GET', `/v1/runs/${attach}`))
  })
  const perform = async (request: Pending) => {
    if (request.kind !== 'start' && (!run || request.path !== `/v1/runs/${run.id}/${request.kind === 'input' ? 'terminal' : 'cancel'}`)) throw new Error('Reconnect and verify the original run before retrying its operation')
    if (request.kind === 'input' && (!view.ready || !run)) throw new Error('Read the original session ready receipt before retrying input; inactive runs can return only an existing receipt')
    setPending(request)
    const response = await call<SymbolicRun & { id: string; status: string }>('POST', request.path, request.body)
    if (!alive.current) return
    if (request.kind === 'start') select(response)
    if (request.kind === 'input' && run) setControl({ run: run.id, id: response.id })
    setPending(null)
    setNotice(request.kind === 'input' ? `Input ${response.id}: ${response.status}. Queued or consumed bytes are not an evaluation result; read output.` : `Run ${response.id}: ${response.status}`)
  }
  const start = () => job(async () => {
    const selected = runtimes.find(r => r.id === runtime)
    if (!selected?.available || !selected.capabilities.includes('resident-jsonl-session') || selected.session_argv?.length !== 1) throw new Error('Select an operator-enabled resident Hyperon runtime')
    const sourceRevision = { ...current.current.ws }
    if (current.current.dirty) throw new Error('Save or discard editor changes before starting a session')
    if (!(await askConfirm(`Start trusted native Hyperon on source generation ${sourceRevision.generation} for up to 60 seconds? Grounded operations can have effects.`, 'Start symbolic session'))) return
    if (!alive.current) return
    if (current.current.dirty || current.current.ws.id !== sourceRevision.id || current.current.ws.tree_digest !== sourceRevision.tree_digest) throw new Error('Source changed during confirmation; review it again')
    await perform({ kind: 'start', path: '/v1/runs', body: { operation_id: crypto.randomUUID(), workspace_id: sourceRevision.id, expected_generation: sourceRevision.generation, expected_tree_digest: sourceRevision.tree_digest, argv: selected.session_argv, symbolic_runtime_id: selected.id, terminal: true, timeout_seconds: 60 } })
  })
  const send = () => job(async () => {
    if (!run || !activeSymbolicRun(run) || !view.ready) throw new Error('Read a matching ready receipt from an active resident session first')
    const frame = symbolicFrame(op, crypto.randomUUID(), { source, label, snapshot, base, incoming, after, limit })
    if (!(await askConfirm(`Authorize this exact ${frame.bytes}-byte input on ${run.id}? Every input requires execution authority, including inspection.\n${JSON.stringify(frame.request)}`, 'Send symbolic input'))) return
    if (!alive.current) return
    await perform({ kind: 'input', path: `/v1/runs/${run.id}/terminal`, body: { operation_id: crypto.randomUUID(), kind: 'input', data_base64: frame.data_base64 } })
  })
  const refresh = () => job(async () => {
    if (!run || !reader.current || !transcript.current) return
    const status = await call<SymbolicRun>('GET', `/v1/runs/${run.id}`)
    verifySymbolicRun(status, ws.id)
    if (status.symbolic_session?.identity_digest !== run.symbolic_session?.identity_digest || status.tree_digest !== run.tree_digest) throw new Error('Selected session identity changed')
    if (!alive.current) return
    setRun(status)
    for (let i = 0; i < 4; i++) {
      const page = await call<OutputPage>('GET', `/v1/runs/${run.id}/output`, undefined, { after: String(reader.current.cursor), limit: '16384' })
      if (!alive.current) return
      const outcome = reader.current.append(page)
      if (outcome === 'replay') { reader.current = new OutputReader(run.id, ws.id); transcript.current = new SymbolicTranscript(run); snapshots.current.clear(); seenResults.current.clear(); setVerified(null); continue }
      for (const event of transcript.current.append(reader.current.text)) {
        if (!event.id || seenResults.current.has(event.id) || event.event !== 'result' || !event.result || typeof event.result !== 'object') continue
        const result = event.result as Record<string, unknown>
        if (event.op === 'snapshot' && typeof result.id === 'string') {
          const assembly = new SnapshotAssembler(result, run)
          if (!snapshots.current.has(result.id)) {
            if (snapshots.current.size >= 32) throw new Error('Snapshot metadata retention limit reached')
            snapshots.current.set(result.id, assembly)
          }
        }
        if (event.op === 'snapshot-bytes' && typeof result.snapshot_id === 'string') {
          const assembly = snapshots.current.get(result.snapshot_id)
          if (!assembly) throw new Error('Read the snapshot creation metadata before its byte pages')
          if (result.after === 0 && assembly.cursor > 0) throw new Error('Byte pages repeat an already assembled cursor; select a new session replay explicitly')
          const retained = [...snapshots.current.values()].reduce((total, item) => total + item.cursor, 0)
          if (typeof result.next !== 'number' || typeof result.after !== 'number' || retained + result.next - result.after > 1048576) throw new Error('Assembled snapshot memory budget exhausted')
          assembly.append(result)
        }
        seenResults.current.add(event.id)
      }
      if (outcome !== 'continue') break
    }
    setView({ events: [...transcript.current.events], diagnostics: [...transcript.current.diagnostics], ready: transcript.current.ready, raw: reader.current.text.slice(-12288) })
  })
  const checkControl = () => job(async () => {
    if (!control) return
    const result = await call<{ status: string }>('GET', `/v1/runs/${control.run}/terminal/${control.id}`)
    if (alive.current) setNotice(`Input ${control.id}: ${result.status}. Evaluation outcome is in the output transcript.`)
  })
  const cancel = () => job(async () => {
    if (!run || !(await askConfirm(`Cancel resident session ${run.id}? Its atom space and snapshots will no longer be accessible.`, 'Cancel symbolic session'))) return
    if (alive.current) await perform({ kind: 'cancel', path: `/v1/runs/${run.id}/cancel`, body: { operation_id: crypto.randomUUID() } })
  })
  const frozen = busy || pending !== null
  const saveRecovery = () => job(async () => {
    const saved: SymbolicRecovery = { version: 1, workspace: ws.id, run: run?.id ?? attach, runtime, pending,
      draft: { op, source, label, snapshot, base, incoming, after, limit } }
    const raw = JSON.stringify(saved)
    decodeRecovery(raw, ws.id)
    sessionStorage.setItem(recoveryKey(ws.id), raw)
    setNotice('Recovery saved in this browser tab. It includes input text, contains no credentials, and will never replay automatically.')
  })
  const restoreRecovery = () => job(async () => {
    const raw = sessionStorage.getItem(recoveryKey(ws.id))
    if (!raw) throw new Error('No tab-local recovery record for this workspace')
    const saved = decodeRecovery(raw, ws.id)
    if (!(await askConfirm('Restore saved draft and exact pending request? This replaces the current panel view. No input will be sent; reconnect and review before retrying.', 'Restore symbolic recovery'))) return
    if (!alive.current) return
    setRun(null); setAttach(saved.run); setRuntime(saved.runtime); setPending(saved.pending)
    setOp(saved.draft.op); setSource(saved.draft.source); setLabel(saved.draft.label)
    setSnapshot(saved.draft.snapshot); setBase(saved.draft.base); setIncoming(saved.draft.incoming)
    setAfter(saved.draft.after); setLimit(saved.draft.limit); setControl(null); setVerified(null)
    reader.current = null; transcript.current = null; snapshots.current.clear(); seenResults.current.clear()
    setView({ events: [], diagnostics: [], ready: false, raw: '' })
    setNotice('Local state restored. Reconnect the original run and read its ready receipt; no effects were sent.')
  })
  return <section className="h-full overflow-auto p-4 space-y-4" aria-label="Symbolic coding session">
    {active && <ConfirmHost />}
    <p>Hyperon resident session · trusted native execution. Atom snapshots contain rendered strings. No automatic replay, PeTTa session, grounded-object restoration or symbolic stepping.</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={frozen} onClick={loadRuntimes}>Discover runtimes</Button>
      <select aria-label="Symbolic runtime" value={runtime} disabled={frozen} onChange={e => setRuntime(e.target.value)}><option value="">Select runtime</option>{runtimes.map(r => <option key={r.id} value={r.id} disabled={!r.available || !r.session_argv}>{r.id} · {r.available ? r.session_argv ? 'session enabled' : 'session disabled' : 'unavailable'}</option>)}</select>
      <Button disabled={frozen || dirty || !runtime || !!run && activeSymbolicRun(run)} onClick={start}>Start session</Button>
      <input aria-label="Existing symbolic run ID" value={attach} disabled={frozen} onChange={e => setAttach(e.target.value)} placeholder="run_…" />
      <Button disabled={busy || pending?.kind === 'start' || !attach} onClick={attachRun}>Reconnect</Button>
      <Button disabled={busy} onClick={saveRecovery}>Save tab-local recovery</Button>
      <Button disabled={busy || pending !== null} onClick={restoreRecovery}>Restore tab-local recovery</Button>
      <Button disabled={busy} onClick={() => job(async () => { sessionStorage.removeItem(recoveryKey(ws.id)); setNotice('Tab-local recovery removed.') })}>Forget saved recovery</Button>
    </div>
    {runtimes.find(r => r.id === runtime)?.limitations && <p>{runtimes.find(r => r.id === runtime)?.limitations}</p>}
    {run && <div className="space-y-2"><p>{run.id} · {run.status} · generation {run.generation}{run.tree_digest !== ws.tree_digest ? ' · historical source' : ''}</p><p className="break-all font-mono text-xs">source {run.tree_digest}<br />runtime {run.symbolic_session?.runtime_id} / {run.symbolic_session?.identity_digest}</p>
      <Button disabled={busy} onClick={refresh}>Read output / status</Button> <Button disabled={frozen || !activeSymbolicRun(run)} onClick={cancel}>Cancel session</Button> {control && <Button disabled={busy} onClick={checkControl}>Check input consumption</Button>}
    </div>}
    {pending && <div role="alert"><p>The exact {pending.kind} request has an uncertain response. Retry uses the same bytes and operation ID; do not create a replacement effect.</p><Button disabled={busy} onClick={() => job(async () => { if (await askConfirm(`Retry this exact request?\n${JSON.stringify(pending.body)}`, 'Retry exact symbolic request')) await perform(pending) })}>Retry exact request</Button></div>}
    <fieldset disabled={frozen || !run || !activeSymbolicRun(run) || !view.ready} className="space-y-2">
      <label>Operation <select value={op} onChange={e => { setOp(e.target.value as SymbolicOp); setAfter(0); setLimit(e.target.value === 'snapshot-bytes' ? 1024 : 50) }}>{symbolicOps.map(value => <option key={value}>{value}</option>)}</select></label>
      {['eval','add','remove','query'].includes(op) && <textarea aria-label="MeTTa input" className="w-full min-h-28 font-mono" value={source} onChange={e => setSource(e.target.value)} />}
      {op === 'snapshot' && <label>Snapshot label <input value={label} onChange={e => setLabel(e.target.value)} maxLength={160} /></label>}
      {['snapshot-atoms','snapshot-bytes'].includes(op) && <label>Snapshot ID <input value={snapshot} onChange={e => setSnapshot(e.target.value)} /></label>}
      {op === 'diff' && <><label>Base snapshot <input value={base} onChange={e => setBase(e.target.value)} /></label><label>Incoming snapshot <input value={incoming} onChange={e => setIncoming(e.target.value)} /></label></>}
      {['atoms','snapshots','snapshot-atoms','snapshot-bytes','diff'].includes(op) && <><label>Offset <input type="number" min={0} value={after} onChange={e => setAfter(Number(e.target.value))} /></label><label>Limit <input type="number" min={1} max={op === 'snapshot-bytes' ? 8192 : 100} value={limit} onChange={e => setLimit(Number(e.target.value))} /></label></>}
      <Button onClick={send}>Review and send input</Button>
    </fieldset>
    <Button disabled={busy || !snapshot || !run} onClick={() => job(async () => {
      const assembly = snapshots.current.get(snapshot)
      if (!assembly) throw new Error('No creation metadata and byte pages assembled for this snapshot')
      const atoms = await assembly.finish()
      if (alive.current) setVerified({ id: snapshot, atoms })
    })}>Verify assembled snapshot bytes</Button>
    <Button disabled={busy || !snapshot || !run} onClick={() => job(async () => {
      const assembly = snapshots.current.get(snapshot)
      if (!assembly || !run) throw new Error('Select a snapshot with creation metadata first')
      snapshots.current.set(snapshot, new SnapshotAssembler(assembly.metadata, run)); setVerified(null)
      setNotice('Local assembly reset. Send byte pages from offset 0 explicitly; no input was issued.')
    })}>Reset selected byte assembly</Button>
    {verified && <div role="status"><p>Content hash and run/source/runtime snapshot identity verified for {verified.id}.</p><pre className="whitespace-pre-wrap break-all">{verified.atoms.join('\n')}</pre></div>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <p>{view.ready ? 'Matching ready receipt observed.' : 'No matching resident ready receipt observed.'} Responses below retain input IDs. Read EOF alone does not mean the process has exited.</p>
    <ol aria-label="Symbolic responses" className="space-y-2">{view.events.map((event, i) => <li key={i} className="border border-line rounded p-2">
      <p>{event.op ?? event.event} · {event.id ?? 'session'}{event.atom_count !== undefined ? ` · ${plural(event.atom_count, 'atom')}` : ''}</p>
      {event.reason && <p role="alert">{event.reason}</p>}
      <AtomResult result={event.result} disabled={frozen} select={(id, target) => { setAfter(0); if (target === 'snapshot') { setSnapshot(id); setOp('snapshot-atoms'); setLimit(50) } if (target === 'base') setBase(id); if (target === 'incoming') setIncoming(id) }} />
      <details><summary>Exact response and provenance</summary><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(event, null, 2)}</pre></details>
    </li>)}</ol>
    {view.diagnostics.length > 0 && <p role="alert">Output diagnostics: {view.diagnostics.join('; ')}</p>}
    <details><summary>Raw output tail (12K characters)</summary><pre className="whitespace-pre-wrap break-all text-xs">{view.raw}</pre></details>
  </section>
}

function AtomResult({ result, disabled, select }: { result: unknown; disabled: boolean; select: (id: string, target: 'snapshot' | 'base' | 'incoming') => void }) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result !== undefined ? <pre className="whitespace-pre-wrap">{JSON.stringify(result)}</pre> : null
  const value = result as Record<string, unknown>
  const items = Array.isArray(value.items) ? value.items : Array.isArray(value.atoms) ? value.atoms : typeof value.id === 'string' && value.id.startsWith('atoms_') ? [value] : []
  return <div className="space-y-1">
    {items.length > 0 && <table className="w-full text-left text-xs" aria-label="Atom inspection"><thead><tr><th>Atom or snapshot</th><th>Change / count</th><th>Selection</th></tr></thead><tbody>{items.map((item: unknown, i: number) => {
      const row = item && typeof item === 'object' ? item as Record<string, unknown> : null
      const id = typeof row?.id === 'string' && /^atoms_[a-f0-9]{64}$/.test(row.id) ? row.id : null
      return <tr key={i}><td className="break-all font-mono">{typeof item === 'string' ? item : String(row?.atom ?? row?.label ?? row?.id ?? '')}{id && <small className="block">{id}</small>}</td><td>{String(row?.kind ?? '')} {String(row?.count ?? row?.atom_count ?? '')}</td><td>{id && <><Button disabled={disabled} onClick={() => select(id, 'snapshot')}>Inspect</Button><Button disabled={disabled} onClick={() => select(id, 'base')}>Base</Button><Button disabled={disabled} onClick={() => select(id, 'incoming')}>Incoming</Button></>}</td></tr>
    })}</tbody></table>}
    {typeof value.next === 'number' && <p>Next offset {value.next} · {value.eof ? 'end of page sequence' : 'more available'}{typeof value.total === 'number' ? ` · ${plural(value.total, 'item')}` : ''}</p>}
    {value.encoding === 'base64' && <p>Exact byte page: inspect base64 and digest in the response below; bytes may split a UTF-8 character.</p>}
  </div>
}
