import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { AnimatePresence, m } from 'framer-motion'
import { shown, useReducedMotion, type Agent } from '../sdk'
import type { Link } from './data'
import { useEngine, useEngineRef } from './engine'
import { centre, type IslandBox, type Item, type Layout, type Rect } from './layout'
import { Avatar } from './parts'
import { avatarFill, tint, type Mode } from './theme'
import { guardComposing } from '../../features/ask/keys'

// ------------------------------------------------------------------ links (world space)

export const Links = memo(function Links({ links, items, agents, now, reduced, focus }: { links: Link[]; items: Map<string, Item>; agents: Record<string, Agent>; now: number; reduced: boolean; focus: string | null }) {
  return (
    <svg aria-hidden className="pointer-events-none absolute top-0 left-0 overflow-visible" width="1" height="1" style={{ zIndex: 1 }}>
      {links.map((l) => {
        const a = items.get(`mind:${l.from}`)
        const b = items.get(`mind:${l.to}`)
        if (!a || !b) return null
        const p = centre(a)
        const q = centre(b)
        const dx = q.x - p.x
        const dy = q.y - p.y
        const len = Math.hypot(dx, dy) || 1
        // bend to the left of travel, so A->B and B->A read as two lanes
        const bend = Math.min(220, len * 0.22)
        const nx = -dy / len
        const ny = dx / len
        const c1 = { x: p.x + dx * 0.25 + nx * bend, y: p.y + dy * 0.25 + ny * bend }
        const c2 = { x: p.x + dx * 0.75 + nx * bend, y: p.y + dy * 0.75 + ny * bend }
        const d = `M${p.x},${p.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${q.x},${q.y}`
        const hue = agents[l.from]?.hue ?? 230
        const hot = focus === l.from || focus === l.to
        const fresh = now - l.last < 12_000
        const w = 1.6 + Math.min(5, l.count) * 0.35 + (hot ? 0.8 : 0)
        return (
          <g key={l.key} opacity={focus && !hot ? 0.25 : 1}>
            <path d={d} fill="none" stroke={avatarFill(hue)} strokeOpacity={hot ? 0.22 : 0.12} strokeWidth={w + 5} vectorEffect="non-scaling-stroke" strokeLinecap="round" />
            <path d={d} fill="none" stroke={avatarFill(hue)} strokeOpacity={0.95} strokeWidth={w} vectorEffect="non-scaling-stroke" strokeLinecap="round" className={reduced ? '' : 'cv-flow'} strokeDasharray="6 6" />
            {fresh && !reduced && (
              <circle key={l.lastId} r="1" fill={avatarFill(hue)} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" style={{ r: 'calc(5px * var(--iz, 1))' } as CSSProperties}>
                <animateMotion dur="1.3s" repeatCount="1" fill="freeze" path={d} keyPoints="0;1" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
              </circle>
            )}
          </g>
        )
      })}
    </svg>
  )
})

// ------------------------------------------------------------------ live cursors (screen space)

export interface CursorSpec {
  id: string
  name: string
  hue: number
  label: string
  target: Rect
}

interface CursorState {
  el: HTMLDivElement | null
  x: number
  y: number
  tx: number
  ty: number
  next: number
  spec: CursorSpec
  placed: boolean
}

