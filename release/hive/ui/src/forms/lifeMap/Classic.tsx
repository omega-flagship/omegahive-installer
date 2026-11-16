import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react'
import type { WorkItem } from '../../api/types'
import { BODY_PATH, NERVES, ORGANS, ORGAN_STROKES } from './anatomy'
import { Atmosphere, hexRgb, type Membrane } from './atmosphere'
import {
  evidenceOf,
  frameFor,
  KIND_COLOR,
  marksAt,
  POLARITY_COLOR,
  readingOf,
  restingName,
  STRUCTURE,
  STRUCTURES,
  TERRITORIES,
  TERRITORY,
  territoryCentre,
  type FigureFrame,
  type Mark,
  type TerritoryId,
} from './model'
import { AskModal, CaptureModal, DISCLAIMER, EmptyState, Header, Icon, LedgerModal, PlanPanel, SampleBanner, TimelinePanel, TodayPanel, ViewBar } from './panels'
import { ConsentDialog, Outcomes, Reading, ZoomRail } from './parts'
import type { Atlas } from './useAtlas'
import type { Level } from './types'

/* ================================================================ plate geometry (figure space, 400 x 900) */

/** Territory callouts, as on an anatomical plate: a label in the margin, a hairline to the territory. */
const CALLOUT: Record<TerritoryId, { x: number; y: number; to: string; side: -1 | 1 }> = {
  sleep: { x: -86, y: 40, to: 'sleep-architecture', side: -1 },
  mind: { x: -86, y: 132, to: 'affect', side: -1 },
  body: { x: -86, y: 300, to: 'heart', side: -1 },
  endocrine: { x: 486, y: 196, to: 'thyroid', side: 1 },
  metabolic: { x: 486, y: 420, to: 'liver', side: 1 },
  context: { x: 486, y: 640, to: 'travel', side: 1 },
}

/** Structure label placement, tuned so the crowded head reads cleanly. */
const SLABEL: Record<string, { side: -1 | 1; dx?: number; dy?: number }> = {
  'sleep-architecture': { side: -1, dx: -30, dy: -10 },
  'circadian-clock': { side: 1, dx: 32, dy: -14 },
  cortex: { side: 1, dx: 22, dy: 6 },
  affect: { side: -1, dx: -26, dy: 14 },
  pituitary: { side: 1, dx: 44, dy: 14 },
  airway: { side: -1, dx: -26, dy: 4 },
  thyroid: { side: 1, dx: 26, dy: 8 },
  heart: { side: -1, dx: -22 },
  lungs: { side: 1, dx: 18 },
  adrenal: { side: 1, dx: 22, dy: -22 },
  liver: { side: 1, dx: 34, dy: 14 },
  pancreas: { side: -1, dx: -20 },
  gut: { side: 1, dx: 32, dy: 30 },
  gonads: { side: -1, dx: -24, dy: 10 },
  muscle: { side: -1, dx: -18 },
  light: { side: 1, dx: 14 },
  intake: { side: 1, dx: 14 },
  travel: { side: 1, dx: 14 },
}

const REL_COLOR: Record<string, string> = { support: POLARITY_COLOR.support, oppose: POLARITY_COLOR.oppose, qualify: POLARITY_COLOR.qualify, neutral: 'color-mix(in oklab, var(--color-ink) 50%, transparent)' }

/* ================================================================ stage geometry */

interface Area {
  x: number
  y: number
  w: number
  h: number
}

