/**
 * Flux: the hive as living liquid. Swarms are bodies of fluid whose colour is the mix of their minds; minds are
 * droplets inside them; decisions gather as drips on the top edge. Touch a body and it pours into a glass panel;
 * touch a droplet and it becomes the conversation. The glass, the ink and the droplets are one shader.
 */
import { AnimatePresence, m } from 'framer-motion'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { beliefText, countPending, openClassic, plainText, openPalette, shown, useHive, useHomeRequested, useResting, useRoomyLayout, useReducedMotion, useRoute, type Agent } from '../sdk'
import { FluxCtx, FONT, INK, INK2, rgbCss, useFlux, useNode, type FluxApi, type Origin, type SheetState } from './ctx'
import { GooDefs, Glyph, Orb } from './kit'
import { DecisionCard, MindPanel, NothingCard, SwarmPanel } from './panels'
import { Sheet } from './sheets'
import { modalLayers } from '../../ui/useModalContainment'
import { HiveDirectory } from '../HiveDirectory'
import { usePickSwarm } from './nav'
import { FluxWorld, hslRgb, type FluxView, type Snapshot } from './world'
import { registerAskBridge } from '../../features/ask/bridge'

const snap = (s: Snapshot): Snapshot => ({ agents: s.agents, swarms: s.swarms, thinking: s.thinking, approvals: s.approvals })

interface Whisper {
  id: number
  agent: string
  text: string
}

type DecisionState = { id: string; origin?: Origin } | { id: null; origin?: Origin } | null

