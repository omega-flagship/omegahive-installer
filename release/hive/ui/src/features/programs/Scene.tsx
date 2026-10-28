import { plural } from '../../lib/plural'
import { AnimatePresence, m } from 'framer-motion'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import type { ProgramDescription, WorkGraph, WorkItem } from '../../api/types'
import { cx } from '../../lib/cx'
import { useReducedMotion } from '../../lib/hooks'
import type { TrailStep } from '../../store/programSession'
import { Icon } from '../../ui/Icon'
import { hash, layoutStage, type EdgeBox, type GraphIndex, type Lane, type NodeBox, type SceneLayout } from './layout'
import { RoleMark, StatusLine, UMini } from './parts'
import { CARD, POL, ROLE, SPRING, STAGE_WORDS, uncertaintyText } from './style'
import { guardComposing } from '../../features/ask/keys'


function useSize<T extends HTMLElement>(): [React.RefObject<T | null>, { w: number; h: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = () => setSize((s) => (s.w === el.clientWidth && s.h === el.clientHeight ? s : { w: el.clientWidth, h: el.clientHeight }))
    const ro = new ResizeObserver(read)
    ro.observe(el)
    read()
    return () => ro.disconnect()
  }, [])
  return [ref, size]
}

export interface SceneProps {
  graph: WorkGraph
  describe: ProgramDescription | null
  gi: GraphIndex
  step: TrailStep
  trail: TrailStep[]
  selection: string[]
  /** Layout ids are scoped per host so a page and a panel never trade elements. */
  scope: string
  onPick(id: string, additive: boolean): void
  onOpen(id: string): void
  /** Clicked the empty stage. */
  onClear(): void
}

export function Scene(p: SceneProps) {
  const [ref, size] = useSize<HTMLDivElement>()
  const reduced = useReducedMotion()
  const layout = useMemo<SceneLayout | null>(
    () => (size.w > 0 ? layoutStage({ graph: p.graph, describe: p.describe, step: p.step, trail: p.step.stage === 'map' ? p.trail : [], width: size.w, height: size.h }, p.gi) : null),
    [p.graph, p.describe, p.gi, p.step, p.trail, size.w, size.h],
  )
  const boxes = useMemo(() => new Map((layout?.nodes ?? []).map((n) => [n.key, n])), [layout])

  // keep the focus in view: centre it when the stage or focus changes (the map scrolls to the followed item)
  const lastFocus = useRef<string | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el || !layout) return
    const key = `${p.step.stage}:${layout.focusKey ?? ''}`
    if (lastFocus.current === key) return
    lastFocus.current = key
    const f = layout.focusKey ? boxes.get(layout.focusKey) : null
    const left = f ? f.x + f.w / 2 - el.clientWidth / 2 : 0
    const top = f ? (p.step.stage === 'map' ? f.y + f.h / 2 - el.clientHeight / 2 : Math.max(0, f.y - el.clientHeight * 0.3)) : 0
    el.scrollTo({ left: Math.max(0, left), top: Math.max(0, top), behavior: reduced ? 'auto' : 'smooth' })
  }, [layout, boxes, p.step.stage, reduced, ref])

  // drag the empty stage with a mouse to pan (touch and trackpads scroll natively)
  const drag = useRef<{ x: number; y: number; l: number; t: number; moved: boolean } | null>(null)
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || (e.target as HTMLElement).closest('[data-node]')) return
    const el = ref.current!
    drag.current = { x: e.clientX, y: e.clientY, l: el.scrollLeft, t: el.scrollTop, moved: false }
  }
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
    ref.current!.scrollLeft = d.l - dx
    ref.current!.scrollTop = d.t - dy
  }
  const onPointerUp = (e: MouseEvent) => {
    const d = drag.current
    drag.current = null
    if (d && !d.moved && !(e.target as HTMLElement).closest('[data-node]')) p.onClear()
  }

  const selected = new Set(p.selection)
  const hot = new Set([...(layout?.focusKey ? [layout.focusKey] : []), ...p.selection])
  return (
    <m.div
      ref={ref}
      layoutScroll
      className="thin-scroll absolute inset-0 overflow-auto overscroll-contain select-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => (drag.current = null)}
      role="group"
      aria-label={`${STAGE_WORDS[p.step.stage]} of ${plural(p.graph.items.length, 'item')}`}
    >
      {layout && (
        <div className="relative" style={{ width: layout.width, height: layout.height }}>
          <Edges layout={layout} boxes={boxes} hot={hot} picked={selected} scope={p.scope} narrow={size.w < 760} />
          <AnimatePresence>
            {layout.lanes.map((l) => (
              <LaneLabel key={`${p.step.stage}-${l.key}`} lane={l} />
            ))}
          </AnimatePresence>
          <AnimatePresence initial={false}>
            {layout.nodes.map((n) => {
              const item = p.graph.items.find((i) => i.id === n.id)
              if (!item) return null
              return (
                <Node
                  key={n.key}
                  box={n}
                  item={item}
                  gi={p.gi}
                  scope={p.scope}
                  focus={n.key === layout.focusKey}
                  selected={selected.has(n.id) && !n.dupOf}
                  alsoSelected={selected.has(n.id) && !!n.dupOf}
                  groupLabel={n.dupOf ? p.graph.groups.find((g) => g.id === n.group)?.label : undefined}
                  onPick={p.onPick}
                  onOpen={p.onOpen}
                />
              )
            })}
          </AnimatePresence>
        </div>
      )}
    </m.div>
  )
}


