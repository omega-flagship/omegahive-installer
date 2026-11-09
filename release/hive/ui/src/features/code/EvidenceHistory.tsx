import { useEffect, useState } from 'react'
import { Button, Segmented } from '../../ui/primitives'
import { OutputReader, type OutputPage } from './runOutput'

type Call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) => Promise<T>
interface Evidence { id: string; run_id?: string; generation: number; tree_digest: string; status?: string; outcome?: string; currency?: string; exit_code?: number | null; created_at: number }
interface History { workspace_id: string; generation: number; tree_digest: string; items: Evidence[]; next_cursor: string | null }
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

export function EvidenceHistory({ call, workspace }: { call: Call; workspace: string }) {
  const [kind, setKind] = useState<'runs' | 'verifications'>('runs')
  const [cursor, setCursor] = useState<string | null>(null)
  const [refresh, setRefresh] = useState(0)
  const [page, setPage] = useState<History | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    void call<History>('GET', `/v1/workspaces/${workspace}/${kind}`, undefined, { limit: '10', ...(cursor ? { cursor } : {}) })
      .then((result) => { if (!cancelled) { if (result.workspace_id !== workspace) throw new Error('History belongs to another workspace'); setPage(result); setError(null) } })
      .catch((e) => { if (!cancelled) setError(errorText(e)) })
    return () => { cancelled = true }
  }, [call, workspace, kind, cursor, refresh])
  return <div className="flex h-full min-h-0 flex-col gap-3 overflow-auto p-3">
    <div className="flex flex-wrap gap-2">
      <Segmented value={kind} onChange={(value) => { setKind(value); setCursor(null); setSelected(null); setPage(null); setError(null) }} label="Evidence history" options={[{ value: 'runs', label: 'Runs' }, { value: 'verifications', label: 'Verifications' }]} />
      <Button onClick={() => { setCursor(null); setRefresh((n) => n + 1); setPage(null); setError(null) }}>Refresh latest</Button>
    </div>
    <p className="text-xs text-ink-3">Recorded evidence on this workspace. A past result does not establish a process is still running.</p>
    {error && <p role="alert" className="text-xs text-bad">Could not load history: {error}</p>}
    {!page && !error && <p className="text-xs text-ink-3">Loading history…</p>}
    {page && <>
      <p className="break-all font-mono text-xs text-ink-3">Observed generation {page.generation} · tree {page.tree_digest}</p>
      {!page.items.length && <p className="text-xs text-ink-3">No recorded {kind}.</p>}
      <div className="space-y-2">{page.items.map((record) => <button key={record.id} disabled={kind === 'verifications' && !record.run_id} aria-pressed={selected === (record.run_id ?? record.id)} onClick={() => setSelected(record.run_id ?? record.id)} className="block w-full rounded-xl border border-line p-3 text-left hover:bg-tint/5">
        <span className="block break-all font-mono text-xs">{record.id}</span>
        <span className="text-xs text-ink-3">{record.outcome ?? record.status} · generation {record.generation} · {record.currency ?? 'currency unknown'}{record.exit_code != null ? ` · exit ${record.exit_code}` : ''}</span>
        {record.run_id && <span className="block break-all font-mono text-xs text-ink-3">Run {record.run_id}</span>}
      </button>)}</div>
      {page.next_cursor && <Button onClick={() => { setCursor(page.next_cursor); setPage(null); setError(null) }}>Older evidence</Button>}
    </>}
    {selected && <RunOutput key={selected} call={call} workspace={workspace} run={selected} />}
  </div>
}

export function RunOutput({ call, workspace, run }: { call: Call; workspace: string; run: string }) {
  const [text, setText] = useState('')
  const [last, setLast] = useState<OutputPage | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let reader = new OutputReader(run, workspace)
    const step = async () => {
      try {
        const page = await call<OutputPage>('GET', `/v1/runs/${run}/output`, undefined, { after: String(reader.cursor), limit: '16384' })
        if (cancelled) return
        const next = reader.append(page)
        if (next === 'replay') { reader = new OutputReader(run, workspace); setText(''); setLast(null) }
        else { setText(reader.text); setLast(page); setError(null) }
        if (next !== 'done') timer = setTimeout(() => void step(), next === 'wait' ? 1200 : 0)
      } catch (e) { if (!cancelled) setError(errorText(e)) }
    }
    void step()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [call, workspace, run, retry])
  return <section className="flex min-h-64 flex-col rounded-xl border border-line" aria-label="Run output">
    <div className="space-y-1 border-b border-line p-3 text-xs text-ink-3">
      <p className="break-all font-mono">Run {run}</p>
      {last && <p>{last.status} · {last.source} · {last.cursor}/{last.size_bytes} bytes · {last.complete ? 'Output complete; descendants stopped' : last.truncated && last.cursor === last.readable_bytes ? 'Output display limit reached' : last.eof ? 'At current EOF; completion unconfirmed' : 'Reading output…'}</p>}
      {last?.output_digest && <p className="break-all font-mono">Artifact {last.output_digest}</p>}
      <p>UTF-8 display; binary bytes may appear as replacement characters.</p>
      <Button onClick={() => { setRetry((n) => n + 1); setText(''); setLast(null); setError(null) }}>Reload output</Button>
    </div>
    {error && <p role="alert" className="p-3 text-xs text-bad">Could not load output: {error}</p>}
    <pre className="thin-scroll max-h-96 min-h-32 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs text-ink-2">{text}</pre>
  </section>
}