export default function Experience() {
  const reduced = useReducedMotion()
  const desktop = useRoomyLayout()
  const [world] = useState(() => new FluxWorld())
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const staticRef = useRef<HTMLDivElement>(null)
  const [failed, setFailed] = useState(false)
  const gpu = !reduced && !failed
  // a classic page over Flux, or the page resting, covers the liquid
  const resting = useResting((s) => s.resting)
  const covered = useRoute().name !== 'hive' || resting
  const picking = usePickSwarm((s) => s.picking)
  const coveredRef = useRef(covered)
  const [nav, setNav] = useState<{ view: FluxView; origin?: Origin }>({ view: { kind: 'home' } })
  const [decision, setDecision] = useState<DecisionState>(null)
  const [whispers, setWhispers] = useState<Whisper[]>([])
  const [sheet, setSheet] = useState<SheetState | null>(null)

  // the liquid: engine, size, visibility
  useEffect(() => {
    const size = () => world.resize(window.innerWidth, window.innerHeight, window.innerWidth >= 768)
    if (gpu && canvasRef.current) {
      if (!world.attach(canvasRef.current, window.innerWidth, window.innerHeight, window.innerWidth >= 768)) {
        queueMicrotask(() => setFailed(true))
        return
      }
    }
    world.setStatic(staticRef.current)
    world.sync(snap(useHive.getState()))
    size()
    if (gpu && !coveredRef.current) world.start()
    if (import.meta.env.DEV) Reflect.set(window, '__flux', world)
    const onVis = () => (document.hidden || coveredRef.current ? world.stop() : gpu && world.start())
    const onResize = () => size()
    // the GPU took the context back (driver reset, too many contexts, a backgrounded phone): the static liquid takes over
    const canvas = canvasRef.current
    const onLost = (e: Event) => {
      e.preventDefault()
      world.stop()
      setFailed(true)
    }
    canvas?.addEventListener('webglcontextlost', onLost)
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      canvas?.removeEventListener('webglcontextlost', onLost)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVis)
      world.dispose()
    }
  }, [world, gpu])

  // the universal Ask's liquid capsule: the shader refracts through it, and the Ask ripples the liquid (presentation
  // only: the bridge never acts or reads hive data)
  useEffect(
    () =>
      registerAskBridge('flux', {
        glass: gpu
          ? (el, radius) => {
              world.glass.set('ask', { el, radius })
              return () => {
                if (world.glass.get('ask')?.el === el) world.glass.delete('ask')
              }
            }
          : undefined,
        ripple: gpu ? (x, y, strength) => world.ripple(x, y, strength) : undefined,
      }),
    [world, gpu],
  )

  // a classic page or an app over Flux covers the liquid: it stops until it is seen again
  useEffect(() => {
    coveredRef.current = covered
    if (!gpu) return
    if (covered || document.hidden) world.stop()
    else world.start()
  }, [world, gpu, covered])

  // the hive drives the liquid: data, messages in flight, events as ripples, thoughts as whispers
  useEffect(() => {
    let wid = 0
    let lastAct = useHive.getState().activitySeq
    const seen = new Set<string>()
    for (const list of Object.values(useHive.getState().messages)) for (const msg of list) seen.add(msg.id)
    return useHive.subscribe((s, p) => {
      if (s.agents !== p.agents || s.swarms !== p.swarms || s.thinking !== p.thinking || s.approvals !== p.approvals) world.sync(snap(s))
      if (s.messages !== p.messages) {
        for (const id in s.messages) {
          if (s.messages[id] === p.messages[id]) continue
          for (const msg of s.messages[id]) {
            if (seen.has(msg.id)) continue
            seen.add(msg.id)
            if (!s.freshMessages[msg.id]) continue
            const from = msg.sender.startsWith('agent:') ? msg.sender.slice(6) : null
            if (from && from !== msg.agent_id) world.message(from, msg.agent_id)
            else world.rippleAt(`drop:${msg.agent_id}`, msg.direction === 'out' ? 0.6 : 0.8)
          }
        }
      }
      if (s.activitySeq !== lastAct) {
        const fresh = s.activity.filter((a) => a.id > lastAct)
        lastAct = s.activitySeq
        const add: Whisper[] = []
        for (const a of fresh) {
          const key = a.agent_id ? `drop:${a.agent_id}` : a.swarm_id ? `body:${a.swarm_id}` : null
          if (!key) continue
          if (a.kind === 'error') world.rippleAt(key, 1.1, [1, 0.3, 0.4])
          else if (a.kind === 'birth') world.rippleAt(key, 1.6)
          else if (a.kind === 'approval') world.ceilKick()
          else if (a.kind !== 'message') world.rippleAt(key, a.kind === 'status' ? 0.9 : 0.55)
          if (a.agent_id && (a.kind === 'belief' || a.kind === 'goal' || a.kind === 'error')) add.push({ id: ++wid, agent: a.agent_id, text: a.statement ? beliefText(a.statement) : plainText(a.text) })
        }
        if (add.length) setWhispers((w) => [...w.filter((x) => !add.some((y) => y.agent === x.agent)), ...add].slice(-4))
      }
    })
  }, [world])

  // whispers fade out by themselves
  useEffect(() => {
    if (!whispers.length) return
    const t = setTimeout(() => setWhispers((w) => w.slice(1)), 4200)
    return () => clearTimeout(t)
  }, [whispers])

  useEffect(() => {
    world.setView(nav.view)
  }, [world, nav.view])
  useEffect(() => {
    world.setDecision(decision?.id ?? null)
  }, [world, decision])
  useEffect(() => {
    world.setSheet(sheet && desktop ? 460 : 0)
  }, [world, sheet, desktop])

  // the cursor or a finger stirs the liquid
  useEffect(() => {
    if (!gpu) return
    const move = (e: PointerEvent) => world.stir(e.clientX, e.clientY)
    window.addEventListener('pointermove', move, { passive: true })
    return () => window.removeEventListener('pointermove', move)
  }, [world, gpu])

  const at = useCallback((key: string): Origin | undefined => {
    const p = world.posOf(key)
    return p ? { x: p.x, y: p.y } : undefined
  }, [world])

  const api = useMemo<FluxApi>(() => ({
    world,
    gpu,
    reduced,
    desktop,
    view: nav.view,
    openSwarm: (id, origin) => {
      world.rippleAt(`body:${id}`, 1.2)
      setNav({ view: { kind: 'swarm', id }, origin: origin ?? at(`body:${id}`) })
    },
    openMind: (id, origin) => {
      world.rippleAt(`drop:${id}`, 1)
      void useHive.getState().loadMessages(id).catch(() => undefined)
      setNav({ view: { kind: 'mind', id }, origin: origin ?? at(`drop:${id}`) })
    },
    openDecision: (id, origin) => setDecision({ id, origin: origin ?? at(`drip:${id}`) }),
    closeDecision: () => setDecision(null),
    home: () => setNav((n) => ({ view: { kind: 'home' }, origin: n.origin })),
    sheet,
    openSheet: (s) => {
      // on a phone the sheet takes the screen: the open panel drains first
      if (s && !desktop) setNav((n) => (n.view.kind === 'home' ? n : { view: { kind: 'home' }, origin: n.origin }))
      setSheet((prev) => (s ? { ...s, origin: s.origin ?? prev?.origin } : null))
    },
  }), [world, gpu, reduced, desktop, nav.view, at, sheet])

  // a surface's X lands on a clean home (home:requested): no sheet, decision or swarm pick open, the open body drained
  useHomeRequested(() => {
    setDecision(null)
    setSheet(null)
    usePickSwarm.getState().pick(null)
    setNav((n) => (n.view.kind === 'home' ? n : { view: { kind: 'home' }, origin: n.origin }))
  })

  // Escape drains the topmost glass
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      // a modal on top (a decision, Ω, Change UI, a classic dialog) takes its own Escape; the glass stays put
      if (e.key !== 'Escape' || e.defaultPrevented || modalLayers.size > 0 || useHive.getState().paletteOpen) return
      if (decision) setDecision(null)
      else if (sheet) setSheet(sheet.page === 'index' ? null : { page: 'index', origin: sheet.origin })
      else if (nav.view.kind === 'mind') {
        const a = useHive.getState().agents[nav.view.id]
        if (a?.swarm_id && useHive.getState().swarms[a.swarm_id]) api.openSwarm(a.swarm_id)
        else api.home()
      } else if (nav.view.kind === 'swarm') api.home()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [decision, nav.view, api, sheet])

  const v = nav.view
  return (
    <FluxCtx.Provider value={api}>
      <div className="fixed inset-0 overflow-hidden select-none" style={{ fontFamily: FONT, color: INK, background: '#0b0515', isolation: 'isolate' }}>
        <style>{FLUX_CSS}</style>
        <GooDefs />
        {gpu ? (
          <canvas ref={canvasRef} aria-hidden className="absolute inset-0 h-full w-full" style={{ touchAction: 'none' }} />
        ) : (
          <div ref={staticRef} aria-hidden className="absolute inset-0" />
        )}
        <Overlay whispers={desktop ? whispers : whispers.slice(-2)} quiet={!!decision || !!sheet} />
        <AnimatePresence>
          {v.kind === 'swarm' && <SwarmPanel key={`swarm-${v.id}`} id={v.id} origin={nav.origin} />}
          {v.kind === 'mind' && <MindPanel key={`mind-${v.id}`} id={v.id} origin={nav.origin} />}
        </AnimatePresence>
        <AnimatePresence>{sheet && <Sheet key="sheet" sheet={sheet} />}</AnimatePresence>
        <AnimatePresence>
          {decision?.id && <DecisionCard key={`d-${decision.id}`} id={decision.id} origin={decision.origin} />}
          {decision && !decision.id && <NothingCard key="nothing" onClose={() => setDecision(null)} />}
        </AnimatePresence>
        {picking && <HiveDirectory experience="flux" initialPick={picking} onClose={() => usePickSwarm.getState().pick(null)} />}
        <Pill onDecisions={() => {
          const first = Object.values(useHive.getState().approvals).filter((a) => a.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at))[0]
          setDecision(first ? { id: first.id, origin: at(`drip:${first.id}`) } : { id: null })
        }} />
      </div>
    </FluxCtx.Provider>
  )
}

