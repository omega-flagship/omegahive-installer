import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence } from 'framer-motion'
import { applyChrome, closeToHome, GoalDecision, openClassic, openPalette, shown, useHive, useHomeRequested, useIsDesktop, useReducedMotion, useRoute, type Agent, type Goal } from '../sdk'
import { chromeForMode } from './chrome'
import { HivePanel } from './HivePanel'
import { isAwake, useClock } from './data'
import { Engine, EngineCtx, lodFor, useEngine } from './engine'
import { CHAT_H, CHAT_W, computeLayout, DEC_GAP, DEC_H, FREE, LANE_HEAD, LANE_W, pendingDecisions, type Item, type Rect } from './layout'
import { BarBtn, Minimap, Search, SelectionBar, TopBar, Toolbar, type Entry, type Tool } from './overlays'
import { AddSticky, DecisionSticky, Lane, Target } from './parts'
import { GoalSlot, IslandSlot, LiveCursors, LiveLinks, MindSlot } from './slots'
import { sigAgents, sigGoals, sigSwarms } from './sig'
import { FONT, tokenStyle, type Mode } from './theme'
import { CSS } from './styles'
import { DecisionInspect } from './Inspect'
import { BoardOutline } from './BoardOutline'
import { buildOutline } from './outline'
import { withBusy } from './busy'
import { goalAsk, goalBarActions, type GoalAsk } from './goalAsk'
import { NO_MOTIVES } from './motives'
import { useMotivationData } from '../../lib/motivations'
import { plural } from '../../lib/plural'

const THEME_KEY = 'omegahive.canvas.mode'
const MAP_KEY = 'omegahive.canvas.minimap'
const readPref = (k: string, d: string) => {
  try {
    return localStorage.getItem(k) ?? d
  } catch {
    return d
  }
}
const writePref = (k: string, v: string) => {
  try {
    localStorage.setItem(k, v)
  } catch {
    /* private mode */
  }
}

/**
 * The hive as of the given structural signatures (the arguments key the memo), with the store session it was read
 * under: a goal decision opened from it is bound to that session (Surface R).
 */
function snapshot(..._sigs: string[]) {
  const st = useHive.getState()
  return { agents: st.agents, swarms: st.swarms, goals: st.goals, session: st.session }
}


const isTyping = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))
const grow = (r: Rect, d: number): Rect => ({ x: r.x - d, y: r.y - d, w: r.w + d * 2, h: r.h + d * 2 })
const inside = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

export default function Experience() {
  const [engine] = useState(() => new Engine())
  return (
    <EngineCtx.Provider value={engine}>
      <Board engine={engine} />
    </EngineCtx.Provider>
  )
}

