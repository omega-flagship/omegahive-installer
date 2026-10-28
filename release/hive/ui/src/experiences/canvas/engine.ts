import { createContext, useContext, useSyncExternalStore } from 'react'
import type { Rect } from './layout'

export type Lod = 'far' | 'overview' | 'detail'
export const lodFor = (z: number): Lod => (z < 0.3 ? 'far' : z < 0.7 ? 'overview' : 'detail')

export const MIN_Z = 0.06
export const MAX_Z = 4
const clampZ = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z))
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2)

interface Anim {
  fx: number
  fy: number
  fz: number
  tx: number
  ty: number
  tz: number
  t0: number
  dur: number
}

/** Insets kept free of chrome when fitting (top bar, bottom toolbar). */
export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

/**
 * The camera. Lives outside React: pans and zooms write one transform on the world layer and the grid
 * background, never re-rendering the board. React subscribes only to coarse, derived values (level of detail,
 * zoom percent, which items are on screen) through `useEngine`.
 */
export class Engine {
  x = 0
  y = 0
  z = 1
  vw = 1
  vh = 1
  reduced = false
  insets: Insets = { top: 64, right: 16, bottom: 88, left: 16 }
  root: HTMLElement | null = null
  world: HTMLElement | null = null
  /** Set when the last pointer gesture moved: the click that follows is swallowed. */
  dragged = false
  version = 0
  private anim: Anim | null = null
  private momentum: { vx: number; vy: number; t: number } | null = null
  private subs = new Set<() => void>()
  private hooks = new Set<(e: Engine) => void>()
  private raf = 0
  private dirty = true
  private lastZ = -1
  private lastMove = 0
  private hot = false
  private settleTimer = 0

  attach(root: HTMLElement | null, world: HTMLElement | null) {
    this.root = root
    this.world = world
    this.dirty = true
  }
  configure(reduced: boolean, insets: Insets) {
    this.reduced = reduced
    this.insets = insets
  }
  /** Mark the end of a gesture (wakes semantic-zoom listeners). */
  settle() {
    for (const s of this.subs) s()
  }

  subscribe = (fn: () => void) => {
    this.subs.add(fn)
    return () => void this.subs.delete(fn)
  }
  /** Runs every animation frame (cursor drift, minimap viewport). */
  onFrame(fn: (e: Engine) => void) {
    this.hooks.add(fn)
    return () => void this.hooks.delete(fn)
  }

  start() {
    const tick = (t: number) => {
      this.raf = requestAnimationFrame(tick)
      if (this.anim) {
        const a = this.anim
        const k = a.dur <= 0 ? 1 : Math.min(1, (t - a.t0) / a.dur)
        const e = ease(k)
        // interpolate the screen-centre world point linearly and the zoom in log space: a smooth "fly"
        const lz = Math.exp(Math.log(a.fz) + (Math.log(a.tz) - Math.log(a.fz)) * e)
        const cx = a.fx + (a.tx - a.fx) * e
        const cy = a.fy + (a.ty - a.fy) * e
        this.z = lz
        this.x = this.vw / 2 - cx * lz
        this.y = this.vh / 2 - cy * lz
        this.dirty = true
        if (k >= 1) this.anim = null
      }
      if (this.momentum) {
        const m = this.momentum
        const dt = Math.min(48, t - m.t)
        m.t = t
        this.x += m.vx * dt
        this.y += m.vy * dt
        const k = Math.exp(-dt / 260)
        m.vx *= k
        m.vy *= k
        this.dirty = true
        if (Math.hypot(m.vx, m.vy) < 0.02) this.momentum = null
      }
      if (this.dirty) this.apply()
      for (const h of this.hooks) h(this)
    }
    this.raf = requestAnimationFrame(tick)
  }
  stop() {
    cancelAnimationFrame(this.raf)
    clearTimeout(this.settleTimer)
  }

  get centreWorld() {
    return { x: (this.vw / 2 - this.x) / this.z, y: (this.vh / 2 - this.y) / this.z }
  }
  toWorld(sx: number, sy: number) {
    return { x: (sx - this.x) / this.z, y: (sy - this.y) / this.z }
  }
  toScreen(wx: number, wy: number) {
    return { x: wx * this.z + this.x, y: wy * this.z + this.y }
  }

  resize(w: number, h: number) {
    const c = this.centreWorld
    this.vw = Math.max(1, w)
    this.vh = Math.max(1, h)
    if (this.version > 0) {
      this.x = this.vw / 2 - c.x * this.z
      this.y = this.vh / 2 - c.y * this.z
    }
    this.dirty = true
  }