// ---------------------------------------------------------------- overlay: labels and touch targets over the liquid

function Overlay({ whispers, quiet }: { whispers: Whisper[]; quiet: boolean }) {
  const { view, desktop, gpu, openSheet } = useFlux()
  const swarms = useHive((s) => s.swarms)
  const agents = useHive((s) => s.agents)
  const thinking = useHive((s) => s.thinking)
  const approvals = useHive((s) => s.approvals)
  const hive = useHive((s) => s.hive)
  const [hot, setHot] = useState<string | null>(null)
  const swarmList = useMemo(() => Object.values(swarms).sort((a, b) => a.created_at.localeCompare(b.created_at)), [swarms])
  const agentList = useMemo(() => Object.values(agents), [agents])
  const pending = useMemo(() => Object.values(approvals).filter((a) => a.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, 7), [approvals])
  const awake = agentList.filter((a) => a.status === 'awake').length
  const busy = agentList.filter((a) => a.status === 'awake' && (thinking[a.id] === 'llm' || thinking[a.id] === 'skills')).length
  const home = view.kind === 'home'
  const empty = swarmList.length === 0 && agentList.length === 0

  return (
    <div className="pointer-events-none absolute inset-0">
      <m.header
        data-flux-occlude=""
        data-xc-keep-clear=""
        className={`absolute ${desktop ? 'top-6 left-8' : 'top-[62px] left-5'}`}
        animate={{ opacity: (home || desktop) && !quiet ? 1 : 0, y: home ? 0 : -8 }}
        transition={{ duration: 0.4 }}
      >
        <h1 className={`${desktop ? 'text-[30px]' : 'text-[22px]'} font-semibold tracking-[-0.015em]`} style={{ textShadow: '0 2px 18px rgb(10 4 20 / 0.9)' }}>{hive?.name ? shown(hive.name) : 'OmegaHive'}</h1>
        <p className="text-[14px]" style={{ color: INK2, textShadow: '0 1px 10px rgb(10 4 20 / 0.95)' }}>
          {agentList.length} {agentList.length === 1 ? 'mind' : 'minds'} · {awake} awake{busy ? ` · ${busy} thinking` : ''}
        </p>
      </m.header>

      {empty && (
        <div className="absolute inset-0 grid place-items-center px-8 text-center">
          <div className="pointer-events-auto">
            <p className="text-[34px] font-semibold tracking-[-0.01em]">The hive is still</p>
            <p className="mt-2 text-[16px]" style={{ color: INK2 }}>No minds yet. The first one becomes the first drop.</p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              <button type="button" onClick={() => openClassic({ name: 'launch' })} className="flux-focus rounded-full px-6 py-3 text-[16px] font-semibold" style={{ color: '#170a22', background: 'radial-gradient(circle at 30% 20%, #fff, #f3a6ff 70%)', boxShadow: '0 0 30px rgb(240 140 255 / 0.4)' }}>
                Start a swarm
              </button>
              <button type="button" onClick={() => openSheet({ page: 'create' })} className="flux-focus rounded-full px-6 py-3 text-[16px] font-semibold" style={{ color: INK, background: 'rgb(255 255 255 / 0.1)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.2)' }}>
                Bring a mind to life
              </button>
            </div>
          </div>
        </div>
      )}

      {swarmList.map((s) => {
        const members = agentList.filter((a) => a.swarm_id === s.id)
        const thinkingNames = members.filter((a) => a.status === 'awake' && (thinking[a.id] === 'llm' || thinking[a.id] === 'skills')).map((a) => shown(a.name))
        const open = view.kind === 'swarm' && view.id === s.id
        return (
          <BodyNode key={s.id} id={s.id} name={shown(s.name)} count={members.length} awake={members.filter((a) => a.status === 'awake').length} thinking={thinkingNames} hidden={open} compact={!home && !desktop} labelled={home || desktop} onHot={setHot} />
        )
      })}

      {agentList.map((a) => {
        const inPanel = (view.kind === 'swarm' && a.swarm_id === view.id) || (view.kind === 'mind' && view.id === a.id)
        return <DropNode key={a.id} agent={a} thinking={thinking[a.id]} hidden={inPanel} named={(hot === a.swarm_id && !!a.swarm_id) || (!a.swarm_id && home)} onHot={setHot} />
      })}

      <AnimatePresence>
        {pending.map((p, i) => <DripNode key={p.id} id={p.id} agent={agents[p.agent_id]} skill={p.skill} index={i} />)}
      </AnimatePresence>

      <AnimatePresence>
        {gpu && (home || desktop) && whispers.map((w) => agents[w.agent] && !(view.kind === 'swarm' && agents[w.agent].swarm_id === view.id) && !(view.kind === 'mind' && view.id === w.agent) && <WhisperNode key={w.id} w={w} agent={agents[w.agent]} />)}
      </AnimatePresence>
    </div>
  )
}