// ---------------------------------------------------------------- nodes

const Node = memo(function Node({
  box,
  item,
  gi,
  scope,
  focus,
  selected,
  alsoSelected,
  groupLabel,
  onPick,
  onOpen,
}: {
  box: NodeBox
  item: WorkItem
  gi: GraphIndex
  scope: string
  focus: boolean
  selected: boolean
  alsoSelected: boolean
  groupLabel?: string
  onPick(id: string, additive: boolean): void
  onOpen(id: string): void
}) {
  const role = gi.role(item.kind)
  const r = ROLE[role]
  const kindLabel = gi.kindLabel(item.kind)
  const slot = box.slot
  const retracted = item.status === 'retracted'
  const superseded = item.status === 'superseded'
  const corrected = item.status === 'corrected'
  const affected = (item.flags ?? []).includes('affected-by-correction')
  const srcCount = item.sources?.length ?? 0
  const lines = box.tier === 'focus' ? 3 : box.tier === 'context' ? 1 : 2
  const label = `${kindLabel}: ${item.label}. ${uncertaintyText(item.uncertainty)}.${item.status && item.status !== 'current' ? ` ${item.status}.` : ''}${affected ? ' Affected by a correction.' : ''}${box.dupOf ? ' Same item, shown again in another group.' : ''}`
  const onKey = (e: KeyboardEvent) => {
    if (guardComposing(e)) return
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      onOpen(item.id)
    }
  }
  const from = box.from
  return (
    <m.button
      data-node
      data-tour={box.dupOf ? undefined : `node-${item.id}`}
      layout
      layoutId={box.dupOf ? undefined : `pn-${scope}-${item.id}`}
      initial={from ? { opacity: 0, scale: 0.6, x: from.x - box.x, y: from.y - box.y } : { opacity: 0, scale: 0.92 }}
      animate={{ opacity: superseded || retracted ? Math.min(box.opacity, 0.62) : box.opacity, scale: 1, x: 0, y: 0 }}
      exit={{ opacity: 0, scale: 0.85, transition: { duration: 0.18 } }}
      transition={SPRING}
      onClick={(e) => onPick(item.id, e.shiftKey || e.metaKey || e.ctrlKey)}
      onDoubleClick={() => onOpen(item.id)}
      onKeyDown={onKey}
      aria-label={label}
      aria-pressed={selected}
      className={cx(
        'group absolute flex flex-col overflow-hidden rounded-2xl border text-left outline-none',
        'focus-visible:ring-2 focus-visible:ring-accent-2 focus-visible:ring-offset-0',
        slot ? 'border-dashed' : '',
        box.tier === 'focus' ? 'px-3.5 py-3' : box.tier === 'context' ? 'px-2.5 py-2' : 'px-3 py-2.5',
      )}
      style={{
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        zIndex: focus ? 3 : selected ? 2 : 1,
        background: slot ? 'repeating-linear-gradient(135deg, rgb(253 164 175 / 0.06) 0 8px, transparent 8px 16px), rgb(12 10 32)' : CARD,
        borderColor: selected
          ? 'rgb(110 231 255 / 0.85)'
          : slot
            ? 'rgb(253 164 175 / 0.5)'
            : focus
              ? `color-mix(in srgb, ${r.color} 55%, transparent)`
              : affected
                ? 'rgb(251 191 36 / 0.45)'
                : 'var(--color-line)',
        boxShadow: selected
          ? '0 0 0 1px rgb(110 231 255 / 0.5), 0 0 30px -6px rgb(110 231 255 / 0.6)'
          : focus
            ? `0 18px 50px -18px rgb(0 0 0 / 0.8), 0 0 46px -12px ${r.color}`
            : '0 10px 30px -18px rgb(0 0 0 / 0.8)',
      }}
    >
      {corrected && <span className="absolute inset-y-2 left-0 w-[3px] rounded-r-full bg-warn" aria-hidden="true" />}
      <m.span layout="position" className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
        <span className="flex w-full min-w-0 items-center gap-1.5">
          {slot ? (
            <span className="inline-flex items-center gap-1 text-[10.5px] font-semibold tracking-[0.08em] text-[#fda4af] uppercase">
              <Icon name="search" size={11} strokeWidth={2.4} />
              Missing research
            </span>
          ) : (
            <RoleMark role={role} kindLabel={kindLabel} className="min-w-0 flex-1" />
          )}
          {slot && <span className="flex-1" />}
          {box.dupOf && (
            <span className="shrink-0 rounded border border-accent/40 bg-accent/12 px-1 text-[9.5px] font-semibold text-accent" title={`The same item, also shown${groupLabel ? ` in “${groupLabel}”` : ' elsewhere'}`}>
              same item
            </span>
          )}
          {affected && box.tier !== 'context' && <Icon name="alert" size={13} strokeWidth={2.2} className="shrink-0 text-warn" aria-hidden="true" />}
        </span>
        <span
          className={cx('mt-1 shrink-0 text-ink', box.tier === 'focus' ? 'font-display text-[15.5px] leading-[1.28] font-semibold' : 'text-[12.5px] leading-[1.32] font-medium', retracted && 'line-through decoration-bad/70', slot && 'text-ink-2 italic')}
          style={{ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
        >
          {item.label}
        </span>
        {box.tier !== 'context' && (
          <span className="mt-auto flex w-full min-w-0 items-center gap-1.5 pt-1">
            {!slot && <UMini u={item.uncertainty} />}
            {srcCount > 0 && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-[10.5px] text-ink-3" title={`${srcCount} source${srcCount === 1 ? '' : 's'}`}>
                <Icon name="link" size={11} />
                {srcCount}
              </span>
            )}
            <span className="min-w-0 flex-1 overflow-hidden">
              <StatusLine item={item} compact />
            </span>
          </span>
        )}
      </m.span>
      {alsoSelected && <span className="pointer-events-none absolute inset-0 rounded-2xl ring-1 ring-accent-2/50" aria-hidden="true" />}
    </m.button>
  )
})