/** detail: 0 = arrow only, 1 = with name, 2 = with what it is doing. */
export function Cursors({ list, reduced, detail }: { list: CursorSpec[]; reduced: boolean; detail: 0 | 1 | 2 }) {
  const engine = useEngineRef()
  const state = useRef(new Map<string, CursorState>())
  useEffect(() => {
    const map = state.current
    const ids = new Set(list.map((c) => c.id))
    for (const id of [...map.keys()]) if (!ids.has(id)) map.delete(id)
    for (const c of list) {
      const s = map.get(c.id)
      if (s) {
        const moved = s.spec.target.x !== c.target.x || s.spec.target.y !== c.target.y
        s.spec = c
        if (moved) s.next = 0
      } else {
        const p = centre(c.target)
        map.set(c.id, { el: null, x: p.x, y: p.y, tx: p.x, ty: p.y, next: 0, spec: c, placed: false })
      }
    }
  }, [list])
  useEffect(() => {
    let last = performance.now()
    return engine.onFrame((e) => {
      const t = performance.now()
      const dt = Math.min(64, t - last)
      last = t
      for (const s of state.current.values()) {
        if (!s.el) continue
        if (t >= s.next) {
          const r = s.spec.target
          s.tx = r.x + r.w * (0.25 + Math.random() * 0.55)
          s.ty = r.y + r.h * (0.3 + Math.random() * 0.5)
          s.next = t + 1600 + Math.random() * 2600
        }
        const k = reduced || !s.placed ? 1 : 1 - Math.exp(-dt / 420)
        s.placed = true
        s.x += (s.tx - s.x) * k
        s.y += (s.ty - s.y) * k
        const p = e.toScreen(s.x, s.y)
        const off = p.x < -60 || p.y < -60 || p.x > e.vw + 60 || p.y > e.vh + 60
        s.el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`
        s.el.style.visibility = off ? 'hidden' : 'visible'
      }
    })
  }, [engine, reduced])
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden" style={{ zIndex: 30 }}>
      {list.map((c) => (
        <div
          key={c.id}
          ref={(el) => {
            const s = state.current.get(c.id)
            if (s) s.el = el
            else if (el) {
              const p = centre(c.target)
              state.current.set(c.id, { el, x: p.x, y: p.y, tx: p.x, ty: p.y, next: 0, spec: c, placed: false })
            }
          }}
          className="absolute top-0 left-0"
          style={{ visibility: 'hidden', willChange: 'transform' }}
        >
          <svg width="18" height="20" viewBox="0 0 18 20" style={{ filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.3))' }}>
            <path d="M1.5 1.5 L16 9.2 L9.4 10.6 L6.2 17.6 Z" fill={avatarFill(c.hue)} stroke="#fff" strokeWidth="1.4" strokeLinejoin="round" />
          </svg>
          {detail > 0 && (
            <div className="absolute top-[16px] left-[12px] flex items-center gap-1 rounded-full py-[3px] pr-2.5 pl-2 text-[11.5px] font-semibold whitespace-nowrap text-white" style={{ background: avatarFill(c.hue), boxShadow: '0 2px 6px rgba(0,0,0,.18)' }}>
              {shown(c.name)}
              {detail > 1 && <span className="font-normal opacity-90">· {c.label}</span>}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ------------------------------------------------------------------ chrome helpers

const glass = 'border border-[var(--chrome-line)] bg-[var(--chrome)] shadow-[var(--shadow)] backdrop-blur-xl'

export function IconBtn({ label, active, onClick, children, kbd, wide, marker }: { label: string; active?: boolean; onClick: () => void; children: ReactNode; kbd?: string; wide?: boolean; marker?: string }) {
  return (
    <button
      {...(marker ? { [`data-${marker}`]: '' } : {})}
      aria-label={label}
      aria-pressed={active}
      title={kbd ? `${label} (${kbd})` : label}
      onClick={onClick}
      className={`grid h-9 place-items-center rounded-[10px] transition-colors ${wide ? 'px-2.5' : 'w-9'} ${active ? 'bg-[var(--accent)] text-[var(--on-accent)]' : 'text-[var(--ink-2)] hover:bg-[var(--accent-soft)] hover:text-[var(--ink)]'}`}
    >
      {children}
    </button>
  )
}

const I = {
  select: <path d="M4 3l9.5 5.2-4.2 1.1-2 4.2z" />,
  hand: <path d="M6 8.5V4.2a1.2 1.2 0 012.4 0V8m0-4.6a1.2 1.2 0 012.4 0V8m0-3.2a1.2 1.2 0 012.4 0v5.4c0 2.6-2 4.6-4.6 4.6-1.8 0-3-.8-4-2.3L3.2 9.8a1.2 1.2 0 011.9-1.4L6 9.5" />,
  sticky: <path d="M3.5 3.5h9v6l-3 3h-6zM12.5 9.5h-3v3" />,
  search: <><circle cx="7" cy="7" r="4.2" /><path d="M10.2 10.2l3.3 3.3" /></>,
  fit: <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />,
  minus: <path d="M4 8h8" />,
  plus: <path d="M4 8h8M8 4v8" />,
  map: <path d="M2.5 4l3.5-1.5 4 1.5 3.5-1.5v9.5L10 13.5l-4-1.5-3.5 1.5zM6 2.5V12M10 4v9.5" />,
  outline: <path d="M3 4h1.5M6.5 4H13M5 8h1.5M8.5 8H13M5 12h1.5M8.5 12H13" />,
}
export const Icon = ({ d }: { d: keyof typeof I }) => (
  <svg width="17" height="17" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {I[d]}
  </svg>
)

export type Tool = 'select' | 'hand' | 'sticky'

export function Toolbar({ tool, setTool, onSearch, onFit, compact, mapOpen, onMap, outlineOpen, onOutline, onLaunch, onNewMind }: { tool: Tool; setTool: (t: Tool) => void; onSearch: () => void; onFit: () => void; compact: boolean; mapOpen: boolean; onMap: () => void; outlineOpen: boolean; onOutline: () => void; onLaunch: () => void; onNewMind: () => void }) {
  const engine = useEngineRef()
  const pct = useEngine((e) => Math.round(e.z * 100))
  return (
    // on phones the bar fills the row between the Ω corner (56px) and the host's OS clock (--os-clock-room), so nothing sits under either
    <div data-xc-keep-clear="" data-chrome className={`absolute bottom-4 flex items-center rounded-[14px] p-1 ${glass} ${compact ? 'justify-between' : 'left-1/2 -translate-x-1/2 gap-0.5'}`} style={{ zIndex: 40, marginBottom: 'var(--sab, 0px)', ...(compact ? { left: 'calc(56px + env(safe-area-inset-left, 0px))', right: 'max(12px, var(--os-clock-room, 0px))' } : null) }} role="group" aria-label="Canvas tools">
      <IconBtn label="Select" kbd="V" active={tool === 'select'} onClick={() => setTool('select')}><Icon d="select" /></IconBtn>
      {/* on touch a finger already pans and pinch zooms: phones drop the hand tool and the zoom readout to fit beside Ω */}
      {!compact && <IconBtn label="Hand: drag to pan" kbd="H or hold Space" active={tool === 'hand'} onClick={() => setTool('hand')}><Icon d="hand" /></IconBtn>}
      <IconBtn label="Task sticky: tap a swarm to pin a task" kbd="N" active={tool === 'sticky'} onClick={() => setTool(tool === 'sticky' ? 'select' : 'sticky')}><Icon d="sticky" /></IconBtn>
      <IconBtn label="New mind" onClick={onNewMind} marker="cv-new-mind">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><circle cx="7" cy="6" r="3" /><path d="M2 14c.6-2.6 2.6-4 5-4M12.5 9.5v5M10 12h5" /></svg>
      </IconBtn>
      <CreateSwarm compact={compact} onClick={onLaunch} />
      {!compact && <span className="mx-1 h-5 w-px bg-[var(--line-2)]" />}
      <IconBtn label="Search the canvas" onClick={onSearch}><Icon d="search" /></IconBtn>
      <IconBtn label="Canvas outline: every swarm, mind, task and decision" kbd="O" active={outlineOpen} onClick={onOutline} marker="cv-outline-btn"><Icon d="outline" /></IconBtn>
      {!compact && <span className="mx-1 h-5 w-px bg-[var(--line-2)]" />}
      {!compact && <IconBtn label="Zoom out" kbd="-" onClick={() => engine.zoomBy(1 / 1.3)}><Icon d="minus" /></IconBtn>}
      {!compact && (
        <button title="Zoom to 100% (1)" aria-label={`Zoom ${pct}%. Reset to 100%`} onClick={() => engine.zoomBy(1 / engine.targetZ)} className="h-9 min-w-[52px] rounded-[10px] px-1.5 text-[12.5px] font-semibold text-[var(--ink)] tabular-nums hover:bg-[var(--accent-soft)]">
          {pct}%
        </button>
      )}
      {!compact && <IconBtn label="Zoom in" kbd="+" onClick={() => engine.zoomBy(1.3)}><Icon d="plus" /></IconBtn>}
      <IconBtn label="Fit the whole hive" kbd="0" onClick={onFit}><Icon d="fit" /></IconBtn>
      {!compact && <IconBtn label="Minimap" kbd="M" active={mapOpen} onClick={onMap}><Icon d="map" /></IconBtn>}
    </div>
  )
}

/** "Start a swarm": labelled on desktop (the owner could not find how to make a top-level swarm), an icon on phones. */
function CreateSwarm({ compact, onClick }: { compact: boolean; onClick: () => void }) {
  const icon = (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden><circle cx="4.5" cy="5" r="2" /><circle cx="10" cy="4" r="1.6" /><circle cx="6.5" cy="11" r="1.8" /><path d="M12.5 8.5v5M10 11h5" /></svg>
  )
  if (compact) return <IconBtn label="Start a swarm" onClick={onClick} marker="cv-launch">{icon}</IconBtn>
  return (
    <button data-cv-launch onClick={onClick} title="Start a swarm: a group of minds with one purpose (it can be private)" className="ml-0.5 flex h-9 items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] font-semibold text-[var(--accent-ink)] hover:bg-[var(--accent-soft)]">
      {icon}
      Start a swarm
    </button>
  )
}

// ------------------------------------------------------------------ minimap

export function Minimap({ layout, mode }: { layout: Layout; mode: Mode }) {
  const engine = useEngineRef()
  const W = 212
  const H = 136
  const b = layout.bounds
  const pad = 10
  const s = Math.min((W - pad * 2) / Math.max(1, b.w), (H - pad * 2) / Math.max(1, b.h))
  const ox = (W - b.w * s) / 2 - b.x * s
  const oy = (H - b.h * s) / 2 - b.y * s
  const view = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let v = -1
    return engine.onFrame((e) => {
      if (e.version === v || !view.current) return
      v = e.version
      const tl = e.toWorld(0, 0)
      const w = e.vw / e.z
      const h = e.vh / e.z
      const x = Math.max(-4, Math.min(W, ox + tl.x * s))
      const y = Math.max(-4, Math.min(H, oy + tl.y * s))
      const x2 = Math.max(-4, Math.min(W + 4, ox + (tl.x + w) * s))
      const y2 = Math.max(-4, Math.min(H + 4, oy + (tl.y + h) * s))
      const st = view.current.style
      st.transform = `translate(${x}px, ${y}px)`
      st.width = `${Math.max(6, x2 - x)}px`
      st.height = `${Math.max(6, y2 - y)}px`
    })
  }, [engine, ox, oy, s])
  const jump = (cx: number, cy: number, animate: boolean) => {
    const wx = (cx - ox) / s
    const wy = (cy - oy) / s
    if (animate) engine.flyTo(wx, wy, engine.z, 380)
    else engine.jumpTo(wx, wy, engine.z)
  }
  return (
    <div
      data-chrome
      role="img"
      aria-label="Minimap. Drag to move around the canvas."
      className={`absolute right-4 bottom-4 overflow-hidden rounded-[14px] ${glass}`}
      style={{ width: W, height: H, zIndex: 40, touchAction: 'none', cursor: 'crosshair', bottom: 'max(16px, var(--os-clock-lift, 0px))' }}
      onPointerDown={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        e.currentTarget.setPointerCapture(e.pointerId)
        jump(e.clientX - r.left, e.clientY - r.top, true)
      }}
      onPointerMove={(e) => {
        if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
        const r = e.currentTarget.getBoundingClientRect()
        jump(e.clientX - r.left, e.clientY - r.top, false)
      }}
    >
      <svg width={W} height={H} className="absolute inset-0">
        {layout.islands.map((i: IslandBox) => {
          const t = tint(i.hue, mode)
          return <rect key={i.id} x={ox + i.x * s} y={oy + i.y * s} width={i.w * s} height={i.h * s} rx={5} fill={t.soft} stroke={t.edge} />
        })}
        <rect x={ox + layout.lane.x * s} y={oy + layout.lane.y * s} width={layout.lane.w * s} height={layout.lane.h * s} rx={5} fill="none" stroke="var(--line-2)" strokeDasharray="3 2" />
        {[...layout.items.values()].map((it) =>
          it.kind === 'mind' || it.kind === 'decision' || it.kind === 'goal' ? (
            <rect key={it.key} x={ox + it.x * s} y={oy + it.y * s} width={Math.max(2, it.w * s)} height={Math.max(2, it.h * s)} rx={1.5} fill={it.kind === 'decision' ? '#ff7a5c' : it.kind === 'goal' ? '#e6c74a' : 'var(--ink-3)'} opacity={it.kind === 'mind' ? 0.55 : 0.9} />
          ) : null,
        )}
      </svg>
      <div ref={view} className="pointer-events-none absolute top-0 left-0 rounded-[3px]" style={{ border: '1.5px solid var(--accent)', background: 'var(--accent-soft)' }} />
    </div>
  )
}

// ------------------------------------------------------------------ top bar

export function TopBar({ awake, pending, connection, mode, onMode, onDecisions, onFollow, onPalette, hiveOpen, onHive, compact }: { awake: Agent[]; pending: number; connection: string; mode: Mode; onMode: () => void; onDecisions: () => void; onFollow: (id: string) => void; onPalette: () => void; hiveOpen: boolean; onHive: () => void; compact: boolean }) {
  const live = connection === 'open'
  return (
    <>
      <div data-xc-keep-clear="" data-chrome className={`absolute top-3 left-3 flex h-11 items-center gap-2.5 rounded-[14px] pr-3.5 pl-2 ${glass}`} style={{ zIndex: 40 }}>
        <span aria-hidden className="grid size-7 place-items-center rounded-[8px] text-[13px] font-bold text-white" style={{ background: 'var(--accent)' }}>
          <svg width="14" height="14" viewBox="0 0 14 14"><circle cx="3.5" cy="3.5" r="2" fill="#fff" /><circle cx="10.5" cy="3.5" r="2" fill="#fff" opacity=".75" /><circle cx="3.5" cy="10.5" r="2" fill="#fff" opacity=".75" /><circle cx="10.5" cy="10.5" r="2" fill="#fff" opacity=".5" /></svg>
        </span>
        <span className="text-[14px] font-semibold tracking-[-0.01em] text-[var(--ink)]">OmegaHive</span>
        {!compact && <span className="text-[14px] text-[var(--ink-3)]">/</span>}
        {!compact && <span className="text-[14px] text-[var(--ink-2)]">Canvas</span>}
        <span title={live ? 'Live' : `Connection: ${connection}`} className="ml-0.5 inline-flex items-center gap-1.5 text-[11.5px] text-[var(--ink-3)]">
          <span className={`inline-block size-[7px] rounded-full ${live ? 'cv-live' : ''}`} style={{ background: live ? 'var(--good)' : 'var(--warn)' }} />
          {!compact && (live ? 'Live' : connection)}
        </span>
      </div>
      <div data-xc-keep-clear="" data-chrome className={`absolute top-3 right-3 flex h-11 items-center gap-1 rounded-[14px] px-1.5 ${glass}`} style={{ zIndex: 40 }}>
        {!compact && awake.length > 0 && (
          <div className="mr-1 flex items-center pl-1" aria-label="Awake minds">
            {awake.slice(0, 5).map((a, i) => (
              <button key={a.id} title={`Go to ${shown(a.name)}`} aria-label={`Go to ${shown(a.name)}`} onClick={() => onFollow(a.id)} className="relative rounded-[9px] transition-transform hover:z-10 hover:-translate-y-0.5" style={{ marginLeft: i ? -6 : 0, boxShadow: '0 0 0 2px var(--card)' }}>
                <Avatar name={a.name} hue={a.hue} size={27} radius={9} />
              </button>
            ))}
            {awake.length > 5 && <span className="ml-1.5 text-[12px] font-medium text-[var(--ink-3)]">+{awake.length - 5}</span>}
          </div>
        )}
        <button data-cv-decisions data-presence-feature="decide.approvals" onClick={onDecisions} className="flex h-9 items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] font-semibold text-[var(--ink)] hover:bg-[var(--accent-soft)]" aria-label={`${pending} decisions waiting`}>
          {!compact && 'Decisions'}
          <span className="grid h-[20px] min-w-[20px] place-items-center rounded-full px-1.5 text-[11.5px] font-bold tabular-nums" style={pending ? { background: 'var(--bad)', color: 'var(--on-bad)' } : { background: 'var(--line)', color: 'var(--ink-2)' }}>
            {pending}
          </span>
        </button>
        <button
          data-cv-hive-btn
          onClick={onHive}
          aria-expanded={hiveOpen}
          aria-label="Hive: everything in the hive"
          title="Everything in the hive: people, usage, beliefs, history, apps, settings…"
          className="flex h-9 items-center gap-1.5 rounded-[10px] px-2.5 text-[13px] font-semibold text-[var(--ink)] hover:bg-[var(--accent-soft)]"
          style={hiveOpen ? { background: 'var(--accent-soft)', color: 'var(--accent-ink)' } : undefined}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden><rect x="2" y="2" width="5" height="5" rx="1.2" /><rect x="9" y="2" width="5" height="5" rx="1.2" /><rect x="2" y="9" width="5" height="5" rx="1.2" /><rect x="9" y="9" width="5" height="5" rx="1.2" /></svg>
          {!compact && 'Hive'}
        </button>
        <IconBtn label={mode === 'light' ? 'Dark canvas' : 'Light canvas'} onClick={onMode}>
          {mode === 'light' ? (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z" /></svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="8" cy="8" r="3" /><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /></svg>
          )}
        </IconBtn>
        <IconBtn label="Commands" onClick={onPalette}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 4.5h10M3 8h10M3 11.5h6" /></svg>
        </IconBtn>
      </div>
    </>
  )
}

// ------------------------------------------------------------------ search

export interface Entry {
  key: string
  label: string
  sub: string
  kind: 'Mind' | 'Swarm' | 'Task' | 'Decision'
  hue: number | null
}

export function Search({ open, entries, onClose, onPick }: { open: boolean; entries: Entry[]; onClose: () => void; onPick: (key: string) => void }) {
  const [q, setQ] = useState('')
  const [i, setI] = useState(0)
  const reduced = useReducedMotion()
  // Esc or Close hands focus back to where it was (a pick moves it to the picked item instead)
  const opener = useRef<HTMLElement | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!open) return
    const at = document.activeElement
    if (at instanceof HTMLElement && at !== inputRef.current) opener.current = at
    inputRef.current?.focus()
  }, [open])
  const close = () => {
    onClose()
    const el = opener.current
    requestAnimationFrame(() => el?.isConnected && el.focus({ preventScroll: true }))
  }
  const results = useMemo(() => {
    const t = q.trim().toLowerCase()
    const list = t ? entries.filter((e) => e.label.toLowerCase().includes(t) || e.sub.toLowerCase().includes(t)) : entries
    return list
      .map((e) => ({ e, s: !t ? 0 : e.label.toLowerCase().startsWith(t) ? 0 : e.label.toLowerCase().includes(t) ? 1 : 2 }))
      .sort((a, b) => a.s - b.s)
      .slice(0, 8)
      .map((x) => x.e)
  }, [q, entries])
  const pick = (k: string) => {
    onPick(k)
    setQ('')
    setI(0)
  }
  return (
    <AnimatePresence>
      {open && (
        <m.div
          data-chrome
          initial={reduced ? { opacity: 0 } : { opacity: 0, y: -8, scale: 0.98 }}
          animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduced ? { opacity: 0, transition: { duration: 0.08 } } : { opacity: 0, y: -6, scale: 0.98, transition: { duration: 0.12 } }}
          transition={reduced ? { duration: 0.08 } : { type: 'spring', stiffness: 520, damping: 36 }}
          data-ownkeys
          className={`absolute top-[68px] left-1/2 w-[min(520px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-[16px] ${glass}`}
          style={{ zIndex: 50, boxShadow: 'var(--shadow-lg)' }}
          role="dialog"
          aria-label="Search the canvas"
        >
          <div className="flex items-center gap-2.5 border-b border-[var(--line)] px-4">
            <span className="text-[var(--ink-3)]"><Icon d="search" /></span>
            <input
              ref={inputRef}
              value={q}
              onChange={(e) => {
                setQ(e.target.value)
                setI(0)
              }}
              onKeyDown={(e) => {
                // an IME's confirming Enter belongs to the input method (features/ask/keys; r2.4 sweep)
                if (guardComposing(e)) return
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setI(Math.min(results.length - 1, i + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setI(Math.max(0, i - 1))
                } else if (e.key === 'Enter' && results[i]) {
                  e.preventDefault()
                  pick(results[i].key)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  e.stopPropagation()
                  close()
                }
              }}
              placeholder="Fly to a mind, swarm, task or decision…"
              aria-label="Search"
              role="combobox"
              aria-expanded
              aria-controls="cv-results"
              aria-activedescendant={results[i] ? `cv-r-${i}` : undefined}
              className="h-12 flex-1 border-0 bg-transparent text-[15px] text-[var(--ink)] outline-none placeholder:text-[var(--ink-3)]"
            />
            <kbd className="rounded-md border border-[var(--line-2)] px-1.5 py-0.5 text-[11px] text-[var(--ink-3)]">Esc</kbd>
          </div>
          <ul id="cv-results" role="listbox" data-unsaved-ignore="" className="m-0 max-h-[50vh] list-none overflow-y-auto p-1.5">
            {results.length === 0 && <li className="px-3 py-6 text-center text-[13.5px] text-[var(--ink-3)]">Nothing on the canvas matches “{q}”.</li>}
            {results.map((r, k) => (
              <li key={r.key} id={`cv-r-${k}`} role="option" aria-selected={k === i}>
                <button onMouseEnter={() => setI(k)} onClick={() => pick(r.key)} className="flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left" style={{ background: k === i ? 'var(--accent-soft)' : 'transparent' }}>
                  {r.kind === 'Mind' && r.hue !== null ? (
                    <Avatar name={r.label} hue={r.hue} size={26} radius={8} />
                  ) : (
                    <span className="grid size-[26px] place-items-center rounded-[8px] text-[11px] font-bold" style={{ background: r.kind === 'Decision' ? '#ff9b8c' : r.kind === 'Task' ? '#fff1a8' : r.hue !== null ? `hsl(${r.hue} 70% 88%)` : 'var(--line)', color: '#16161a' }}>
                      {r.kind[0]}
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] font-medium text-[var(--ink)]">{r.label}</span>
                    <span className="block truncate text-[12px] text-[var(--ink-3)]">{r.sub}</span>
                  </span>
                  <span className="text-[11.5px] text-[var(--ink-3)]">{r.kind}</span>
                </button>
              </li>
            ))}
          </ul>
        </m.div>
      )}
    </AnimatePresence>
  )
}

// ------------------------------------------------------------------ selection bar (world space, screen-constant size)

export function SelectionBar({ r, label, children }: { r: Rect; label: string; children: ReactNode }) {
  const reduced = useReducedMotion()
  return (
    <div
      data-nopan
      className="absolute top-0 left-0"
      style={{ transform: `translate(${r.x}px, ${r.y}px) scale(var(--iz, 1)) translateY(calc(-100% - 12px))`, transformOrigin: '0 0', zIndex: 25 }}
    >
      <m.div
        role="group"
        aria-label={label}
        initial={reduced ? false : { opacity: 0, y: 6 }}
        animate={reduced ? { opacity: 1 } : { opacity: 1, y: 0 }}
        transition={reduced ? { duration: 0 } : { type: 'spring', stiffness: 600, damping: 36 }}
        className="cv-bar flex items-center gap-0.5 rounded-[12px] p-1 whitespace-nowrap"
        style={{ background: 'var(--ink)', color: 'var(--paper)', boxShadow: 'var(--shadow-lg)' }}
      >
        {children}
      </m.div>
    </div>
  )
}

export function BarBtn({ onClick, children, strong, busy, label }: { onClick: () => void; children: ReactNode; strong?: boolean; busy?: boolean; label?: string }) {
  return (
    <button
      aria-label={label}
      disabled={busy}
      aria-busy={busy || undefined}
      onClick={(e) => (e.stopPropagation(), onClick())}
      className="h-8 rounded-[8px] px-2.5 text-[13px] font-medium transition-colors hover:bg-[color-mix(in_srgb,var(--paper)_16%,transparent)]"
      style={strong ? { background: 'var(--accent)', color: 'var(--on-accent)' } : undefined}
    >
      {children}
    </button>
  )
}