function Board({ engine }: { engine: Engine }) {
  const reduced = useReducedMotion()
  const desktop = useIsDesktop()
  // the motivations each task serves (chips on stickies, the outline and the selection bar): read once per session
  useMotivationData()
  const [mode, setMode] = useState<Mode>(() => (readPref(THEME_KEY, 'light') === 'dark' ? 'dark' : 'light'))
  const [mapOpen, setMapOpen] = useState(() => readPref(MAP_KEY, '1') === '1')
  const [tool, setTool] = useState<Tool>('select')
  const [spaceHand, setSpaceHand] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [openId, setOpenId] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [inspectId, setInspectId] = useState<string | null>(null)
  const [outlineOpen, setOutlineOpen] = useState(false)
  const [hiveOpen, setHiveOpen] = useState(false)
  // Review D1: done, cancel, re-open and release are decided in the shared GoalDecision, never one tap on the board
  const [goalAsking, setGoalAsking] = useState<GoalAsk | null>(null)
  const [aspect, setAspect] = useState(() => Math.round((window.innerWidth / Math.max(1, window.innerHeight)) * 10) / 10)
  // a surface's X lands on the plain board (home:requested): no chat, inspection, search, hive panel, outline or draft open
  useHomeRequested(() => {
    setInspectId(null)
    setSearchOpen(false)
    setHiveOpen(false)
    setOutlineOpen(false)
    setDraft(null)
    setOpenId(null)
    setGoalAsking(null)
    setSelected(null)
  })
  const rootRef = useRef<HTMLDivElement>(null)
  const pointers = useRef(0)
  const worldRef = useRef<HTMLDivElement>(null)

  const ready = useHive((s) => s.ready)
  const connection = useHive((s) => s.connection)
  // The board re-renders only when its structure changes (signatures), never on chatter.
  const agentSig = useHive((s) => sigAgents(s.agents))
  const swarmSig = useHive((s) => sigSwarms(s.swarms))
  const goalSig = useHive((s) => sigGoals(s.goals))
  const sessionSig = useHive((s) => s.session)
  const approvals = useHive((s) => s.approvals)
  const now = useClock(15_000)

  const snap = useMemo(() => snapshot(agentSig, swarmSig, goalSig, sessionSig), [agentSig, swarmSig, goalSig, sessionSig])
  const { agents, swarms, goals } = snap
  const agentList = useMemo(() => Object.values(agents), [agents])
  const swarmList = useMemo(() => Object.values(swarms), [swarms])
  const goalList = useMemo(() => Object.values(goals), [goals])
  const decisions = useMemo(() => pendingDecisions(approvals), [approvals])
  const layout = useMemo(() => computeLayout(agentList, swarmList, goalList, decisions, aspect), [agentList, swarmList, goalList, decisions, aspect])
  const goalStats = useMemo(() => {
    const m = new Map<string, { all: number; open: number }>()
    for (const g of goalList) {
      const e = m.get(g.swarm_id) ?? { all: 0, open: 0 }
      e.all++
      if (g.status !== 'done' && g.status !== 'cancelled' && g.status !== 'failed') e.open++
      m.set(g.swarm_id, e)
    }
    return m
  }, [goalList])

  const lod = useEngine((e) => lodFor(e.z))
  const visKey = useEngine((e) => {
    let k = ''
    for (const it of layout.items.values()) if ((it.kind === 'mind' || it.kind === 'goal' || it.kind === 'add') && e.visible(it)) k += it.key + '|'
    return k
  })
  const vis = useMemo(() => new Set(visKey.split('|')), [visKey])

  // ---------------------------------------------------------------- engine wiring
  useEffect(() => {
    engine.attach(rootRef.current, worldRef.current)
    const ro = new ResizeObserver(([e]) => {
      engine.resize(e.contentRect.width, e.contentRect.height)
      setAspect(Math.round((e.contentRect.width / Math.max(1, e.contentRect.height)) * 10) / 10)
    })
    if (rootRef.current) {
      ro.observe(rootRef.current)
      const r = rootRef.current.getBoundingClientRect()
      engine.resize(r.width, r.height)
    }
    // the root clips the board; focus moving to an offscreen card must never scroll it
    const root = rootRef.current
    const unscroll = () => {
      if (root && (root.scrollTop || root.scrollLeft)) {
        root.scrollTop = 0
        root.scrollLeft = 0
      }
    }
    root?.addEventListener('scroll', unscroll)
    engine.start()
    return () => {
      root?.removeEventListener('scroll', unscroll)
      ro.disconnect()
      engine.stop()
    }
  }, [engine])
  useEffect(() => {
    engine.configure(reduced, desktop ? { top: 64, right: hiveOpen ? 416 : 16, bottom: 84, left: outlineOpen ? 404 : 16 } : { top: 60, right: 10, bottom: 76, left: 10 })
  }, [engine, reduced, desktop, outlineOpen, hiveOpen])

  const fitAll = useCallback(
    (dur?: number) => engine.fitRect(layout.empty ?? layout.bounds, { pad: desktop ? 36 : 14, maxZ: 1, dur }),
    [engine, layout, desktop],
  )

  // first view: settle onto the whole hive with a short glide
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current || !ready) return
    fitted.current = true
    const r = layout.empty ?? layout.bounds
    const z = engine.fitZ(r, { pad: desktop ? 36 : 14, maxZ: 1 })
    const i = engine.insets
    engine.jumpTo(r.x + r.w / 2 - (i.left - i.right) / 2 / z, r.y + r.h / 2 - (i.top - i.bottom) / 2 / z, reduced ? z : z * 0.82)
    if (!reduced) requestAnimationFrame(() => requestAnimationFrame(() => fitAll(1100)))
    else fitAll(0)
  }, [ready, layout, engine, desktop, reduced, fitAll])

  // what each mind said and heard (message lists load once per mind; live events keep them fresh)
  useEffect(() => {
    if (!ready) return
    const st = useHive.getState()
    for (const a of Object.values(st.agents).slice(0, 80)) if (!st.messagesLoaded?.[a.id]) void st.loadMessages(a.id).catch(() => undefined)
  }, [ready])

  // ---------------------------------------------------------------- actions
  const flyToItem = useCallback(
    (key: string, opts: { maxZ?: number; pad?: number } = {}) => {
      const it = layout.items.get(key)
      if (!it) return
      if (it.kind === 'island') engine.fitRect(it, { pad: 30, maxZ: opts.maxZ ?? 1 })
      else if (it.kind === 'mind') engine.fitRect(grow(it, 120), { maxZ: opts.maxZ ?? 1.15, pad: opts.pad ?? 20 })
      else engine.fitRect(grow(it, 90), { maxZ: opts.maxZ ?? 1.25, pad: opts.pad ?? 20 })
    },
    [engine, layout],
  )

  const closeChat = useCallback(() => setOpenId(null), [])
  const openChat = useCallback(
    (id: string) => {
      const it = layout.items.get(`mind:${id}`)
      if (!it) return
      setOpenId(id)
      setSelected(`mind:${id}`)
      engine.fitRect({ x: it.x, y: it.y, w: CHAT_W, h: CHAT_H }, { pad: desktop ? 28 : 6, maxZ: desktop ? 1.2 : 1.1, dur: 560 })
    },
    [engine, layout, desktop],
  )

  const select = useCallback(
    (key: string) => {
      if (engine.dragged) return
      const it = layout.items.get(key)
      if (!it) return
      // a note never decides: choosing it opens the full request
      if (it.kind === 'decision') {
        setSelected(key)
        setInspectId(it.id)
        return
      }
      // at a distance a tap means "take me there"
      if (lodFor(engine.z) === 'far' && (it.kind === 'island' || it.kind === 'lane')) {
        flyToItem(key)
        setSelected(key)
        return
      }
      setSelected(key)
    },
    [engine, layout, flyToItem],
  )
  const selectMind = useCallback((id: string) => select(`mind:${id}`), [select])

  const onFocusItem = useCallback(
    (key: string) => {
      const it = layout.items.get(key)
      if (!it || engine.dragged) return
      const full = engine.visible(it, -0.06)
      if (!full || engine.z < 0.55) flyToItem(key, { maxZ: Math.max(engine.z, 0.9) })
    },
    [engine, layout, flyToItem],
  )

  const openInspect = useCallback((id: string) => {
    setSelected(`decision:${id}`)
    setInspectId(id)
  }, [])
  const closeInspect = useCallback(() => setInspectId(null), [])
  const decisionsFallback = useCallback(() => rootRef.current?.querySelector<HTMLElement>('[data-cv-decisions]') ?? null, [])
  const askGoal = useCallback((ask: GoalAsk) => setGoalAsking(ask), [])
  const closeGoalAsk = useCallback(() => setGoalAsking(null), [])
  // the opener can go with the change (Mark done becomes Reopen): focus returns to the goal on the board, else the outline
  const goalHome = useCallback(
    (opener: HTMLElement | null) => {
      if (opener?.isConnected) return opener
      const root = rootRef.current
      const id = goalAsking?.seen.id
      const el = id ? root?.querySelector<HTMLElement>(`[data-item="goal:${window.CSS.escape(id)}"]`) : null
      return (el && (el.tabIndex >= 0 ? el : el.querySelector<HTMLElement>('button, [tabindex="0"]'))) ?? root?.querySelector<HTMLElement>('[data-cv-outline-btn]') ?? null
    },
    [goalAsking],
  )

  /** Put keyboard focus on a board item once the camera has brought it on screen (it mounts when visible). */
  const focusItem = useCallback(
    (key: string) => {
      let n = 0
      const tick = () => {
        const root = rootRef.current
        if (!root) return
        const el = root.querySelector<HTMLElement>(`[data-item="${window.CSS.escape(key)}"]`)
        const target = el && (el.tabIndex >= 0 ? el : el.querySelector<HTMLElement>('button, [tabindex="0"]'))
        if (target && !engine.animating) return void target.focus({ preventScroll: true })
        if (++n < 240) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    },
    [engine],
  )

  const startDraft = useCallback(
    (islandId: string) => {
      setDraft(islandId)
      setTool('select')
      const it = layout.items.get(`add:${islandId}`)
      if (it && !engine.visible(it, -0.05)) engine.fitRect(grow(it, 160), { maxZ: Math.max(0.95, engine.z), pad: 20 })
      else if (engine.z < 0.7 && it) engine.fitRect(grow(it, 200), { maxZ: 1, pad: 20 })
    },
    [engine, layout],
  )
  const submitDraft = useCallback(async (swarmId: string, title: string) => {
    const g = await useHive.getState().createGoal(swarmId, { title })
    if (g) {
      setDraft(null)
      setSelected(`goal:${g.id}`)
      useHive.getState().toast({ tone: 'success', title: 'Task pinned', body: title })
      return true
    }
    return false
  }, [])

  const fitDecisions = useCallback(() => {
    const l = layout.lane
    if (layout.laneMode === 'row') engine.fitRect({ x: l.x, y: l.y + 10, w: Math.min(l.w, LANE_W + 10), h: l.h - 10 }, { maxZ: 1.1, pad: 8 })
    else engine.fitRect({ x: l.x, y: 0, w: l.w, h: Math.min(l.h, LANE_HEAD + Math.max(1, Math.min(3, decisions.length)) * (DEC_H + DEC_GAP)) }, { maxZ: 1.1, pad: 24 })
  }, [engine, layout, decisions.length])

  const toggleMode = () => {
    const next = mode === 'light' ? 'dark' : 'light'
    setMode(next)
    writePref(THEME_KEY, next)
    applyChrome(chromeForMode(next)) // shared windows follow the board
  }
  const toggleMap = () => {
    setMapOpen(!mapOpen)
    writePref(MAP_KEY, mapOpen ? '0' : '1')
  }

  // ---------------------------------------------------------------- semantic zoom: closing in on a mind opens its conversation
  useEffect(() => {
    let t = 0
    const check = () => {
      clearTimeout(t)
      t = window.setTimeout(() => {
        if (engine.animating || pointers.current > 0) return
        if (engine.z >= 1.5) {
          const c = engine.centreWorld
          for (const it of layout.items.values()) if (it.kind === 'mind' && inside(it, c.x, c.y)) return void setOpenId((cur) => cur ?? (setSelected(it.key), it.id))
        } else if (engine.z < 0.5) setOpenId(null)
      }, 260)
    }
    const off = engine.subscribe(check)
    return () => {
      off()
      clearTimeout(t)
    }
  }, [engine, layout])

  // ---------------------------------------------------------------- gestures
  const toolRef = useRef<Tool>(tool)
  const handRef = useRef(false)
  const handlers = useRef({ tap: (_x: number, _y: number, _item: string | null, _double: boolean) => {} })
  useEffect(() => {
    toolRef.current = tool
    handRef.current = tool === 'hand' || spaceHand
  }, [tool, spaceHand])

  useEffect(() => {
    handlers.current.tap = (sx, sy, item, double) => {
      const w = engine.toWorld(sx, sy)
      if (toolRef.current === 'sticky') {
        let best: Item | null = null
        let bestD = Infinity
        for (const it of layout.items.values()) {
          if (it.kind !== 'island' || it.id === FREE) continue
          const d = inside(it, w.x, w.y) ? 0 : Math.hypot(it.x + it.w / 2 - w.x, it.y + it.h / 2 - w.y)
          if (d < bestD) {
            bestD = d
            best = it
          }
        }
        if (best) startDraft(best.id)
        else useHive.getState().toast({ tone: 'info', title: 'No swarm to pin to', body: 'Tasks belong to a swarm. Launch one first.' })
        return
      }
      if (double) {
        if (item?.startsWith('mind:')) openChat(item.slice(5))
        else if (item) flyToItem(item)
        else engine.flyTo(w.x, w.y, engine.z * 2, 420)
        return
      }
      if (!item) {
        setSelected(null)
        setOpenId(null)
      }
    }
  }, [engine, layout, openChat, flyToItem, startDraft])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const pts = new Map<number, { x: number; y: number }>()
    let mode: 'none' | 'pending' | 'pan' | 'pinch' = 'none'
    let start = { x: 0, y: 0 }
    let downItem: string | null = null
    let pinch = { d: 1, mx: 0, my: 0 }
    let lastTap = { t: 0, x: 0, y: 0 }
    let vel = { x: 0, y: 0, t: 0 }
    const local = (e: MouseEvent) => {
      const r = root.getBoundingClientRect()
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }
    const pinchState = () => {
      const [a, b] = [...pts.values()]
      return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
    }
    const down = (e: PointerEvent) => {
      const t = e.target as Element
      if (t.closest('[data-chrome]')) return
      if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
      const hand = handRef.current || e.button === 1
      if (!hand && pts.size === 0 && t.closest('button, a, input, textarea, select, [data-nopan], [data-scroll]')) return
      engine.halt()
      const p = local(e)
      pts.set(e.pointerId, p)
      pointers.current = pts.size
      if (pts.size === 1) {
        engine.dragged = false
        start = p
        downItem = t.closest('[data-item]')?.getAttribute('data-item') ?? null
        mode = hand ? 'pan' : 'pending'
        vel = { x: 0, y: 0, t: performance.now() }
        if (hand) e.preventDefault()
      } else if (pts.size === 2) {
        mode = 'pinch'
        engine.dragged = true
        pinch = pinchState()
      }
    }
    const move = (e: PointerEvent) => {
      const prev = pts.get(e.pointerId)
      if (!prev) return
      const p = local(e)
      pts.set(e.pointerId, p)
      if (mode === 'pending' && Math.hypot(p.x - start.x, p.y - start.y) > (e.pointerType === 'touch' ? 8 : 4)) {
        mode = 'pan'
        engine.dragged = true
        root.dataset.panning = '1'
      }
      if (mode === 'pan' && pts.size === 1) {
        const dx = p.x - prev.x
        const dy = p.y - prev.y
        engine.panBy(dx, dy)
        const tt = performance.now()
        const dt = Math.max(1, tt - vel.t)
        vel = { x: vel.x * 0.6 + (dx / dt) * 0.4, y: vel.y * 0.6 + (dy / dt) * 0.4, t: tt }
        root.dataset.panning = '1'
      } else if (mode === 'pinch' && pts.size >= 2) {
        const n = pinchState()
        engine.zoomAt(n.mx, n.my, n.d / pinch.d)
        engine.panBy(n.mx - pinch.mx, n.my - pinch.my)
        pinch = n
      }
    }
    const up = (e: PointerEvent) => {
      if (!pts.has(e.pointerId)) return
      const p = pts.get(e.pointerId)!
      pts.delete(e.pointerId)
      pointers.current = pts.size
      if (mode === 'pinch' && pts.size === 1) {
        mode = 'pan'
        vel = { x: 0, y: 0, t: performance.now() }
        return
      }
      if (pts.size > 0) return
      delete root.dataset.panning
      if (mode === 'pending' && e.type === 'pointerup') {
        const tt = performance.now()
        // mouse double-clicks come from the native dblclick (OS timing); touch double-taps are detected here
        const dbl = e.pointerType !== 'mouse' && tt - lastTap.t < 360 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30
        lastTap = dbl ? { t: 0, x: 0, y: 0 } : { t: tt, x: p.x, y: p.y }
        handlers.current.tap(p.x, p.y, downItem, dbl)
      } else if (mode === 'pan' && performance.now() - vel.t < 60) engine.fling(vel.x, vel.y)
      mode = 'none'
      engine.settle()
    }
    const wheel = (e: WheelEvent) => {
      const t = e.target as Element
      if (t.closest('[data-chrome]')) return
      const sc = t.closest('[data-scroll]') as HTMLElement | null
      if (sc && !e.ctrlKey && sc.scrollHeight > sc.clientHeight + 1) return
      e.preventDefault()
      const p = local(e)
      let dx = e.deltaX
      let dy = e.deltaY
      if (e.deltaMode === 1) {
        dx *= 16
        dy *= 16
      }
      const mouseWheel = !e.ctrlKey && dx === 0 && Number.isInteger(dy) && Math.abs(dy) >= 50
      if (e.ctrlKey || e.metaKey || mouseWheel) engine.zoomAt(p.x, p.y, Math.exp(-dy * (e.ctrlKey ? 0.011 : 0.0022)))
      else engine.panBy(e.shiftKey ? -dy : -dx, e.shiftKey ? 0 : -dy)
    }
    let gScale = 1
    const gStart = (e: Event) => {
      e.preventDefault()
      gScale = 1
    }
    const gChange = (e: Event) => {
      e.preventDefault()
      const ge = e as Event & { scale: number; clientX: number; clientY: number }
      const r = root.getBoundingClientRect()
      engine.zoomAt(ge.clientX - r.left, ge.clientY - r.top, ge.scale / gScale)
      gScale = ge.scale
    }
    const dblclick = (e: MouseEvent) => {
      const t = e.target as Element
      if (t.closest('[data-chrome], button, a, input, textarea, select, [data-nopan], [data-scroll]')) return
      const p = local(e as PointerEvent)
      handlers.current.tap(p.x, p.y, t.closest('[data-item]')?.getAttribute('data-item') ?? null, true)
    }
    root.addEventListener('dblclick', dblclick)
    root.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move, { passive: true })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    root.addEventListener('wheel', wheel, { passive: false })
    root.addEventListener('gesturestart', gStart)
    root.addEventListener('gesturechange', gChange)
    return () => {
      root.removeEventListener('dblclick', dblclick)
      root.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      root.removeEventListener('wheel', wheel)
      root.removeEventListener('gesturestart', gStart)
      root.removeEventListener('gesturechange', gChange)
    }
  }, [engine])

  // ---------------------------------------------------------------- keyboard
  // Board keys are claimed in the capture phase (so the shell's "n" does not also fire; "/" and ⌘K are the universal
  // Ask's, and search is on the toolbar); Esc stays in the
  // bubble phase so a classic page or dialog above the board gets it first.
  const route = useRoute()
  const overlay = route.name !== 'hive'
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (overlay || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return
      if (useHive.getState().paletteOpen || searchOpen || inspectId || goalAsking) return
      // dialogs and the outline own their keys
      if (e.target instanceof Element && e.target.closest('[data-ownkeys]')) return
      const step = e.shiftKey ? 320 : 90
      switch (e.key) {
        case 'ArrowLeft': engine.panBy(step, 0); break
        case 'ArrowRight': engine.panBy(-step, 0); break
        case 'ArrowUp': engine.panBy(0, step); break
        case 'ArrowDown': engine.panBy(0, -step); break
        case '+': case '=': engine.zoomBy(1.3); break
        case '-': case '_': engine.zoomBy(1 / 1.3); break
        case '0': fitAll(); break
        case '1': engine.zoomBy(1 / engine.targetZ); break
        case 'v': case 'V': setTool('select'); break
        case 'h': case 'H': setTool('hand'); break
        case 'n': case 'N': setTool('sticky'); break
        case 'm': case 'M': toggleMap(); break
        case 'd': case 'D': fitDecisions(); break
        case 'o': case 'O': setOutlineOpen(true); requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.cv-outline button')?.focus()); break
        case 'Enter':
          if (!(e.target instanceof HTMLElement) || e.target === document.body || e.target === rootRef.current) {
            if (selected?.startsWith('mind:')) openChat(selected.slice(5))
            else if (selected?.startsWith('decision:')) openInspect(selected.slice(9))
            else if (selected) flyToItem(selected)
            else return
          } else return
          break
        case ' ':
          if (e.target instanceof HTMLButtonElement) return
          setSpaceHand(true)
          break
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || overlay) return
      // the goal decision owns its Esc (it closes itself); the board does not also act on it
      if (goalAsking) return
      if (inspectId) setInspectId(null)
      else if (searchOpen) setSearchOpen(false)
      else if (hiveOpen) setHiveOpen(false)
      else if (outlineOpen) setOutlineOpen(false)
      else if (draft) setDraft(null)
      else if (openId) setOpenId(null)
      else if (tool !== 'select') setTool('select')
      else setSelected(null)
    }
    const ku = (e: KeyboardEvent) => {
      if (e.key === ' ') setSpaceHand(false)
    }
    window.addEventListener('keydown', kd, true)
    window.addEventListener('keydown', esc)
    window.addEventListener('keyup', ku)
    return () => {
      window.removeEventListener('keydown', kd, true)
      window.removeEventListener('keydown', esc)
      window.removeEventListener('keyup', ku)
    }
  })

  // ---------------------------------------------------------------- derived view data
  const coordName = (sid: string) => {
    const c = swarms[sid]?.coordinator_id
    return c && agents[c] ? agents[c].name : null
  }
  const awakeList = useMemo(() => agentList.filter(isAwake).sort((a, b) => a.name.localeCompare(b.name)), [agentList])

  const getEntries = useCallback((): Entry[] => {
    const out: Entry[] = []
    for (const i of layout.islands) out.push({ key: `island:${i.id}`, label: shown(i.name), sub: plural(i.members.length, 'mind'), kind: 'Swarm', hue: i.hue })
    for (const a of agentList) out.push({ key: `mind:${a.id}`, label: shown(a.name), sub: `${a.swarm_id && swarms[a.swarm_id] ? shown(swarms[a.swarm_id].name) : 'Unassigned'} · ${a.status}`, kind: 'Mind', hue: a.hue })
    for (const i of layout.islands) for (const g of i.goals) if (goals[g]) out.push({ key: `goal:${g}`, label: goals[g].title, sub: shown(i.name), kind: 'Task', hue: i.hue })
    for (const d of decisions) out.push({ key: `decision:${d.id}`, label: `${d.skill}: ${d.command}`, sub: `${shown(agents[d.agent_id]?.name ?? 'A mind')} · ${d.risk} risk`, kind: 'Decision', hue: null })
    return out
  }, [layout, agentList, swarms, goals, decisions, agents])
  const entries = useMemo(() => (searchOpen ? getEntries() : []), [searchOpen, getEntries])

  const outline = useMemo(() => buildOutline(agents, swarms, goals, approvals, (k) => layout.items.has(k)), [agents, swarms, goals, approvals, layout])

  const selItem = selected ? layout.items.get(selected) : undefined
  const focusMind = selected?.startsWith('mind:') ? selected.slice(5) : selected?.startsWith('decision:') ? approvals[selected.slice(9)]?.agent_id ?? null : null

  const hand = tool === 'hand' || spaceHand

  return (
    <div
      ref={rootRef}
      className={`cv-root fixed inset-0 isolate overflow-hidden select-none ${hand ? 'cv-hand' : ''} ${tool === 'sticky' ? 'cv-place' : ''}`}
      style={{
        ...tokenStyle(mode),
        fontFamily: FONT,
        background: 'var(--paper)',
        backgroundImage: 'radial-gradient(circle at 1px 1px, var(--dot) 1.1px, transparent 1.4px)',
        color: 'var(--ink)',
        touchAction: 'none',
        colorScheme: mode,
        fontFeatureSettings: "'cv11', 'ss01', 'ss03'",
        WebkitFontSmoothing: 'antialiased',
      }}
    >
      <style>{CSS}</style>
      <BoardOutline
        outline={outline}
        open={outlineOpen}
        onClose={() => {
          const root = rootRef.current
          // opened from the toolbar: back to its button; reached by Tab: on to the first thing on the board
          const to = outlineOpen ? root?.querySelector<HTMLElement>('[data-cv-outline-btn]') : root?.querySelector<HTMLElement>('.cv-world [data-item][tabindex="0"], .cv-world button') ?? root?.querySelector<HTMLElement>('[data-cv-outline-btn]')
          setOutlineOpen(false)
          to?.focus({ preventScroll: true })
        }}
        onLocate={(k) => {
          if (!desktop) setOutlineOpen(false)
          setSelected(k)
          flyToItem(k)
          focusItem(k)
        }}
        onInspect={openInspect}
        onDecideGoal={(id, to) => {
          const g = snap.goals[id]
          if (g) askGoal(goalAsk(g, to, snap.session))
        }}
        onTalk={(id) => {
          if (!desktop) setOutlineOpen(false)
          openChat(id)
        }}
        onAddGoal={(id) => {
          if (!desktop) setOutlineOpen(false)
          startDraft(id)
        }}
      />
      <div ref={worldRef} className="cv-world absolute top-0 left-0" style={{ transformOrigin: '0 0', width: 0, height: 0 }}>
        {layout.islands.map((i) => (
          <IslandSlot
            key={i.id}
            box={i}
            members={i.members.map((id) => agents[id]).filter(Boolean) as Agent[]}
            goalCount={goalStats.get(i.id)?.all ?? 0}
            openGoals={goalStats.get(i.id)?.open ?? 0}
            coordinator={coordName(i.id)}
            mode={mode}
            lod={lod}
            selected={selected === `island:${i.id}`}
            onSelect={select}
            onFocusItem={onFocusItem}
          />
        ))}
        <Lane r={layout.lane} lod={lod} count={decisions.length} mode={mode} />
        {layout.empty && <EmptyBoard r={layout.empty} lod={lod} />}

        {lod !== 'far' && <LiveLinks layout={layout} reduced={reduced} focus={focusMind} />}

        {lod !== 'far' &&
          [...layout.items.values()].map((it) => {
            if (it.kind === 'mind') {
              if (!vis.has(it.key) && openId !== it.id) return null
              return (
                <MindSlot
                  key={it.key}
                  it={it}
                  lod={lod}
                  now={now}
                  selected={selected === it.key}
                  open={openId === it.id}
                  reduced={reduced}
                  onSelect={selectMind}
                  onOpen={openChat}
                  onCloseX={closeToHome}
                  onDismiss={closeChat}
                  onFocusItem={onFocusItem}
                />
              )
            }
            if (it.kind === 'goal') {
              if (!vis.has(it.key)) return null
              return <GoalSlot key={it.key} it={it} lod={lod} selected={selected === it.key} mode={mode} onSelect={select} onFocusItem={onFocusItem} />
            }
            if (it.kind === 'add') {
              if (!vis.has(it.key) && draft !== it.id) return null
              return <AddSticky key={it.key} r={it} lod={lod} drafting={draft === it.id} reduced={reduced} draftKey={`canvas:sticky:${it.id}`} onStart={() => startDraft(it.id)} onCancel={() => setDraft(null)} onSubmit={(t) => submitDraft(it.id, t)} />
            }
            return null
          })}

        <div style={{ display: lod === 'far' ? 'none' : undefined }}>
          <AnimatePresence initial={false}>
            {decisions.map((d) => {
              const it = layout.items.get(`decision:${d.id}`)
              if (!it) return null
              return <DecisionSticky key={d.id} r={it} approval={d} agent={agents[d.agent_id] ?? null} lod={lod} now={now} selected={selected === it.key} reduced={reduced} onSelect={select} onInspect={openInspect} onFocusItem={onFocusItem} />
            })}
          </AnimatePresence>
        </div>

        {selItem && lod !== 'far' && !(selItem.kind === 'mind' && openId === selItem.id) && (
          <SelectionBar key={selItem.key} r={selItem} label={`Actions for the selected ${selItem.kind === 'island' ? 'swarm' : selItem.kind === 'goal' ? 'task' : selItem.kind}`}>
            <SelectionActions item={selItem} openChat={openChat} startDraft={startDraft} flyToItem={flyToItem} openInspect={openInspect} askGoal={askGoal} />
          </SelectionBar>
        )}
      </div>

      <LiveCursors layout={layout} reduced={reduced} lod={lod} />

      <TopBar
        awake={awakeList}
        pending={decisions.length}
        connection={connection}
        mode={mode}
        onMode={toggleMode}
        onDecisions={fitDecisions}
        onFollow={(id) => {
          setSelected(`mind:${id}`)
          flyToItem(`mind:${id}`, { maxZ: 1.1 })
        }}
        onPalette={openPalette}
        hiveOpen={hiveOpen}
        onHive={() => {
          setHiveOpen(!hiveOpen)
          if (!desktop) setOutlineOpen(false)
        }}
        compact={!desktop}
      />
      <Toolbar
        tool={tool}
        setTool={setTool}
        onSearch={() => setSearchOpen(true)}
        onFit={() => fitAll()}
        compact={!desktop}
        mapOpen={mapOpen}
        onMap={toggleMap}
        outlineOpen={outlineOpen}
        onLaunch={() => openClassic({ name: 'launch' })}
        onNewMind={() => openClassic({ name: 'new' })}
        onOutline={() => {
          const next = !outlineOpen
          setOutlineOpen(next)
          if (next && !desktop) setHiveOpen(false)
          if (next) requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.cv-outline button')?.focus())
        }}
      />
      {desktop && mapOpen && <Minimap layout={layout} mode={mode} />}
      {hiveOpen && (
        <HivePanel
          selectedMind={selected?.startsWith('mind:') ? selected.slice(5) : null}
          onClose={() => {
            setHiveOpen(false)
            requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('[data-cv-hive-btn]')?.focus({ preventScroll: true }))
          }}
          onBoard={(id) => {
            if (id === 'decide.approvals') fitDecisions()
            else if (id === 'hive.search') setSearchOpen(true)
            else if (id === 'minds.talk' || id === 'minds.wake' || id === 'work.goals') {
              setOutlineOpen(true)
              requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.cv-outline button')?.focus())
            } else fitAll()
          }}
        />
      )}
      <Search
        open={searchOpen}
        entries={entries}
        onClose={() => setSearchOpen(false)}
        onPick={(k) => {
          setSearchOpen(false)
          setSelected(k)
          flyToItem(k)
          if (k.startsWith('decision:')) openInspect(k.slice(9))
          else focusItem(k)
        }}
      />
      {tool === 'sticky' && (
        <div data-chrome className="pointer-events-none absolute top-[68px] left-1/2 -translate-x-1/2 rounded-full px-3.5 py-1.5 text-[13px] font-medium" style={{ zIndex: 40, background: 'var(--ink)', color: 'var(--paper)', boxShadow: 'var(--shadow)' }}>
          Tap a swarm to pin a task · Esc to cancel
        </div>
      )}
      {!ready && (
        <div className="absolute inset-0 grid place-items-center text-[14px]" style={{ color: 'var(--ink-3)' }}>
          Laying out the canvas…
        </div>
      )}
      <div className="sr-only" aria-live="polite">
        {decisions.length ? `${plural(decisions.length, 'decision')} waiting` : ''}
      </div>
      {inspectId && <DecisionInspect key={inspectId} id={inspectId} now={now} onClose={closeInspect} fallbackFocus={decisionsFallback} />}
      <AnimatePresence>
        {goalAsking && <GoalDecision key={`${goalAsking.seen.id}:${goalAsking.to}`} seen={goalAsking.seen} to={goalAsking.to} session={goalAsking.session} onClose={closeGoalAsk} restoreFocus={goalHome} />}
      </AnimatePresence>
    </div>
  )
}