// ---------------------------------------------------------------- lanes

const LANE_COLOR: Record<Lane['tone'], string> = {
  support: POL.support.color,
  oppose: POL.oppose.color,
  qualify: POL.qualify.color,
  neutral: '#8a89b3',
  gap: '#fda4af',
  group: '#c8c2ff',
  context: '#5d5c86',
  conflict: '#fb7185',
}

function LaneLabel({ lane }: { lane: Lane }) {
  const color = LANE_COLOR[lane.tone]
  const x = lane.align === 'center' ? lane.x - lane.w / 2 : lane.align === 'right' ? lane.x - lane.w : lane.x
  if (lane.tone === 'conflict')
    return (
      <m.div
        className="pointer-events-none absolute flex items-center justify-center gap-1.5 text-[10.5px] font-semibold tracking-[0.12em] uppercase"
        style={{ left: x, top: lane.y, width: lane.w, color }}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <Icon name="columns" size={12} strokeWidth={2} />
        {lane.label}
      </m.div>
    )
  return (
    <m.div
      className={cx('pointer-events-none absolute flex items-baseline gap-2 truncate', lane.align === 'center' && 'justify-center')}
      style={{ left: x, top: lane.y, width: lane.w }}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
    >
      <span className="truncate font-display text-[11px] font-semibold tracking-[0.14em] uppercase" style={{ color }}>
        {lane.label}
      </span>
      {lane.count != null && <span className="font-mono text-[10.5px] text-ink-4">{lane.count}</span>}
    </m.div>
  )
}

// ---------------------------------------------------------------- edges

function anchor(b: NodeBox, tx: number, ty: number) {
  const cx = b.x + b.w / 2
  const cy = b.y + b.h / 2
  const dx = tx - cx
  const dy = ty - cy
  if (!dx && !dy) return { x: cx, y: cy }
  const sx = Math.abs(dx) / (b.w / 2 + 4)
  const sy = Math.abs(dy) / (b.h / 2 + 4)
  const s = Math.max(sx, sy)
  return { x: cx + dx / s, y: cy + dy / s }
}

