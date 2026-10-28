import { createPortal } from 'react-dom'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { askMemory, KIND_TITLES, type MemoryReviewSnapshot } from '../../lib/askMemory/store'
import type { MemoryCommitGuard } from '../../lib/askMemory/backend'
import { memoryThemeStyle, resolveMemoryTheme, type MemoryThemes } from '../../lib/memoryTheme'
import { useReducedMotion, useEscape } from '../../lib/hooks'
import { useModalContainment } from '../../ui/useModalContainment'

export interface AppMemoryOpening {
  readonly id: string
  readonly appName: string
  readonly topic: string
  readonly theme?: string
  readonly themes: MemoryThemes
  readonly snapshot: MemoryReviewSnapshot
  readonly guard: MemoryCommitGuard
}
/** Host lifecycle identity is independent of the frame's reusable correlation id. */
export interface AppMemoryHostState { readonly hostKey: string; readonly opening: AppMemoryOpening }
export function AppMemoryHost({ state, mode, onClose }: { state: AppMemoryHostState | null; mode: 'light' | 'dark'; onClose: () => void }) {
  return state ? <AppMemory key={state.hostKey} opening={state.opening} mode={mode} onClose={onClose} /> : null
}
type Card = { kind: 'fix' | 'forget'; snapshot: MemoryReviewSnapshot; id: string; words: string; current: string; changed: boolean; armAt: number }
  | { kind: 'export'; snapshot: MemoryReviewSnapshot }