function SelectionActions({ item, openChat, startDraft, flyToItem, openInspect, askGoal }: { item: Item; openChat: (id: string) => void; startDraft: (id: string) => void; flyToItem: (k: string) => void; openInspect: (id: string) => void; askGoal: (ask: GoalAsk) => void }) {
  const agent = useHive((s) => (item.kind === 'mind' ? s.agents[item.id] : undefined))
  const goal = useHive((s) => (item.kind === 'goal' ? s.goals[item.id] : undefined))
  // the session this goal was read under, from the same store state (Surface R)
  const session = useHive((s) => s.session)
  const swarm = useHive((s) => (item.kind === 'island' ? s.swarms[item.id] : undefined))
  if (item.kind === 'mind' && agent) {
    const awake = isAwake(agent)
    return (
      <>
        <BarBtn strong onClick={() => openChat(agent.id)}>Talk</BarBtn>
        <BarAct run={() => useHive.getState().agentAction(agent.id, awake ? 'sleep' : 'wake')}>{awake ? 'Sleep' : 'Wake'}</BarAct>
        <BarBtn onClick={() => openClassic({ name: 'dot', id: agent.id, tab: 'mind' })}>Mind</BarBtn>
        <BarBtn onClick={() => openClassic({ name: 'dot', id: agent.id, tab: 'memory' })}>Memory</BarBtn>
      </>
    )
  }
  if (item.kind === 'goal' && goal) {
    // Review D1: each opens the shared GoalDecision on the goal as shown (Release too: it changes status, see goalAsk)
    return (
      <>
        {goalBarActions(goal.status).map((a) => (
          <BarBtn key={a.label} strong={a.strong} onClick={() => askGoal(goalAsk(goal, a.to, session))}>
            {a.label}
          </BarBtn>
        ))}
        <BarBtn onClick={() => openClassic({ name: 'tasks', swarm: goal.swarm_id })}>All tasks</BarBtn>
        <BarMotives goal={goal} />
      </>
    )
  }
  if (item.kind === 'island') {
    if (item.id === FREE) return <BarBtn onClick={() => openClassic({ name: 'new' })}>New mind</BarBtn>
    return (
      <>
        <BarBtn strong onClick={() => startDraft(item.id)}>Add task</BarBtn>
        <BarBtn onClick={() => flyToItem(item.key)}>Zoom to</BarBtn>
        <BarBtn onClick={() => openClassic({ name: 'new', swarm: item.id })}>Add mind</BarBtn>
        {swarm && <BarBtn onClick={() => openClassic({ name: 'swarm', id: swarm.id })}>Beliefs</BarBtn>}
      </>
    )
  }
  if (item.kind === 'decision') {
    return (
      <>
        <BarBtn strong onClick={() => openInspect(item.id)}>Review</BarBtn>
        <BarBtn onClick={() => openClassic({ name: 'approvals', tab: 'rules' })}>Rules</BarBtn>
      </>
    )
  }
  return null
}