function freeArea(W: number, H: number, view: string, sheet: boolean, mode: string): { area: Area; callouts: boolean; dim: number } {
  const desk = W >= 900
  const top = 64 + (mode === 'sample' ? 40 : 0)
  const bottom = desk ? 92 : 84
  if (desk && mode === 'empty') return { area: { x: 40, y: top, w: W * 0.5, h: H - top - 24 }, callouts: false, dim: 0 }
  if (desk) {
    const left = view === 'map' ? 0 : view === 'today' ? 440 : 520
    const right = sheet ? 500 : 64
    const chips = view === 'map' ? 56 : 0
    const area = { x: left, y: top + chips, w: Math.max(200, W - left - right), h: H - top - bottom - chips }
    return { area, callouts: area.w > 560, dim: view === 'timeline' || view === 'plan' ? 0.45 : 0 }
  }
  if (view === 'today') return { area: { x: 0, y: top, w: W, h: H * 0.5 - top + 20 }, callouts: false, dim: 0 }
  if (sheet) return { area: { x: 0, y: top, w: W, h: H * 0.42 - top + 10 }, callouts: false, dim: 0 }
  if (view !== 'map') return { area: { x: 0, y: top, w: W, h: H - top - bottom }, callouts: false, dim: 0.75 }
  return { area: { x: 0, y: top + 40, w: W - 44, h: H - top - bottom - 40 }, callouts: false, dim: 0 }
}

/** Callouts need margin: fit 640 units wide instead of 440 when they are drawn. */
function fitFrame(area: Area, level: Level, focus: { x: number; y: number } | null, callouts: boolean): FigureFrame {
  if (!callouts) return frameFor(area, level, focus)
  const f = frameFor({ ...area, w: (area.w * 440) / 660 }, level, focus)
  return { ...f, ox: f.ox + (area.w - (area.w * 440) / 660) / 2 }
}

const reducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

/* ================================================================ one frame */

interface Scene {
  width: number
  /** Labels outside the free area are hidden rather than drawn under the chrome. */
  area: { y0: number; y1: number }
  goal: FigureFrame
  /** In figure space. */
  membranes: Membrane[]
  dim: number
  figAlpha: number
  warm: number
}

interface FrameRefs {
  cam: RefObject<FigureFrame | null>
  scene: RefObject<Scene>
  plate: RefObject<SVGGElement | null>
  labels: RefObject<SVGGElement | null>
  atm: RefObject<Atmosphere | null>
}

