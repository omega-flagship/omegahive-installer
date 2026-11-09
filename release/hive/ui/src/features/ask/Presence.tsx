/**
 * Presence (Jon, 2026-10-05: watch the orchestrator work live). Presentation only: it never moves focus, takes no
 * pointer events, and is inert (and hidden) under a modal. Each experience has its own system:
 *  - Classic: a soft light glides to the target, which glows, with a caption pill; `sketch` is a stronger glow.
 *  - Still: the referenced words light up (on the paper and in the letter thread).
 *  - Cosmos: a comms beacon flies from where it was (or from the console) to the target, leaving a light trail, and
 *    locks onto it with HUD brackets and a transmission caption.
 *  - Flux: a glowing current flows from where it was to the target, which glows like lit glass; the liquid ripples
 *    there (through the experience's bridge).
 *  - Construct: a block caret frames the target like a second operator's cursor; Construct's console also echoes the
 *    orchestrator's work as typed lines (experiences/construct, from the same store).
 *  - Canvas: the mind's cursor glides to the target and leaves a sticky note beside it; `sketch` is the pencil: a
 *    hand-drawn loop around the target, drawn as you watch (the pencil is Canvas's only).
 * Reduced motion: an instant highlight and the caption. A conductor `highlight` is in place: the glow, no travelling light. A target not on screen is said as "not on screen"; it is
 * never searched for, scrolled to or fetched. Outside Canvas `sketch` is each experience's own stronger emphasis.
 */
import { useEffect, useMemo, useState } from 'react'
import { featureById } from '../registry'
import { useHive } from '../../store/store'
import { useReducedMotion } from '../../lib/hooks'
import { resolvePresence, type Box } from '../../lib/presence'
import { useAskStore, type PresenceItem } from '../../store/ask'
import { shownMind } from './words'
import { askBridge } from './bridge'

export const PRESENCE_MS = 4200

interface Shown {
  item: PresenceItem
  box: Box | null
  /** where the light comes from (the last place it was) */
  from: { x: number; y: number } | null
}

const verbWord: Record<PresenceItem['verb'], string> = { look: 'looking', point: 'pointing', go: 'going', arrange: 'arranging', propose: 'proposing', sketch: 'marking' }

function useLatestPresence(): PresenceItem | null {
  const items = useAskStore((s) => s.presence)
  return items.length ? items[items.length - 1] : null
}

let lastPoint: { x: number; y: number } | null = null

/** Resolve in a frame callback and while visible (layout can move under it); one rAF per frame at most, none idle. */
function useResolved(item: PresenceItem | null): Shown | null {
  const [shown, setShown] = useState<Shown | null>(null)
  useEffect(() => {
    if (!item) return
    let raf = 0
    let from: { x: number; y: number } | null | undefined
    const measure = () => {
      raf = 0
      const r = resolvePresence(item.target, document, { width: window.innerWidth, height: window.innerHeight })
      const box = r.kind === 'found' ? r.box : null
      if (from === undefined) {
        from = lastPoint
        if (box) lastPoint = { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 }
      }
      setShown({ item, box, from })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    schedule()
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    // the page may still be arriving (a `go`): look again once it has
    const again = window.setTimeout(schedule, 450)
    const drop = window.setTimeout(() => useAskStore.getState().dropPresence(item.id), PRESENCE_MS)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.clearTimeout(again)
      window.clearTimeout(drop)
    }
  }, [item])
  return item && shown?.item === item ? shown : null
}

