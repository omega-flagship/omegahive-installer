import { AnimatePresence, m } from 'framer-motion'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ago, modelLabel, money } from '../lib/format'
import { SimChip } from '../ui/SimChip'
import { useFinePointer, useNow, useReducedMotion } from '../lib/hooks'
import { navigate, useRoute } from '../lib/router'
import { describeLlmError } from '../lib/llmErrors'
import { askingByAgent } from '../store/reducer'
import { hiveBus, useHive } from '../store/store'
import { Icon } from '../ui/Icon'
import { Orb, StatusPill } from '../ui/primitives'
import { HiveEngine, type HitTarget } from './engine'
import { setMapLabelReader } from './mapLabels'
import { mapScene } from './sceneData'
import { visibleSet } from './visibleSet'
import { hiveAliases, useViewer } from './viewer'
import { readPositions, savePosition } from './galaxyPositions'
import { attachGalaxyDrag } from './galaxyDrag'
import { onIdentityChange } from '../lib/identityEpoch'
import { useAskStore } from '../store/ask'
import { combineInsets, useScene } from './sceneStore'
import { shown } from '../lib/displayName'
import { plural } from '../lib/plural'


/** The full-bleed living hive. Owns the engine and bridges store ⇄ canvas. */
export function HiveScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const regionRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<HiveEngine | null>(null)
  const reduced = useReducedMotion()
  const fine = useFinePointer()
  const route = useRoute()
  const [hover, setHover] = useState<HitTarget | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const setEngine = useScene((s) => s.setEngine)
  const insetSources = useScene((s) => s.insetSources)
  const chatAnchor = useScene((s) => s.chatAnchor)
  const dimmed = useScene((s) => s.dimmed)
  const ready = useHive((s) => s.ready)
  const fitted = useRef(false)
  const ownHiveRef = useRef<string | null>(null)
  const userMoved = useRef(false)
  const landedOn = useRef<string | null>(null)
  const adminRef = useRef(false)
  const pinnedRef = useRef<string | null>(null)
  useEffect(() => {
    pinnedRef.current = pinned
  }, [pinned])

  const selectedId = route.name === 'dot' ? route.id : null

  // create engine once
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let engine: HiveEngine
    try {
      engine = new HiveEngine(
        canvas,
        {
          onHover: (t) => setHover(t),
          onTap: (t, pointerType) => {
            if (!t) {
              setPinned(null)
              return
            }
            if (t.kind === 'core') {
              navigate({ name: 'swarm', id: t.id })
              return
            }
            // Touch: first tap shows the card, second tap (or the card) opens the panel.
            if (pointerType !== 'mouse') {
              if (pinnedRef.current === t.id) {
                setPinned(null)
                navigate({ name: 'dot', id: t.id })
              } else {
                setPinned(t.id)
              }
              return
            }
            navigate({ name: 'dot', id: t.id })
          },
          onUserCamera: () => {
            userMoved.current = true
          },
        },
        { reducedMotion: reduced },
      )
    } catch {
      return
    }
    engineRef.current = engine
    setEngine(engine)
    // UI checks may read the map's galaxies only in the simulator or a dev build: decided once, from the first client
    // the map is attached to (the client arrives after the first render), and never again
    let allowed: boolean | null = import.meta.env.DEV ? true : null
    const checksAllowed = () => {
      if (allowed === null) {
        const c = useHive.getState().client
        if (c) allowed = c.mode === 'sim'
      }
      return allowed === true
    }
    // read-only hook for automated UI checks (screenshots, perf)
    window.__hiveScene = {
      screenPos: (id: string) => engine.screenPos(id),
      focus: (id: string) => engine.flyToDot(id),
      // the galaxy checks answer only in the simulator or a dev build (Kimi r1 note); elsewhere: nothing
      galaxies: () => (checksAllowed() ? engine.galaxyScreens() : []),
      overview: () => void (checksAllowed() && engine.overview()),
      handleAt: (x: number, y: number) => (checksAllowed() ? engine.galaxyHandleAt(x, y) : null),
      labels: () => (checksAllowed() ? engine.galaxyLabelBoxes() : []),
    }
    setMapLabelReader(() => engine.labelBoxes())
    engine.start()
    const ro = new ResizeObserver(() => engine.resize())
    ro.observe(canvas)
    const off = hiveBus.on((e) => engine.handleEvent(e))
    // sync store → engine without re-rendering React. The visible set is fixed first (scene/visibleSet): grouping,
    // sizes, counts, links and labels are all computed from what this viewer is shown, never from anything hidden.
    let pinnedFor: string | null | undefined
    const push = () => {
      const s = useHive.getState()
      const vs = useViewer.getState()
      // the person's own mind arrives with the Ask's settings, and may arrive before the viewer is known
      const personal = useAskStore.getState().personal
      const viewer = { ...vs.viewer, ownMind: vs.viewer.ownMind ?? (personal ? { id: personal.id, swarm_id: personal.swarm_id ?? null } : null) }
      const { shown, universe, claims } = mapScene(Object.values(s.swarms), Object.values(s.agents), Object.values(s.goals), { viewer, names: vs.names })
      // the person's own arrangement, read once per person (positions are keyed by shown hive ids only)
      if (pinnedFor !== viewer.principal) {
        pinnedFor = viewer.principal
        engine.setPinned(readPositions(viewer.principal))
      }
      engine.setData({
        agents: shown.agents,
        swarms: shown.swarms,
        thinking: s.thinking,
        beliefs: s.beliefs,
        claims,
        asking: askingByAgent(s.approvals),
        universe,
      })
      useScene.getState().setGalaxies(engine.galaxyList().map((g) => ({ ...g, mine: g.id === shown.ownHive, aliases: hiveAliases(g.id, vs, shown.ownHive) })))
      ownHiveRef.current = shown.ownHive
      adminRef.current = vs.viewer.admin || vs.viewer.visitor
      // who is looking became known after the first fit: land them where they belong, unless they have moved already
      // and once the private-app homes are known (r1.1: the map is held back until then), fit what is now shown
      const target = adminRef.current ? null : shown.ownHive
      const landKey = `${target ?? ''}|${viewer.homesState ?? 'pending'}`
      if (fitted.current && !userMoved.current && landedOn.current !== landKey) {
        landedOn.current = landKey
        engine.land(target)
      }
    }
    push()
    const unsub = useHive.subscribe((s, p) => {
      if (s.agents !== p.agents || s.swarms !== p.swarms || s.thinking !== p.thinking || s.beliefs !== p.beliefs || s.goals !== p.goals || s.approvals !== p.approvals) push()
    })
    // the person's own mind (GET /api/me/mind) arrives with the Ask's settings: it is drawn as "You"
    const unsubOwn = useAskStore.subscribe((s, p) => {
      if (s.personal !== p.personal) push()
    })
    const unsubViewer = useViewer.subscribe(() => push())
    // a person's arrangement and hive list die with the identity: the next person starts from their own
    const offIdentity = onIdentityChange(() => {
      pinnedFor = undefined
      userMoved.current = false
      landedOn.current = null
      engine.setPinned({})
      useScene.getState().setGalaxies([])
    })
    // drag a galaxy to rearrange the universe (scene/galaxyDrag: bound to the identity it started under)
    const region = regionRef.current
    const detachDrag = region
      ? attachGalaxyDrag(region, canvas, engine, {
          principal: () => useViewer.getState().viewer.principal,
          save: savePosition,
          onMoved: () => {
            userMoved.current = true
          },
        })
      : () => undefined
    return () => {
      detachDrag()
      unsubViewer()
      offIdentity()
      useScene.getState().setGalaxies([])
      unsub()
      unsubOwn()
      off()
      ro.disconnect()
      engine.destroy()
      delete window.__hiveScene
      setMapLabelReader(null)
      engineRef.current = null
      setEngine(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => engineRef.current?.setReducedMotion(reduced), [reduced])
  useEffect(() => engineRef.current?.setDimmed(dimmed), [dimmed])
  useEffect(() => engineRef.current?.setChatAnchor(chatAnchor), [chatAnchor])

  const insets = useMemo(() => combineInsets(insetSources), [insetSources])
  useEffect(() => engineRef.current?.setInsets(insets), [insets])

  // first fit once data is in
  useEffect(() => {
    const e = engineRef.current
    if (!e || !ready || fitted.current) return
    fitted.current = true
    // a signed-in person lands in their own hive; an admin, the operator, a visitor or the demo on the universe
    requestAnimationFrame(() => {
      const target = adminRef.current ? null : ownHiveRef.current
      landedOn.current = `${target ?? ''}|${useViewer.getState().viewer.homesState ?? 'pending'}`
      e.land(target, true)
    })
  }, [ready])

  // selection follows the route
  useEffect(() => {
    const e = engineRef.current
    if (!e) return
    e.setSelected(selectedId, true)
    if (!selectedId && route.name === 'hive' && fitted.current) e.land(adminRef.current ? null : ownHiveRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const cardId = (hover?.kind === 'dot' ? hover.id : null) ?? pinned
  const showCard = cardId && cardId !== selectedId && route.name === 'hive'

  useEffect(() => {
    const e = engineRef.current
    const el = cardRef.current
    if (!e || !el) return
    e.track(el, showCard ? cardId : null)
    return () => e.track(el, null)
  }, [cardId, showCard])

  const coreHover = hover?.kind === 'core' ? hover.id : null

  return (
    <div ref={regionRef} className="fixed inset-0" aria-label="The hive" role="region">
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full touch-none select-none"
        style={{ cursor: 'grab' }}
        aria-label="Living view of every mind and swarm. Use the mind list or command palette for keyboard navigation."
        role="img"
      />
      <div ref={cardRef} className="pointer-events-none absolute top-0 left-0 z-10" style={{ willChange: 'transform' }}>
        <AnimatePresence>{showCard && <DotCard key={cardId} id={cardId} touch={!fine} />}</AnimatePresence>
      </div>
      <AnimatePresence>{coreHover && <CoreTip key={coreHover} id={coreHover} />}</AnimatePresence>
    </div>
  )
}

function DotCard({ id, touch }: { id: string; touch: boolean }) {
  const agent = useHive((s) => s.agents[id])
  const thinking = useHive((s) => s.thinking[id])
  const swarm = useHive((s) => (agent?.swarm_id ? s.swarms[agent.swarm_id] : undefined))
  const now = useNow(5000)
  if (!agent) return null
  return (
    <m.div
      initial={{ opacity: 0, y: 6, scale: 0.94 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 4, scale: 0.96, transition: { duration: 0.12 } }}
      transition={{ type: 'spring', stiffness: 520, damping: 32 }}
      // with a mouse the card has nothing to press: it lets clicks through, so a dot drifting under its own card (or a
      // neighbour's) is still clicked on the map; on touch it carries the Open button
      className={`glass-strong ${touch ? 'pointer-events-auto' : 'pointer-events-none'} absolute left-0 w-[252px] -translate-x-1/2 rounded-2xl p-3`}
      style={{ top: 22 }}
    >
      <div className="flex items-center gap-2.5">
        <Orb hue={agent.hue} status={agent.status} thinking={thinking} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-display text-[15px] font-semibold leading-tight">{shown(agent.name)}</div>
          <div className="truncate text-[11px] text-ink-3">
            {agent.kind} · {swarm?.name ?? 'wanderer'}
          </div>
        </div>
        <StatusPill status={agent.status} thinking={thinking} />
      </div>
      <dl className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
        <div className="col-span-2 flex items-baseline justify-between gap-2">
          <dt className="text-ink-4">Model</dt>
          <dd className="truncate font-mono text-ink-2">{modelLabel(agent.model)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="flex items-center gap-1 text-ink-4">
            Spend <SimChip />
          </dt>
          <dd className="font-mono text-ink-2">{money(agent.spent_usd)}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-2">
          <dt className="text-ink-4">Active</dt>
          <dd className="text-ink-2">{ago(agent.last_active_at, now)}</dd>
        </div>
      </dl>
      {agent.last_error && (
        <div className="mt-2 flex items-center gap-1.5 rounded-lg bg-bad/10 px-2 py-1 text-[11px] text-bad">
          <Icon name="alert" size={12} className="shrink-0" />
          <span className="truncate">{describeLlmError(agent.last_error)?.title}</span>
        </div>
      )}
      {touch && (
        <button
          onClick={() => navigate({ name: 'dot', id })}
          className="mt-2.5 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-white/[0.08] text-[13px] font-medium text-ink"
        >
          Open {shown(agent.name)} <Icon name="chevron" size={16} />
        </button>
      )}
    </m.div>
  )
}

function CoreTip({ id }: { id: string }) {
  const stored = useHive((s) => s.swarms[id])
  const agents = useHive((s) => s.agents)
  const viewer = useViewer((s) => s.viewer)
  // its minds as this viewer is shown them (scene/visibleSet): a hidden mind is never counted
  const swarm = useMemo(() => (stored ? visibleSet([stored], Object.values(agents), viewer, { map: true }).swarms[0] : undefined), [stored, agents, viewer])
  const count = useHive((s) => Object.keys(s.beliefs[id] ?? {}).length)
  if (!swarm) return null
  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="glass pointer-events-none fixed bottom-[calc(var(--hud-bottom,0px)+96px)] left-1/2 z-10 -translate-x-1/2 rounded-2xl px-4 py-2.5 text-center"
    >
      <div className="font-display text-sm font-semibold">{shown(swarm.name)}</div>
      <div className="text-xs text-ink-3">
        {plural(count, 'belief')} · {plural(swarm.member_ids.length, 'mind')} · click to open the commons
      </div>
    </m.div>
  )
}
