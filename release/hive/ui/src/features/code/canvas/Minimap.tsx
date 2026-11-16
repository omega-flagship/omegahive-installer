import { useEffect, useMemo, useRef, useState } from 'react'
import type { EditorView } from '@codemirror/view'

export interface MiniMark {
  line: number
  lastLine?: number
  tone: 'mind' | 'bad' | 'ok' | 'you'
}

const TONE: Record<MiniMark['tone'], string> = { mind: 'rgb(190 160 255 / 0.95)', bad: 'rgb(255 110 120 / 0.95)', ok: 'rgb(110 220 160 / 0.9)', you: 'rgb(255 255 255 / 0.55)' }

/**
 * Where you are in the file: every line as a faint bar (its indent and length), the mind's changes and test results
 * as coloured ticks, and the part on screen as a lens. Press or drag to move there. Decorative for assistive tech (the
 * editor itself is the keyboard and screen-reader path); hidden on phones.
 */
export function Minimap({ view, text, marks }: { view: EditorView | null; text: string; marks: MiniMark[] }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [lens, setLens] = useState<{ top: number; height: number; fits: boolean } | null>(null)
  const lines = useMemo(() => text.split('\n'), [text])
  const per = 3

  useEffect(() => {
    const c = canvas.current
    if (!c) return
    const h = c.clientHeight
    const w = c.clientWidth
    const ratio = window.devicePixelRatio || 1
    c.width = w * ratio
    c.height = h * ratio
    const g = c.getContext('2d')
    if (!g) return
    g.scale(ratio, ratio)
    g.clearRect(0, 0, w, h)
    const scale = Math.min(per, h / Math.max(1, lines.length))
    g.fillStyle = 'rgb(255 255 255 / 0.16)'
    lines.forEach((l, i) => {
      const indent = /^\s*/.exec(l)?.[0].length ?? 0
      const len = l.trimEnd().length - indent
      if (len > 0) g.fillRect(4 + indent * 1.1, i * scale, Math.min(w - 8, len * 1.1), Math.max(1, scale - 1))
    })
    for (const m of marks) {
      g.fillStyle = TONE[m.tone]
      const top = (m.line - 1) * scale
      g.fillRect(0, top, 3, Math.max(2, ((m.lastLine ?? m.line) - m.line + 1) * scale - 1))
    }
  }, [lines, marks])

  useEffect(() => {
    const s = view?.scrollDOM
    if (!s) return
    let raf = 0
    const measure = () => {
      raf = 0
      const c = canvas.current
      if (!c || !s.scrollHeight) return
      const total = Math.min(c.clientHeight, lines.length * per)
      setLens({ top: (s.scrollTop / s.scrollHeight) * total, height: Math.max(12, (s.clientHeight / s.scrollHeight) * total), fits: lines.length * 24 < s.clientHeight * 0.6 })
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
    }
    schedule()
    s.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      cancelAnimationFrame(raf)
      s.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [view, lines.length])

  const go = (clientY: number) => {
    const c = canvas.current
    const s = view?.scrollDOM
    if (!c || !s) return
    const r = c.getBoundingClientRect()
    const total = Math.min(r.height, lines.length * per)
    const f = Math.min(1, Math.max(0, (clientY - r.top) / Math.max(1, total)))
    s.scrollTo({ top: f * s.scrollHeight - s.clientHeight / 2 })
  }

  return (
    <div
      className="cc-minimap"
      data-fits={lens?.fits || undefined}
      aria-hidden="true"
      data-presence-region="code-minimap"
      onPointerDown={(e) => {
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
        go(e.clientY)
      }}
      onPointerMove={(e) => e.buttons === 1 && go(e.clientY)}
    >
      <canvas ref={canvas} />
      {lens && <span className="cc-minimap-lens" style={{ top: lens.top, height: lens.height }} />}
    </div>
  )
}