/**
 * The motivations the selected task serves, on its selection bar. One: its chip opens the classic Tasks page filtered to
 * it. Several: one chip saying how many, which opens the task itself in Tasks, where each motivation is its own chip
 * (the board outline lists them one by one as well). Kept to one button so the bar still fits a phone.
 */
function BarMotives({ goal }: { goal: Goal }) {
  const refs = useHive((s) => s.taskLinks[goal.id] ?? NO_MOTIVES)
  if (!refs.length) return null
  const one = refs.length === 1
  return (
    <BarBtn onClick={() => openClassic(one ? { name: 'tasks', motivation: refs[0].id } : { name: 'tasks', swarm: goal.swarm_id, task: goal.id })} label={one ? `Tasks under the motivation ${refs[0].title}` : `This task serves ${refs.length} motivations: ${refs.map((r) => r.title).join(', ')}. Open it in Tasks`}>
      <span className="inline-flex max-w-[180px] items-center gap-1.5">
        <Target size={11} />
        <span className="truncate">{one ? refs[0].title : `${refs.length} motivations`}</span>
      </span>
    </BarBtn>
  )
}

/** A selection-bar action that is busy while it runs and always recovers (the store reports failures). */
function BarAct({ run, children, strong }: { run: () => Promise<unknown>; children: ReactNode; strong?: boolean }) {
  const [busy, setBusy] = useState(false)
  return (
    <BarBtn strong={strong} busy={busy} onClick={() => void withBusy(setBusy, run)}>
      {busy ? '…' : children}
    </BarBtn>
  )
}