/** Classic: a soft light, an outline glow and a caption pill. */
export function ClassicPresence() {
  const item = useLatestPresence()
  const shown = useResolved(item)
  const reduced = useReducedMotion()
  if (!shown) return null
  const { box } = shown
  const who = shownMind(shown.item.actor.name)
  const caption = shown.item.caption || `${who} is ${verbWord[shown.item.verb]}`
  const strong = shown.item.verb === 'sketch'
  if (!box) {
    return (
      <div className="ask-presence-layer" aria-hidden="false">
        <p className="ask-presence-pill" data-off="" role="status">
          <b>{who}</b> · {caption} · not on screen
        </p>
      </div>
    )
  }
  const x = (box.left + box.right) / 2
  const y = (box.top + box.bottom) / 2
  const from = shown.from ?? { x: x - 60, y: y + 40 }
  const pillTop = box.bottom + 10 > window.innerHeight - 60 ? Math.max(8, box.top - 40) : box.bottom + 10
  return (
    <div className="ask-presence-layer" data-reduced={reduced || undefined}>
      <span
        key={`glow-${shown.item.id}`}
        className="ask-presence-glow"
        data-strong={strong || undefined}
        style={{ left: box.left - 6, top: box.top - 6, width: box.right - box.left + 12, height: box.bottom - box.top + 12 }}
      />
      {!reduced && !shown.item.still && <span key={`light-${shown.item.id}`} className="ask-presence-light" style={{ ['--from-x' as string]: `${from.x}px`, ['--from-y' as string]: `${from.y}px`, left: x, top: y }} />}
      <p className="ask-presence-pill" role="status" style={{ left: Math.min(Math.max(12, x), window.innerWidth - 12), top: pillTop }}>
        <b>{who}</b> · {caption}
      </p>
    </div>
  )
}

/** Still: the referenced elements on the paper light up, like a highlighted word; the caption sits as a margin note. */
export function StillPresence() {
  const item = useLatestPresence()
  const shown = useResolved(item)
  useEffect(() => {
    if (!shown?.item) return
    const r = resolvePresence(shown.item.target, document, { width: window.innerWidth, height: window.innerHeight })
    if (r.kind !== 'found') return
    const els = r.els as unknown as HTMLElement[]
    const cls = shown.item.verb === 'sketch' ? 'ask-lit-strong' : 'ask-lit'
    els.forEach((e) => e.classList.add(cls))
    return () => els.forEach((e) => e.classList.remove(cls))
  }, [shown])
  if (!shown) return null
  const who = shownMind(shown.item.actor.name)
  return (
    <div className="ask-presence-layer">
      <p className="ask-presence-note" role="status">
        {who}: {shown.item.caption || verbWord[shown.item.verb]}
        {!shown.box && ' · not on screen'}
      </p>
    </div>
  )
}

/** The words the orchestrator is referring to now (a mind's or swarm's name, a feature's label), to light up. */
export function usePresenceWords(): string[] {
  const presence = useAskStore((s) => s.presence)
  const agents = useHive((s) => s.agents)
  const swarms = useHive((s) => s.swarms)
  return useMemo(() => {
    const p = presence[presence.length - 1]
    if (!p) return []
    const e = p.target.entity
    if (e?.kind === 'mind' && agents[e.ref]) return [agents[e.ref].name]
    if (e?.kind === 'swarm' && swarms[e.ref]) return [swarms[e.ref].name]
    const f = p.target.feature ? featureById(p.target.feature) : undefined
    return f ? [f.label] : []
  }, [presence, agents, swarms])
}

/** Where a flight starts when nothing was touched before: the Ask itself (the console, the capsule, the prompt). */
function askPoint(): { x: number; y: number } | null {
  const el = document.querySelector('.ask-root .ask-capsule, [data-ask-zone] [data-ask-input]')
  const r = el?.getBoundingClientRect()
  return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null
}

/** A gentle arc from a to b (the control point lifted off the straight line), as an SVG path. */
export function arcPath(a: { x: number; y: number }, b: { x: number; y: number }, bend = 0.22): string {
  const mx = (a.x + b.x) / 2
  const my = (a.y + b.y) / 2
  const dx = b.x - a.x
  const dy = b.y - a.y
  const cx = mx - dy * bend
  const cy = my + dx * bend
  const r = (n: number) => Math.round(n * 10) / 10
  return `M${r(a.x)} ${r(a.y)} Q${r(cx)} ${r(cy)} ${r(b.x)} ${r(b.y)}`
}