/** Eases the camera toward its goal, moves the SVG plate and its screen-space labels, and paints the atmosphere. */
function drawFrame(r: FrameRefs, reduced: boolean, t: number) {
  const sc = r.scene.current
  const g = sc.goal
  const c = r.cam.current ?? g
  const k = reduced || !r.cam.current ? 1 : 0.12
  const next = { z: c.z + (g.z - c.z) * k, ox: c.ox + (g.ox - c.ox) * k, oy: c.oy + (g.oy - c.oy) * k }
  r.cam.current = next
  r.plate.current?.setAttribute('transform', `translate(${next.ox.toFixed(2)} ${next.oy.toFixed(2)}) scale(${next.z.toFixed(4)})`)
  const labels = r.labels.current
  labels?.querySelectorAll<SVGGElement>('[data-fx]').forEach((el) => {
    let x = next.ox + +el.dataset.fx! * next.z
    const y = next.oy + +el.dataset.fy! * next.z
    // keep labels on screen: measure once (local bbox, includes text-anchor), then clamp to the stage
    if (el.dataset.clamp) {
      if (el.dataset.bw == null) {
        const b = el.getBBox()
        el.dataset.bx = String(b.x)
        el.dataset.bw = String(b.width)
      }
      const bx = +el.dataset.bx!
      const bw = +el.dataset.bw!
      x = Math.max(8 - bx, Math.min(sc.width - 8 - bx - bw, x))
    }
    el.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(1)})`)
    if (el.dataset.clamp) el.style.visibility = y < sc.area.y0 || y > sc.area.y1 ? 'hidden' : ''
  })
  labels?.querySelectorAll<SVGElement>('[data-dx]').forEach((el) => {
    const x = (+el.dataset.dx! * next.z).toFixed(1)
    const y = (+el.dataset.dy! * next.z).toFixed(1)
    el.setAttribute(el.tagName === 'line' ? 'x2' : 'cx', x)
    el.setAttribute(el.tagName === 'line' ? 'y2' : 'cy', y)
  })
  r.atm.current?.render({
    t: reduced ? 14000 : t,
    cam: { x: next.ox, y: next.oy },
    dim: sc.dim,
    membranes: sc.membranes.map((m) => ({ ...m, x: next.ox + m.x * next.z, y: next.oy + m.y * next.z, r: m.r * next.z })),
    figure: { rect: [next.ox, next.oy, 400 * next.z, 900 * next.z], alpha: sc.figAlpha },
    pulse: reduced ? 0.4 : 0.5 + 0.5 * Math.sin(t / 900),
    warm: sc.warm,
  })
}

/* ================================================================ the plate */

export default function Classic({ atlas }: { atlas: Atlas }) {
  const root = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const plate = useRef<SVGGElement>(null)
  const labels = useRef<SVGGElement>(null)
  const [size, setSize] = useState({ W: 1440, H: 900 })
  const [glOk, setGlOk] = useState(true)
  const [reduced] = useState(reducedMotion)
  const { view, level, territory, selected, mode } = atlas
  const sheetOpen = !!selected && mode !== 'empty'
  const { area, callouts, dim } = freeArea(size.W, size.H, view, sheetOpen, mode)
  const desk = size.W >= 900

  const focusPoint = useMemo(() => {
    if (selected) {
      const p = atlas.place.get(selected)
      if (p) return { x: p.x, y: p.y }
    }
    if (territory) return territoryCentre(territory)
    return null
  }, [selected, territory, atlas.place])

  const target = fitFrame(area, view === 'map' ? level : 0, view === 'map' ? focusPoint : null, callouts)
  const marks = useMemo(() => (mode === 'empty' ? [] : marksAt(atlas.ix, atlas.place, level, { asOf: atlas.asOf, territory })), [mode, atlas.ix, atlas.place, level, atlas.asOf, territory])

  /* ---- size */
  useEffect(() => {
    const el = root.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setSize({ W: Math.round(e.contentRect.width), H: Math.round(e.contentRect.height) }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  /* ---- the render loop: one camera drives the GL atmosphere and the SVG plate */
  const counts = useMemo(() => {
    const c = new Map<string, number>()
    for (const it of atlas.graph.items) {
      const p = atlas.place.get(it.id)
      if (p?.structure && it.kind === 'observation') c.set(p.structure, (c.get(p.structure) ?? 0) + 1)
    }
    return c
  }, [atlas.graph, atlas.place])
  const selStruct = selected ? (atlas.place.get(selected)?.structure ?? null) : null
  const membranes = useMemo<Membrane[]>(
    () =>
      STRUCTURES.map((s) => {
        const n = counts.get(s.id) ?? 0
        const on = !territory || territory === s.territory
        const lit = mode === 'empty' ? 0.16 : Math.min(1, 0.32 + n / 40)
        return { x: s.x, y: s.y, r: (s.territory === 'context' ? 40 : 46) * (s.id === 'muscle' ? 1.6 : 1), rim: on ? 0.75 : 0.3, rgb: hexRgb(TERRITORY[s.territory].color), a: (on ? lit : lit * 0.25) * (s.id === selStruct ? 1.6 : 1) }
      }),
    [counts, territory, mode, selStruct],
  )
  const scene: Scene = { width: size.W, area: { y0: area.y - 4, y1: area.y + area.h + 4 }, goal: target, membranes, dim, figAlpha: mode === 'empty' ? 0.45 : 1, warm: territory ? 0.2 : 0.6 }
  const sceneRef = useRef(scene)
  useLayoutEffect(() => {
    sceneRef.current = scene
  })
  const cam = useRef<FigureFrame | null>(null)
  const atm = useRef<Atmosphere | null>(null)
  const frame = useCallback((t: number) => drawFrame({ cam, scene: sceneRef, plate, labels, atm }, reduced, t), [reduced])

  useEffect(() => {
    const cv = canvas.current
    if (!cv) return
    const a = new Atmosphere(cv)
    if (!a.ok) {
      setGlOk(false)
      a.dispose()
      return
    }
    atm.current = a
    a.onFigure = () => frame(performance.now())
    return () => {
      a.dispose()
      atm.current = null
    }
  }, [frame])
  useEffect(() => {
    atm.current?.resize(size.W, size.H, window.devicePixelRatio || 1)
  }, [size])

  // the loop: runs while visible; under reduced motion it draws only when something changes
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    const el = root.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting))
    io.observe(el)
    const onVis = () => setVisible(!document.hidden)
    document.addEventListener('visibilitychange', onVis)
    return () => {
      io.disconnect()
      document.removeEventListener('visibilitychange', onVis)
    }
  }, [])
  useEffect(() => {
    if (!visible) return
    if (reduced) {
      frame(0)
      return
    }
    let raf = 0
    const loop = (t: number) => {
      frame(t)
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [visible, reduced, frame])
  useEffect(() => {
    if (reduced) frame(0)
  })

  const openMap = useCallback(
    (id?: string, t?: TerritoryId) => {
      atlas.setView('map')
      if (t) atlas.focusTerritory(t)
      if (id) {
        const it = atlas.ix.byId.get(id)
        if (it?.kind === 'observation' && atlas.level < 2) atlas.setLevel(2)
        if ((it?.kind === 'hypothesis' || it?.kind === 'prediction' || it?.kind === 'experiment') && atlas.level < 1) atlas.setLevel(1)
        if ((it?.kind === 'event' || it?.kind === 'literature' || (it?.status && it.status !== 'current')) && atlas.level < 3) atlas.setLevel(3)
        atlas.select(id)
      }
    },
    [atlas],
  )

  const showLabels = view === 'map' || (view === 'today' && desk)
  const z = target.z

  return (
    <div ref={root} className="lm lm-classic" data-view={view} data-mode={mode} data-sheet={sheetOpen ? 'y' : undefined}>
      <canvas ref={canvas} className="lm-gl" aria-hidden="true" />
      {!glOk && <div className="lm-gl-fallback" aria-hidden="true" />}
      <svg className="lm-plate" width={size.W} height={size.H} aria-hidden={view !== 'map' ? true : undefined} role={view === 'map' ? 'group' : undefined} aria-label={view === 'map' ? 'The body map' : undefined}>
        <defs>
          {Object.entries(KIND_COLOR).map(([k, c]) => (
            <radialGradient key={k} id={`lm-orb-${k}`}>
              <stop offset="0" stopColor="#fff" stopOpacity="1" />
              <stop offset=".35" stopColor={c} stopOpacity=".95" />
              <stop offset="1" stopColor={c} stopOpacity="0" />
            </radialGradient>
          ))}
          <radialGradient id="lm-fallback-body" cx=".45" cy=".35" r=".8">
            <stop offset="0" stopColor="#3d58a8" stopOpacity=".55" />
            <stop offset="1" stopColor="#0f1a3a" stopOpacity=".2" />
          </radialGradient>
        </defs>
        <g ref={plate}>
          <Figure ink={!glOk} empty={mode === 'empty'} />
          {view === 'map' && <Threads atlas={atlas} marks={marks} level={level} />}
          {mode !== 'empty' && <Marks atlas={atlas} marks={marks} interactive={view === 'map'} z={z} />}
        </g>
        <g ref={labels} className="lm-labels">
          {showLabels && mode !== 'empty' && callouts && (level === 0 || view !== 'map') && <Callouts atlas={atlas} />}
          {view === 'map' && level >= 1 && mode !== 'empty' && <StructureLabels atlas={atlas} marks={marks} level={level} />}
        </g>
      </svg>

      <Header atlas={atlas} />
      <SampleBanner atlas={atlas} />

      {mode === 'empty' ? (
        <EmptyState atlas={atlas} />
      ) : (
        <>
          {view === 'today' && (
            <aside className="lm-side lm-side-today">
              <TodayPanel atlas={atlas} openMap={openMap} />
            </aside>
          )}
          {view === 'timeline' && (
            <aside className="lm-side lm-side-wide">
              <TimelinePanel atlas={atlas} openMap={openMap} />
            </aside>
          )}
          {view === 'plan' && (
            <aside className="lm-side lm-side-wide">
              <PlanPanel atlas={atlas} openMap={openMap} />
            </aside>
          )}
          {view === 'map' && (
            <>
              <MapHead atlas={atlas} />
              <ZoomRail level={level} onLevel={atlas.setLevel} />
              <Legend level={level} />
            </>
          )}
          {sheetOpen && (
            <div className="lm-sheet lm-paper" key={selected}>
              <div className="lm-sheet-grip" aria-hidden="true" />
              <Reading atlas={atlas} id={selected!} onClose={() => atlas.select(null)} />
            </div>
          )}
          <button type="button" className="lm-fab" onClick={() => atlas.setPanel('capture')} aria-label="Add to your record" title="Add to your record">
            <Icon name="plus" size={24} />
          </button>
          <ViewBar atlas={atlas} />
          <p className="lm-disclaimer">{DISCLAIMER}</p>
        </>
      )}

      {atlas.panel === 'ask' && <AskModal atlas={atlas} openMap={openMap} />}
      {atlas.panel === 'ledger' && <LedgerModal atlas={atlas} />}
      {atlas.panel === 'capture' && <CaptureModal atlas={atlas} />}
      <ConsentDialog atlas={atlas} />
      <Outcomes atlas={atlas} />
    </div>
  )
}

/* ================================================================ the figure (ink line-work above the light) */

function Figure({ ink, empty }: { ink: boolean; empty: boolean }) {
  return (
    <g className="lm-figure" data-empty={empty ? 'y' : undefined}>
      {ink && <path d={BODY_PATH} fill="url(#lm-fallback-body)" />}
      <path d={BODY_PATH} className="lm-figure-contour" />
      {ink &&
        ORGANS.map((o) => <path key={o.id} d={o.d} className="lm-figure-organ" fillRule="evenodd" />)}
      {ink && ORGAN_STROKES.map((d, i) => <path key={i} d={d} className="lm-figure-stroke" />)}
      {ink && NERVES.slice(0, 16).map((d, i) => <path key={i} d={d} className="lm-figure-nerve" />)}
    </g>
  )
}

/* ================================================================ marks */

const R: Record<string, number> = { observation: 4.6, event: 3.2, hypothesis: 8.5, prediction: 6.5, experiment: 6.5, literature: 5.5, question: 0, subject: 0 }

function Marks({ atlas, marks, interactive, z }: { atlas: Atlas; marks: Mark[]; interactive: boolean; z: number }) {
  const sel = atlas.selected
  const related = useMemo(() => {
    if (!sel) return null
    const s = new Set([sel])
    for (const l of [...(atlas.ix.out.get(sel) ?? []), ...(atlas.ix.into.get(sel) ?? [])]) s.add(l.from === sel ? l.to : l.from)
    return s
  }, [sel, atlas.ix])
  const onKey = (e: KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      atlas.select(id)
    }
  }
  const k = 1 / Math.max(0.6, Math.min(z, 1.8))
  return (
    <g className="lm-marks">
      {marks.map((m) => {
        const it = m.item
        if (it.kind === 'subject' || it.kind === 'question') return null
        const r = (R[it.kind] ?? 4) * (m.presence === 'glimmer' ? 0.42 : 1) * Math.sqrt(k)
        const retired = it.status && it.status !== 'current'
        const isSel = sel === it.id
        const faded = related && !related.has(it.id) ? 0.28 : 1
        const color = it.kind === 'observation' ? TERRITORY[m.place.territory].color : KIND_COLOR[it.kind]
        const full = m.presence === 'full' && interactive
        const name = `${restingName(it)}, ${it.kind}${retired ? `, ${it.status}` : ''}`
        return (
          <g
            key={it.id}
            className="lm-mark"
            data-kind={it.kind}
            data-presence={m.presence}
            data-retired={retired ? 'y' : undefined}
            data-sel={isSel ? 'y' : undefined}
            transform={`translate(${m.place.x.toFixed(1)} ${m.place.y.toFixed(1)})`}
            opacity={faded}
            role={full ? 'button' : undefined}
            tabIndex={full ? 0 : undefined}
            aria-label={full ? name : undefined}
            aria-hidden={full ? undefined : true}
            onClick={full ? () => atlas.select(it.id) : undefined}
            onKeyDown={full ? (e) => onKey(e, it.id) : undefined}
          >
            {full && <circle r={Math.max(r * 2.2, 9)} className="lm-hit" />}
            {m.presence === 'full' && it.kind !== 'observation' && <circle r={r * 3.2} fill={`url(#lm-orb-${it.kind in KIND_COLOR ? it.kind : 'event'})`} opacity={0.5} />}
            {it.kind === 'hypothesis' && m.presence === 'full' ? (
              <>
                <circle r={r} fill="none" stroke={color} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
                <circle r={r * 0.42} fill={color} />
              </>
            ) : it.kind === 'prediction' ? (
              <path d={`M0 ${-r} L${r} 0 L0 ${r} L${-r} 0Z`} fill={color} opacity={0.9} />
            ) : it.kind === 'experiment' ? (
              <rect x={-r} y={-r} width={r * 2} height={r * 2} rx={r * 0.35} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
            ) : it.kind === 'literature' ? (
              <rect x={-r * 0.75} y={-r} width={r * 1.5} height={r * 2} rx={1} fill={color} opacity={0.85} />
            ) : it.kind === 'event' ? (
              <circle r={r} fill="none" stroke={color} strokeWidth={1} vectorEffect="non-scaling-stroke" strokeDasharray={retired ? '2 2' : undefined} />
            ) : (
              <>
                <circle r={r * 1.9} fill={color} opacity={m.presence === 'glimmer' ? 0.1 : 0.16} />
                <circle r={r} fill={color} opacity={m.presence === 'glimmer' ? 0.55 : 0.95} />
                <circle r={r * 0.4} fill="#fff" opacity={m.presence === 'glimmer' ? 0 : 0.85} />
              </>
            )}
            {retired && m.presence === 'full' && <path d={`M${-r * 1.4} ${r * 1.4} L${r * 1.4} ${-r * 1.4}`} stroke="#ff9aa6" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />}
            {isSel && <circle r={r * 2.4 + 4} className="lm-sel-ring" vectorEffect="non-scaling-stroke" />}
            {m.folded > 0 && (
              <text className="lm-folded" x={r + 4} y={-r - 2}>
                +{m.folded}
              </text>
            )}
          </g>
        )
      })}
    </g>
  )
}

