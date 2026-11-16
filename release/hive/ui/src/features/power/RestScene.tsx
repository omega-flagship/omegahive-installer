import { useEffect, useRef } from 'react'
import { constellation, type Constellation } from './restClocks'
import { sceneLoops } from './rest'

/**
 * The moving part of a rest: one canvas-2D layer, drawn slowly (12 to 24 frames a second, at a reduced resolution for
 * the soft scenes), only while the page is visible. Reduced motion draws one still frame and runs no loop at all.
 * Decorative: aria-hidden, no pointer events. Classic, Cosmos, Flux and Construct have one; Still and Canvas are paper
 * and pencil and draw with markup alone.
 */

export interface SceneData {
  /** Hues of the minds, awake ones first (the orbs and the liquid take their colours from the hive). */
  hues: number[]
  awake: number
  /** The clock's digits (Cosmos draws them as constellations). */
  digits: string
}

interface Painter {
  fps: number
  /** Backing-store pixels per CSS pixel (before the device ratio, which is capped at 2). */
  scale: number
  resize(w: number, h: number): void
  draw(ctx: CanvasRenderingContext2D, w: number, h: number, t: number): void
}

/** A small, fixed pseudo-random sequence (the same scene each time it rests). */
function rng(seed: number) {
  let s = seed >>> 0 || 1
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822519) ^ Math.imul(s ^ (s >>> 13), 3266489917)), ((s >>> 0) % 100000) / 100000)
}

const DEFAULT_HUES = [258, 222, 290, 196, 320, 240]