function BodyNode({ id, name, count, awake, thinking, hidden, compact, labelled, onHot }: { id: string; name: string; count: number; awake: number; thinking: string[]; hidden: boolean; compact: boolean; labelled: boolean; onHot: (id: string | null) => void }) {
  const { world, openSwarm } = useFlux()
  const ref = useNode(`body:${id}`)
  const label = useNode(`label:${id}`)
  const hot = (on: boolean) => {
    world.setHover(on ? `body:${id}` : null)
    onHot(on ? id : null)
  }
  const line = thinking.length ? `${thinking.slice(0, 2).join(' and ')}${thinking.length > 2 ? ` +${thinking.length - 2}` : ''} thinking` : `${count} ${count === 1 ? 'mind' : 'minds'} · ${awake} awake`
  return (
    <>
      <div ref={ref} className="absolute top-0 left-0" style={{ width: 0, height: 0 }}>
        {!hidden && (
          <button
            type="button"
            data-presence-ref={`swarm:${id}`}
            aria-label={`Open ${name}: ${count} ${count === 1 ? 'mind' : 'minds'}, ${awake} awake${thinking.length ? `, ${thinking.length} thinking` : ''}`}
            onClick={(e) => openSwarm(id, { x: e.clientX || world.posOf(`body:${id}`)!.x, y: e.clientY || world.posOf(`body:${id}`)!.y })}
            onPointerEnter={() => hot(true)}
            onPointerLeave={() => hot(false)}
            onFocus={() => hot(true)}
            onBlur={() => hot(false)}
            className="flux-focus flux-hit pointer-events-auto absolute rounded-full"
            style={{ width: 'calc(var(--r) * 2.3)', height: 'calc(var(--r) * 2.3)', left: 'calc(var(--r) * -1.15)', top: 'calc(var(--r) * -1.15)', touchAction: 'none' }}
          />
        )}
      </div>
      <div ref={label} className="absolute top-0 left-0" style={{ width: 0, height: 0 }}>
        <m.div
          className="absolute left-0 w-max max-w-[260px] -translate-x-1/2 text-center"
          style={{ top: compact ? 'calc(var(--r) * 1.55)' : 'calc(var(--r) * 1.75 + 6px)' }}
          animate={{ opacity: hidden || !labelled ? 0 : 1, scale: hidden ? 0.9 : 1 }}
          transition={{ duration: 0.35 }}
        >
          <div className={`${compact ? 'text-[13px]' : 'text-[24px]'} font-semibold tracking-[-0.01em]`} style={{ textShadow: '0 2px 16px rgb(10 4 20 / 0.95), 0 0 2px rgb(10 4 20 / 0.8)' }}>{name}</div>
          {!compact && <div className="text-[14px]" style={{ color: INK2, textShadow: '0 1px 10px rgb(10 4 20 / 0.95), 0 0 2px rgb(10 4 20 / 0.9)' }}>{line}</div>}
        </m.div>
      </div>
    </>
  )
}

