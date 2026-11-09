import { useEffect, useMemo, useRef, useState } from 'react'
import { evidenceSubjectKey, ProjectTestEvidenceReader, type EvidenceCall, type EvidenceState, type EvidenceSubject } from './projectTestEvidence'

/** Read-only: call must carry the person's existing current normal read scope.
 * No Test/Ask/dispatch, generic Run or grant API is accepted by this component.
 */
export function ProjectTestEvidencePanel({ call, subject }: { call: EvidenceCall | null; subject: EvidenceSubject }) {
  const key = evidenceSubjectKey(subject)
  const owner = useMemo(() => ({ call, key }), [call, key])
  const [state, setState] = useState<{ owner: object; value: EvidenceState } | null>(null)
  const reader = useRef<{ owner: object; value: ProjectTestEvidenceReader } | null>(null)
  useEffect(() => {
    if (!call) return
    const value = new ProjectTestEvidenceReader(call, subject, next => setState({ owner, value: next }))
    reader.current = { owner, value }
    void value.load()
    return () => { value.dispose(); if (reader.current?.owner === owner) reader.current = null }
    // Exact subject primitives are captured by key; a fresh call also revokes this owner.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, key, owner])
  const current = state?.owner === owner ? state.value : null
  const pending = !!call && (!current || current.pending)
  const load = (cursor = '0') => { if (reader.current?.owner === owner) void reader.current.value.load(cursor) }
  return <section aria-label="Project test evidence" className="flex flex-col gap-3 rounded-xl border border-line p-3">
    <div className="flex items-center justify-between gap-2">
      <h3 className="text-[13px] font-medium text-ink">Project test evidence</h3>
      <button type="button" className="rounded-lg border border-line px-2 py-1 text-xs text-ink-2 disabled:opacity-50" disabled={!call || pending} onClick={() => load()}>Refresh evidence</button>
    </div>
    <p className="text-xs text-ink-3">Read-only retained sandbox observations. Testing never accepts the proposal.</p>
    {!call && <p className="text-xs text-ink-3">A current scoped evidence reader is unavailable.</p>}
    {pending && <p role="status" className="text-xs text-ink-3">Reading and verifying evidence…</p>}
    {current?.error && <p role="alert" className="text-xs text-bad">{current.error}</p>}
    {current?.page?.results.length === 0 && <p className="text-xs text-ink-3">No retained test evidence for this proposal.</p>}
    {current?.page?.results.map(row => <article key={row.test_id + ':' + row.launch_key} className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <p className="text-[13px] text-ink">{row.tested ? 'Tested on the current proposal and runtime' : row.currency === 'stale' ? 'Historical evidence · current proposal not tested' : row.currency === 'unknown' || row.outcome === 'unknown' ? 'Current test status unknown' : 'Current evidence · not marked tested'}</p>
      <p className="text-xs text-ink-3">Source: {row.source_currency} · execution: {row.execution_currency} · original command: {row.outcome}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 text-[11px] text-ink-3">
        <dt>Test</dt><dd className="break-all font-mono">{row.test_id}</dd>
        <dt>Launch</dt><dd className="break-all font-mono">{row.launch_key}</dd>
        <dt>Receipt</dt><dd className="break-all font-mono">{row.receipt_digest ?? 'No terminal receipt retained'}</dd>
      </dl>
      {row.logs.map(log => <details key={log.name} className="text-xs text-ink-2">
        <summary>{log.name} · {log.bytes} retained bytes · digest verified{log.complete ? '' : ' · incomplete capture'}{log.preview_truncated ? ' · first 32768 bytes shown' : ''}</summary>
        <pre className="thin-scroll mt-2 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-shade/25 p-2 font-mono text-[11px]">{log.text || '(empty capture)'}</pre>
        <p className="break-all font-mono text-[10px] text-ink-4">{log.digest}</p>
      </details>)}
    </article>)}
    {current?.page?.next_cursor && <button type="button" disabled={pending} className="self-start rounded-lg border border-line px-2 py-1 text-xs text-ink-2 disabled:opacity-50" onClick={() => load(current.page!.next_cursor!)}>Next four records</button>}
  </section>
}
