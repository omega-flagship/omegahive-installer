/**
 * The demo cursor and the draw layer on screen (features/ink/ink.ts holds their state), shared by the D4 showreel and
 * guided-play. Mounted once, with the guided layer (App.tsx), so a real hive's guided demo has it without loading the
 * showreel. aria-hidden and pointer-events: none throughout: it never takes a pointer, focus or a press.
 * Reduced motion (the system's or the look's own "no motion"): the cursor jumps, the marks appear without drawing,
 * and their words say what they mark.
 */
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { findIn } from '../guided/driver'
import { picksNow } from '../guided/store'
import { markElement, useInk, visiblePart, type Mark } from './ink'
import { useLookReduced } from './lookReduced'
import { dialogTitle, labelTop, type Box } from './labels'
import './ink.css'


/** a mark's box, with the box of the title of the dialog it is in (its label keeps off that title) */
interface MarkBox extends Box {
  title?: Box | null
}

function useBoxes(marks: Mark[]): (MarkBox | null)[] {
  const [boxes, setBoxes] = useState<(MarkBox | null)[]>([])
  useEffect(() => {
    if (!marks.length) return
    let raf = 0
    const measure = () => {
      raf = 0
      const next = marks.map((m) => {
        // the very element the player chose, and no mark once it has gone (r1.2b); an unbound mark is found
        const el = markElement(m, () => findIn(document, m.target, picksNow()))
        const r = el?.getBoundingClientRect()
        const t = dialogTitle(el)?.getBoundingClientRect()
        const title = t && t.width > 0 ? { left: t.left, top: t.top, right: t.right, bottom: t.bottom } : null
        // drawn on the part of it that is on screen: a mark never rings empty space below the window
        const box = r && r.width > 0 ? visiblePart(r, window.innerWidth, window.innerHeight) : null
        return box ? { ...box, title } : null
      })
      setBoxes((b) => (JSON.stringify(b) === JSON.stringify(next) ? b : next))
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    schedule()
    const t = window.setInterval(schedule, 300)
    window.addEventListener('scroll', schedule, true)
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      window.clearInterval(t)
      window.removeEventListener('scroll', schedule, true)
      window.removeEventListener('resize', schedule)
    }
  }, [marks])
  return marks.length ? boxes : []
}

const clampTo = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

function MarkShape({ m, b, reduced }: { m: Mark; b: Box; reduced: boolean }) {
  const w = b.right - b.left
  const h = b.bottom - b.top
  const anim = reduced ? undefined : 'sr-draw'
  if (m.kind === 'circle') {
    const rx = Math.min(w / 2 + 14, window.innerWidth / 2)
    const ry = Math.min(h / 2 + 12, window.innerHeight / 2)
    return <ellipse className={anim} cx={b.left + w / 2} cy={b.top + h / 2} rx={rx} ry={ry} pathLength={1} />
  }
  if (m.kind === 'underline') {
    const y = clampTo(b.bottom + 6, 8, window.innerHeight - 8)
    const x1 = Math.max(8, b.left)
    const x2 = Math.min(window.innerWidth - 8, b.right)
    return <path className={anim} d={`M ${x1} ${y} Q ${(x1 + x2) / 2} ${y + 7} ${x2} ${y - 2}`} pathLength={1} />
  }
  // an arrow from up and to the left (or below, near the top), to the target's corner
  const tx = clampTo(b.left + Math.min(28, w / 2), 12, window.innerWidth - 12)
  const ty = clampTo(b.top + Math.min(20, h / 2), 12, window.innerHeight - 12)
  const fx = clampTo(tx - 90, 12, window.innerWidth - 12)
  const fy = ty > 120 ? ty - 80 : ty + 90
  const ang = Math.atan2(ty - fy, tx - fx)
  const hx = (a: number) => tx - 12 * Math.cos(ang + a)
  const hy = (a: number) => ty - 12 * Math.sin(ang + a)
  return (
    <g className={anim}>
      <path d={`M ${fx} ${fy} Q ${fx + 10} ${(fy + ty) / 2} ${tx} ${ty}`} pathLength={1} />
      <path d={`M ${hx(0.5)} ${hy(0.5)} L ${tx} ${ty} L ${hx(-0.5)} ${hy(-0.5)}`} pathLength={1} />
    </g>
  )
}

function DrawLayer({ reduced }: { reduced: boolean }) {
  const marks = useInk((s) => s.marks)
  const boxes = useBoxes(marks)
  if (!marks.length) return null
  return (
    <div className="sr-ink" aria-hidden="true" data-reduced={reduced || undefined}>
      <svg width="100%" height="100%">
        {marks.map((m, i) => (boxes[i] ? <MarkShape key={`${i}-${m.kind}`} m={m} b={boxes[i]!} reduced={reduced} /> : null))}
      </svg>
      {marks.map((m, i) => {
        const b = boxes[i]
        if (!b || !m.label) return null
        // above the mark, or below it (no room above, or above would cover its dialog's title): labels.ts
        const left = clampTo(b.left, 8, window.innerWidth - 220)
        return (
          <span key={`l${i}`} className="sr-ink-label" style={{ left, top: labelTop(b, left, window.innerHeight, b.title) }}>
            {reduced ? `Marked: ${m.label}` : m.label}
          </span>
        )
      })}
    </div>
  )
}

function Cursor({ reduced }: { reduced: boolean }) {
  const c = useInk((s) => s.cursor)
  if (!c.shown) return null
  return (
    <div className="sr-cursor" aria-hidden="true" data-jump={c.jump || reduced || undefined} style={{ transform: `translate(${c.x}px, ${c.y}px)` }}>
      <svg width="22" height="26" viewBox="0 0 22 26">
        <path d="M2 2 L2 21 L7 16.5 L10.5 24 L14 22.5 L10.5 15 L17.5 15 Z" />
      </svg>
      {c.clicks > 0 && <span key={c.clicks} className="sr-click" />}
    </div>
  )
}



/** The cursor and the marks, whoever is drawing them. */
export function InkLayer() {
  const reduced = useLookReduced()
  const shown = useInk((s) => s.cursor.shown || s.marks.length > 0)
  if (!shown) return null
  return createPortal(
    <>
      <DrawLayer reduced={reduced} />
      <Cursor reduced={reduced} />
    </>,
    document.body,
  )
}