  set(x: number, y: number, z: number) {
    this.anim = null
    this.momentum = null
    this.x = x
    this.y = y
    this.z = clampZ(z)
    this.dirty = true
  }
  panBy(dx: number, dy: number) {
    this.anim = null
    this.momentum = null
    this.x += dx
    this.y += dy
    this.dirty = true
  }
  zoomAt(sx: number, sy: number, factor: number) {
    this.anim = null
    this.momentum = null
    const nz = clampZ(this.z * factor)
    const w = this.toWorld(sx, sy)
    this.x = sx - w.x * nz
    this.y = sy - w.y * nz
    this.z = nz
    this.dirty = true
  }
  /** Fly so that world point (cx, cy) sits at the centre of the free area at zoom z. */
  flyTo(cx: number, cy: number, z: number, dur = 640) {
    const tz = clampZ(z)
    // the free area's centre is offset from the viewport centre by the insets
    const ox = (this.insets.left - this.insets.right) / 2 / tz
    const oy = (this.insets.top - this.insets.bottom) / 2 / tz
    const from = this.centreWorld
    this.momentum = null
    this.anim = { fx: from.x, fy: from.y, fz: this.z, tx: cx - ox, ty: cy - oy, tz, t0: performance.now(), dur: this.reduced ? 0 : dur }
  }
  fitZ(r: Rect, opts: { pad?: number; maxZ?: number; minZ?: number } = {}) {
    const pad = opts.pad ?? 40
    const aw = this.vw - this.insets.left - this.insets.right - pad * 2
    const ah = this.vh - this.insets.top - this.insets.bottom - pad * 2
    const z = Math.min(aw / Math.max(1, r.w), ah / Math.max(1, r.h))
    return Math.min(opts.maxZ ?? 1.6, Math.max(opts.minZ ?? MIN_Z, z))
  }
  fitRect(r: Rect, opts: { pad?: number; maxZ?: number; minZ?: number; dur?: number } = {}) {
    this.flyTo(r.x + r.w / 2, r.y + r.h / 2, this.fitZ(r, opts), opts.dur)
  }
  /** Jump (no animation) to centre r at zoom z. */
  jumpTo(cx: number, cy: number, z: number) {
    this.flyTo(cx, cy, z, 0)
  }
  /** Momentum after a flick (px per ms). */
  fling(vx: number, vy: number) {
    if (this.reduced || Math.hypot(vx, vy) < 0.25) return
    this.momentum = { vx, vy, t: performance.now() }
  }
  /** Zoom about the centre of the free area (keys, toolbar). Repeated presses compound on the target. */
  zoomBy(factor: number) {
    const i = this.insets
    const base = this.anim ? this.anim.tz : this.z
    const p = this.anim ? { x: this.anim.tx, y: this.anim.ty } : this.toWorld(this.vw / 2 + (i.left - i.right) / 2, this.vh / 2 + (i.top - i.bottom) / 2)
    if (this.anim) {
      // anim target is stored as the viewport-centre point; convert back to the free-area centre
      p.x += (i.left - i.right) / 2 / base
      p.y += (i.top - i.bottom) / 2 / base
    }
    this.flyTo(p.x, p.y, base * factor, 240)
  }
  get animating() {
    return this.anim !== null || this.momentum !== null
  }
  halt() {
    this.anim = null
    this.momentum = null
  }
  /** The zoom the camera is at or heading to. */
  get targetZ() {
    return this.anim ? this.anim.tz : this.z
  }

  visible(r: Rect, margin = 0.4) {
    const mx = (this.vw * margin) / this.z
    const my = (this.vh * margin) / this.z
    const l = -this.x / this.z - mx
    const t = -this.y / this.z - my
    const rr = (this.vw - this.x) / this.z + mx
    const b = (this.vh - this.y) / this.z + my
    return r.x + r.w >= l && r.x <= rr && r.y + r.h >= t && r.y <= b
  }

  private apply() {
    this.dirty = false
    const w = this.world
    if (w) {
      w.style.transform = `translate3d(${this.x}px, ${this.y}px, 0) scale(${this.z})`
      if (!this.hot) {
        this.hot = true
        w.style.willChange = 'transform'
      }
      if (this.z !== this.lastZ) {
        w.style.setProperty('--iz', String(1 / this.z))
        this.lastZ = this.z
      }
    }
    const r = this.root
    if (r) {
      let s = 24 * this.z
      while (s < 14) s *= 4
      r.style.backgroundSize = `${s}px ${s}px`
      r.style.backgroundPosition = `${this.x}px ${this.y}px`
    }
    this.lastMove = performance.now()
    clearTimeout(this.settleTimer)
    // once still, drop the layer hint so text re-rasterises crisp at the new scale
    this.settleTimer = window.setTimeout(() => {
      if (performance.now() - this.lastMove >= 160 && this.world) {
        this.world.style.willChange = 'auto'
        this.hot = false
      }
    }, 180)
    this.version++
    for (const s of this.subs) s()
  }
}

export const EngineCtx = createContext<Engine | null>(null)
export const useEngineRef = () => {
  const e = useContext(EngineCtx)
  if (!e) throw new Error('Canvas engine missing')
  return e
}

/** Subscribe to a primitive derived from the camera; re-renders only when it changes. */
export function useEngine<T extends string | number | boolean>(sel: (e: Engine) => T): T {
  const e = useEngineRef()
  return useSyncExternalStore(e.subscribe, () => sel(e), () => sel(e))
}