function pathFor(e: { key: string }, a: NodeBox, b: NodeBox) {
  const p = anchor(a, b.x + b.w / 2, b.y + b.h / 2)
  const q = anchor(b, a.x + a.w / 2, a.y + a.h / 2)
  const mx = (p.x + q.x) / 2
  const my = (p.y + q.y) / 2
  const len = Math.hypot(q.x - p.x, q.y - p.y) || 1
  const bend = (hash(e.key) % 2 ? 1 : -1) * Math.min(40, len * 0.12)
  const cx = mx + (-(q.y - p.y) / len) * bend
  const cy = my + ((q.x - p.x) / len) * bend
  return { d: `M ${p.x.toFixed(1)} ${p.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${q.x.toFixed(1)} ${q.y.toFixed(1)}`, mid: { x: (p.x + 2 * cx + q.x) / 4, y: (p.y + 2 * cy + q.y) / 4 }, len }
}

const DASH: Record<EdgeBox['pol'], string | undefined> = { support: undefined, oppose: '6 5', qualify: '2 4', neutral: '1 5' }

function Edges({ layout, boxes, hot, picked, scope, narrow }: { layout: SceneLayout; boxes: Map<string, NodeBox>; hot: Set<string>; picked: Set<string>; scope: string; narrow: boolean }) {
  // labels only where they can be read: a few edges at the focus, long enough to hold the words
  const labelled = layout.edges.filter((e) => e.label).length <= 7 && !narrow
  // on a crowded narrow stage, only the links of what you picked are drawn; a busy focus is drawn faintly
  const crowded = narrow && layout.edges.length > 10
  const busyFocus = !!layout.focusKey && layout.edges.filter((e) => e.from === layout.focusKey || e.to === layout.focusKey).length > 10
  const mk = (pol: string) => `arrow-${scope.replace(/[^a-z0-9]/gi, '')}-${pol}`
  return (
    <svg className="pointer-events-none absolute inset-0" width={layout.width} height={layout.height} aria-hidden="true">
      <defs>
        {(Object.keys(POL) as (keyof typeof POL)[]).map((pol) => (
          <marker key={pol} id={mk(pol)} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 1 L 9 5 L 0 9 z" fill={POL[pol].color} />
          </marker>
        ))}
      </defs>
      {layout.same.map(([a, b]) => {
        const A = boxes.get(a)
        const B = boxes.get(b)
        if (!A || !B) return null
        const { d } = pathFor({ key: `${a}=${b}` }, A, B)
        return <m.path key={`same-${a}-${b}`} initial={{ opacity: 0, d }} animate={{ opacity: 0.55, d }} transition={SPRING} fill="none" stroke="#a493ff" strokeWidth={1.4} strokeDasharray="3 4" />
      })}
      <AnimatePresence initial={false}>
        {layout.edges.map((e) => {
          const A = boxes.get(e.from)
          const B = boxes.get(e.to)
          if (!A || !B) return null
          const { d, mid, len } = pathFor(e, A, B)
          const on = hot.has(e.from) || hot.has(e.to)
          const mine = picked.has(boxes.get(e.from)!.id) || picked.has(boxes.get(e.to)!.id)
          if (crowded && !mine) return null
          const faded = Math.min(A.opacity, B.opacity) < 0.7
          const color = POL[e.pol].color
          return (
            <m.g key={e.key} initial={{ opacity: 0 }} animate={{ opacity: mine ? 0.95 : on ? (busyFocus ? 0.3 : 0.9) : faded ? 0.2 : 0.42 }} exit={{ opacity: 0 }} transition={{ duration: 0.3 }}>
              <m.path initial={{ d }} animate={{ d }} transition={SPRING} fill="none" stroke={color} strokeWidth={on ? 1.6 + e.weight * 1.4 : 1 + e.weight} strokeDasharray={DASH[e.pol]} strokeLinecap="round" markerEnd={`url(#${mk(e.pol)})`} />
              {e.label && on && labelled && len > 34 + (e.label.length * 6.2) && (
                <m.text initial={false} animate={{ x: mid.x, y: mid.y }} transition={SPRING} textAnchor="middle" dominantBaseline="middle" fontSize={10.5} fontWeight={600} fill={color} stroke="rgb(6 6 22)" strokeWidth={4} paintOrder="stroke" style={{ fontFamily: 'var(--font-sans)' }}>
                  {e.label}
                </m.text>
              )}
            </m.g>
          )
        })}
      </AnimatePresence>
    </svg>
  )
}