function DropNode({ agent: a, thinking, hidden, named, onHot }: { agent: Agent; thinking?: string; hidden: boolean; named: boolean; onHot: (id: string | null) => void }) {
  const { world, openMind } = useFlux()
  const ref = useNode(`drop:${a.id}`)
  const [hover, setHover] = useState(false)
  const busy = a.status === 'awake' && (thinking === 'llm' || thinking === 'skills')
  const hot = (on: boolean) => {
    setHover(on)
    world.setHover(on ? `drop:${a.id}` : a.swarm_id ? `body:${a.swarm_id}` : null)
    if (a.swarm_id) onHot(on ? a.swarm_id : null)
  }
  const state = a.status === 'awake' ? (busy ? 'thinking' : 'awake') : a.status === 'starting' ? 'waking' : a.status === 'error' ? 'needs attention' : a.status
  return (
    <div ref={ref} className="absolute top-0 left-0" style={{ width: 0, height: 0 }}>
      {!hidden && (
        <>
          <button
            type="button"
            data-presence-ref={`mind:${a.id}`}
            aria-label={`Talk to ${shown(a.name)} (${state})`}
            onClick={() => openMind(a.id)}
            onPointerEnter={() => hot(true)}
            onPointerLeave={() => hot(false)}
            onFocus={() => hot(true)}
            onBlur={() => hot(false)}
            className="flux-focus flux-hit pointer-events-auto absolute rounded-full"
            style={{ width: 'max(42px, calc(var(--r) * 2.1))', height: 'max(42px, calc(var(--r) * 2.1))', left: 'min(-21px, calc(var(--r) * -1.05))', top: 'min(-21px, calc(var(--r) * -1.05))', touchAction: 'none' }}
          />
          <AnimatePresence>
            {(named || hover) && (
              <m.div
                data-flux-label={hover ? 'hot' : ''}
                className="absolute left-0 -translate-x-1/2 rounded-full px-2.5 py-0.5 text-[13px] font-semibold whitespace-nowrap"
                style={{ top: 'calc(var(--r) + 6px)', background: 'rgb(14 6 26 / 0.72)', boxShadow: 'inset 0 0 0 1px rgb(255 255 255 / 0.14)', color: INK }}
                initial={{ opacity: 0, y: -6, scale: 0.8 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -4, scale: 0.85 }}
                transition={{ type: 'spring', stiffness: 400, damping: 26 }}
              >
                {shown(a.name)}
                <span className="ml-1.5 font-normal" style={{ color: INK2 }}>{state}</span>
              </m.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  )
}

function DripNode({ id, agent, skill, index }: { id: string; agent?: Agent; skill: string; index: number }) {
  const { openDecision, gpu } = useFlux()
  const ref = useNode(`drip:${id}`)
  return (
    <div ref={ref} className="absolute top-0 left-0" style={{ width: 0, height: 0 }}>
      <m.button
        type="button"
        // the waiting decisions hang from the top edge: host notices keep clear of them (request Q)
        data-xc-keep-clear=""
        aria-label={`Decision needed: ${agent ? shown(agent.name) : 'a mind'} wants to use ${skill}`}
        onClick={(e) => openDecision(id, { x: e.clientX, y: e.clientY })}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="flux-focus flux-hit group pointer-events-auto absolute -top-[24px] -left-[22px] size-[44px] rounded-full"
      >
        {!gpu && <span className="absolute inset-[8px]"><Orb hue={agent?.hue ?? 320} size={28} /></span>}
        {index === 0 && (
          <span className="pointer-events-none absolute top-[48px] left-1/2 -translate-x-1/2 rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" style={{ background: 'rgb(14 6 26 / 0.8)', color: INK }}>
            {agent ? shown(agent.name) : 'A mind'} asks · {skill}
          </span>
        )}
      </m.button>
    </div>
  )
}

function WhisperNode({ w, agent }: { w: Whisper; agent: Agent }) {
  const ref = useNode(`drop:${agent.id}#w${w.id}`)
  const c = hslRgb(agent.hue, 90, 82)
  return (
    <div ref={ref} className="absolute top-0 left-0" style={{ width: 0, height: 0 }} aria-hidden>
      <m.div
        className="absolute bottom-[calc(var(--r)+10px)] left-0 w-max max-w-[min(300px,60vw)] -translate-x-1/2 text-center text-[14px] font-medium leading-snug"
        style={{ color: rgbCss(c), textShadow: '0 1px 12px rgb(10 4 20 / 1), 0 0 3px rgb(10 4 20 / 0.9)' }}
        initial={{ opacity: 0, y: 12, filter: 'blur(8px)', scale: 0.9 }}
        animate={{ opacity: 1, y: -6, filter: 'blur(0px)', scale: 1 }}
        exit={{ opacity: 0, y: -26, filter: 'blur(10px)' }}
        transition={{ type: 'spring', stiffness: 120, damping: 18 }}
      >
        <span className="line-clamp-2">{w.text}</span>
      </m.div>
    </div>
  )
}

// ---------------------------------------------------------------- the floating liquid pill

function Pill({ onDecisions }: { onDecisions: () => void }) {
  const { world, gpu, home, view, desktop, sheet, openSheet } = useFlux()
  const approvals = useHive((s) => s.approvals)
  const n = countPending(approvals)
  const ref = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<string | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !gpu) return
    world.glass.set('pill', { el, radius: 999 })
    return () => { world.glass.delete('pill') }
  }, [world, gpu])
  const origin = (e: { currentTarget: HTMLElement }) => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }
  const items: { k: string; label: string; icon: string; run: (e: { currentTarget: HTMLElement }) => void; active?: boolean; hint?: string; badge?: number; text?: boolean }[] = [
    { k: 'home', label: 'Hive', icon: 'home', run: () => (openSheet(null), home()), active: view.kind === 'home' && !sheet },
    ...(desktop ? [{ k: 'search', label: 'Search', icon: 'search', run: openPalette }] : []),
    { k: 'decide', label: n ? `${n} ${n === 1 ? 'decision' : 'decisions'}` : 'Decisions', icon: 'drop', run: onDecisions, badge: n },
    { k: 'new', label: 'New mind', icon: 'plus', run: (e) => openSheet({ page: 'create', swarm: view.kind === 'swarm' ? view.id : null, origin: origin(e) }), active: sheet?.page === 'create', text: true },
    { k: 'swarm', label: 'New swarm', icon: 'swarm', run: () => openClassic({ name: 'launch' }), text: true },
    { k: 'all', label: 'Everything', icon: 'grid', run: (e) => openSheet(sheet ? null : { page: 'index', origin: origin(e) }), active: !!sheet && sheet.page !== 'create' },
  ]
  return (
    <m.nav
      ref={ref}
      aria-label="Flux"
      data-flux-occlude=""
      data-xc-keep-clear=""
      initial={{ y: 80, opacity: 0, scaleX: 0.6 }}
      animate={{ y: 0, opacity: 1, scaleX: 1 }}
      transition={{ type: 'spring', stiffness: 160, damping: 16, delay: 0.3 }}
      className={`absolute z-50 flex items-center rounded-full ${desktop ? 'gap-1 p-1.5' : 'gap-0.5 p-1'}`}
      style={{
        // above the home indicator; on a phone, centred in the room right of the Ω corner (never under it)
        bottom: 'calc(16px + var(--sab, 0px))',
        left: desktop ? '50%' : 'calc(50% + 24px + env(safe-area-inset-left, 0px) / 2 - var(--os-clock-room, 0px) / 2)',
        maxWidth: desktop ? undefined : 'calc(100vw - 64px - env(safe-area-inset-left, 0px) - var(--os-clock-room, 0px))',
        x: '-50%',
        background: gpu ? 'transparent' : 'rgb(28 14 48 / 0.85)',
        backdropFilter: gpu ? undefined : 'blur(20px)',
        boxShadow: gpu ? undefined : 'inset 0 1px 0 rgb(255 255 255 / 0.25), inset 0 0 0 1px rgb(255 255 255 / 0.1), 0 20px 50px rgb(0 0 0 / 0.5)',
      }}
      onPointerLeave={() => setHover(null)}
    >
      {items.map((it) => {
        const lit = hover === it.k || (!hover && it.active)
        const wide = desktop || it.k === 'decide'
        const sweep = it.k === 'all' ? 'nav' : it.k === 'decide' ? 'decide' : it.k === 'swarm' ? 'nav-new-swarm' : undefined
        return (
          <button
            key={it.k}
            type="button"
            data-sweep={sweep}
            data-flux-decide={it.k === 'decide' ? '' : undefined}
            data-presence-feature={it.k === 'decide' ? 'decide.approvals' : undefined}
            aria-expanded={it.k === 'all' ? !!sheet : undefined}
            onClick={it.run}
            onPointerEnter={() => setHover(it.k)}
            onFocus={() => setHover(it.k)}
            aria-label={it.label}
            title={it.label}
            className={`flux-focus relative flex h-11 items-center justify-center gap-2 rounded-full text-[15px] font-semibold ${desktop ? 'px-3.5' : 'shrink px-2.5'}`}
            // on a phone the five share the room between Ω and the OS clock (44 px each where it fits, a little less on the narrowest)
            style={{ color: lit ? '#160a22' : INK, minWidth: desktop ? 44 : 'min(44px, calc((100vw - 64px - var(--os-clock-room, 0px) - 16px) / 5))' }}
          >
            {lit && <m.span layoutId="flux-pill-blob" className="absolute inset-0 rounded-full" style={{ background: 'radial-gradient(circle at 35% 20%, #fff, #f0c8ff 55%, #c9a2ff)', boxShadow: '0 0 22px rgb(230 170 255 / 0.55)' }} transition={{ type: 'spring', stiffness: 420, damping: 28, mass: 0.8 }} />}
            <span className="relative"><Glyph name={it.icon} size={19} stroke={2.1} /></span>
            <AnimatePresence initial={false}>
              {desktop && (it.text || hover === it.k) ? (
                <m.span key="l" className="relative overflow-hidden whitespace-nowrap tabular-nums" initial={{ width: 0, opacity: 0 }} animate={{ width: 'auto', opacity: 1 }} exit={{ width: 0, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 34 }}>
                  {it.label}
                </m.span>
              ) : wide && it.badge ? (
                <span key="b" className="relative tabular-nums">{it.badge}</span>
              ) : null}
            </AnimatePresence>
            {it.k === 'decide' && !!it.badge && !lit && <m.span aria-hidden className="absolute top-1.5 right-2 size-2 rounded-full" style={{ background: '#ff8fd0', boxShadow: '0 0 10px #ff8fd0' }} animate={{ scale: [1, 1.5, 1] }} transition={{ duration: 1.6, repeat: Infinity }} />}
          </button>
        )
      })}
    </m.nav>
  )
}