/** Evidence threads for the selected idea (support, opposition, qualification in the relation family), and at Provenance, extraction and correction threads. */
function Threads({ atlas, marks, level }: { atlas: Atlas; marks: Mark[]; level: Level }) {
  const shown = useMemo(() => new Set(marks.filter((m) => m.presence === 'full').map((m) => m.item.id)), [marks])
  const sel = atlas.selected
  const lines: { id: string; a: { x: number; y: number }; b: { x: number; y: number }; color: string; dash?: string; w: number }[] = []
  if (sel) {
    const ev = evidenceOf(atlas.ix, sel)
    for (const pol of ['support', 'oppose', 'qualify', 'neutral'] as const)
      for (const { item, link } of ev[pol]) {
        const a = atlas.place.get(sel)
        const b = atlas.place.get(item.id)
        if (a && b) lines.push({ id: link.id, a, b, color: REL_COLOR[pol], dash: pol === 'qualify' ? '4 4' : undefined, w: 1.3 })
      }
  }
  if (level >= 3)
    for (const l of atlas.graph.links) {
      if (l.rel !== 'extracted-from' && l.rel !== 'corrects' && l.rel !== 'supersedes') continue
      if (!shown.has(l.from) || !shown.has(l.to)) continue
      const a = atlas.place.get(l.from)
      const b = atlas.place.get(l.to)
      if (a && b) lines.push({ id: l.id, a, b, color: l.rel === 'extracted-from' ? 'color-mix(in oklab, var(--color-ink) 22%, transparent)' : POLARITY_COLOR.qualify, dash: l.rel === 'extracted-from' ? undefined : '3 3', w: l.rel === 'extracted-from' ? 0.7 : 1.2 })
    }
  return (
    <g className="lm-threads" aria-hidden="true">
      {lines.map((l) => {
        const mx = (l.a.x + l.b.x) / 2 + (l.b.y - l.a.y) * 0.12
        const my = (l.a.y + l.b.y) / 2 - (l.b.x - l.a.x) * 0.12
        return <path key={l.id} d={`M${l.a.x} ${l.a.y} Q${mx} ${my} ${l.b.x} ${l.b.y}`} fill="none" stroke={l.color} strokeWidth={l.w} strokeDasharray={l.dash} vectorEffect="non-scaling-stroke" />
      })}
    </g>
  )
}

