import { plural } from '../../lib/plural'
import { useEffect, useRef, useState } from 'react'
import { askConfirm } from '../../ui/confirm'
import { Button } from '../../ui/primitives'
import { decodePages } from './reviewSelection'
import { canApplyMerge, resolutionPayload, type MergeChoice, type MergeDraft, type MergeFile } from './mergeResolution'
import { useUnsaved } from '../ask/dirty'
import { markSaved } from '../../shell/unsavedWork'

type Call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) => Promise<T>
interface Source { id: string; generation: number; tree_digest: string }
interface Preview extends Source { workspace_id: string; file_count: number; conflict_count: number; files_digest: string; kind: string; currency?: string; files?: MergeFile[]; cursor?: number; eof?: boolean }
interface Content { preview_id: string; path: string; side: Side; generation: number; tree_digest: string; data: string; cursor: number; eof: boolean; size_bytes: number }
type Side = 'base' | 'ours' | 'incoming' | 'merged'
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
const emptyDraft = (): MergeDraft => ({ choice: '', format: 'text', content: '', executable: false })

export function MergePanel<W extends Source>({ call, ws, dirty, onApplied }: { call: Call; ws: W; dirty: boolean; onApplied: (current: W) => Promise<void> }) {
  const [checkpoints, setCheckpoints] = useState<{ id: string; label: string; generation: number }[]>([])
  const [base, setBase] = useState('')
  const [incoming, setIncoming] = useState('')
  const [id, setId] = useState('')
  const [preview, setPreview] = useState<Preview | null>(null)
  const [files, setFiles] = useState<MergeFile[]>([])
  const [cursor, setCursor] = useState(0)
  const [eof, setEof] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, MergeDraft>>({})
  const [view, setView] = useState<{ path: string; side: Side; pages: string[]; page: Content | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)
  // reviewed resolutions live only here until the merge is applied: a reload or a proposed move must not drop them
  // (stand-in r5 P1). A cancelled or failed Apply keeps them; only a successful Apply releases them.
  useUnsaved(Object.values(drafts).some((d) => !!d.choice || !!d.content))
  const alive = useRef(true)
  const epoch = useRef(0)
  const operation = useRef<{ key: string; id: string } | null>(null)
  const currentSource = useRef({ ws, dirty })
  useEffect(() => { currentSource.current = { ws, dirty } }, [ws, dirty])
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const live = (stamp: number) => alive.current && epoch.current === stamp
  const accept = (r: Preview) => {
    if (r.workspace_id !== ws.id || r.kind !== 'manifest-three-way') throw new Error('Unexpected merge receipt')
    setPreview(r); setId(r.id); setFiles(r.files ?? []); setCursor(r.cursor ?? 0); setEof(r.eof ?? false)
    setDrafts({}); setView(null); setResult(null)
  }
  const loadCheckpoints = async () => {
    const stamp = ++epoch.current; setBusy(true); setError(null)
    try {
      const response = await call<{ checkpoints: { id: string; label: string; generation: number }[] }>('GET', `/v1/workspaces/${ws.id}/checkpoints`)
      if (live(stamp)) setCheckpoints(response.checkpoints)
    } catch (e) { if (live(stamp)) setError(errorText(e)) }
    finally { if (live(stamp)) setBusy(false) }
  }
  const prepare = async (existing = false) => {
    const stamp = ++epoch.current; setBusy(true); setError(null)
    try {
      if (Object.values(drafts).some(d => d.choice || d.content) && !(await askConfirm('Replace this preview and its manual resolution drafts?', 'Replace merge preview'))) return
      if (!live(stamp)) return
      const expected = { generation: ws.generation, tree_digest: ws.tree_digest }
      const response = existing
        ? await call<Preview>('GET', `/v1/workspaces/${ws.id}/merges/${encodeURIComponent(id)}`, undefined, { limit: '20' })
        : await call<Preview>('POST', `/v1/workspaces/${ws.id}/merges`, { expected_generation: expected.generation, expected_tree_digest: expected.tree_digest, base_checkpoint_id: base, incoming_checkpoint_id: incoming })
      if (live(stamp)) {
        if (!existing && (response.generation !== expected.generation || response.tree_digest !== expected.tree_digest)) throw new Error('Merge belongs to another source version')
        if (!existing && (currentSource.current.ws.generation !== expected.generation || currentSource.current.ws.tree_digest !== expected.tree_digest)) return
        accept(response)
      }
    } catch (e) { if (live(stamp)) setError(errorText(e)) }
    finally { if (live(stamp)) setBusy(false) }
  }
  const moreFiles = async () => {
    if (!preview) return
    const stamp = ++epoch.current; setBusy(true); setError(null)
    try {
      const next = await call<Preview>('GET', `/v1/workspaces/${ws.id}/merges/${preview.id}`, undefined, { after: String(cursor), limit: '20' })
      if (live(stamp)) {
        if (next.id !== preview.id || next.files_digest !== preview.files_digest || next.cursor !== cursor + (next.files?.length ?? 0)) throw new Error('Unexpected merge file page')
        const combined = [...files, ...(next.files ?? [])]
        if (new Set(combined.map(f => f.path)).size !== combined.length || combined.length > preview.file_count) throw new Error('Duplicate or excessive merge files')
        setFiles(combined); setCursor(next.cursor); setEof(next.eof ?? false)
      }
    } catch (e) { if (live(stamp)) setError(errorText(e)) }
    finally { if (live(stamp)) setBusy(false) }
  }
  const bytes = async (path: string, side: Side, continuation = false) => {
    if (!preview) return
    const stamp = ++epoch.current; setBusy(true); setError(null)
    const after = continuation ? view?.page?.cursor ?? 0 : 0
    try {
      const next = await call<Content>('GET', `/v1/workspaces/${ws.id}/merges/${preview.id}/content`, undefined, { path, side, after: String(after), limit: '4096' })
      if (live(stamp)) {
        if (next.preview_id !== preview.id || next.path !== path || next.side !== side || next.generation !== preview.generation || next.tree_digest !== preview.tree_digest || next.cursor !== after + atob(next.data).length) throw new Error('Unexpected source byte page')
        setView({ path, side, page: next, pages: [...(continuation ? view?.pages ?? [] : []), next.data] })
      }
    } catch (e) { if (live(stamp)) setError(errorText(e)) }
    finally { if (live(stamp)) setBusy(false) }
  }
  const apply = async () => {
    if (!preview || !canApplyMerge(ws, preview, files, eof, dirty, drafts)) return
    const stamp = ++epoch.current; setBusy(true); setError(null)
    try {
      const resolutions = resolutionPayload(files, drafts)
      if (!(await askConfirm(`Apply the reviewed merge to saved generation ${preview.generation}, resolving ${plural(preview.conflict_count, 'file')}?`, 'Apply merge'))) return
      if (!live(stamp) || !canApplyMerge(currentSource.current.ws, preview, files, eof, currentSource.current.dirty, drafts)) return
      const key = JSON.stringify([ws.id, preview.id, preview.generation, preview.tree_digest, resolutions])
      if (operation.current?.key !== key) operation.current = { key, id: `merge-${crypto.randomUUID()}` }
      const response = await call<{ workspace: W; change: { id: string } | null; no_change: boolean; preview_id: string }>('POST', `/v1/workspaces/${ws.id}/merges/${preview.id}/apply`, { operation_id: operation.current.id, preview_id: preview.id, expected_generation: preview.generation, expected_tree_digest: preview.tree_digest, resolutions })
      if (live(stamp)) {
        if (response.preview_id !== preview.id || response.workspace.id !== ws.id) throw new Error('Unexpected applied merge identity')
        setDrafts({}); markSaved('merge-resolution'); setResult(response.no_change ? 'Choices preserve the current source; no new generation.' : `Applied ${response.change?.id} · generation ${response.workspace.generation}`)
        if (response.workspace.generation >= currentSource.current.ws.generation) await onApplied(response.workspace)
      }
    } catch (e) { if (live(stamp)) setError(errorText(e)) }
    finally { if (live(stamp)) setBusy(false) }
  }
  const update = (path: string, values: Partial<MergeDraft>) => {
    const file = files.find(f => f.path === path)
    const initial = { ...emptyDraft(), executable: file?.ours?.executable ?? file?.incoming?.executable ?? file?.base?.executable ?? false }
    setDrafts(old => ({ ...old, [path]: { ...(old[path] ?? initial), ...values } }))
  }
  const stale = !!preview && (preview.generation !== ws.generation || preview.tree_digest !== ws.tree_digest)
  return <div className="thin-scroll flex h-full flex-col gap-3 overflow-auto p-3" data-unsaved-scope="merge-resolution">
    <p className="text-sm">Merge saved source snapshots</p>
    <p className="text-xs text-ink-3">Choose a shared base and incoming checkpoint. Clean changes combine; conflicts require explicit whole-file choices. Original Git branches and history remain separate.</p>
    <Button disabled={busy} onClick={() => void loadCheckpoints()}>Load checkpoints</Button>
    {(['base', 'incoming'] as const).map(which => <label key={which} className="text-xs">{which === 'base' ? 'Base checkpoint' : 'Incoming checkpoint'}<select className="mt-1 block w-full rounded border border-line bg-surface p-2" value={which === 'base' ? base : incoming} disabled={busy} onChange={e => which === 'base' ? setBase(e.target.value) : setIncoming(e.target.value)}><option value="">Choose checkpoint</option>{checkpoints.map(cp => <option key={cp.id} value={cp.id}>{cp.label} · g{cp.generation} · {cp.id}</option>)}</select></label>)}
    <Button disabled={busy || dirty || !base || !incoming} onClick={() => void prepare()}>Prepare merge preview</Button>
    <div className="flex gap-2"><input aria-label="Existing merge preview ID" className="min-w-0 flex-1 rounded border border-line bg-surface p-2 font-mono text-xs" value={id} disabled={busy} onChange={e => setId(e.target.value)} placeholder="merge_id" /><Button disabled={busy || !id} onClick={() => void prepare(true)}>Inspect preview</Button></div>
    {dirty && <p role="status" className="text-xs text-ink-3">Save or discard your editor draft before preparing or applying saved-source changes.</p>}
    {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    {result && <p role="status" className="text-xs">{result}</p>}
    {preview && <><p className="break-all font-mono text-xs text-ink-3">{preview.id} · generation {preview.generation} · {plural(preview.conflict_count, 'conflict')} · {stale ? 'stale, resolution drafts retained' : 'reviewed saved source'}<br />Tree {preview.tree_digest}</p>
      {files.map(file => <div key={file.path} className="space-y-2 rounded border border-line p-2 text-xs">
        <p className="break-all font-mono">{file.path} · {file.conflict ? `conflict: ${file.reason}` : 'clean merged change'}</p>
        <div className="flex flex-wrap gap-2">{(['base', 'ours', 'incoming', 'merged'] as Side[]).map(side => <Button key={side} disabled={busy} onClick={() => void bytes(file.path, side)}>{side} {file[side] ? `(${file[side]!.size} bytes${file[side]!.executable ? ', executable' : ''})` : '(absent)'}</Button>)}</div>
        {file.conflict && <><label className="block">Resolution<select className="ml-2 rounded border border-line bg-surface p-1" aria-label={`Resolution for ${file.path}`} disabled={busy} value={drafts[file.path]?.choice ?? ''} onChange={e => update(file.path, { choice: e.target.value as MergeChoice | '' })}><option value="">Choose explicitly</option>{(['ours', 'incoming', 'base', 'delete', 'manual'] as const).map(c => <option key={c} value={c}>{c}</option>)}</select></label>
          {drafts[file.path]?.choice === 'manual' && <><label className="block">Manual source format<select className="ml-2 rounded border border-line bg-surface p-1" value={drafts[file.path].format} disabled={busy} onChange={e => update(file.path, { format: e.target.value as 'text' | 'base64' })}><option value="text">UTF-8 text</option><option value="base64">Exact binary base64</option></select></label><textarea aria-label={`Manual resolution for ${file.path}`} className="block min-h-32 w-full rounded border border-line bg-surface p-2 font-mono" disabled={busy} maxLength={2796204} value={drafts[file.path].content} onChange={e => update(file.path, { content: e.target.value })} /><label className="flex gap-2"><input type="checkbox" disabled={busy} checked={drafts[file.path].executable} onChange={e => update(file.path, { executable: e.target.checked })} />Executable file</label></>}
        </>}
      </div>)}
      {!eof && <Button disabled={busy} onClick={() => void moreFiles()}>Load more files ({files.length}/{preview.file_count})</Button>}
      {view && <div className="space-y-2 rounded border border-line p-2"><p className="break-all font-mono text-xs">{view.path} · {view.side} · {view.page?.cursor}/{view.page?.size_bytes} bytes · {view.page?.eof ? 'complete' : 'partial'}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{decodePages(view.pages)}</pre><details className="text-xs"><summary>Exact base64 byte pages</summary>{view.pages.map((data, i) => <pre key={i} className="whitespace-pre-wrap break-all">{data}</pre>)}</details>{!view.page?.eof && (view.page?.cursor ?? 0) < 65536 && <Button disabled={busy} onClick={() => void bytes(view.path, view.side, true)}>More source bytes</Button>}<p className="text-xs text-ink-3">Text display is decoded; exact bytes are in the base64 pages. Display is capped at64KiB. Conflicting merged text may contain markers and is a suggestion for manual review.</p></div>}
      <Button disabled={busy || !canApplyMerge(ws, preview, files, eof, dirty, drafts)} onClick={() => void apply()}>Apply reviewed merge</Button>
      {!eof && <p className="text-xs text-ink-3">Inspect all file records before applying.</p>}
    </>}
  </div>
}