/** A centred caption's x, kept so a caption up to `max` wide stays on screen. */
const captionX = (x: number, max: number) => {
  const half = Math.min(max, window.innerWidth - 24) / 2 + 12
  return Math.min(Math.max(half, x), Math.max(half, window.innerWidth - half))
}

/**
 * Where a caption `h` tall goes for a target: just below it, else just above it; never over the Ask itself (a target
 * under the Ask, like a pill or a navigator, gets its caption above the Ask).
 */
function captionTop(b: Box, h: number): number {
  const H = window.innerHeight
  const ask = document.querySelector('.ask-root .ask-capsule, [data-ask-zone] .cx-cmd')?.getBoundingClientRect()
  const askTop = ask && ask.height ? ask.top : H
  const clear = (t: number) => t >= 4 && t + h <= H - 8 && (t + h <= askTop - 6 || t >= (ask?.bottom ?? H) + 6)
  const below = b.bottom + 12
  if (clear(below)) return below
  const above = b.top - h - 10
  if (clear(above)) return above
  return Math.max(4, askTop - h - 12)
}

function centre(b: Box) {
  return { x: (b.left + b.right) / 2, y: (b.top + b.bottom) / 2 }
}

/** Cosmos: a comms beacon flies to the target on a light trail and locks on with HUD brackets. */
export function CosmosPresence() {
  const item = useLatestPresence()
  const shown = useResolved(item)
  const reduced = useReducedMotion()
  if (!shown) return null
  const who = shownMind(shown.item.actor.name).toUpperCase()
  const caption = shown.item.caption || `${who} is ${verbWord[shown.item.verb]}`
  const { box } = shown
  if (!box)
    return (
      <div className="ask-presence-layer" data-look="cosmos">
        <p className="ask-cx-tx" data-off="" role="status">
          <b>{who}</b> ▸ {caption} · not on screen
        </p>
      </div>
    )
  const to = centre(box)
  const from = shown.from ?? askPoint() ?? { x: to.x, y: window.innerHeight }
  const path = arcPath(from, to)
  const strong = shown.item.verb === 'sketch'
  const tagTop = captionTop(box, 30)
  return (
    <div className="ask-presence-layer" data-look="cosmos" data-reduced={reduced || undefined}>
      {!reduced && !shown.item.still && (
        <svg key={`trail-${shown.item.id}`} className="ask-cx-trail" width="100%" height="100%" aria-hidden>
          <defs>
            <linearGradient id="ask-cx-grad" gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
              <stop offset="0" style={{ stopColor: 'var(--xc-accent)' }} stopOpacity="0" />
              <stop offset="1" style={{ stopColor: 'var(--xc-ink)' }} stopOpacity="0.95" />
            </linearGradient>
          </defs>
          <path d={path} pathLength={1} stroke="url(#ask-cx-grad)" />
        </svg>
      )}
      {!reduced && !shown.item.still && <span key={`ship-${shown.item.id}`} className="ask-cx-ship" style={{ offsetPath: `path('${path}')` }} aria-hidden />}
      <span key={`lock-${shown.item.id}`} className="ask-cx-lock" data-strong={strong || undefined} style={{ left: box.left - 8, top: box.top - 8, width: box.right - box.left + 16, height: box.bottom - box.top + 16 }} aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </span>
      <p className="ask-cx-tx" role="status" style={{ left: captionX(to.x, 380), top: tagTop }}>
        <b>{who}</b> ▸ {caption}
      </p>
    </div>
  )
}