/* ================================================================ labels in screen space (they never scale) */

function Callouts({ atlas }: { atlas: Atlas }) {
  const per = atlas.summary.perTerritory
  return (
    <>
      {TERRITORIES.map((t) => {
        const c = CALLOUT[t.id]
        const s = STRUCTURE[c.to]
        const n = per.find((p) => p.territory === t.id)
        const on = !atlas.territory || atlas.territory === t.id
        return (
          <g key={t.id} className="lm-callout" data-on={on ? 'y' : 'n'} style={{ ['--tc' as string]: t.color }}>
            <g data-fx={c.x} data-fy={c.y}>
              <text className="lm-callout-name" textAnchor={c.side < 0 ? 'end' : 'start'} y={-2}>
                {t.label}
              </text>
              <text className="lm-callout-sub" textAnchor={c.side < 0 ? 'end' : 'start'} y={15}>
                {n ? `${n.observations} observations · ${n.hypotheses} idea${n.hypotheses === 1 ? '' : 's'}` : ''}
              </text>
            </g>
            <CalloutLine x1={c.x + c.side * -8} y1={c.y - 6} x2={s.x} y2={s.y} />
          </g>
        )
      })}
    </>
  )
}

/** A hairline from the callout to its territory: anchored in figure space, drawn in screen space, rescaled each frame. */
function CalloutLine({ x1, y1, x2, y2 }: { x1: number; y1: number; x2: number; y2: number }) {
  return (
    <g data-fx={x1} data-fy={y1} className="lm-leader">
      <line x1={0} y1={0} x2={x2 - x1} y2={y2 - y1} className="lm-leader-line" data-dx={x2 - x1} data-dy={y2 - y1} />
      <circle r={2.6} cx={x2 - x1} cy={y2 - y1} className="lm-leader-dot" data-dx={x2 - x1} data-dy={y2 - y1} />
    </g>
  )
}

