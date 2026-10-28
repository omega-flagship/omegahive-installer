/**
 * The Flux world: swarms as liquid bodies, minds as droplets, decisions as drips hanging from the top edge.
 * Plain spring physics on the CPU feeds the GPU fluid (ink and stirring) and the metaball display every frame.
 * Overlay nodes (labels, hit targets) and panel slots (where droplets pour into glass) are bound by key.
 */
import type { Agent, Approval, Swarm } from '../sdk'
import { FluidEngine, MAXB, type GlassRegion, type Splat } from './fluid'

export type RGB = [number, number, number]

export function hslRgb(h: number, s: number, l: number): RGB {
  s /= 100
  l /= 100
  const k = (n: number) => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return [f(0), f(8), f(4)]
}

export type FluxView = { kind: 'home' } | { kind: 'swarm'; id: string } | { kind: 'mind'; id: string }

export interface Snapshot {
  agents: Record<string, Agent>
  swarms: Record<string, Swarm>
  thinking: Record<string, string>
  approvals: Record<string, Approval>
}

export interface GlassSource {
  el: HTMLElement
  radius: number
  clip?: () => { x: number; y: number; r: number } | null
}

interface Spring {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  vr: number
}

interface Body extends Spring {
  id: string
  color: RGB
  members: string[]
  ax: number
  ay: number
  seed: number
  pull: { to: string; until: number } | null
  /** the core blob (it pours into a panel header when the swarm opens) */
  core: Spring
  coreLayer: number
  size: number
}

interface Drop extends Spring {
  id: string
  swarm: string | null
  color: RGB
  energy: number
  status: Agent['status']
  thinking: boolean
  seed: number
  layer: number
  kick: number
  dying: boolean
}

interface Drip extends Spring {
  id: string
  agent: string
  color: RGB
  neck: Spring
  falling: boolean
  layer: number
}

interface Messenger {
  from: string
  to: string
  t: number
  dur: number
  x: number
  y: number
  px: number
  py: number
  color: RGB
}

const spring = (x: number, y: number, r = 0): Spring => ({ x, y, vx: 0, vy: 0, r, vr: 0 })
const hash = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) % 10000) / 10000
}

function stepSpring(s: Spring, tx: number, ty: number, tr: number, k: number, damp: number, kr: number, dt: number) {
  const c = 2 * Math.sqrt(k) * damp
  s.vx += (k * (tx - s.x) - c * s.vx) * dt
  s.vy += (k * (ty - s.y) - c * s.vy) * dt
  s.x += s.vx * dt
  s.y += s.vy * dt
  const cr = 2 * Math.sqrt(kr) * 0.42
  s.vr += (kr * (tr - s.r) - cr * s.vr) * dt
  s.r = Math.max(0, s.r + s.vr * dt)
}

export class FluxWorld {
  engine: FluidEngine | null = null
  W = 1
  H = 1
  desktop = true
  view: FluxView = { kind: 'home' }
  decision: string | null = null
  hover: string | null = null
  bodies = new Map<string, Body>()
  drops = new Map<string, Drop>()
  drips = new Map<string, Drip>()
  messengers: Messenger[] = []
  nodes = new Map<string, HTMLElement>()
  slots = new Map<string, HTMLElement>()
  glass = new Map<string, GlassSource>()
  staticEl: HTMLElement | null = null
  private velQ: Splat[] = []
  private dyeQ: Splat[] = []
  private t = 0
  private last = 0
  private raf = 0
  private running = false
  private ceil = 0
  private ceilCol: RGB = [1, 0.62, 0.86]
  private dim = 0
  private pointer = { x: -1, y: -1, t: 0, has: false }
  private frameCb: ((dt: number) => void) | null = null
  private bodyOrder: string[] = []

  setHover(key: string | null) {
    this.hover = key
  }

  setDecision(id: string | null) {
    this.decision = id
  }

  setStatic(el: HTMLElement | null) {
    this.staticEl = el
  }

  attach(canvas: HTMLCanvasElement, w: number, h: number, desktop: boolean): boolean {
    this.W = w
    this.H = h
    try {
      const dpr = Math.min(window.devicePixelRatio || 1, desktop ? 1.25 : 1.5)
      this.engine = new FluidEngine(canvas, { simRes: desktop ? 128 : 96, dyeRes: desktop ? 640 : 448, dpr })
      this.engine.resize(this.W, this.H)
      if (!this.engine.healthy()) throw new Error('the GPU cannot run the liquid')
      return true
    } catch {
      this.engine?.dispose()
      this.engine = null
      return false
    }
  }

