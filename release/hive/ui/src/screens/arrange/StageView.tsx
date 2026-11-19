// Purpose: draw the stage MeTTa arranges (screens/arrange/lib_arrange.metta) over whichever look is open: each item at
// the rectangle MeTTa gave it, every divider as a window splitter the person drags, the tray of what was put away, and
// Put away; a drag, a press and Escape are said back to the stage, and MeTTa arranges again.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent } from 'react'
import { useScene } from '../../scene/sceneStore'
import { useHive } from '../../store/store'
import { NotThePage, pageParts, useOpenScreens } from '../openScreens'
import { arrangeSpace, type Arrangement, type ArrangeItem, type ArrangeState, type Divider } from './arrangeSpace'
import { credit, drag, learn, say, stageState, stageWindow, useStage, type StageWindow } from './arrange'
import { Tile } from './drawers'
import { useTitle } from './drawerData'

const sub = (f: () => void) => {
  window.addEventListener('resize', f)
  return () => window.removeEventListener('resize', f)
}
const width = () => window.innerWidth
const height = () => window.innerHeight

type Composed = { ok: true; plan: Arrangement } | { ok: false; why: string }
function arrange(state: ArrangeState): Composed {
  try {
    return { ok: true, plan: arrangeSpace().compose(state) }
  } catch (e) {
    console.error('the stage could not be arranged', e)
    return { ok: false, why: e instanceof Error ? e.message : String(e) }
  }
}

/** The shares MeTTa settles a divider at for `at`: what the person's drag teaches, once they let go. */
function settle(d: Divider, at: number, state: ArrangeState) {
  const composed = arrange({ ...state, dragging: { group: d.group, index: d.index, at } })
  const settled = composed.ok ? composed.plan.dividers.find((x) => x.group === d.group && x.index === d.index) : undefined
  if (settled) learn({ dir: settled.dir, kinds: settled.kinds, shares: settled.shares })
  else drag(null)
}

/** Where the divider sits now, as a fraction of its group's length: the shares before and at it. */
const position = (d: Divider) => d.shares.slice(0, d.index + 1).reduce((a, b) => a + b, 0)

/** One divider: `top` is where the arranged area starts in the window, `state` what it was arranged from. */
function Splitter({ d, controls, origin, state }: { d: Divider; controls: string; origin: StageWindow; state: ArrangeState }) {
  const held = useRef(false)
  const frame = useRef(0)
  // the pointer in the stage window's own coordinates, where MeTTa placed the divider
  const along = (e: PointerEvent) => (d.dir === 'row' ? e.clientX - origin.x : e.clientY - origin.y)
  const at = (e: PointerEvent) => (along(e) - d.offset) / d.room
  const down = (e: PointerEvent<HTMLDivElement>) => {
    held.current = true
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    if (!held.current) return
    const next = at(e)
    // one arrangement per frame, however fast the pointer moves
    cancelAnimationFrame(frame.current)
    frame.current = requestAnimationFrame(() => drag({ group: d.group, index: d.index, at: next }))
  }
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (!held.current) return
    held.current = false
    cancelAnimationFrame(frame.current)
    settle(d, at(e), state)
  }
  // the APG window splitter's keys, in react-resizable-panels' steps: arrows by 5, Home and End to the ends
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowLeft: -0.05, ArrowUp: -0.05, ArrowRight: 0.05, ArrowDown: 0.05 }[e.key]
    if (step !== undefined) settle(d, position(d) + step, state)
    else if (e.key === 'Home') settle(d, d.lo, state)
    else if (e.key === 'End') settle(d, d.hi, state)
    else return
    e.preventDefault()
  }
  const pct = (x: number) => Math.round(x * 100)
  return (
    <div role="separator" tabIndex={0} aria-label="Resize" aria-controls={controls} aria-orientation={d.dir === 'row' ? 'vertical' : 'horizontal'}
      aria-valuenow={pct(position(d))} aria-valuemin={pct(d.lo)} aria-valuemax={pct(d.hi)} data-stage-divider={`${d.group} ${d.index}`}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onKeyDown={key}
      className={`absolute touch-none rounded-full hover:bg-accent/40 focus-visible:bg-accent/60 ${d.dir === 'row' ? 'cursor-col-resize' : 'cursor-row-resize'}`}
      style={{ left: d.x, top: d.y, width: d.w, height: d.h }} />
  )
}

function TrayChip({ item }: { item: ArrangeItem }) {
  const title = useTitle(item)
  return (
    <button type="button" onClick={() => say({ say: 'recall', key: item.key })} data-stage-tray={item.key}
      className="xc-frame glass max-w-[220px] truncate rounded-full border border-line px-3 py-1 text-[12px] hover:border-accent/60">{title}</button>
  )
}