function StructureLabels({ atlas, marks, level }: { atlas: Atlas; marks: Mark[]; level: Level }) {
  const newest = useMemo(() => {
    const m = new Map<string, WorkItem>()
    for (const k of marks) {
      const s = k.place.structure
      if (!s || k.presence !== 'full' || k.item.kind !== 'observation') continue
      const cur = m.get(s)
      if (!cur || (k.item.at ?? '') > (cur.at ?? '')) m.set(s, k.item)
    }
    return m
  }, [marks])
  // a selection narrows the labels to its own territory, so the reading stays the subject
  const t = atlas.territory ?? (atlas.selected ? (atlas.place.get(atlas.selected)?.territory ?? null) : null)
  return (
    <>
      {STRUCTURES.filter((s) => !t || s.territory === t || (level < 2 && !atlas.selected)).map((s) => {
        const L = SLABEL[s.id] ?? { side: 1 }
        // values are named at the Values depth; at Provenance the threads speak, so labels quieten to names
        const latest = level === 2 || (level === 3 && t) ? newest.get(s.id) : undefined
        const reading = latest ? readingOf(latest) : null
        const shown = latest && atlas.revealer.shown(latest.id)
        return (
          <g key={s.id + (latest?.id ?? '') + (shown ? 'o' : '')} className="lm-slabel" data-level={level} style={{ ['--tc' as string]: TERRITORY[s.territory].color }} data-fx={s.x + (L.dx ?? L.side * 16)} data-fy={s.y + (L.dy ?? 0)} data-clamp="y">
            <text textAnchor={L.side < 0 ? 'end' : 'start'} className="lm-slabel-name" y={4}>
              {s.label}
            </text>
            {latest && (
              <text textAnchor={L.side < 0 ? 'end' : 'start'} className="lm-slabel-val" y={19}>
                {clip(restingName(latest), 26)} {reading ? (shown ? `${reading.value}${reading.unit ? ' ' + reading.unit : ''}` : '· sealed') : ''}
              </text>
            )}
          </g>
        )
      })}
    </>
  )
}

