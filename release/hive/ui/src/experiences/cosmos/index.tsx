import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, m } from 'framer-motion'
import './cosmos.css'
import { countPending, hsl, openClassic, openPalette, shown, useHive, useHomeRequested, useResting, useRoomyLayout, useReducedMotion, useRoute } from '../sdk'
import { buildLayout, type CosmosLayout } from './layout'
import { useCosmos } from './state'
import { Labels } from './Labels'
import { ApprovalsPanel, MindPanel, SystemPanel } from './Panels'
import { Deck } from './Deck'
import { ApprovalDecision } from '../ApprovalDecision'
import { HiveDirectory } from '../HiveDirectory'
import { modalLayers } from '../../ui/useModalContainment'

// the 3D engine streams in after the HUD, so the hive is usable while the stars ignite
const Scene = lazy(() => import('./Scene'))


/** COSMOS: the hive as a navigable galaxy. Swarms are star systems, minds are worlds. */
export default function Cosmos() {
  const desktop = useRoomyLayout()
  const reduced = useReducedMotion()
  const swarmKey = useHive((s) => Object.values(s.swarms).map((w) => `${w.id}:${w.name}:${w.hue}:${w.created_at}:${w.member_ids.join(',')}`).sort().join('|'))
  const agentKey = useHive((s) => Object.values(s.agents).map((a) => `${a.id}:${a.swarm_id}:${a.kind}:${a.created_at}`).sort().join('|'))
  const layout = useMemo<CosmosLayout>(() => {
    const st = useHive.getState()
    return buildLayout(st.swarms, st.agents)
    // the layout only changes when the shape of the hive does, not on every status tick
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swarmKey, agentKey])
  const view = useCosmos((s) => s.view)
  const go = useCosmos((s) => s.go)
  const approvalsOpen = useCosmos((s) => s.approvalsOpen)
  const answering = useCosmos((s) => s.answering)
  const answeringSession = useCosmos((s) => s.answeringSession)
  const answer = useCosmos((s) => s.answer)
  const pickingSwarm = useCosmos((s) => s.pickingSwarm)
  const deck = useCosmos((s) => s.deck)
  // a surface's X lands on a clean galaxy (home:requested)
  useHomeRequested(() => useCosmos.getState().clearToHome())
  const hidden = usePageHidden()
  const [lit, setLit] = useState(false)
  const lightUp = useCallback(() => setLit(true), [])
  // a classic page or app over the galaxy, or the page resting (the rest draws its own sky), stops the scene
  const resting = useResting((s) => s.resting)
  const covered = useRoute().name !== 'hive' || resting
  const [gl, setGl] = useState<'ok' | 'lost' | 'failed'>('ok')
  const [epoch, setEpoch] = useState(0)
  const onContext = useCallback((st: 'lost' | 'restored') => {
    if (st === 'lost') setGl('lost')
    else {
      setGl('ok')
      setEpoch((n) => n + 1)
    }
  }, [])
  const sceneFailed = useCallback(() => {
    setGl('failed')
    setLit(true)
  }, [])
  useBootData(layout)
  useKeys(layout)

  // a focused thing that disappears sends you back out
  useEffect(() => {
    if (view.kind === 'mind' && !layout.planetById[view.id]) go({ kind: 'galaxy' })
    if (view.kind === 'system' && !layout.systemById[view.id]) go({ kind: 'galaxy' })
  }, [view, layout, go])

  const empty = layout.planets.length === 0 && layout.systems.length === 0
  return (
    <div className="cx" data-experience="cosmos">
      <SceneBoundary key={epoch} onFail={sceneFailed}>
        <Suspense fallback={null}>
          <Scene layout={layout} reduced={reduced} desktop={desktop} hidden={hidden || covered} onReady={lightUp} onContext={onContext} />
        </Suspense>
      </SceneBoundary>
      {gl !== 'ok' && (
        <p role="status" className="cx-gl-note cx-glass">
          {gl === 'lost' ? 'The 3D sky paused: the graphics card took it back. It returns by itself; everything else still works.' : 'This device could not start the 3D sky. Everything else works: use the navigator, the deck and the search.'}
        </p>
      )}
      <Ignition lit={lit} />
      <Labels layout={layout} />
      <Hud layout={layout} desktop={desktop} />
      {empty && <Void />}
      {/* on a phone the deck or the incoming list covers the world's panel: what is covered is not reachable either */}
      <div className="contents" inert={!desktop && (!!deck || approvalsOpen) ? true : undefined}>
        <AnimatePresence mode="wait">
          {view.kind === 'mind' && <MindPanel key={`m-${view.id}`} id={view.id} desktop={desktop} />}
          {view.kind === 'system' && <SystemPanel key={`s-${view.id}`} id={view.id} desktop={desktop} />}
        </AnimatePresence>
      </div>
      <AnimatePresence>{approvalsOpen && <ApprovalsPanel key="ap" desktop={desktop} />}</AnimatePresence>
      {pickingSwarm && <HiveDirectory experience="cosmos" initialPick={pickingSwarm} onClose={() => useCosmos.getState().pickSwarm(null)} />}
      <AnimatePresence>{answering && <ApprovalDecision key={answering.id} seen={answering} session={answeringSession ?? undefined} onClose={() => answer(null)} restoreFocus={afterAnswer} />}</AnimatePresence>
      <AnimatePresence>
        <Deck key="deck" layout={layout} desktop={desktop} />
      </AnimatePresence>
    </div>
  )
}