export default function StageView() {
  const st = useStage()
  const goals = useHive((s) => s.goals)
  const askRoom = useScene((s) => s.insetSources.ask?.bottom ?? 0)
  const thread = useScene((s) => s.askThread)
  const w = useSyncExternalStore(sub, width, width)
  const h = useSyncExternalStore(sub, height, height)
  const bar = useRef<HTMLDivElement>(null)
  const [barH, setBarH] = useState(0)
  // the stage arranges in the window below its own bar and above the room the docked Ask takes, beside the Ask's open
  // thread (drawn over the stage), which the scrim and the bar still run under
  const win = useMemo(() => stageWindow({ w, h }, barH, askRoom, thread), [w, h, barH, askRoom, thread])
  const stage = useMemo(() => ({ w: win.w, h: win.h }), [win.w, win.h])
  const screens = useOpenScreens()
  const parts = useMemo(() => pageParts(screens).map((p) => ({ key: p.key, block: p.part.block! })), [screens])
  const state = useMemo(() => stageState(st, stage, goals, parts), [st, stage, goals, parts])
  const composed = useMemo(() => arrange(state), [state])
  // open while something is arranged, something put aside waits in the tray (the last shown item put away comes back
  // with a press), or something said could not be (a key the page has nothing for is said, never dropped in silence),
  // until the person puts the stage away
  const open = !composed.ok || composed.plan.mode !== 'home' || composed.plan.tray.length > 0 || composed.plan.unknown.length > 0
  useLayoutEffect(() => {
    const el = bar.current
    if (!open || !el) return
    const measure = () => setBarH(el.getBoundingClientRect().height)
    measure()
    const watch = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    watch?.observe(el)
    return () => watch?.disconnect()
  }, [open])
  useEffect(() => {
    if (composed.ok) credit(composed.plan.seen.episode, composed.plan.task, composed.plan.seen.keys)
  }, [composed])
  const region = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      // Escape puts the stage away when the person is on it, never while they type in the Ask or a dialog is open
      if (e.target !== document.body && !region.current?.contains(e.target as Node)) return
      say({ say: 'clear' })
    }
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [])

  if (!open) return null
  const plan = composed.ok ? composed.plan : null
  return (
    <NotThePage.Provider value={true}>
    <div ref={region} role="region" aria-label="Shown" data-stage={plan?.mode ?? 'failed'} className="xc-dress fixed inset-x-0 top-0 z-[45]" style={{ bottom: askRoom }}>
      <div className="absolute inset-0 bg-void/70 backdrop-blur-md" aria-hidden />
      {/* the bar keeps to the window's own width, so a thread beside it (the Ask's half column on the left, a pinned one
          on the right) never covers Put away; only its height feeds the window, so the two never chase each other */}
      <div ref={bar} className="relative flex flex-wrap items-center gap-2 px-6 py-2" style={{ marginLeft: win.x, width: win.w }}>
        <button type="button" onClick={() => say({ say: 'clear' })} className="xc-frame glass-strong rounded-full border border-line px-3 py-1 text-[12px] font-medium">Put away</button>
        {plan && plan.tray.length > 0 && <span className="text-[12px] text-ink-3">Put aside:</span>}
        {plan?.tray.map((k) => st.items[k] && <TrayChip key={k} item={st.items[k]} />)}
        {plan && plan.unknown.length > 0 && (
          <p role="status" className="xc-frame glass-strong rounded-xl border border-line px-3 py-1 text-[12px]">
            Something asked to be shown is not here, or is not shown to you.
          </p>
        )}
      </div>
      <div className="absolute" data-stage-window="" style={{ left: win.x, top: win.y, width: win.w, height: win.h }}>
        {!plan && (
          <div role="alert" className="xc-frame glass-strong mx-auto mt-10 max-w-md rounded-2xl border border-line p-4 text-[13px]">
            The stage could not be arranged: {composed.ok ? '' : composed.why}
          </div>
        )}
        {plan?.placed.map((p) => {
          const item = state.items.find((x) => x.key === p.key)
          if (!item) return null
          return (
            <div key={p.key} id={`stage-${p.key}`} data-stage-item={p.key} data-stage-role={p.role} className="absolute" style={{ left: p.x, top: p.y, width: p.w, height: p.h }}>
              <Tile item={item} placed={p} onPutAway={() => say({ say: 'putAway', key: p.key })} onBring={() => say({ say: 'recall', key: p.key })} />
            </div>
          )
        })}
        {plan?.dividers.map((d) => <Splitter key={`${d.group} ${d.index}`} d={d} controls={`stage-${d.group}`} origin={win} state={state} />)}
      </div>
    </div>
    </NotThePage.Provider>
  )
}