const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/[\s,;:(]+\S*$/, '') + '…')

/* ================================================================ map chrome */

function MapHead({ atlas }: { atlas: Atlas }) {
  const t = atlas.territory ? TERRITORY[atlas.territory] : null
  return (
    <div className="lm-maphead">
      <div className="lm-chips" role="group" aria-label="Territories">
        <button type="button" className="lm-chip" data-on={!t ? 'y' : undefined} onClick={() => atlas.focusTerritory(null)}>
          Whole body
        </button>
        {TERRITORIES.map((x) => (
          <button key={x.id} type="button" className="lm-chip" style={{ ['--tc' as string]: x.color }} data-on={atlas.territory === x.id ? 'y' : undefined} onClick={() => atlas.focusTerritory(atlas.territory === x.id ? null : x.id)}>
            <i aria-hidden="true" />
            {x.label}
          </button>
        ))}
      </div>
      {t && <p className="lm-maphead-gist">{t.gist}</p>}
      {atlas.asOf && (
        <p className="lm-maphead-asof">
          As it stood at the end of {atlas.asOf.slice(0, 7)} ·{' '}
          <button type="button" className="lm-link" onClick={() => atlas.setAsOf(null)}>
            back to now
          </button>
        </p>
      )}
    </div>
  )
}

function Legend({ level }: { level: Level }) {
  const items: [string, string, string][] = [
    ['observation', 'Observation', 'dot'],
    ['hypothesis', 'Idea', 'ring'],
    ['prediction', 'Prediction', 'diamond'],
    ['experiment', 'Experiment', 'square'],
  ]
  if (level >= 3) items.push(['event', 'Recorded event', 'hollow'], ['literature', 'Literature', 'doc'])
  return (
    <div className="lm-legend" aria-label="Legend">
      {items.map(([k, n, shape]) => (
        <span key={k} data-shape={shape} style={{ ['--kc' as string]: KIND_COLOR[k] }}>
          <i aria-hidden="true" />
          {n}
        </span>
      ))}
      <span data-shape="line" style={{ ['--kc' as string]: POLARITY_COLOR.support }}>
        <i aria-hidden="true" />
        leans toward
      </span>
      <span data-shape="line" style={{ ['--kc' as string]: POLARITY_COLOR.oppose }}>
        <i aria-hidden="true" />
        leans against
      </span>
    </div>
  )
}