/**
 * Where focus goes when the decision dialog closes: back to what opened it, unless that was the card of a request that
 * is no longer waiting; then to the neutral Incoming heading (never onto the next request's controls, Review R3).
 */
function afterAnswer(opener: HTMLElement | null): HTMLElement | null {
  const card = opener?.closest<HTMLElement>('[data-cx-decision]')
  const settled = card ? useHive.getState().approvals[card.dataset.cxDecision ?? '']?.status !== 'pending' : false
  if (opener && opener.isConnected && !settled) return opener
  return document.querySelector<HTMLElement>('[data-cx-incoming]') ?? document.querySelector<HTMLElement>('[data-cx-approvals-toggle]')
}

/**
 * Without WebGL (or when the scene fails to start) Cosmos stays: the galaxy is decoration over a working HUD, deck,
 * navigator and panels, so only the sky is replaced by its dark backdrop. The experience's own Guard is for real crashes.
 */
class SceneBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(e: unknown) {
    console.warn('cosmos: the 3D scene could not start; the rest of Cosmos stays', e)
    this.props.onFail()
  }
  render() {
    return this.state.failed ? <div aria-hidden className="absolute inset-0" style={{ background: 'radial-gradient(ellipse at center, #070b1d 0%, #010208 70%)' }} /> : this.props.children
  }
}

/** Covers the canvas until its first frames are drawn, then dissolves. */
function Ignition({ lit }: { lit: boolean }) {
  return (
    <div
      aria-hidden={lit}
      className="pointer-events-none absolute inset-0 grid place-items-center"
      style={{ background: 'radial-gradient(ellipse at center, #070b1d 0%, #010208 70%)', opacity: lit ? 0 : 1, transition: 'opacity 1.4s ease', zIndex: 1 }}
    >
      <div className="flex flex-col items-center gap-4">
        <span className="relative grid size-10 place-items-center">
          <span className="cx-ping absolute size-10 rounded-full" style={{ border: '1px solid #7cc4ff' }} />
          <span className="size-2.5 rounded-full" style={{ background: '#eaf3ff', boxShadow: '0 0 18px #7cc4ff' }} />
        </span>
        <div className="cx-wide cx-blink text-[12px]" style={{ color: '#c3d1ec' }}>
          Igniting stars
        </div>
      </div>
    </div>
  )
}