function classicOrbs(data: () => SceneData): Painter {
  const r = rng(7)
  const orbs = Array.from({ length: 14 }, () => ({ fx: 0.12 + r() * 0.76, fy: 0.14 + r() * 0.72, ax: 0.05 + r() * 0.09, ay: 0.04 + r() * 0.08, sx: 0.03 + r() * 0.05, sy: 0.025 + r() * 0.05, p: r() * 6.28, size: 0.05 + r() * 0.1 }))
  return {
    fps: 24,
    scale: 0.5,
    resize() {},
    draw(ctx, w, h, t) {
      const d = data()
      const hues = d.hues.length ? d.hues : DEFAULT_HUES
      const n = Math.min(orbs.length, Math.max(6, hues.length))
      const m = Math.min(w, h)
      ctx.clearRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < n; i++) {
        const o = orbs[i]
        const awake = i < d.awake
        const x = (o.fx + Math.sin(t * o.sx + o.p) * o.ax) * w
        const y = (o.fy + Math.cos(t * o.sy + o.p * 1.3) * o.ay) * h
        const rad = m * o.size * (awake ? 1 + Math.sin(t * 0.6 + o.p) * 0.08 : 0.8)
        const a = awake ? 0.42 : 0.16
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
        const hue = hues[i % hues.length]
        g.addColorStop(0, `hsla(${hue},90%,72%,${a})`)
        g.addColorStop(0.35, `hsla(${hue},85%,60%,${a * 0.45})`)
        g.addColorStop(1, `hsla(${hue},80%,50%,0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, rad, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    },
  }
}

function cosmosSky(data: () => SceneData): Painter {
  let stars: { x: number; y: number; s: number; l: number; p: number }[] = []
  let cached: { digits: string; c: Constellation } | null = null
  const speeds = [1.2, 3, 7]
  return {
    fps: 24,
    scale: 1,
    resize(w, h) {
      const r = rng(11)
      const count = Math.round((w * h) / 2600)
      stars = Array.from({ length: Math.min(900, count) }, () => {
        const l = r() < 0.7 ? 0 : r() < 0.75 ? 1 : 2
        return { x: r() * w, y: r() * h, s: [0.6, 1, 1.6][l] * (0.7 + r() * 0.6), l, p: r() * 6.28 }
      })
    },
    draw(ctx, w, h, t) {
      ctx.clearRect(0, 0, w, h)
      for (const s of stars) {
        const x = (((s.x - t * speeds[s.l]) % w) + w) % w
        const a = 0.35 + s.l * 0.2 + Math.sin(t * (0.6 + s.l * 0.3) + s.p) * 0.15
        ctx.fillStyle = `rgba(214,230,255,${a.toFixed(3)})`
        ctx.fillRect(x, s.y, s.s, s.s)
      }
      // the time, as constellations
      const d = data()
      if (!cached || cached.digits !== d.digits) cached = { digits: d.digits, c: constellation(d.digits) }
      const c = cached.c
      if (!c.w) return
      const u = Math.min((w * 0.72) / c.w, (h * 0.26) / c.h)
      const ox = (w - c.w * u) / 2
      const oy = h * 0.4 - c.h * u * 0.5
      ctx.strokeStyle = 'rgba(159,208,255,0.32)'
      ctx.lineWidth = Math.max(1, u * 0.012)
      ctx.beginPath()
      for (const [x1, y1, x2, y2] of c.lines) {
        ctx.moveTo(ox + x1 * u, oy + y1 * u)
        ctx.lineTo(ox + x2 * u, oy + y2 * u)
      }
      ctx.stroke()
      c.stars.forEach((s, i) => {
        const x = ox + s.x * u
        const y = oy + s.y * u
        const tw = 0.75 + Math.sin(t * 1.3 + i * 1.7) * 0.25
        const rad = Math.max(2, u * (s.bright ? 0.05 : 0.035)) * (0.9 + tw * 0.2)
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad * 4)
        g.addColorStop(0, `rgba(235,244,255,${0.95 * tw})`)
        g.addColorStop(0.25, `rgba(159,208,255,${0.45 * tw})`)
        g.addColorStop(1, 'rgba(159,208,255,0)')
        ctx.fillStyle = g
        ctx.fillRect(x - rad * 4, y - rad * 4, rad * 8, rad * 8)
      })
    },
  }
}

function fluxLiquid(data: () => SceneData): Painter {
  const r = rng(23)
  const blobs = Array.from({ length: 10 }, () => ({ fx: 0.2 + r() * 0.6, fy: 0.2 + r() * 0.6, ax: 0.12 + r() * 0.2, ay: 0.1 + r() * 0.18, sx: 0.04 + r() * 0.06, sy: 0.035 + r() * 0.06, p: r() * 6.28, size: 0.16 + r() * 0.14 }))
  const LIQUID = [318, 286, 334, 262, 300]
  return {
    fps: 20,
    scale: 0.22,
    resize() {},
    draw(ctx, w, h, t) {
      const d = data()
      const n = Math.min(blobs.length, 5 + Math.min(5, d.awake))
      const m = Math.min(w, h)
      ctx.fillStyle = '#0a0414'
      ctx.fillRect(0, 0, w, h)
      ctx.globalCompositeOperation = 'lighter'
      for (let i = 0; i < n; i++) {
        const b = blobs[i]
        const x = (b.fx + Math.sin(t * b.sx + b.p) * b.ax) * w
        const y = (b.fy + Math.cos(t * b.sy + b.p * 0.7) * b.ay) * h
        const rad = m * b.size
        const hue = i < d.hues.length && i < d.awake ? d.hues[i] : LIQUID[i % LIQUID.length]
        const g = ctx.createRadialGradient(x, y, 0, x, y, rad)
        g.addColorStop(0, `hsla(${hue},78%,58%,0.7)`)
        g.addColorStop(0.55, `hsla(${hue},75%,45%,0.28)`)
        g.addColorStop(1, `hsla(${hue},75%,40%,0)`)
        ctx.fillStyle = g
        ctx.beginPath()
        ctx.arc(x, y, rad, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.globalCompositeOperation = 'source-over'
    },
  }
}

const KATA = 'ｦｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789:.=+-<>'

function constructRain(): Painter {
  const CELL = 18
  let drops: { col: number; y: number; v: number }[] = []
  let lastT = 0
  const r = rng(31)
  return {
    fps: 12,
    scale: 1,
    resize(w, h) {
      const cols = Math.ceil(w / CELL)
      // low rain: about one column in three
      drops = Array.from({ length: Math.ceil(cols / 3) }, () => ({ col: Math.floor(r() * cols), y: r() * (h / CELL), v: 1.5 + r() * 3 }))
      lastT = 0
    },
    draw(ctx, w, h, t) {
      const dt = lastT ? Math.min(0.25, t - lastT) : 0
      lastT = t
      ctx.fillStyle = dt ? 'rgba(0,6,0,0.16)' : '#000600'
      ctx.fillRect(0, 0, w, h)
      ctx.font = `${CELL - 4}px 'IBM Plex Mono', ui-monospace, monospace`
      ctx.textBaseline = 'top'
      const rows = h / CELL
      for (const d of drops) {
        d.y += d.v * dt
        if (d.y > rows + 4) {
          d.y = -r() * 8
          d.col = Math.floor(r() * Math.ceil(w / CELL))
          d.v = 1.5 + r() * 3
        }
        const x = d.col * CELL
        const y = Math.floor(d.y) * CELL
        ctx.fillStyle = 'rgba(57,255,20,0.35)'
        ctx.fillText(KATA[Math.floor(r() * KATA.length)], x, y - CELL)
        ctx.fillStyle = 'rgba(190,255,180,0.7)'
        ctx.fillText(KATA[Math.floor(r() * KATA.length)], x, y)
      }
    },
  }
}

const PAINTERS: Record<string, ((data: () => SceneData) => Painter) | undefined> = {
  classic: classicOrbs,
  cosmos: cosmosSky,
  flux: fluxLiquid,
  construct: () => constructRain(),
}

export const hasScene = (kind: string) => !!PAINTERS[kind]

export function RestScene({ kind, reduced, data }: { kind: string; reduced: boolean; data: SceneData }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const dataRef = useRef(data)
  useEffect(() => {
    dataRef.current = data
  }, [data])

  useEffect(() => {
    const make = PAINTERS[kind]
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!make || !c || !ctx) return
    const painter = make(() => dataRef.current)
    let raf = 0
    let last = 0
    let w = 0
    let h = 0
    const t0 = performance.now()
    // a still frame stands for the scene under reduced motion: the moment it would reach after a while
    const STILL_T = 40
    const size = () => {
      const s = painter.scale * Math.min(window.devicePixelRatio || 1, 2)
      w = window.innerWidth
      h = window.innerHeight
      c.width = Math.max(1, Math.round(w * s))
      c.height = Math.max(1, Math.round(h * s))
      ctx.setTransform(s, 0, 0, s, 0, 0)
      painter.resize(w, h)
      painter.draw(ctx, w, h, reduced ? STILL_T : (performance.now() - t0) / 1000)
    }
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (now - last < 1000 / painter.fps - 2) return
      last = now
      painter.draw(ctx, w, h, (now - t0) / 1000)
    }
    const start = () => {
      if (!raf && sceneLoops(reduced, document.hidden)) raf = requestAnimationFrame(frame)
    }
    const stop = () => {
      cancelAnimationFrame(raf)
      raf = 0
    }
    const onVis = () => (document.hidden ? stop() : start())
    let resizeT = 0
    const onResize = () => {
      window.clearTimeout(resizeT)
      resizeT = window.setTimeout(size, 150)
    }
    size()
    start()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('resize', onResize)
    return () => {
      stop()
      window.clearTimeout(resizeT)
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('resize', onResize)
    }
  }, [kind, reduced])

  // under reduced motion the still frame is redrawn when the minute (or the minds) change
  useEffect(() => {
    if (!reduced) return
    const make = PAINTERS[kind]
    const c = canvas.current
    const ctx = c?.getContext('2d')
    if (!make || !c || !ctx) return
    const p = make(() => data)
    p.resize(window.innerWidth, window.innerHeight)
    p.draw(ctx, window.innerWidth, window.innerHeight, 40)
  }, [reduced, kind, data])

  if (!PAINTERS[kind]) return null
  return <canvas ref={canvas} className="pw-scene" aria-hidden="true" />
}