function EmptyBoard({ r, lod }: { r: Rect; lod: string }) {
  return (
    <div className="absolute flex flex-col items-center justify-center gap-4 text-center" style={{ left: r.x, top: r.y, width: r.w, height: r.h, borderRadius: 32, border: '1.5px dashed var(--line-2)', background: 'var(--card)', padding: 40, fontSize: lod === 'far' ? 30 : 16 }}>
      <div className="text-[1.9em] font-semibold tracking-[-0.025em]" style={{ color: 'var(--ink)' }}>An empty canvas</div>
      <p className="m-0 max-w-[420px] text-[1em] leading-[1.45]" style={{ color: 'var(--ink-2)' }}>
        Swarms appear here as islands, minds as cards you can talk to, and tasks as stickies. Start with a swarm or a single mind.
      </p>
      <div data-nopan className="flex gap-2">
        <button onClick={() => openClassic({ name: 'launch' })} className="rounded-[10px] px-4 py-2.5 text-[0.9em] font-semibold" style={{ background: 'var(--accent)', color: 'var(--on-accent)' }}>
          Launch a swarm
        </button>
        <button onClick={() => openClassic({ name: 'new' })} className="rounded-[10px] px-4 py-2.5 text-[0.9em] font-semibold" style={{ border: '1px solid var(--line-2)', color: 'var(--ink)' }}>
          Create a mind
        </button>
      </div>
    </div>
  )
}
