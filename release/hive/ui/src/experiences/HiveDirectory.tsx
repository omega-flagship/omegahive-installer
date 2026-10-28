import { plural } from '../lib/plural'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useHive } from '../store/store'
import { shown } from '../lib/displayName'
import { FEATURES, GROUP_LABEL, type Feature, type FeatureGroup } from '../features/registry'
import { reach } from './coverage'
import { openFeature, targetFor } from './targets'
import { useModalContainment } from '../ui/useModalContainment'

/**
 * "Everything in the hive": every feature, reachable from any experience (Ω menu). Native features say so; the rest
 * open their classic page over the experience; features with no UI yet are listed and marked, never hidden.
 */
export function HiveDirectory({ experience, onClose, restoreTo, initialPick }: { experience: string; onClose: () => void; /** Where focus goes on close (the Ω button); default the opener. */ restoreTo?: () => HTMLElement | null; /** Open straight on "which mind / which swarm?" for this feature (an experience asking for a scope it lacks). */ initialPick?: Feature }) {
  const [q, setQ] = useState('')
  // a feature that lives in one mind's panel, or on one swarm's page, asks which one first
  const [pick, setPick] = useState<{ f: Feature; scope: 'mind' | 'swarm' } | null>(() => (initialPick ? { f: initialPick, scope: targetFor(initialPick)?.kind === 'swarm' ? 'swarm' : 'mind' } : null))
  const forMind = pick?.f ?? null
  const setForMind = (f: Feature | null) => setPick(f ? { f, scope: targetFor(f)?.kind === 'swarm' ? 'swarm' : 'mind' } : null)
  const agents = useHive((s) => s.agents)
  const swarmMap = useHive((s) => s.swarms)
  const minds = useMemo(() => {
    const list = pick?.scope === 'swarm' ? Object.values(swarmMap).map((s) => ({ id: s.id, name: s.name, hue: s.hue, status: plural(Object.values(agents).filter((a) => a.swarm_id === s.id).length, 'mind') })) : Object.values(agents).map((a) => ({ id: a.id, name: a.name, hue: a.hue, status: a.status as string }))
    return list.sort((a, b) => a.name.localeCompare(b.name))
  }, [agents, swarmMap, pick?.scope])
  const input = useRef<HTMLInputElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  // Tab stays in the directory; the experience behind is inert; focus returns to the Ω button on close
  useModalContainment(panel, { restoreFocus: restoreTo ? (opener) => restoreTo() ?? opener : true })
  useEffect(() => input.current?.focus(), [forMind])
  const groups = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    const hit = (f: Feature) => words.every((w) => `${f.label} ${f.blurb} ${f.keywords ?? ''}`.toLowerCase().includes(w))
    const by = new Map<FeatureGroup, Feature[]>()
    for (const f of FEATURES.filter(hit)) by.set(f.group, [...(by.get(f.group) ?? []), f])
    return [...by.entries()]
  }, [q])

  const open = (f: Feature) => {
    const k = targetFor(f)?.kind
    if (k === 'mind' || k === 'swarm') {
      setForMind(f)
      setQ('')
      return
    }
    onClose()
    openFeature(f)
  }
  const openFor = (mind: string) => {
    if (!forMind) return
    onClose()
    if (pick?.scope === 'swarm') openFeature(forMind, undefined, mind)
    else openFeature(forMind, mind)
  }
  const mindHits = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return minds.filter((a) => words.every((w) => shown(a.name).toLowerCase().includes(w)))
  }, [minds, q])
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      if (forMind) setForMind(null)
      else onClose()
    }
  }

  return (
    <div className="xc-scrim fixed inset-0 z-[85] flex items-end justify-center p-3 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ paddingBottom: 'calc(var(--sab, 0px) + 12px)' }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="hive-dir-title" onKeyDown={onKey} className="xc-window flex max-h-[min(85dvh,calc(100dvh-24px))] w-full max-w-[640px] flex-col overflow-hidden">
        <div className="xc-divider flex items-center gap-3 border-b px-4 py-3">
          {forMind && (
            <button onClick={() => setForMind(null)} aria-label="Back to everything" className="xc-button xc-subtle size-9 px-0 text-[16px]">
              ‹
            </button>
          )}
          <h2 id="hive-dir-title" className="xc-heading min-w-0 flex-1 truncate text-[15px]">{forMind ? `${forMind.label}: which ${pick?.scope === 'swarm' ? 'swarm' : 'mind'}?` : 'Everything in the hive'}</h2>
          <button onClick={onClose} aria-label="Close" className="xc-button xc-subtle size-9 px-0 text-[18px]">
            ×
          </button>
        </div>
        <label className="xc-divider border-b px-3 py-2">
          <span className="sr-only">Find a feature</span>
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder={forMind ? (pick?.scope === 'swarm' ? 'Find a swarm…' : 'Find a mind…') : 'Find anything: memory, budget, people, flows…'} className="xc-input min-h-10 w-full px-3 text-[14px]" />
        </label>
        <div className="thin-scroll min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
          {forMind && (
            <section aria-label={pick?.scope === 'swarm' ? 'Swarms' : 'Minds'}>
              {mindHits.length === 0 && <p className="xc-ink-2 px-3 py-6 text-center text-[13px]">{minds.length ? `Nothing matches “${q}”.` : pick?.scope === 'swarm' ? 'There are no swarms in this hive yet.' : 'There are no minds in this hive yet.'}</p>}
              {mindHits.map((a) => (
                <button key={a.id} onClick={() => openFor(a.id)} className="xc-item flex w-full items-center gap-3 px-3 py-2 text-left">
                  <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full" style={{ background: `hsl(${a.hue} 80% 60%)` }} />
                  <span className="min-w-0 flex-1 truncate text-[14px]">{shown(a.name)}</span>
                  <span className="xc-ink-3 shrink-0 text-[11px]">{a.status}</span>
                </button>
              ))}
            </section>
          )}
          {!forMind && groups.length === 0 && <p className="xc-ink-2 px-3 py-6 text-center text-[13px]">Nothing matches “{q}”.</p>}
          {!forMind && groups.map(([g, items]) => (
            <section key={g} aria-label={GROUP_LABEL[g]} className="mb-2">
              <h3 className="xc-ink-3 px-3 pt-2 pb-1 text-[11px] font-semibold tracking-[0.12em] uppercase">{GROUP_LABEL[g]}</h3>
              {items.map((f) => {
                const r = reach(experience, f)
                return (
                  <button
                    key={f.id}
                    disabled={r === 'gap'}
                    onClick={() => open(f)}
                    className="xc-item flex w-full items-center gap-3 px-3 py-2 text-left"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-[14px]">{f.label}</span>
                      <span className="xc-ink-2 block truncate text-[12px]">{f.blurb}</span>
                    </span>
                    <span className="xc-ink-3 shrink-0 text-[11px]">{r === 'native' ? 'here' : r === 'gap' ? 'not built yet' : targetFor(f)?.kind === 'mind' ? 'pick a mind' : targetFor(f)?.kind === 'swarm' ? 'pick a swarm' : 'opens a page'}</span>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}