/** Host portal only. Neither this DOM, any text, a download URL nor a mutation result enters the app frame. */
export function AppMemory({ opening, mode, onClose }: { opening: AppMemoryOpening; mode: 'light' | 'dark'; onClose: () => void }) {
  const id = useId(), box = useRef<HTMLDivElement>(null), head = useRef<HTMLHeadingElement>(null)
  const reducedMotion = useReducedMotion()
  const theme = useMemo(() => resolveMemoryTheme(opening.themes, { theme: opening.theme, mode, reducedMotion }), [opening, mode, reducedMotion])
  const [snapshot, setSnapshot] = useState(opening.snapshot)
  const [query, setQuery] = useState(''), [editing, setEditing] = useState<string | null>(null), [words, setWords] = useState('')
  const [card, setCard] = useState<Card | null>(null), [busy, setBusy] = useState(false), [status, setStatus] = useState('')
  const [clock, setClock] = useState(() => performance.now())
  const urls = useRef(new Set<string>())
  const latestClose = useRef(onClose)
  latestClose.current = onClose
  const current = () => !opening.guard.signal.aborted && opening.guard.current()
  useEscape(onClose)
  useModalContainment(box)
  useEffect(() => { head.current?.focus() }, [])
  useEffect(() => {
    const close = () => {
      if (box.current) { box.current.hidden = true; box.current.style.display = 'none' }
      for (const url of urls.current) URL.revokeObjectURL(url)
      urls.current.clear(); latestClose.current()
    }
    opening.guard.signal.addEventListener('abort', close, { once: true })
    return () => { opening.guard.signal.removeEventListener('abort', close); for (const url of urls.current) URL.revokeObjectURL(url); urls.current.clear() }
  }, [opening])
  useEffect(() => {
    if (card?.kind !== 'forget') return
    const timer = window.setInterval(() => setClock(performance.now()), 100)
    return () => window.clearInterval(timer)
  }, [card])
  const refresh = async () => {
    const latest = await askMemory.openReview(opening.guard)
    if (current() && latest) setSnapshot(latest)
    return latest
  }
  const prepare = async (kind: 'fix' | 'forget', beliefId: string, proposed: string) => {
    if (busy || !current()) return
    setBusy(true)
    const latest = await askMemory.openReview(opening.guard)
    if (!current()) return
    setBusy(false)
    const old = latest?.beliefs.find((b) => b.id === beliefId)
    if (!latest || !old) { setStatus('This memory is no longer available.'); return }
    setCard({ kind, snapshot: latest, id: beliefId, words: proposed, current: old.statement,
      changed: opening.snapshot.token.base(beliefId) !== latest.token.base(beliefId)
        || opening.snapshot.beliefs.find((b) => b.id === beliefId)?.statement !== old.statement,
      armAt: performance.now() + (kind === 'forget' ? 2000 : 0) })
  }
  const confirm = async () => {
    if (!card || busy || !current() || card.kind === 'forget' && performance.now() < card.armAt) return
    const shown = card
    setBusy(true)
    if (shown.kind === 'export') {
      const exported = await askMemory.exportReview(shown.snapshot, opening.guard)
      if (!current()) return
      setBusy(false); setCard(null)
      if (!exported) { setStatus('Memory could not be exported.'); return }
      const url = URL.createObjectURL(new Blob([exported.text], { type: 'application/json' }))
      urls.current.add(url)
      // The only download is an explicit host click, after the same document/person fence was checked above.
      const link = document.createElement('a'); link.href = url; link.download = 'Your-memory.json'; link.click()
      // Keep it valid for the browser's download handoff; abort/unmount cleanup owns every registered URL.
      setStatus('Your memory was exported on this device.')
      return
    }
    const result = shown.kind === 'fix'
      ? await askMemory.fixReview(shown.snapshot, shown.id, shown.words, opening.guard)
      : await askMemory.forgetReview(shown.snapshot, shown.id, opening.guard)
    if (!current()) return
    setBusy(false)
    if (result.kind === 'stale') {
      const latest = result.snapshot, old = latest?.beliefs.find((b) => b.id === shown.id)
      if (latest && old) setCard({ ...shown, snapshot: latest, current: old.statement, changed: true, armAt: performance.now() + (shown.kind === 'forget' ? 2000 : 0) })
      else { setCard(null); setStatus('This memory is no longer available.') }
      return
    }
    if (result.kind === 'refused') { setStatus(result.reason === 'same' ? 'Those words are already kept.' : 'The change could not be saved.'); return }
    setCard(null); setEditing(null); setWords(''); setStatus(shown.kind === 'fix' ? 'Memory fixed.' : 'Memory forgotten.')
    await refresh()
  }
  const visible = snapshot.beliefs.filter((b) => !query.trim() || `${b.statement} ${KIND_TITLES[b.kind]}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    .slice().sort((a, b) => b.updated_at - a.updated_at || a.id.localeCompare(b.id))
  const buttonStyle = { backgroundColor: theme.accent, color: theme.accentText, borderRadius: `${theme.radius}px` }
  if (!current()) return null
  return createPortal(
    <div className="xc-scrim fixed inset-0 z-[80] flex items-stretch justify-center p-2 md:p-6">
      <div ref={box} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} data-app-memory-host="" className="xc-window flex w-full max-w-[920px] flex-col overflow-hidden">
        {/* Identity and confirms are siblings of the themed body, always in host styling. */}
        <header data-memory-host-identity="" className="xc-divider flex items-start gap-3 border-b px-5 py-4">
          <div className="flex-1"><h2 ref={head} tabIndex={-1} id={`${id}-title`} className="xc-heading text-[18px] outline-none">Your memory · kept safe in your hive</h2><p className="xc-ink-3 text-[11px]">OmegaHive</p></div>
          <button type="button" className="xc-button xc-subtle" onClick={onClose}>Close</button>
        </header>
        <section data-memory-themed="" style={{ ...memoryThemeStyle(theme), transitionProperty: 'none' }} className="min-h-0 flex-1 overflow-auto p-5">
          <p className="mb-3 text-[13px]">Browse the notes kept in this browser. Only you can see this view.</p>
          <label className="block text-[13px]">Search your memory<input aria-label="Search your memory" value={query} onChange={(e) => setQuery(e.target.value)} className="mt-1 block w-full border p-2" style={{ backgroundColor: theme.panel, color: theme.text, borderColor: theme.border, borderRadius: theme.radius }} /></label>
          <div className="mt-3 flex justify-end"><button type="button" className="px-3 py-2 text-[13px]" style={buttonStyle} disabled={busy} onClick={() => current() && setCard({ kind: 'export', snapshot })}>Export your memory</button></div>
          <div className="mt-4 space-y-3">
            {visible.map((b) => <article key={b.id} className="border p-4" style={{ backgroundColor: theme.panel, borderColor: theme.border, borderRadius: theme.radius }}>
              <p className="text-[11px]" style={{ color: theme.muted }}>{KIND_TITLES[b.kind]}</p>
              <p className="mt-1 whitespace-pre-wrap break-words text-[14px]">{b.statement}</p>
              {editing === b.id && <label className="mt-3 block text-[13px]">Corrected words<textarea maxLength={500} value={words} onChange={(e) => setWords(e.target.value)} className="mt-1 block min-h-24 w-full border p-2" style={{ backgroundColor: theme.surface, color: theme.text, borderColor: theme.border, borderRadius: theme.radius }} /></label>}
              <div className="mt-3 flex gap-3 text-[13px]">
                {editing === b.id ? <><button type="button" disabled={busy || !words.trim()} style={buttonStyle} className="px-3 py-1.5" onClick={() => void prepare('fix', b.id, words)}>Review fix</button><button type="button" onClick={() => setEditing(null)}>Cancel</button></> : <button type="button" disabled={busy} onClick={() => { setEditing(b.id); setWords(b.statement) }}>Fix</button>}
                <button type="button" disabled={busy} style={{ color: theme.danger }} onClick={() => void prepare('forget', b.id, '')}>Forget</button>
              </div>
            </article>)}
            {!visible.length && <p className="py-6 text-[14px]">{snapshot.beliefs.length ? 'No matching notes.' : 'No notes are kept here yet.'}</p>}
          </div>
        </section>
        <div className="xc-divider border-t px-5 py-3 text-[13px]" role="status">{status || 'The app receives only opened and closed notices.'}</div>
        {card && <section data-memory-host-confirm="" className="xc-divider border-t px-5 py-4">
          <p className="xc-ink-3 text-[12px]">{opening.appName} asked you to review {opening.topic}</p>
          <h3 className="xc-heading mt-2 text-[16px]">{card.kind === 'fix' ? 'Save this fix?' : card.kind === 'forget' ? 'Forget this memory?' : 'Export your memory?'}</h3>
          {card.kind !== 'export' && <>
            {card.changed && <p role="alert" className="xc-ink-2 mt-2 text-[13px]">This changed since you opened it. Review the current text before confirming again.</p>}
            <p className="xc-ink-3 mt-2 text-[12px]">Current text</p><p className="mt-1 whitespace-pre-wrap break-words text-[14px]">{card.current}</p>
            {card.kind === 'fix' && <><p className="xc-ink-3 mt-2 text-[12px]">Your correction</p><p className="mt-1 whitespace-pre-wrap break-words text-[14px]">{card.words}</p></>}
          </>}
          {card.kind === 'export' && <p className="xc-ink-2 mt-2 text-[13px]">A file of your local memory will download on this device. The app receives nothing from it.</p>}
          <div className="mt-4 flex justify-end gap-2"><button type="button" className="xc-button xc-subtle" disabled={busy} onClick={() => setCard(null)}>Cancel</button><button type="button" className="xc-button xc-primary" disabled={busy || card.kind === 'forget' && clock < card.armAt} onClick={() => void confirm()}>{busy ? 'Saving…' : card.kind === 'fix' ? 'Save fix' : card.kind === 'forget' ? clock < card.armAt ? 'Wait a moment…' : 'Forget' : 'Export'}</button></div>
        </section>}
      </div>
    </div>, document.body,
  )
}