  onFrame(cb: ((dt: number) => void) | null) {
    this.frameCb = cb
  }

  private primed = false

  resize(w: number, h: number, desktop: boolean) {
    this.W = w
    this.H = h
    this.desktop = desktop
    this.engine?.resize(w, h)
    this.layout()
    if (!this.engine) this.settle()
    else if (!this.primed && this.bodies.size + this.drops.size > 0) {
      // first sight: everything already in place, the water already inked; later births grow from nothing
      this.primed = true
      this.settle()
      for (const d of this.drops.values()) {
        const a = d.energy * 0.5
        this.dyeQ.push({ x: d.x, y: d.y, r: d.r * 2.2, a: d.color[0] * a, b: d.color[1] * a, c: d.color[2] * a })
        const ang = d.seed * 6.28
        this.velQ.push({ x: d.x, y: d.y, r: d.r * 2, a: Math.cos(ang) * 500, b: Math.sin(ang) * 500, c: 0 })
      }
    }
  }

  // ------------------------------------------------------------------ data

  sync(s: Snapshot) {
    const swarms = Object.values(s.swarms).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name))
    const agents = Object.values(s.agents).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.name.localeCompare(b.name))
    const seen = new Set<string>()
    for (const sw of swarms) {
      seen.add(sw.id)
      let b = this.bodies.get(sw.id)
      const members = agents.filter((a) => a.swarm_id === sw.id).map((a) => a.id)
      if (!b) {
        b = { ...spring(this.W / 2, this.H / 2), id: sw.id, color: hslRgb(sw.hue, 80, 60), members, ax: -1, ay: -1, seed: hash(sw.id), pull: null, core: spring(this.W / 2, this.H / 2), coreLayer: 0, size: 1 }
        this.bodies.set(sw.id, b)
      }
      b.members = members
      // the body's colour is the mix of its minds' hues (awake minds count more)
      let r = 0, g = 0, bl = 0, w = 0
      for (const id of members) {
        const a = s.agents[id]
        const c = hslRgb(a.hue, 85, 62)
        const k = a.status === 'awake' ? 1 : 0.35
        r += c[0] * k; g += c[1] * k; bl += c[2] * k; w += k
      }
      b.color = w ? [r / w, g / w, bl / w] : hslRgb(sw.hue, 70, 55)
      b.size = 0.78 + 0.22 * Math.sqrt(Math.max(1, members.length))
    }
    for (const id of [...this.bodies.keys()]) if (!seen.has(id)) this.bodies.delete(id)
    const order = swarms.map((x) => x.id)
    const changed = order.join() !== this.bodyOrder.join()
    this.bodyOrder = order

    const live = new Set<string>()
    for (const a of agents) {
      live.add(a.id)
      let d = this.drops.get(a.id)
      const home = a.swarm_id ? this.bodies.get(a.swarm_id) : null
      if (!d) {
        d = { ...spring(home?.x ?? this.W / 2, home?.y ?? this.H / 2, 0), id: a.id, swarm: a.swarm_id, color: [1, 1, 1], energy: 1, status: a.status, thinking: false, seed: hash(a.id), layer: 0, kick: 0, dying: false }
        this.drops.set(a.id, d)
      }
      d.swarm = a.swarm_id && this.bodies.has(a.swarm_id) ? a.swarm_id : null
      d.status = a.status
      d.dying = false
      const th = s.thinking[a.id]
      d.thinking = a.status === 'awake' && (th === 'llm' || th === 'skills')
      d.color =
        a.status === 'error' ? [1, 0.32, 0.42]
        : a.status === 'asleep' ? hslRgb(a.hue, 38, 42)
        : a.status === 'stopped' || a.status === 'created' ? hslRgb(a.hue, 10, 36)
        : hslRgb(a.hue, 88, d.thinking ? 70 : 62)
      d.energy = a.status === 'awake' ? (d.thinking ? 1 : 0.78) : a.status === 'starting' ? 0.7 : a.status === 'error' ? 0.9 : 0.22
    }
    for (const d of this.drops.values()) if (!live.has(d.id)) d.dying = true

    const pending = Object.values(s.approvals).filter((a) => a.status === 'pending').sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, 7)
    const pset = new Set(pending.map((p) => p.id))
    for (const p of pending) {
      if (this.drips.has(p.id)) continue
      const ag = s.agents[p.agent_id]
      const color = hslRgb(ag?.hue ?? 320, 90, 66)
      this.drips.set(p.id, { ...spring(this.W / 2, -10, 0), id: p.id, agent: p.agent_id, color, neck: spring(this.W / 2, 0, 0), falling: false, layer: 0 })
      this.ceilKick()
    }
    for (const d of this.drips.values()) if (!pset.has(d.id) && !d.falling) {
      d.falling = true
      d.layer = 0
    }
    if (changed) this.layout()
    if (!this.engine) this.settle()
  }

  /** Width a left-hand sheet takes on desktop (0 when none). */
  sheetW = 0
  setSheet(width: number) {
    if (this.sheetW === width) return
    this.sheetW = width
    this.layout()
    if (!this.engine) this.settle()
  }

  setView(v: FluxView) {
    this.view = v
    this.layout()
    if (!this.engine) this.settle()
  }

  /** Free space for the bodies (what panels leave). */
  private freeRect() {
    const { W, H, desktop } = this
    const panel = this.view.kind !== 'home'
    // a sheet open on the left (desktop) pushes the liquid into the space it leaves
    const sl = this.sheetW
    if (desktop) return panel ? { x: 24 + sl, y: 70, w: Math.max(240, W - 520 - sl), h: H - 150 } : { x: 40 + sl, y: 80, w: Math.max(240, W - 80 - sl), h: H - 180 }
    return panel ? { x: 16, y: 54, w: W - 32, h: Math.max(110, H * 0.2) } : { x: 20, y: 86, w: W - 40, h: H - 200 }
  }

  private scale() {
    const f = this.freeRect()
    const base = Math.min(f.w, f.h)
    return Math.max(0.42, Math.min(1.05, base / (this.desktop ? 640 : 560)))
  }

  layout() {
    const f = this.freeRect()
    const ids = this.bodyOrder.filter((id) => this.bodies.has(id))
    const n = ids.length
    const cx = f.x + f.w / 2, cy = f.y + f.h / 2
    const panel = this.view.kind !== 'home'
    ids.forEach((id, i) => {
      const b = this.bodies.get(id)!
      let x = cx, y = cy
      if (n === 1) {
        /* centred */
      } else if (!this.desktop && panel) {
        x = f.x + ((i + 0.5) / n) * f.w
      } else if (n <= 6) {
        const tall = f.h > f.w * 1.15
        const a = -Math.PI / 2 + (2 * Math.PI * i) / n + (n === 2 ? Math.PI / 2 : 0) + (tall && n === 2 ? -Math.PI / 2 : 0)
        const rx = f.w * (n === 2 ? 0.26 : panel ? 0.25 : 0.3), ry = f.h * (n === 2 ? 0.24 : 0.3)
        x = cx + Math.cos(a) * rx
        y = cy + Math.sin(a) * ry
      } else {
        const r = Math.sqrt((i + 0.5) / n) * 0.44
        const a = i * 2.39996
        x = cx + Math.cos(a) * r * f.w
        y = cy + Math.sin(a) * r * f.h
      }
      if (b.ax === -1) {
        b.x = x; b.y = y; b.core.x = x; b.core.y = y
      }
      b.ax = x
      b.ay = y
    })
  }

  /** Static placement (reduced motion, or no WebGL). */
  settle() {
    const s = this.scale()
    for (const b of this.bodies.values()) {
      b.x = b.ax; b.y = b.ay
      b.r = 84 * s * b.size
      b.core.x = b.x; b.core.y = b.y; b.core.r = b.r
    }
    for (const d of this.drops.values()) {
      const t = this.target(d, 0, s)
      d.x = t.x; d.y = t.y; d.r = t.r
    }
    this.positionDrips(0, true)
    this.place()
    this.paintStatic()
  }

  // ------------------------------------------------------------------ effects

  ceilKick() {
    for (const d of this.drips.values()) d.vy += 40
  }

  ripple(x: number, y: number, strength: number, color?: RGB) {
    if (!this.engine) return
    this.velQ.push({ x, y, r: 60 * strength, a: 1400 * strength, b: 0, c: 0, radial: true })
    if (color) this.dyeQ.push({ x, y, r: 26 * strength, a: color[0] * 0.5, b: color[1] * 0.5, c: color[2] * 0.5 })
  }

  rippleAt(key: string, strength: number, color?: RGB) {
    const p = this.posOf(key)
    if (p) this.ripple(p.x, p.y, strength, color ?? this.colorOf(key))
    const d = key.startsWith('drop:') ? this.drops.get(key.slice(5)) : null
    if (d) d.kick = Math.min(1.4, d.kick + 0.6 * strength)
  }

  message(from: string, to: string) {
    const a = this.drops.get(from), b = this.drops.get(to)
    if (!a || !b || this.messengers.length > 6) return
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    this.messengers.push({ from, to, t: 0, dur: Math.min(1.8, Math.max(0.7, dist / 520)), x: a.x, y: a.y, px: a.x, py: a.y, color: a.color })
    if (a.swarm && b.swarm && a.swarm !== b.swarm) {
      const A = this.bodies.get(a.swarm), B = this.bodies.get(b.swarm)
      if (A && B) {
        A.pull = { to: B.id, until: this.t + 2.6 }
        B.pull = { to: A.id, until: this.t + 2.6 }
      }
    }
  }

  stir(x: number, y: number) {
    const now = performance.now() / 1000
    const p = this.pointer
    if (p.has && now - p.t < 0.1) {
      const dt = Math.max(1 / 240, now - p.t)
      const vx = (x - p.x) / dt, vy = (y - p.y) / dt
      const sp = Math.hypot(vx, vy)
      if (sp > 4 && this.engine) {
        const k = Math.min(1, 2400 / (sp + 1))
        this.velQ.push({ x, y, r: this.desktop ? 46 : 54, a: vx * 0.9 * k, b: vy * 0.9 * k, c: 0 })
        const c = hslRgb((now * 40) % 360, 90, 60)
        const m = Math.min(0.09, sp / 30000)
        this.dyeQ.push({ x, y, r: 22, a: c[0] * m, b: c[1] * m, c: c[2] * m })
        // nearby droplets get nudged by the current
        for (const d of this.drops.values()) {
          if (d.layer) continue
          const dd = Math.hypot(d.x - x, d.y - y)
          if (dd < 140) {
            const w = (1 - dd / 140) * 0.07 * k
            d.vx += vx * w
            d.vy += vy * w
          }
        }
      }
    }
    p.x = x; p.y = y; p.t = now; p.has = true
  }

  // ------------------------------------------------------------------ queries

  posOf(key: string): { x: number; y: number; r: number } | null {
    const hashAt = key.indexOf('#')
    const k = hashAt >= 0 ? key.slice(0, hashAt) : key
    const [kind, id] = [k.slice(0, k.indexOf(':')), k.slice(k.indexOf(':') + 1)]
    if (kind === 'body') { const b = this.bodies.get(id); return b ? { x: b.x, y: b.y, r: b.r } : null }
    if (kind === 'drop') { const d = this.drops.get(id); return d ? { x: d.x, y: d.y, r: d.r } : null }
    if (kind === 'drip') { const d = this.drips.get(id); return d ? { x: d.x, y: d.y, r: d.r } : null }
    return null
  }

  colorOf(key: string): RGB | undefined {
    const id = key.slice(key.indexOf(':') + 1)
    return this.drops.get(id)?.color ?? this.bodies.get(id)?.color ?? this.drips.get(id)?.color
  }

  // ------------------------------------------------------------------ loop

  start() {
    if (this.running || !this.engine) return
    this.running = true
    this.last = performance.now()
    const tick = (now: number) => {
      if (!this.running) return
      const dt = Math.min(1 / 24, Math.max(1 / 240, (now - this.last) / 1000))
      this.last = now
      this.frame(dt)
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  dispose() {
    this.stop()
    this.engine?.dispose()
    this.engine = null
  }

  private slotRect(key: string) {
    const el = this.slots.get(key)
    if (!el || !el.isConnected) return null
    const r = el.getBoundingClientRect()
    if (r.width < 1) return null
    let visible = true
    const box = el.closest('[data-flux-scroll]')
    if (box) {
      const b = box.getBoundingClientRect()
      const cy = r.top + r.height / 2
      visible = cy > b.top + r.height * 0.3 && cy < b.bottom - r.height * 0.3
    }
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, r: visible ? r.width / 2 : 0 }
  }

  private target(d: Drop, t: number, s: number): { x: number; y: number; r: number; slot: boolean } {
    const v = this.view
    const slotKey = v.kind === 'swarm' && d.swarm === v.id ? `mind:${d.id}` : v.kind === 'mind' && v.id === d.id ? `mindhead:${d.id}` : null
    if (slotKey) {
      const sr = this.slotRect(slotKey)
      if (sr) return { x: sr.x, y: sr.y, r: sr.r * 0.9, slot: true }
    }
    const statusK = d.status === 'awake' ? 1 : d.status === 'starting' ? 0.9 : d.status === 'error' ? 0.95 : d.status === 'asleep' ? 0.72 : 0.6
    const hov = this.hover === `drop:${d.id}` ? 1.16 : 1
    const b = d.swarm ? this.bodies.get(d.swarm) : null
    if (d.dying) return { x: d.x, y: d.y, r: 0, slot: false }
    if (b) {
      const ids = b.members.filter((id) => !(v.kind === 'mind' && v.id === id))
      const i = Math.max(0, ids.indexOf(d.id))
      const n = Math.max(1, ids.length)
      const bh = this.hover === `body:${b.id}` ? 1.12 : 1
      const ang = (i / n) * Math.PI * 2 + t * 0.07 + 0.35 * Math.sin(t * 0.23 + d.seed * 9)
      const orbit = b.r * (0.9 + 0.13 * Math.sin(t * 0.5 + d.seed * 17)) * (d.thinking ? 1.12 : 1) * bh
      return { x: b.x + Math.cos(ang) * orbit, y: b.y + Math.sin(ang) * orbit, r: b.r * 0.5 * statusK * hov * (1 + 0.12 * Math.sin(t * 2.2 + d.seed * 6) * (d.thinking ? 1 : 0.25)), slot: false }
    }
    // a free mind wanders between the bodies
    const f = this.freeRect()
    return {
      x: f.x + f.w * (0.5 + 0.42 * Math.sin(t * 0.045 + d.seed * 6.28)),
      y: f.y + f.h * (0.5 + 0.4 * Math.sin(t * 0.061 + d.seed * 3.1 + 1.3)),
      r: 30 * s * statusK * hov,
      slot: false,
    }
  }

  private positionDrips(dt: number, snap = false) {
    const list = [...this.drips.values()].filter((d) => !d.falling)
    const n = list.length
    const sp = this.desktop ? 64 : 46
    const t = this.t
    list.forEach((d, i) => {
      let tx = this.W / 2 + (i - (n - 1) / 2) * sp
      let ty = (this.desktop ? 50 : 42) + 6 * Math.sin(t * 1.4 + i * 1.7)
      let tr = this.desktop ? 18 : 14
      let nr = tr * 0.62
      d.layer = 0
      if (this.decision === d.id) {
        const sr = this.slotRect(`drip:${d.id}`)
        if (sr) {
          tx = sr.x; ty = sr.y; tr = sr.r * 0.9; nr = 0
          d.layer = 1
        }
      }
      if (snap) {
        d.x = tx; d.y = ty; d.r = tr; d.neck.x = tx; d.neck.y = 12; d.neck.r = nr
      } else {
        stepSpring(d, tx, ty, tr, d.layer ? 70 : 26, d.layer ? 0.75 : 0.32, 60, dt)
        stepSpring(d.neck, d.x, Math.min(d.y, 22), nr, 40, 0.5, 60, dt)
      }
    })
  }

  /** Dev probe: run frames synchronously and report the cost of one (CPU + GPU, forced to finish). */
  probe(n: number, dt = 1 / 60): number {
    if (!this.engine) return -1
    const gl = this.engine.renderer.getContext()
    const px = new Uint8Array(4)
    const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px)
    for (let i = 0; i < n; i++) this.frame(dt)
    sync()
    let best = Infinity
    for (let i = 0; i < 12; i++) {
      const t0 = performance.now()
      this.frame(dt)
      sync()
      best = Math.min(best, performance.now() - t0)
    }
    return best
  }

  private frame(dt: number) {
    this.t += dt
    const t = this.t
    const s = this.scale()
    const eng = this.engine
    const panel = this.view.kind !== 'home'

    // bodies
    for (const b of this.bodies.values()) {
      let tx = b.ax + Math.sin(t * 0.13 + b.seed * 40) * this.W * 0.025
      let ty = b.ay + Math.cos(t * 0.11 + b.seed * 70) * this.H * 0.025
      if (b.pull && b.pull.until > t) {
        const o = this.bodies.get(b.pull.to)
        if (o) {
          tx += (o.ax - b.ax) * 0.3
          ty += (o.ay - b.ay) * 0.3
        }
      } else b.pull = null
      // keep apart
      for (const o of this.bodies.values()) {
        if (o === b) continue
        const dx = b.x - o.x, dy = b.y - o.y
        const dd = Math.hypot(dx, dy) || 1
        const min = (b.r + o.r) * 1.5
        if (dd < min && !(b.pull && b.pull.to === o.id)) {
          tx += (dx / dd) * (min - dd) * 0.6
          ty += (dy / dd) * (min - dd) * 0.6
        }
      }
      const tr = 84 * s * b.size * (this.hover === `body:${b.id}` ? 1.07 : 1)
      stepSpring(b, tx, ty, tr, 5, 0.75, 30, dt)
      // the core follows the body, or pours into the open swarm panel's header
      let cx = b.x, cy = b.y, cr = b.r
      b.coreLayer = 0
      if (this.view.kind === 'swarm' && this.view.id === b.id) {
        const sr = this.slotRect(`swarm:${b.id}`)
        if (sr) { cx = sr.x; cy = sr.y; cr = sr.r * 0.9; b.coreLayer = 1 }
      }
      const wob = 1 + 0.05 * Math.sin(t * 0.9 + b.seed * 11)
      stepSpring(b.core, cx, cy, cr * (b.coreLayer ? 1 : wob), b.coreLayer ? 55 : 22, b.coreLayer ? 0.7 : 0.45, 40, dt)
    }

    // droplets
    for (const d of [...this.drops.values()]) {
      const tg = this.target(d, t, s)
      d.layer = tg.slot ? 1 : 0
      d.kick *= Math.exp(-dt * 3)
      stepSpring(d, tg.x, tg.y, tg.r * (1 + d.kick * 0.3), tg.slot ? 75 : 13, tg.slot ? 0.72 : 0.42, tg.slot ? 90 : 50, dt)
      if (d.dying && d.r < 0.4) this.drops.delete(d.id)
    }

    // drips
    this.positionDrips(dt)
    for (const d of [...this.drips.values()]) {
      if (!d.falling) continue
      d.vy += 1300 * dt
      d.y += d.vy * dt
      d.x += d.vx * dt
      d.r = Math.max(0, d.r - dt * 9)
      d.neck.r = Math.max(0, d.neck.r - dt * 40)
      if (d.y > this.H * 0.55 || d.r <= 0.5) {
        this.ripple(d.x, d.y, 1.1, d.color)
        this.drips.delete(d.id)
      }
    }
    const pendingN = [...this.drips.values()].filter((d) => !d.falling).length
    this.ceil += ((pendingN ? 1 : 0) - this.ceil) * Math.min(1, dt * 2.5)
    this.dim += ((panel ? (this.desktop ? 0.25 : 0.55) : 0) - this.dim) * Math.min(1, dt * 3)

    // messages in flight
    for (const m of [...this.messengers]) {
      const a = this.drops.get(m.from), b = this.drops.get(m.to)
      m.t += dt / m.dur
      if (!a || !b) { this.messengers.splice(this.messengers.indexOf(m), 1); continue }
      const u = m.t < 0.5 ? 2 * m.t * m.t : 1 - Math.pow(-2 * m.t + 2, 2) / 2
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
      const nx = -(b.y - a.y) * 0.28, ny = (b.x - a.x) * 0.28
      const cx = mx + nx, cy = my + ny
      m.px = m.x; m.py = m.y
      m.x = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * cx + u * u * b.x
      m.y = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * cy + u * u * b.y
      if (eng) {
        const vx = (m.x - m.px) / dt, vy = (m.y - m.py) / dt
        this.velQ.push({ x: m.x, y: m.y, r: 16, a: vx * 0.6, b: vy * 0.6, c: 0 })
        this.dyeQ.push({ x: m.x, y: m.y, r: 9, a: m.color[0] * 0.16, b: m.color[1] * 0.16, c: m.color[2] * 0.16 })
      }
      if (m.t >= 1) {
        this.messengers.splice(this.messengers.indexOf(m), 1)
        b.kick = Math.min(1.4, b.kick + 0.8)
        this.ripple(b.x, b.y, 0.7, m.color)
      }
    }

    // ink and currents from everything that moves
    if (eng) {
      for (const d of this.drops.values()) {
        if (d.layer || d.r < 1) continue
        this.velQ.push({ x: d.x, y: d.y, r: d.r * 1.1, a: d.vx * 0.8, b: d.vy * 0.8, c: 0 })
        if (d.thinking) {
          const a = t * 5 + d.seed * 20
          this.velQ.push({ x: d.x + Math.cos(a) * d.r, y: d.y + Math.sin(a) * d.r, r: d.r * 0.8, a: -Math.sin(a) * 260, b: Math.cos(a) * 260, c: 0 })
        }
        const amt = (d.status === 'awake' ? (d.thinking ? 0.07 : 0.028) : d.status === 'error' ? 0.08 : d.status === 'starting' ? 0.05 : 0.004) * dt * 60
        this.dyeQ.push({ x: d.x, y: d.y, r: d.r * 0.85, a: d.color[0] * amt, b: d.color[1] * amt, c: d.color[2] * amt })
      }
      for (const b of this.bodies.values()) {
        if (b.coreLayer) continue
        const amt = 0.008 * dt * 60
        this.dyeQ.push({ x: b.core.x, y: b.core.y, r: b.core.r * 0.9, a: b.color[0] * amt, b: b.color[1] * amt, c: b.color[2] * amt })
        this.velQ.push({ x: b.core.x, y: b.core.y, r: b.core.r, a: b.core.vx, b: b.core.vy, c: 0 })
      }
      for (const d of this.drips.values()) {
        if (d.layer) continue
        if (d.falling) this.dyeQ.push({ x: d.x, y: d.y, r: d.r, a: d.color[0] * 0.2, b: d.color[1] * 0.2, c: d.color[2] * 0.2 })
        this.velQ.push({ x: d.x, y: d.y, r: d.r, a: d.vx * 0.5, b: d.vy * 0.5, c: 0 })
      }
      eng.step(dt, this.velQ, this.dyeQ, { vel: 0.35, dye: 0.95 })
      this.velQ = []
      this.dyeQ = []
      this.upload()
    }
    this.place()
    this.frameCb?.(dt)
  }

  private upload() {
    const eng = this.engine!
    let n = 0
    const front: [number, number, number, RGB, number][] = []
    const put = (x: number, y: number, r: number, layer: number, c: RGB, e: number) => {
      if (r < 0.5) return
      if (layer) { front.push([x, y, r, c, e]); return }
      if (n >= MAXB) return
      eng.B[n].set(x, y, r, 0)
      eng.C[n].set(c[0], c[1], c[2], e)
      n++
    }
    for (const b of this.bodies.values()) put(b.core.x, b.core.y, b.core.r, b.coreLayer, b.color, b.coreLayer ? 0.95 : 0.55)
    for (const d of this.drops.values()) put(d.x, d.y, d.r, d.layer, d.color, d.layer ? Math.max(0.75, d.energy) : d.energy)
    for (const d of this.drips.values()) {
      put(d.x, d.y, d.r, d.layer, d.color, 0.95)
      if (!d.layer) put(d.neck.x, d.neck.y, d.neck.r, 0, d.color, 0.85)
    }
    for (const m of this.messengers) put(m.x, m.y, 9, 0, m.color, 1)
    const split = n
    for (const [x, y, r, c, e] of front) {
      if (n >= MAXB) break
      eng.B[n].set(x, y, r, 1)
      eng.C[n].set(c[0], c[1], c[2], e)
      n++
    }
    const glass: GlassRegion[] = []
    for (const g of this.glass.values()) {
      const r = g.el.getBoundingClientRect()
      if (r.width < 2 || r.height < 2) continue
      glass.push({ x: r.left, y: r.top, w: r.width, h: r.height, radius: g.radius, clip: g.clip?.() ?? null })
    }
    eng.render(this.t, n, split, glass, this.ceil, this.ceilCol, this.dim)
  }

  /** Move overlay nodes (labels and hit targets) to their liquid. */
  private glassRects: DOMRect[] = []

  /** Static mode (no engine): a node or slot that mounted after the last settle is put in place now. */
  placeStatic() {
    if (!this.engine) this.place()
  }

  private place() {
    const rects = this.glassRects
    rects.length = 0
    for (const g of this.glass.values()) rects.push(g.el.getBoundingClientRect())
    for (const [key, el] of this.nodes) {
      const p = key.startsWith('label:') ? this.posOf('body:' + key.slice(6)) : this.posOf(key)
      if (!p) continue
      const ly = key.startsWith('label:') ? p.y + p.r * 1.9 : key.includes('#w') ? p.y - p.r - 24 : p.y
      const under = rects.some((r) => p.x > r.left - 30 && p.x < r.right + 30 && ly > r.top - 20 && ly < r.bottom + 20)
      const vis = under ? 'hidden' : ''
      if (el.style.visibility !== vis) el.style.visibility = vis
      el.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`
      el.style.setProperty('--r', `${Math.max(p.r, 1).toFixed(1)}px`)
    }
    this.declutter()
  }

  /**
   * Droplet name tags never pile up: swarm names and the tag you hover are placed first, then the biggest drops; a tag
   * that would overlap one already placed (or the hive title, the pill, Ω) waits until there is room.
   */
  private frameNo = 0
  private blocked: [number, number, number, number][] = []
  private declutter() {
    this.frameNo++
    if (this.frameNo % 15 === 1) {
      const b: [number, number, number, number][] = [[0, this.H - 64, 64, this.H]]
      for (const el of document.querySelectorAll<HTMLElement>('[data-flux-occlude]')) {
        const r = el.getBoundingClientRect()
        if (r.width > 0) b.push([r.left, r.top, r.right, r.bottom])
      }
      this.blocked = b
    }
    const tags: { el: HTMLElement; hot: boolean; r: number; box: [number, number, number, number] }[] = []
    const placed = [...this.blocked]
    for (const [key, node] of this.nodes) {
      if (key.startsWith('label:')) {
        const wrap = node.firstElementChild as HTMLElement | null
        if (wrap && wrap.style.opacity !== '0' && node.style.visibility !== 'hidden' && wrap.offsetWidth) {
          const r = wrap.getBoundingClientRect()
          if (r.width) placed.push([r.left, r.top, r.right, r.bottom])
        }
        continue
      }
      if (key.includes('#w')) {
        // a whisper is news: tags make way for it
        const r = (node.firstElementChild as HTMLElement | null)?.getBoundingClientRect()
        if (r && r.width) placed.push([r.left, r.top, r.right, r.bottom])
        continue
      }
      if (!key.startsWith('drop:') || key.includes('#')) continue
      const tag = node.querySelector<HTMLElement>('[data-flux-label]')
      if (!tag) continue
      const p = this.posOf(key)
      if (!p) continue
      const w = tag.offsetWidth
      const h = tag.offsetHeight || 22
      const top = p.y + Math.max(p.r, 1) + 6
      // keep the whole tag on screen
      const dx = Math.min(this.W - 6 - (p.x + w / 2), Math.max(6 - (p.x - w / 2), 0))
      const ml = `${dx.toFixed(0)}px`
      if (tag.style.marginLeft !== ml) tag.style.marginLeft = ml
      const x = p.x + dx
      tags.push({ el: tag, hot: tag.dataset.fluxLabel === 'hot', r: p.r, box: [x - w / 2 - 3, top, x + w / 2 + 3, top + h] })
    }
    tags.sort((a, b) => Number(b.hot) - Number(a.hot) || b.r - a.r)
    for (const t of tags) {
      const clash = !t.hot && placed.some((q) => t.box[0] < q[2] && t.box[2] > q[0] && t.box[1] < q[3] && t.box[3] > q[1])
      const vis = clash ? 'hidden' : ''
      if (t.el.style.visibility !== vis) t.el.style.visibility = vis
      if (!clash) placed.push(t.box)
    }
  }

  /** Reduced motion: a still gradient made from the same bodies. */
  paintStatic() {
    const el = this.staticEl
    if (!el) return
    const css = (c: RGB, a: number) => `rgb(${Math.round(c[0] * 255)} ${Math.round(c[1] * 255)} ${Math.round(c[2] * 255)} / ${a})`
    const layers: string[] = []
    for (const d of this.drops.values()) layers.push(`radial-gradient(circle at ${d.x}px ${d.y}px, ${css(d.color, 0.55)} 0, ${css(d.color, 0.18)} ${d.r * 1.3}px, transparent ${d.r * 3}px)`)
    for (const b of this.bodies.values()) layers.push(`radial-gradient(circle at ${b.x}px ${b.y}px, ${css(b.color, 0.45)} 0, ${css(b.color, 0.12)} ${b.r * 1.6}px, transparent ${b.r * 3.4}px)`)
    layers.push('radial-gradient(ellipse at 82% 8%, rgb(80 16 96 / 0.5), transparent 55%)', 'radial-gradient(ellipse at 12% 92%, rgb(14 40 92 / 0.45), transparent 55%)', 'linear-gradient(180deg, #0e0619, #08030f)')
    el.style.background = layers.join(',')
  }
}