function usePageHidden() {
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  useEffect(() => {
    const on = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return hidden
}

function useBootData(layout: CosmosLayout) {
  const loadApprovals = useHive((s) => s.loadApprovals)
  const loadBeliefs = useHive((s) => s.loadBeliefs)
  const loadGoals = useHive((s) => s.loadGoals)
  const ids = layout.systems.map((s) => s.id).join(',')
  useEffect(() => {
    void loadApprovals().catch(() => undefined)
  }, [loadApprovals])
  useEffect(() => {
    for (const id of ids.split(',').filter(Boolean)) {
      void loadBeliefs(id).catch(() => undefined)
      void loadGoals(id).catch(() => undefined)
    }
  }, [ids, loadBeliefs, loadGoals])
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')

function useKeys(layout: CosmosLayout) {
  const ref = useRef(layout)
  useEffect(() => {
    ref.current = layout
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return
      // a modal (a decision, Ω, Change UI, a classic dialog) owns the keyboard: the flight keys stay out of it
      if (modalLayers.size > 0) return
      // and so does anything outside the galaxy (the Ω menu, a classic page over it): those keys are not flight keys
      const tgt = e.target
      if (tgt instanceof Element && tgt !== document.body && tgt.isConnected && !tgt.closest('[data-experience="cosmos"]')) return
      const st = useCosmos.getState()
      const lay = ref.current
      if (e.key === 'Escape') {
        if (useHive.getState().paletteOpen) return
        if (st.deck) st.setDeck(st.deck === 'index' ? null : 'index')
        else if (st.approvalsOpen) st.setApprovals(false)
        else if (st.view.kind === 'mind') {
          const sys = lay.planetById[st.view.id]?.systemId
          st.go(sys ? { kind: 'system', id: sys } : { kind: 'galaxy' })
        } else if (st.view.kind === 'system') st.go({ kind: 'galaxy' })
        else return
        e.preventDefault()
        return
      }
      // a field that has focus owns its keys too (resting mode focuses the Ask in the capture phase of this very key)
      if (typing(e.target) || typing(document.activeElement) || useHive.getState().paletteOpen) return
      const k = e.key.toLowerCase()
      if (k === 'h' || e.key === 'Home') st.home()
      else if (k === 'a') st.setApprovals(!st.approvalsOpen)
      else if (k === 'd') st.setDeck(st.deck ? null : 'index')
      else if (k === '/') openPalette()
      else if (e.key === ']' || e.key === '[') {
        // step through systems (in the galaxy) or through the worlds of the current system
        const dir = e.key === ']' ? 1 : -1
        const v = st.view
        const sysId = v.kind === 'system' ? v.id : v.kind === 'mind' ? lay.planetById[v.id]?.systemId : null
        if (v.kind === 'galaxy' || !sysId) {
          const list = lay.systems
          if (!list.length) return
          const i = v.kind === 'system' ? list.findIndex((s) => s.id === v.id) : -1
          st.go({ kind: 'system', id: list[(i + dir + list.length) % list.length].id })
        } else {
          const members = lay.systemById[sysId]?.members ?? []
          if (!members.length) return
          const i = v.kind === 'mind' ? members.indexOf(v.id) : dir > 0 ? -1 : 0
          st.go({ kind: 'mind', id: members[(i + dir + members.length) % members.length] })
        }
      } else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}

/* ============================================================ HUD */

function Wordmark({ small }: { small: boolean }) {
  return (
    <div className="flex items-center gap-2.5">
      <svg width={small ? 20 : 24} height={small ? 20 : 24} viewBox="0 0 24 24" aria-hidden>
        <circle cx="12" cy="12" r="3.2" fill="#eaf3ff" />
        <ellipse cx="12" cy="12" rx="10.5" ry="4.2" fill="none" stroke="#7cc4ff" strokeWidth="1" transform="rotate(-24 12 12)" />
        <circle cx="21" cy="8.6" r="1.4" fill="#7cc4ff" />
      </svg>
      <span className="cx-wide" style={{ fontSize: small ? 12 : 13.5, letterSpacing: '0.55em', color: '#eef4ff' }}>
        Cosmos
      </span>
    </div>
  )
}

function Hud({ layout, desktop }: { layout: CosmosLayout; desktop: boolean }) {
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  const thinking = useHive((s) => s.thinking)
  const beliefs = useHive((s) => s.beliefs)
  const view = useCosmos((s) => s.view)
  const go = useCosmos((s) => s.go)
  const home = useCosmos((s) => s.home)
  const all = Object.values(agents)
  const lit = all.filter((a) => a.status === 'awake').length
  const busy = Object.values(thinking).filter((t) => t === 'llm' || t === 'skills').length
  let nBeliefs = 0
  for (const id in beliefs) nBeliefs += Object.keys(beliefs[id]).length
  const sysId = view.kind === 'system' ? view.id : view.kind === 'mind' ? (layout.planetById[view.id]?.systemId ?? null) : null
  const crumbs: { label: string; on: () => void; hue?: number }[] = [{ label: 'Hive', on: home }]
  if (sysId && swarms[sysId]) crumbs.push({ label: shown(swarms[sysId].name), on: () => go({ kind: 'system', id: sysId }), hue: swarms[sysId].hue })
  else if (view.kind === 'mind') crumbs.push({ label: 'Deep space', on: home })
  if (view.kind === 'mind' && agents[view.id]) crumbs.push({ label: shown(agents[view.id].name), on: () => undefined, hue: agents[view.id].hue })
  const deck = useCosmos((s) => s.deck)
  const sheet = !desktop && (view.kind !== 'galaxy' || !!deck)
  return (
    <>
      {/* top-left: identity, where you are, the pulse of the hive */}
      <div data-xc-keep-clear="" data-cx-occlude="" className="pointer-events-none fixed z-10" style={{ top: desktop ? 22 : 14, left: desktop ? 26 : 16 }}>
        <Wordmark small={!desktop} />
        <nav aria-label="Location" className="pointer-events-auto mt-2.5 flex flex-wrap items-center gap-1.5 cx-mono text-[10.5px]" style={{ letterSpacing: '0.16em' }}>
          {crumbs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden="true" style={{ color: '#7d90b4' }}>/</span>}
              <button className="cx-focus cx-crumb uppercase hover:text-white" style={{ color: i === crumbs.length - 1 ? (c.hue != null ? hsl(c.hue, 90, 80) : '#eef4ff') : '#b4c3e0' }} onClick={c.on} aria-current={i === crumbs.length - 1 ? 'location' : undefined}>
                {c.label}
              </button>
            </span>
          ))}
        </nav>
        {desktop && (
          <div className="mt-3 flex gap-4 cx-mono text-[10.5px]" style={{ color: '#9fb2d6', letterSpacing: '0.12em' }} aria-label="Hive telemetry">
            <Stat k="SYSTEMS" v={layout.systems.length} />
            <Stat k="WORLDS" v={all.length} />
            <Stat k="LIT" v={lit} />
            <Stat k="THINKING" v={busy} hot={busy > 0} />
            <Stat k="BELIEFS" v={nBeliefs} />
          </div>
        )}
      </div>

      <Beacon desktop={desktop} />
      <Controls desktop={desktop} />
      {!sheet && <Navigator layout={layout} desktop={desktop} shifted={desktop && view.kind !== 'galaxy'} />}
      {desktop && view.kind === 'galaxy' && !deck && (
        // the key hints sit under the top-right controls, never on the navigator's row (it can be as wide as the screen)
        <div data-cx-hint="" className="pointer-events-none fixed right-6 z-10 cx-mono text-[10px]" style={{ top: 72, color: '#8ea2c8', letterSpacing: '0.14em' }} aria-hidden>
          DRAG ORBIT · SCROLL ZOOM · [ ] STEP · D DECK · ESC BACK
        </div>
      )}
    </>
  )
}

function Stat({ k, v, hot }: { k: string; v: number; hot?: boolean }) {
  return (
    <span>
      <span style={{ color: hot ? '#ffd79a' : '#eef4ff', fontSize: 12 }}>{String(v).padStart(2, '0')}</span> {k}
    </span>
  )
}

function Beacon({ desktop }: { desktop: boolean }) {
  const n = useHive((s) => countPending(s.approvals))
  const open = useCosmos((s) => s.approvalsOpen)
  const setOpen = useCosmos((s) => s.setApprovals)
  return (
    <div data-xc-keep-clear="" data-cx-occlude="" className="fixed left-1/2 z-20 -translate-x-1/2" style={{ top: desktop ? 20 : 62 }}>
      <AnimatePresence>
        {n > 0 ? (
          <m.button
            key="on"
            initial={{ opacity: 0, y: -12, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -12 }}
            data-sweep="decide"
            data-presence-feature="decide.approvals"
            data-cx-approvals-toggle=""
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={`${n} incoming transmission${n === 1 ? '' : 's'} awaiting your clearance`}
            className="cx-beacon cx-focus flex items-center gap-3 border px-4 py-2"
            style={{ borderColor: 'rgba(255,195,107,0.6)', backdropFilter: 'blur(14px)', WebkitBackdropFilter: 'blur(14px)', background: 'rgba(30,18,4,0.55)', boxShadow: '0 0 30px -6px rgba(255,170,60,0.55)' }}
          >
            <span className="relative grid size-3 place-items-center">
              <span className="cx-ping absolute size-3 rounded-full" style={{ background: '#ffc36b' }} />
              <span className="size-2 rounded-full" style={{ background: '#ffc36b' }} />
            </span>
            <span className="cx-wide text-[10.5px]" style={{ color: '#ffd9a0', letterSpacing: desktop ? '0.34em' : '0.22em' }}>
              {desktop ? 'Incoming transmission' : 'Incoming'}
            </span>
            <span className="cx-mono text-[12px] px-1.5" style={{ background: '#ffc36b', color: '#1a1000', fontWeight: 600 }}>
              {String(n).padStart(2, '0')}
            </span>
          </m.button>
        ) : (
          desktop && (
            <m.button key="off" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setOpen(!open)} className="cx-focus flex items-center gap-2 px-3 py-1.5 cx-mono text-[10px]" style={{ color: '#9fb2d6', letterSpacing: '0.2em' }}>
              <span className="size-1.5 rounded-full" style={{ background: '#5fd4a8' }} />
              CHANNEL CLEAR
            </m.button>
          )
        )}
      </AnimatePresence>
    </div>
  )
}

function Controls({ desktop }: { desktop: boolean }) {
  const home = useCosmos((s) => s.home)
  const deck = useCosmos((s) => s.deck)
  const setDeck = useCosmos((s) => s.setDeck)
  return (
    <div data-xc-keep-clear="" data-cx-occlude="" className="fixed z-40 flex items-start gap-1.5" style={{ top: desktop ? 20 : 10, right: desktop ? 20 : 10 }}>
      <button className="cx-icon-btn cx-focus" onClick={openPalette} aria-label="Search and commands" title="Search">
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path d="M10.4 10.4L14 14" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      <button className="cx-icon-btn cx-focus" onClick={home} aria-label="Galaxy overview (H)" title="Galaxy  H">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle cx="9" cy="9" r="1.8" fill="currentColor" />
          <ellipse cx="9" cy="9" rx="7.4" ry="3" fill="none" stroke="currentColor" strokeWidth="1.1" />
          <ellipse cx="9" cy="9" rx="7.4" ry="3" fill="none" stroke="currentColor" strokeWidth="1.1" transform="rotate(60 9 9)" />
          <ellipse cx="9" cy="9" rx="7.4" ry="3" fill="none" stroke="currentColor" strokeWidth="1.1" transform="rotate(120 9 9)" />
        </svg>
      </button>
      <button
        data-sweep="nav"
        className="cx-icon-btn cx-focus"
        onClick={() => setDeck(deck ? null : 'index')}
        aria-expanded={!!deck}
        data-presence-region="deck"
        aria-label="Flight deck: everything in the hive (D)"
        title="Flight deck  D"
        style={deck ? { color: '#fff', borderColor: 'var(--cx-accent)', boxShadow: '0 0 18px -6px var(--cx-accent)' } : undefined}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <rect x="2.5" y="2.5" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <rect x="10.5" y="2.5" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <rect x="2.5" y="10.5" width="5" height="5" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <circle cx="13" cy="13" r="2.4" fill="currentColor" />
        </svg>
      </button>
    </div>
  )
}

function Navigator({ layout, desktop, shifted }: { layout: CosmosLayout; desktop: boolean; shifted: boolean }) {
  const agents = useHive((s) => s.agents)
  const view = useCosmos((s) => s.view)
  const go = useCosmos((s) => s.go)
  const home = useCosmos((s) => s.home)
  const drifters = layout.planets.filter((p) => !p.systemId && agents[p.id])
  const sysId = view.kind === 'system' ? view.id : view.kind === 'mind' ? (layout.planetById[view.id]?.systemId ?? null) : null
  return (
    <nav
      data-cx-occlude=""
      data-xc-keep-clear=""
      aria-label="Navigator"
      className="cx-hscroll fixed z-10 flex items-stretch gap-1.5"
      style={desktop ? { bottom: 18, left: shifted ? 'calc(50% - 200px)' : '50%', transform: 'translateX(-50%)', maxWidth: shifted ? 'calc(100vw - 640px)' : 'calc(100vw - 520px)', transition: 'left 0.5s cubic-bezier(.2,.8,.2,1)' } : { bottom: 'calc(12px + var(--sab, 0px))', left: 'calc(64px + env(safe-area-inset-left, 0px))', right: 'max(8px, var(--os-clock-room, 0px))' }}
    >
      <Chip active={view.kind === 'galaxy'} onClick={home} label="Galaxy" sub={`${String(layout.systems.length).padStart(2, '0')} SYS`} hue={210} glyph="galaxy" />
      {layout.systems.map((s) => {
        const lit = s.members.filter((id) => agents[id]?.status === 'awake').length
        return <Chip key={s.id} presence={`swarm:${s.id}`} sweep={s.id === layout.systems[0]?.id ? 'first-swarm' : undefined} active={sysId === s.id} onClick={() => go({ kind: 'system', id: s.id })} label={shown(s.name)} sub={`${lit}/${s.members.length} LIT`} hue={s.hue} glyph="star" />
      })}
      {drifters.map((p) => (
        <Chip key={p.id} presence={`mind:${p.id}`} active={view.kind === 'mind' && view.id === p.id} onClick={() => go({ kind: 'mind', id: p.id })} label={shown(agents[p.id].name)} sub="DRIFTER" hue={agents[p.id].hue} glyph="planet" />
      ))}
      <Chip active={false} onClick={() => openClassic({ name: 'launch' })} label="Start a swarm" sub="NEW SYSTEM" hue={38} glyph="new" sweep="nav-new-swarm" />
    </nav>
  )
}

function Chip({ active, onClick, label, sub, hue, glyph, sweep, presence }: { active: boolean; onClick: () => void; label: string; sub: string; hue: number; glyph: 'galaxy' | 'star' | 'planet' | 'new'; sweep?: string; presence?: string }) {
  return (
    <button
      data-sweep={sweep}
      data-presence-ref={presence}
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className="cx-focus flex shrink-0 items-center gap-2.5 border px-3 py-2 text-left transition-colors"
      style={{
        borderColor: active ? hsl(hue, 90, 66) : 'rgba(160,196,255,0.18)',
        background: active ? `linear-gradient(180deg, ${hsl(hue, 90, 50, 0.22)}, rgba(6,10,24,0.7))` : 'rgba(6,10,24,0.55)',
        backdropFilter: 'blur(14px)',
        WebkitBackdropFilter: 'blur(14px)',
        boxShadow: active ? `0 0 24px -8px ${hsl(hue, 95, 60)}` : 'none',
      }}
    >
      <span aria-hidden className="relative grid size-4 place-items-center">
        {glyph === 'new' ? (
          <svg width="16" height="16" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="6.2" fill="none" stroke={hsl(hue, 95, 72)} strokeWidth="1" strokeDasharray="2 2" />
            <path d="M8 5v6M5 8h6" stroke={hsl(hue, 95, 80)} strokeWidth="1.3" />
          </svg>
        ) : glyph === 'galaxy' ? (
          <svg width="16" height="16" viewBox="0 0 16 16">
            <path d="M8 8m-1.4 0a1.4 1.4 0 1 0 2.8 0a1.4 1.4 0 1 0 -2.8 0M8 2.5c3.5 0 5.5 2.5 5.5 5.5M8 13.5c-3.5 0-5.5-2.5-5.5-5.5" fill="none" stroke={hsl(hue, 80, 78)} strokeWidth="1.2" />
          </svg>
        ) : (
          <span
            className="block rounded-full"
            style={{
              width: glyph === 'star' ? 9 : 7,
              height: glyph === 'star' ? 9 : 7,
              background: glyph === 'star' ? `radial-gradient(circle, #fff 0%, ${hsl(hue, 95, 70)} 55%)` : hsl(hue, 85, 62),
              boxShadow: `0 0 10px ${hsl(hue, 95, 62)}`,
            }}
          />
        )}
      </span>
      <span>
        <span className="cx-caps block text-[10.5px]" style={{ color: '#eef4ff', letterSpacing: '0.22em' }}>
          {label}
        </span>
        <span className="cx-mono block text-[9.5px]" style={{ color: '#a9bbdc', letterSpacing: '0.12em' }}>
          {sub}
        </span>
      </span>
    </button>
  )
}

function Void() {
  return (
    <div className="pointer-events-none fixed inset-0 z-10 grid place-items-center px-6">
      <div className="pointer-events-auto max-w-sm text-center">
        <div className="cx-wide text-[13px]" style={{ color: '#eef4ff' }}>
          The void is quiet
        </div>
        <p className="mt-3 text-[14px] leading-relaxed" style={{ color: '#b4c3e0' }}>
          No minds orbit here yet. Seed one and a world will form; give it a swarm and a star will ignite around it.
        </p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <button className="cx-btn cx-btn-hue" style={{ ['--cx-hue' as string]: '#ffc36b' }} onClick={() => openClassic({ name: 'launch' })}>
            Start a swarm
          </button>
          <button className="cx-btn cx-btn-hue" style={{ ['--cx-hue' as string]: '#7cc4ff' }} onClick={() => useCosmos.getState().setDeck('create')}>
            Seed a mind
          </button>
        </div>
      </div>
    </div>
  )
}