const FLUX_CSS = `
.flux-focus:focus-visible { outline: 2.5px solid #ffd6fb; outline-offset: 3px; }
@media (pointer: coarse) { button.flux-focus, a.flux-focus, .flux-hit { min-height: 44px; min-width: 44px; } }
.flux-hit:focus-visible { outline: 2.5px solid #ffd6fb; outline-offset: 2px; box-shadow: 0 0 0 6px rgb(255 214 251 / 0.25); }
.flux-hit { cursor: pointer; background: transparent; -webkit-tap-highlight-color: transparent; }
.flux-hscroll { scrollbar-width: none; }
.flux-hscroll::-webkit-scrollbar { display: none; }
.flux-field { color: #f8f3ff; background: rgb(255 255 255 / 0.08); box-shadow: inset 0 1px 0 rgb(255 255 255 / 0.14), inset 0 0 0 1px rgb(255 255 255 / 0.14); outline: none; transition: box-shadow .2s; }
.flux-field::placeholder { color: #c8bddb; }
.flux-field:focus, .flux-field:focus-within { box-shadow: inset 0 0 0 2px #ffd6fb, 0 0 18px rgb(255 160 230 / 0.25); }
.flux-field[aria-invalid='true'] { box-shadow: inset 0 0 0 2px #ff9fb2; }
.flux-select { appearance: none; -webkit-appearance: none; color-scheme: dark; padding-right: 40px; background: rgb(255 255 255 / 0.08) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8'%3E%3Cpath d='M1 1.5l5 5 5-5' fill='none' stroke='%23e4dcf2' stroke-width='1.8' stroke-linecap='round'/%3E%3C/svg%3E") no-repeat right 16px center; }
.flux-select option { background: #241136; color: #f8f3ff; }
`
