import { useEffect, useRef, useState } from 'react'
import { askConfirm } from '../../ui/confirm'
import { Button } from '../../ui/primitives'
import { decodePages, selectionPayload, type Hunk, type Review, type SourceVersion } from './reviewSelection'

type Call = <T>(method: 'GET' | 'POST', path: string, body?: unknown, query?: Record<string, string>) => Promise<T>
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
interface Git { base_commit: string; observed_source_branch: string | null; source_matches_base: boolean | null }
interface Bytes { data: string; cursor: number; eof: boolean; size_bytes: number; review_id: string; hunk_id: string; side: string }

function HunkBytes({ call, ws, review, hunk, side }: { call: Call; ws: SourceVersion; review: string; hunk: Hunk; side: 'before' | 'after' }) {
  const [pages, setPages] = useState<string[]>([])
  const [page, setPage] = useState<Bytes | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const load = async () => {
    setBusy(true)
    try {
      const after = page?.cursor ?? 0
      const next = await call<Bytes>('GET', `/v1/workspaces/${ws.id}/reviews/${review}/hunks/${hunk.id}`, undefined, { side, after: String(after), limit: '2048' })
      if (!alive.current) return
      if (next.review_id !== review || next.hunk_id !== hunk.id || next.side !== side || next.cursor < after || next.cursor > after + 2048) throw new Error('Unexpected review byte page')
      setPages(p => [...p, next.data]); setPage(next); setError(null)
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <div className="min-w-0 flex-1 rounded border border-line p-2">
    <p className="text-xs text-ink-3">{side === 'before' ? 'Current saved source' : 'Restore target'}</p>
    {pages.length > 0 && <pre className="my-2 max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs">{decodePages(pages)}</pre>}
    {page && <p className="text-xs text-ink-4">{page.cursor} of {page.size_bytes} bytes · {page.eof ? 'complete' : 'partial'}</p>}
    {(!page?.eof && (page?.cursor ?? 0) < 65536) && <Button disabled={busy} onClick={() => void load()}>{busy ? 'Loading…' : pages.length ? 'More bytes' : 'Inspect bytes'}</Button>}
    {page && !page.eof && page.cursor >= 65536 && <p className="text-xs text-ink-3">Display capped at 64 KiB.</p>}
    {error && <p role="alert" className="text-xs text-bad">{error}</p>}
  </div>
}

export function SourceReview({ call, ws, dirty, onRestored }: { call: Call; ws: SourceVersion; dirty: boolean; onRestored: (ws: SourceVersion & { base_commit: string }) => Promise<void> }) {
  const [review, setReview] = useState<Review | null>(null)
  const [selected, setSelected] = useState<string[]>([])
  const [target, setTarget] = useState('base')
  const [checkpoints, setCheckpoints] = useState<{ id: string; label: string }[]>([])
  const [git, setGit] = useState<Git | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    void call<Git>('GET', `/v1/workspaces/${ws.id}/git/context`).then(r => { if (alive.current) setGit(r) }).catch(e => { if (alive.current) setError(errorText(e)) })
    void call<{ checkpoints: { id: string; label: string }[] }>('GET', `/v1/workspaces/${ws.id}/checkpoints`).then(r => { if (alive.current) setCheckpoints(r.checkpoints) }).catch(e => { if (alive.current) setError(errorText(e)) })
    return () => { alive.current = false }
  }, [call, ws.id])
  const create = async () => {
    setBusy(true); setError(null); setReview(null); setSelected([])
    try {
      const r = await call<{ id: string }>('POST', `/v1/workspaces/${ws.id}/reviews`, { expected_generation: ws.generation, expected_tree_digest: ws.tree_digest, target: target === 'base' ? 'base' : 'checkpoint', ...(target === 'base' ? {} : { checkpoint_id: target }) })
      if (!alive.current) return
      const page = await call<Review>('GET', `/v1/workspaces/${ws.id}/reviews/${r.id}`, undefined, { limit: '20' })
      if (alive.current) {
        if (page.workspace_id !== ws.id || page.generation !== ws.generation || page.tree_digest !== ws.tree_digest) throw new Error('Review belongs to a different source version')
        setReview(page)
      }
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const more = async () => {
    if (!review) return
    setBusy(true)
    try {
      const page = await call<Review>('GET', `/v1/workspaces/${ws.id}/reviews/${review.id}`, undefined, { after: String(review.cursor), limit: '20' })
      if (alive.current) {
        if (page.id !== review.id || page.workspace_id !== ws.id || page.tree_digest !== review.tree_digest || page.cursor <= review.cursor) throw new Error('Unexpected review hunk page')
        setReview({ ...page, hunks: [...review.hunks, ...page.hunks] })
      }
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  const apply = async () => {
    if (!review || dirty) return
    setBusy(true); setError(null)
    try {
      const payload = selectionPayload(ws, review, selected, `select-${crypto.randomUUID()}`)
      const paths = [...new Set(review.hunks.filter(h => selected.includes(h.id)).map(h => h.path))]
      if (!(await askConfirm(`Restore ${selected.length} selected hunks in ${paths.join(', ')} on generation ${review.generation}? Unselected changes stay.`, 'Restore selected'))) return
      if (!alive.current) return
      const r = await call<{ workspace: SourceVersion & { base_commit: string } }>('POST', `/v1/workspaces/${ws.id}/reviews/${review.id}/apply`, payload)
      if (alive.current) await onRestored(r.workspace)
    } catch (e) { if (alive.current) setError(errorText(e)) }
    finally { if (alive.current) setBusy(false) }
  }
  return <div className="thin-scroll flex h-full flex-col gap-3 overflow-auto p-3">
    <p className="text-xs text-ink-3">Restore selected saved-source hunks to the pinned base or a checkpoint. Unselected edits stay.</p>
    {git && <p className="break-all font-mono text-xs text-ink-3">Source branch: {git.observed_source_branch ?? 'detached / unavailable'} · pinned base {git.base_commit} · source HEAD {git.source_matches_base === null ? 'unknown' : git.source_matches_base ? 'matches base' : 'has moved'}</p>}
    <div className="flex flex-wrap gap-2"><select aria-label="Restore target" disabled={busy} value={target} onChange={e => { setTarget(e.target.value); setReview(null); setSelected([]) }} className="rounded border border-line bg-surface p-2 text-xs"><option value="base">Pinned base</option>{checkpoints.map(cp => <option key={cp.id} value={cp.id}>{cp.label} · {cp.id}</option>)}</select>
      <Button disabled={busy || dirty} onClick={() => void create()}>Review saved source</Button>
      <Button disabled={busy || dirty || !selected.length || review?.currency !== 'current'} onClick={() => void apply()}>Restore selected ({selected.length})</Button></div>
    {dirty && <p role="status" className="text-xs text-ink-3">Save or discard your editor draft before restoring source.</p>}
    {error && <p role="alert" className="text-xs text-bad">{error}</p>}
    {review && <><p className="break-all font-mono text-xs text-ink-3">{review.id} · generation {review.generation} · {review.currency}</p>
      {!review.hunks.length && <p className="text-xs text-ink-3">Saved source matches this target.</p>}
      {review.hunks.map(h => <div key={h.id} className="rounded border border-line p-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={busy || dirty || review.currency !== 'current'} checked={selected.includes(h.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, h.id] : ids.filter(id => id !== h.id))} />{h.path} · {h.kind === 'file' ? `whole file: ${h.reason} · executable ${String(h.before?.executable ?? false)} → ${String(h.after?.executable ?? false)}` : h.kind === 'mode' ? `executable ${String(h.before?.executable)} → ${String(h.after?.executable)}` : `text at line ${(h.before_start ?? 0) + 1}`}</label>
        <p className="my-1 break-all font-mono text-xs text-ink-4">{h.id}</p>
        {h.kind !== 'mode' && <div className="flex flex-wrap gap-2"><HunkBytes call={call} ws={ws} review={review.id} hunk={h} side="before" /><HunkBytes call={call} ws={ws} review={review.id} hunk={h} side="after" /></div>}</div>)}
      {!review.eof && <Button disabled={busy} onClick={() => void more()}>More hunks</Button>}</>}
  </div>
}
