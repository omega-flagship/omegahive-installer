import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { Feature } from '../features/registry'
import { shown } from '../lib/displayName'
import { useAdminView } from '../lib/useAdmin'
import { useAuthContext } from '../lib/useResource'
import { useHive } from '../store/store'
import { useModalContainment } from '../ui/useModalContainment'
import { featureOffered } from './navigationScope'
import { openFeature, targetFor } from './targets'

/** Exact native mind/team picker for a guarded experience. It never widens into a second full directory. */
export function ScopedFeaturePicker({ feature, displayedOriginCurrent, onClose, restoreTo }: { feature: Feature; displayedOriginCurrent: () => boolean; onClose: () => void; restoreTo: () => HTMLElement | null }) {
  const state = useHive()
  useAuthContext(state.client)
  const { adminView } = useAdminView()
  const panel = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const title = useId()
  const [query, setQuery] = useState('')
  const target = targetFor(feature)
  const team = target?.kind === 'swarm'
  const rows = useMemo(() => (team ? Object.values(state.swarms) : Object.values(state.agents)).map((item) => ({ id: item.id, name: item.name })).sort((a,b) => a.id.localeCompare(b.id)), [team, state.swarms, state.agents])
  useModalContainment(panel, { restoreFocus: (opener) => restoreTo() ?? opener })
  useEffect(() => { input.current?.focus() }, [])
  const allowed = displayedOriginCurrent() && featureOffered(feature, { admin: adminView, apps: state.programs })
  const open = (id: string) => {
    if (!displayedOriginCurrent() || !featureOffered(feature, { admin: adminView, apps: useHive.getState().programs })) return
    const live = useHive.getState()
    if (team ? !live.swarms[id] : !live.agents[id]) return
    if (target?.kind !== 'mind' && target?.kind !== 'swarm') return
    if (openFeature(feature, team ? undefined : id, team ? id : undefined)) onClose()
  }
  return <div className="xc-scrim fixed inset-0 z-[85] flex items-end justify-center p-3 sm:items-center" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div ref={panel} role="dialog" aria-modal="true" aria-labelledby={title} className="xc-window flex max-h-[min(85dvh,calc(100dvh-24px))] w-full max-w-[640px] flex-col overflow-hidden" onKeyDown={(event) => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); onClose() } }}>
      <div className="xc-divider flex items-center justify-between border-b px-4 py-3"><h2 id={title} className="xc-heading text-[15px]">Choose the exact {team ? 'swarm' : 'mind'}</h2><button type="button" className="xc-button xc-subtle min-h-11 px-3" onClick={onClose}>Close</button></div>
      <label className="xc-divider border-b px-3 py-2"><span className="sr-only">Find by name or exact ID</span><input ref={input} value={query} onChange={(event) => { if (allowed) setQuery(event.target.value) }} className="xc-input min-h-11 w-full px-3" placeholder="Name or exact ID" /></label>
      <div className="thin-scroll min-h-0 overflow-auto p-2">{!allowed ? <p className="xc-ink-2 p-3">This selection is no longer available. Close it and choose again.</p> : rows.filter((row) => `${row.id} ${shown(row.name)}`.toLowerCase().includes(query.toLowerCase())).map((row) => <button type="button" key={row.id} onClick={() => open(row.id)} className="xc-item flex min-h-11 w-full flex-col px-3 py-2 text-left"><strong>{shown(row.name)}</strong><small className="xc-ink-2">{row.id}</small></button>)}{allowed && !rows.length && <p className="xc-ink-2 p-3">No {team ? 'swarms' : 'minds'} are visible here yet.</p>}</div>
    </div>
  </div>
}