/** Flux: a glowing current flows to the target, which lights like glass; the liquid ripples there. */
export function FluxPresence() {
  const item = useLatestPresence()
  const shown = useResolved(item)
  const reduced = useReducedMotion()
  const id = shown?.item.id
  const box = shown?.box
  useEffect(() => {
    if (!id || !box || reduced) return
    const c = centre(box)
    const t = window.setTimeout(() => askBridge('flux')?.ripple?.(c.x, c.y, 1.1), 520)
    return () => window.clearTimeout(t)
    // once per presence item (the box may be re-measured while it shows)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, !!box, reduced])
  if (!shown) return null
  const who = shownMind(shown.item.actor.name)
  const caption = shown.item.caption || `${who} is ${verbWord[shown.item.verb]}`
  if (!shown.box)
    return (
      <div className="ask-presence-layer" data-look="flux">
        <p className="ask-fx-bubble" data-off="" role="status">
          <b>{who}</b> · {caption} · not on screen
        </p>
      </div>
    )
  const b = shown.box
  const to = centre(b)
  const from = shown.from ?? askPoint() ?? { x: to.x, y: window.innerHeight }
  const strong = shown.item.verb === 'sketch'
  const top = captionTop(b, 34)
  return (
    <div className="ask-presence-layer" data-look="flux" data-reduced={reduced || undefined}>
      {!reduced && !shown.item.still && (
        <svg key={`current-${shown.item.id}`} className="ask-fx-current" width="100%" height="100%" aria-hidden>
          <defs>
            <linearGradient id="ask-fx-grad" gradientUnits="userSpaceOnUse" x1={from.x} y1={from.y} x2={to.x} y2={to.y}>
              <stop offset="0" style={{ stopColor: 'var(--xc-accent)' }} stopOpacity="0.15" />
              <stop offset="0.6" style={{ stopColor: 'var(--ax-soft)' }} stopOpacity="0.85" />
              <stop offset="1" style={{ stopColor: 'var(--xc-ink)' }} stopOpacity="0.95" />
            </linearGradient>
          </defs>
          <path className="ask-fx-flow" d={arcPath(from, to, 0.3)} pathLength={1} stroke="url(#ask-fx-grad)" />
        </svg>
      )}
      <span key={`glass-${shown.item.id}`} className="ask-fx-glow" data-strong={strong || undefined} style={{ left: b.left - 8, top: b.top - 8, width: b.right - b.left + 16, height: b.bottom - b.top + 16 }} aria-hidden />
      <p className="ask-fx-bubble" role="status" style={{ left: captionX(to.x, 360), top }}>
        <b>{who}</b> · {caption}
      </p>
    </div>
  )
}

/** Construct: a block caret frames the target, like a second operator's cursor, with the command it stands for. */
export function ConstructPresence() {
  const item = useLatestPresence()
  const shown = useResolved(item)
  const reduced = useReducedMotion()
  if (!shown) return null
  const who = shownMind(shown.item.actor.name).toLowerCase()
  const line = presenceCommand(shown.item)
  const caption = shown.item.caption
  if (!shown.box)
    return (
      <div className="ask-presence-layer" data-look="construct">
        <p className="ask-ct-tag" data-off="" role="status">
          {who}@hive ❯ {line}
          {caption ? `  # ${caption}` : ''} · not on screen
        </p>
      </div>
    )
  const b = shown.box
  // a big target (a whole pane) carries its tag inside its top edge; a small one just below it (or above, near the floor)
  const inside = b.bottom - b.top > 160
  const tagLeft = Math.min(Math.max(8, b.left + (inside ? 14 : 0)), Math.max(8, window.innerWidth - 240))
  const top = inside ? b.top + 6 : captionTop(b, 22)
  return (
    <div className="ask-presence-layer" data-look="construct" data-reduced={reduced || undefined}>
      <span key={`caret-${shown.item.id}`} className="ask-ct-frame" data-strong={shown.item.verb === 'sketch' || undefined} style={{ left: b.left - 4, top: b.top - 3, width: b.right - b.left + 8, height: b.bottom - b.top + 6 }} aria-hidden>
        <i className="ask-ct-caret" />
      </span>
      <p className="ask-ct-tag" role="status" style={{ left: tagLeft, top, maxWidth: `min(520px, ${window.innerWidth - tagLeft - 8}px)` }}>
        {who}@hive ❯ {line}
        {caption ? <span className="ask-ct-dim">{`  # ${caption}`}</span> : null}
      </p>
    </div>
  )
}

/** The presence as the command a second operator would type ("point work.goals", "look mind:a_vega01"). Plain text. */
export function presenceCommand(p: Pick<PresenceItem, 'verb' | 'target'>): string {
  const t = p.target
  const what = t.entity ? `${t.entity.kind}:${t.entity.ref}` : t.feature ?? (t.region ? `#${t.region}` : '')
  return `${p.verb}${what ? ` ${what}` : ''}`.slice(0, 80)
}

/**
 * A hand-drawn loop around a box: two passes, slightly out of true, as a pencil makes them (deterministic from the
 * seed, so a re-render never redraws it differently). Pure.
 */
export function pencilLoop(b: Box, seed = 1): string {
  const cx = (b.left + b.right) / 2
  const cy = (b.top + b.bottom) / 2
  const rx = (b.right - b.left) / 2 + 12
  const ry = (b.bottom - b.top) / 2 + 10
  const r = (n: number) => Math.round(n * 10) / 10
  const wob = (i: number) => Math.sin(seed * 12.9898 + i * 78.233) * 0.045
  const pts: string[] = []
  const steps = 26
  // a little more than one turn (1.12), starting up-left: the pencil overshoots where it began
  for (let i = 0; i <= steps; i++) {
    const t = -2.4 + (i / steps) * Math.PI * 2 * 1.12
    const k = 1 + wob(i) + (i / steps) * 0.05
    pts.push(`${r(cx + Math.cos(t) * rx * k)} ${r(cy + Math.sin(t) * ry * k)}`)
  }
  return `M${pts[0]} L${pts.slice(1).join(' L')}`
}

/**
 * Canvas: the mind's own cursor glides to the target, which it rings in the experience's accent, and leaves a sticky
 * note with the caption beside it. `sketch` is the pencil: a loop drawn around the target as you watch (reduced
 * motion: the finished loop). A conductor `highlight` (still) is the ring and the note in place, no cursor travel.
 */
export function CanvasPresence() {
  const item = useLatestPresence()
  const shown = useResolved(item)
  const reduced = useReducedMotion()
  if (!shown) return null
  const who = shownMind(shown.item.actor.name)
  const caption = shown.item.caption || `${who} is ${verbWord[shown.item.verb]}`
  const { box } = shown
  if (!box)
    return (
      <div className="ask-presence-layer" data-look="canvas">
        <p className="ask-cv-note" data-off="" role="status">
          <b>{who}</b> {caption} · not on screen
        </p>
      </div>
    )
  const to = centre(box)
  const from = shown.from ?? askPoint() ?? { x: to.x, y: window.innerHeight }
  const path = arcPath(from, { x: box.right - 6, y: box.bottom - 6 }, 0.16)
  const sketch = shown.item.verb === 'sketch'
  const noteTop = captionTop(box, 64)
  return (
    <div className="ask-presence-layer" data-look="canvas" data-reduced={reduced || undefined}>
      <span key={`ring-${shown.item.id}`} className="ask-cv-ring" style={{ left: box.left - 6, top: box.top - 6, width: box.right - box.left + 12, height: box.bottom - box.top + 12 }} aria-hidden />
      {sketch && (
        <svg key={`pencil-${shown.item.id}`} className="ask-cv-pencil" width="100%" height="100%" aria-hidden>
          <path d={pencilLoop(box, shown.item.at % 97)} pathLength={1} />
        </svg>
      )}
      {!reduced && !shown.item.still && (
        <span key={`cursor-${shown.item.id}`} className="ask-cv-cursor" style={{ offsetPath: `path('${path}')` }} aria-hidden>
          <svg viewBox="0 0 20 20" width="20" height="20">
            <path d="M3 2.5l13 6.2-5.6 1.5-2.4 5.3z" />
          </svg>
          <i>{who}</i>
        </span>
      )}
      <p className="ask-cv-note" role="status" style={{ left: captionX(to.x, 240), top: noteTop }}>
        <b>{who}</b> {caption}
      </p>
    </div>
  )
}
