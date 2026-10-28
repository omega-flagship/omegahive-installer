import { useEffect, useRef, useState } from 'react'
import { askConfirm } from '../../ui/confirm'
import { Button } from '../../ui/primitives'
import { useUnsaved } from '../ask/dirty'
import { decodePages } from './reviewSelection'
import { gitExportBody, verifyGitHistory, type HistoryMode } from './gitHistory'

type Call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) => Promise<T>
interface Source { id: string; generation: number; tree_digest: string }
interface Export { id: string; workspace_id: string; generation: number; tree_digest: string; source_base_commit: string; baseline_commit: string; commit: string; branch_ref: string; patch_digest: string; patch_bytes: number; bundle_digest: string; bundle_bytes: number; history_kind: string; original_history_included: boolean; published: boolean; currency?: string }
interface Patch { export_id: string; digest: string; data: string; cursor: number; eof: boolean; size_bytes: number }
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)

export function GitExportPanel({ call, ws, dirty }: { call: Call; ws: Source; dirty: boolean }) {
  const [branch, setBranch] = useState('review/candidate')
  const [message, setMessage] = useState('Review candidate source')
  const [mode, setMode] = useState<HistoryMode>('snapshot')
  const [pending, setPending] = useState<{ body: ReturnType<typeof gitExportBody>; mode: HistoryMode } | null>(null)
  // an export request retained after an uncertain answer, kept exact for its retry: a reload would lose it
  useUnsaved(!!pending)
  const [exportId, setExportId] = useState('')
  const [record, setRecord] = useState<Export | null>(null)
  const [pages, setPages] = useState<string[]>([])
  const [page, setPage] = useState<Patch | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const current = useRef({ ws, dirty })
  useEffect(() => { current.current = { ws, dirty } }, [ws, dirty])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const accept = (r: Export) => {
    verifyGitHistory(r, ws.id)
    setRecord(r); setExportId(r.id); setPages([]); setPage(null)
  }
  const create = async (retry = false) => {
    if (dirty && !retry) return
    setBusy(true); setError(null)
    try {
      const source = { ...current.current.ws }
      const request = retry && pending ? pending : { body: gitExportBody(source, branch, message, mode, `git-export-${crypto.randomUUID()}`), mode }
      if (!(await askConfirm(`Create or retry local ${request.mode} review export from saved generation ${request.body.expected_generation}? Original mode includes its validated parent ancestry and requires operator opt-in.\n${JSON.stringify(request.body)}`, retry ? 'Retry exact export' : 'Create review export'))) return
      if (!alive.current) return
      if (!retry && (current.current.dirty || current.current.ws.tree_digest !== source.tree_digest || current.current.ws.generation !== source.generation)) throw new Error('Source changed during confirmation; review it again')
      setPending(request)
      const r = await call<Export>('POST', `/v1/workspaces/${ws.id}/git/exports`, request.body)
      if (alive.current) {
        if (r.generation !== request.body.expected_generation || r.tree_digest !== request.body.expected_tree_digest) throw new Error('Export belongs to another source version')
        verifyGitHistory(r, ws.id, request.mode)
        accept(r); setPending(null)
      }
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const inspect = async () => {
    setBusy(true); setError(null)
    try {
      const r = await call<Export>('GET', `/v1/workspaces/${ws.id}/git/exports/${encodeURIComponent(exportId)}`)
      if (alive.current) accept(r)
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const more = async () => {
    if (!record) return
    setBusy(true)
    try {
      const after = page?.cursor ?? 0
      const next = await call<Patch>('GET', `/v1/workspaces/${ws.id}/git/exports/${record.id}/patch`, undefined, { after: String(after), limit: '4096' })
      if (alive.current) {
        if (next.export_id !== record.id || next.digest !== record.patch_digest || next.cursor < after || next.cursor > after + 4096) throw new Error('Unexpected patch byte page')
        setPages(p => [...p, next.data]); setPage(next); setError(null)
      }
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const download = async (kind: 'bundle' | 'patch') => {
    if (!record) return
    setBusy(true); setError(null)
    try {
      const digest = kind === 'bundle' ? record.bundle_digest : record.patch_digest
      const expected = kind === 'bundle' ? record.bundle_bytes : record.patch_bytes
      const r = await call<{ digest: string; size_bytes: number; content_base64: string }>('GET', `/v1/artifacts/${digest}`, undefined, { workspace_id: ws.id })
      if (!alive.current) return
      if (r.digest !== digest || r.size_bytes !== expected) throw new Error('Export artifact identity or size differs')
      const bytes = Uint8Array.from(atob(r.content_base64), c => c.charCodeAt(0))
      if (bytes.length !== expected) throw new Error('Export download is incomplete')
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('')
      if (!alive.current) return
      if (hash !== digest) throw new Error('Export download digest differs')
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
      const a = document.createElement('a'); a.href = url; a.download = `${record.id}.${kind}`; a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <div className="thin-scroll flex h-full flex-col gap-3 overflow-auto p-3">
    <p className="text-sm">Export saved source for local Git review</p>
    <p className="text-xs text-ink-3">Snapshot mode reconstructs its baseline. Original mode includes validated bounded Git ancestry and makes the candidate a child of the actual pinned commit; operator repository opt-in is required. Exporting does not publish, apply or edit the original checkout.</p>
    <label className="text-xs">History mode<select value={mode} disabled={busy || pending !== null} onChange={e => setMode(e.target.value as HistoryMode)}><option value="snapshot">Reconstructed snapshot</option><option value="original">Original parent ancestry (operator enabled)</option></select></label>
    <label className="text-xs">Review branch<input className="mt-1 block w-full rounded border border-line bg-surface p-2 font-mono" value={branch} maxLength={120} disabled={busy || pending !== null} onChange={e => setBranch(e.target.value)} /></label>
    <label className="text-xs">Commit message<textarea className="mt-1 block w-full rounded border border-line bg-surface p-2" value={message} maxLength={4000} disabled={busy || pending !== null} onChange={e => setMessage(e.target.value)} /></label>
    <Button disabled={busy || pending !== null || dirty || !branch || !message} onClick={() => void create()}>Create review export</Button>
    {pending && <div role="alert"><p>Exact {pending.mode} export request retained after an uncertain response. Source and mode remain fixed for retry.</p><Button disabled={busy} onClick={() => void create(true)}>Retry exact export</Button><Button disabled={busy} onClick={async () => { if (await askConfirm('Forget only this local retry record? A server artifact may already exist. Retrying first can recover its ID.', 'Forget local retry')) setPending(null) }}>Forget local retry</Button></div>}
    {dirty && <p role="status" className="text-xs text-ink-3">Save or discard your editor draft before exporting saved source.</p>}
    <div className="flex flex-wrap gap-2"><input aria-label="Existing export ID" placeholder="gx_id" className="min-w-0 flex-1 rounded border border-line bg-surface p-2 font-mono text-xs" value={exportId} disabled={busy} onChange={e => setExportId(e.target.value)} /><Button disabled={busy || !exportId} onClick={() => void inspect()}>Inspect existing export</Button></div>
    {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    {record && <><div className="space-y-1 break-all rounded border border-line p-3 font-mono text-xs text-ink-3"><p>{record.id} · generation {record.generation} · {record.tree_digest !== ws.tree_digest ? 'historical source' : record.currency ?? 'exported saved source'}</p><p>History {record.history_kind}</p><p>Branch {record.branch_ref}</p><p>Candidate commit {record.commit}</p><p>{record.original_history_included ? 'Actual parent' : 'Reconstructed baseline'} {record.baseline_commit}</p><p>Original pinned source {record.source_base_commit}</p><p>Source tree {record.tree_digest}</p></div>
      <div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void download('bundle')}>Download Git bundle ({record.bundle_bytes} bytes)</Button><Button disabled={busy} onClick={() => void download('patch')}>Download patch ({record.patch_bytes} bytes)</Button>
        {!page?.eof && (page?.cursor ?? 0) < 65536 && <Button disabled={busy} onClick={() => void more()}>{pages.length ? 'More patch bytes' : 'Inspect patch'}</Button>}</div>
      {page && <p className="text-xs text-ink-3">Showing {page.cursor} of {page.size_bytes} patch bytes · {page.eof ? 'complete' : 'partial'}{page.cursor >= 65536 && !page.eof ? ' · display capped at 64 KiB' : ''}</p>}
      {pages.length > 0 && <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{decodePages(pages)}</pre>}
      <p className="text-xs text-ink-3">Inspect and verify the bundle in a disposable repository. Checkout attributes may affect working-file encoding; committed blobs preserve the saved bytes. Applying the patch to another checkout is a separate action.</p></>}
  </div>
}
