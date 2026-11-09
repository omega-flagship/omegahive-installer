import type { Agent, AgentStatus, AssertionOutcome, Belief, HiveEvent, Swarm, ThinkingPhase } from '../api/types'
import { swarmLabelBox, type LabelBox } from './mapLabels'
import { freqRgb, surenessRgb } from '../lib/color'
import { surenessOf } from '../lib/beliefSentence'
import { CLOUD_HIVE, PLACEHOLDER_R, universeLayout, type Galaxy, type UniverseLayout } from './rings'
import { glowSprite, nebulaSprite, starTile, type SpriteCanvas } from './sprites'
import { shown } from '../lib/displayName'
import { plural } from '../lib/plural'

/**
 * HiveEngine: an imperative 2.5D canvas renderer for the living hive.
 *
 * World space is a flat plane; every dot orbits its swarm core on a tilted ellipse whose
 * third axis (z) drives depth: scale, brightness, fog and draw order. Everything luminous is a
 * cached glow sprite composited additively, which reads as bloom without a GPU post-pass.
 */

/** The backdrop's three gradient stops (top, middle, bottom); a UI variant may replace them (shell/uiVariant.ts). */
const DEFAULT_BACKDROP: [string, string, string] = ['#05051a', '#070620', '#030311']
let backdrop: [string, string, string] = DEFAULT_BACKDROP
export function setSceneBackdrop(stops: [string, string, string] | null): void {
  backdrop = stops ?? DEFAULT_BACKDROP
}
/** The look's text inks for words drawn into the scene (names, counts); a light look draws them dark (light-token round R1). */
const DEFAULT_INK = { ink: '#ecebff', ink2: '#bebfe4', bad: '#ffaaaf' }
let sceneInk = DEFAULT_INK
export function setSceneInk(ink: { ink: string; ink2: string; bad: string } | null): void {
  sceneInk = ink ?? DEFAULT_INK
}
/** one of the scene's inks at an alpha, as a canvas colour */
const ink = (which: keyof typeof DEFAULT_INK, a: number) => {
  const h = sceneInk[which]
  return /^#[0-9a-f]{6}$/i.test(h) ? `rgba(${parseInt(h.slice(1, 3), 16)},${parseInt(h.slice(3, 5), 16)},${parseInt(h.slice(5, 7), 16)},${a})` : h
}

/** `group`: a team's folded request helpers (scene/helperGroups), id = the group's id (helperGroupId). */
export type HitTarget = { kind: 'dot'; id: string } | { kind: 'core'; id: string } | { kind: 'group'; id: string }

export interface EngineCallbacks {
  onHover(target: HitTarget | null): void
  onTap(target: HitTarget | null, pointerType: string): void
  /** Called when the user drags or zooms the camera themselves. */
  onUserCamera?(): void
}

export interface SceneData {
  agents: Agent[]
  swarms: Swarm[]
  thinking: Record<string, ThinkingPhase>
  beliefs: Record<string, Record<string, Belief>>
  /** Phase 2: every goal id → its claimant while claimed, else null (task glyphs orbit claimants). */
  claims?: Record<string, string | null>
  /** Phase 2: pending approvals per agent (an amber "asking" halo). */
  asking?: Record<string, number>
  /**
   * The universe of galaxies (PLAN_HIVE_VIEW_SCALING r2; scene/visibleSet): each shown swarm's hive, each hive's label
   * as this viewer may read it, where minds without a swarm gather, and how many authorised placeholders to draw.
   * Absent: every swarm is in the cloud hive.
   */
  universe?: SceneUniverse
  /**
   * A team's finished request helpers, folded into one quiet orb near the team (scene/helperGroups groupHelpers): its
   * id (helperGroupId), team, how many, the words drawn under it, and whether it is open (its helpers are then in
   * `agents`). Absent: none.
   */
  helperGroups?: SceneHelperGroup[]
}

export interface SceneHelperGroup {
  id: string
  teamId: string
  count: number
  label: string
  expanded: boolean
}

export interface SceneUniverse {
  hiveOf: Record<string, string>
  labels: Record<string, string>
  wanderHive: string | null
  placeholders: number
}

/** A galaxy as the engine draws it: its layout, label and colour, and where it was on screen last frame. */
interface GalaxyView extends Galaxy {
  label: string
  hue: number
  sx: number
  sy: number
  /** its radius on screen (px) */
  sr: number
  /** on screen and big enough to show its swarms (else one point of light, or off screen) */
  open: boolean
  visible: boolean
}

/** A galaxy smaller than this on screen (radius, px) is drawn as one point of light: no swarms, no minds. */
const GALAXY_POINT_PX = 34
/** A swarm whose packing slot is smaller than this on screen (px) is one point of light: no orbits, motes or minds. */
const SWARM_POINT_PX = 22
/** A swarm's name shows once its slot is at least this big on screen (px). */
const SWARM_LABEL_PX = 48
/**
 * A galaxy's name is drawn in screen px above its outline (drawLabels: its top 26 px above, 11–13 px type), so the fit
 * keeps this much screen room above the universe (and above a galaxy flown into), whatever the zoom: world-unit room
 * alone shrinks to a few px at universe zoom and the top name ran under the HUD's stats (followups-r5).
 */
export const GALAXY_LABEL_ROOM = 30
const GALAXY_LABEL_LIFT = 26

export interface Insets {
  top: number
  right: number
  bottom: number
  left: number
}

type V2 = { x: number; y: number }

interface Dot {
  id: string
  name: string
  hue: number
  swarmId: string | null
  status: AgentStatus
  thinking: ThinkingPhase | null
  // orbit
  orbitR: number
  tilt: number
  node: number
  angle: number
  speed: number
  wobble: number
  // dynamics
  glow: number
  size: number
  ring: number
  errorMix: number
  hover: number
  birth: number
  dying: number
  glitchUntil: number
  glitchX: number
  phase: number
  // phase 2: claimed goals, pending approvals, scheduled wake pulse
  tasks: number
  taskVis: number
  asking: number
  askVis: number
  wake: number
  // derived per frame
  x: number
  y: number
  z: number
  sx: number
  sy: number
  sr: number
  ox: number
  oy: number
  /** Where the dot was drawn over the last frames: [time, x, y] × TRAIL_FRAMES, a ring (trailAt = next slot). */
  trail: Float64Array
  trailAt: number
  /** not drawn this frame: its swarm is a point of light, or its galaxy is a point or off screen */
  culled?: boolean
  /** a folded group of finished request helpers (scene/helperGroups): small, dim, slow, never pulses */
  group?: boolean
}

interface Mote {
  r: number
  a: number
  w: number
  incl: number
  f: number
  c: number
  statement: string
  born: number
}

interface Core {
  id: string
  name: string
  hue: number
  x: number
  y: number
  tx: number
  ty: number
  motes: Mote[]
  flash: number
  spin: number
  spinBoost: number
  members: number
  sx: number
  sy: number
  hover: number
  /** the hive (galaxy) it belongs to, and its packing slot's radius (world units) */
  hive: string
  slot: number
  /** level of detail this frame: 0 not drawn (its galaxy is a point or off screen), 1 a point of light, 2 full */
  lod: 0 | 1 | 2
}

type ParticleKind = 'belief' | 'msg' | 'peer' | 'task'
interface Particle {
  kind: ParticleKind
  from: () => V2 | null
  to: () => V2 | null
  t: number
  dur: number
  hue: number
  bend: number
  trail: V2[]
  outcome?: AssertionOutcome
  swarmId?: string
  f?: number
  /** the assertion's confidence: with f, its colour is how sure (uifix-r3.4) */
  c?: number
  key?: string
  done?: boolean
  /** Dot the particle lands on (task particles spark there). */
  target?: string
}

type EffectKind = 'ripple' | 'choice' | 'adopt' | 'quarantine' | 'duplicate' | 'birth' | 'spark' | 'wake'
interface Effect {
  kind: EffectKind
  at: () => V2 | null
  t: number
  dur: number
  hue: number
  seed: number
  jag?: number[]
  sparks?: { a: number; v: number; s: number }[]
  rejected?: boolean
  /** uifix-r3.6 (Kimi 3 on r3.5): an adopt ring's sureness tone (surenessOf), drawn on the diverging scale; never coded into hue */
  tone?: number
}

interface Dust {
  x: number
  y: number
  z: number
  vx: number
  vy: number
  a: number
}

const TAU = Math.PI * 2
/**
 * How far from a mind's dot a click or tap still picks it (a radius, in CSS px). A dot is drawn only a few px wide and
 * drifts, so its target is wider than the dot: at least 32 px across for a mouse, 44 px for a finger (52 px here).
 */
export const HIT_SLOP_MOUSE = 16
export const HIT_SLOP_TOUCH = 26
export const hitSlop = (pointerType: string): number => (pointerType === 'mouse' ? HIT_SLOP_MOUSE : HIT_SLOP_TOUCH)
/**
 * A press also counts where a dot was drawn this long ago: people aim at what they saw, and a dot riding a camera move
 * travels up to ~1 px/ms. Hover uses only where the dot is now.
 */
export const PRESS_RECENT_MS = 150
const TRAIL_FRAMES = 12
/** How long a full page has to cover the scene before the render loop stops. */
const PAUSE_AFTER_DIM_MS = 700
/** Task glyphs and goal light: a warm gold that reads apart from thinking rings and belief motes. */
const TASK_HUE = 44
const WAKE_HUE = 40
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const damp = (a: number, b: number, k: number, dt: number) => lerp(a, b, 1 - Math.exp(-k * dt))
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
const easeOut = (t: number) => 1 - (1 - t) ** 3
const easeOutBack = (t: number) => {
  const c1 = 1.5
  const c3 = c1 + 1
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2
}

function hash(str: string): number {
  let h = 2166136261
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

const STATUS_GLOW: Record<AgentStatus, number> = {
  awake: 1,
  starting: 0.75,
  created: 0.55,
  asleep: 0.32,
  stopped: 0.14,
  error: 0.95,
}
const STATUS_SIZE: Record<AgentStatus, number> = {
  awake: 1,
  starting: 0.9,
  created: 0.8,
  asleep: 0.72,
  stopped: 0.62,
  error: 1,
}
/** A folded helper group's orb: smaller and dimmer than a sleeping mind, and all but still (it never pulses). */
const GROUP_SIZE = 0.6
const GROUP_GLOW = 0.24
const GROUP_SPEED = 0.04
const STATUS_SPEED: Record<AgentStatus, number> = {
  awake: 1,
  starting: 1.6,
  created: 0.6,
  asleep: 0.22,
  stopped: 0.05,
  error: 0.4,
}

export class HiveEngine {
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D
  private cb: EngineCallbacks
  private dots = new Map<string, Dot>()
  private cores = new Map<string, Core>()
  private wanderCore: Core
  private particles: Particle[] = []
  private effects: Effect[] = []
  private dust: Dust[] = []
  private inFlight = new Map<string, number>()
  private convPeer = new Map<string, string>()
  /** Last claimant the engine has seen per goal, to tell a fresh claim from a re-send. */
  private claimSeen = new Map<string, string | null>()

  private w = 0
  private h = 0
  private dpr = 1
  private maxDpr = 2
  private raf = 0
  private running = false
  private last = 0
  private time = 0
  private frameAcc = 0
  private fpsCap = 0
  private perf: number[] = []
  private fpsFrames = 0
  private fpsAt = 0
  private synced = false
  private reduced = false
  private dimmed = false
  /** True while a full page covers the scene: the loop is stopped, not just throttled. */
  private paused = false
  private readonly drawingHolds = new Set<symbol>()
  private destroyed = false
  private pauseTimer: ReturnType<typeof setTimeout> | undefined

  // camera
  private cam = { x: 0, y: 0, z: 0.8 }
  private camT = { x: 0, y: 0, z: 0.8 }
  private camK = 3.2
  private follow: string | null = null
  /** The fit the camera is in, until the person moves it or it flies to a dot or swarm: refitted when insets change. */
  private fit: { galaxy: string | null } | null = null
  /**
   * A dot flight whose zoom is still the engine's own (followups-r6): its zoom is clamped again when the insets or the
   * size change, from the zoom it flew from. Ends when the person moves the camera or it flies elsewhere.
   */
  private dotFly: { id: string; from: number } | null = null
  private insets: Insets = { top: 0, right: 0, bottom: 0, left: 0 }
  private center = { x: 0, y: 0 }
  private centerT = { x: 0, y: 0 }
  private anchor: V2 | null = null

  // input
  /** `hit`: what was under the pointer when it went down (where the person saw the dot), kept for the tap. */
  private pointers = new Map<number, { x: number; y: number; sx: number; sy: number; t: number; type: string; hit: HitTarget | null }>()
  private dragging = false
  private pinch: { d: number; z: number; mx: number; my: number } | null = null
  private vel = { x: 0, y: 0 }
  private hoverTarget: HitTarget | null = null
  private selected: string | null = null
  private tracked = new Map<HTMLElement, string>()

  private stars: { far: SpriteCanvas; near: SpriteCanvas; farPat: CanvasPattern | null; nearPat: CanvasPattern | null }
  /** Half-resolution cache of everything behind the dots (gradient, far stars, nebulae, vignette). */
  private bg: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; key: string; farPat: CanvasPattern | null } | null = null
  private perfAt = 0
  private twinkles: { x: number; y: number; p: number; s: number }[] = []
  // the universe of galaxies (scene/rings): the shown set's hives, their places, and the placeholders' cluster
  private universe: SceneUniverse = { hiveOf: {}, labels: {}, wanderHive: null, placeholders: 0 }
  private galaxies: GalaxyView[] = []
  /** The galaxy names' screen boxes as last drawn (CSS px): for the layout checks (HiveScene, sim/dev only). */
  private galaxyLabelRects: { id: string; left: number; top: number; right: number; bottom: number }[] = []
  private privateCluster: UniverseLayout['privateCluster'] = null
  /** where the person dragged galaxies (world units, by hive id): scene/galaxyPositions keeps them per person */
  private pinned: Record<string, { x: number; y: number }> = {}
  private wanderCount = 0
  private galaxyDrag: { id: string; dx: number; dy: number; sx: number; sy: number; moved: boolean } | null = null

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks, opts: { reducedMotion?: boolean } = {}) {
    this.canvas = canvas
    const ctx = canvas.getContext('2d', { alpha: false })
    if (!ctx) throw new Error('Canvas 2D unavailable')
    this.ctx = ctx
    this.cb = cb
    this.reduced = !!opts.reducedMotion
    this.wanderCore = this.makeCore('__wander', 'Wanderers', 210)
    const far = starTile(11, 512, 260, 0.9)
    const near = starTile(29, 640, 70, 1.6)
    this.stars = { far, near, farPat: ctx.createPattern(far, 'repeat'), nearPat: ctx.createPattern(near, 'repeat') }
    for (let i = 0; i < 46; i++) this.twinkles.push({ x: Math.random(), y: Math.random(), p: Math.random() * TAU, s: 0.5 + Math.random() * 1.5 })
    // Glows are soft by nature: phones do not need their full 3x backing store.
    const coarse = window.matchMedia?.('(pointer: coarse)').matches
    this.maxDpr = Math.min(coarse ? 1.5 : 2, window.devicePixelRatio || 1)
    const bgc = document.createElement('canvas')
    const bgctx = bgc.getContext('2d', { alpha: false })
    if (bgctx) this.bg = { canvas: bgc, ctx: bgctx, key: '', farPat: bgctx.createPattern(far, 'repeat') }
    this.resize()
    this.seedDust()
    this.bindInput()
    document.addEventListener('visibilitychange', this.onVisibility)
  }

  // ================================================================== lifecycle

  start(): void {
    if (this.running || this.destroyed || this.paused || this.drawingHolds.size || document.hidden) return
    this.running = true
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.frame)
  }

  stop(): void {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  /** Stop drawing while the scene is covered; the last frame stays on the canvas. */
  pause(): void {
    this.paused = true
    this.stop()
  }

  /** Resume drawing after pause() (unless the tab is hidden; visibility resumes it then). */
  resume(): void {
    this.paused = false
    if (!document.hidden) this.start()
  }

  get isPaused(): boolean {
    return this.paused || this.drawingHolds.size > 0
  }

  /** An owned hold for a view covering the map. Other pause/resume owners cannot
   * restart it until every hold is released; late cleanup cannot revive a destroyed engine. */
  holdDrawing(): () => void {
    if (this.destroyed) return () => undefined
    const firstHold = this.drawingHolds.size === 0
    const owner = Symbol('drawing hold')
    this.drawingHolds.add(owner)
    this.stop()
    if (firstHold) this.drawStill() // also paint under a page's pause; drawStill guards hidden/destroyed
    let released = false
    return () => {
      if (released) return
      released = true
      this.drawingHolds.delete(owner)
      if (!this.destroyed && !this.isPaused && !document.hidden) this.start()
    }
  }

  /** Compute current screen positions before painting a still, including before the first animation frame. */
  private drawStill(): void {
    if (this.destroyed || document.hidden) return
    this.update(0)
    this.render()
  }

  destroy(): void {
    this.destroyed = true
    this.drawingHolds.clear()
    clearTimeout(this.pauseTimer)
    this.stop()
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.unbindInput()
  }

  private onVisibility = () => {
    if (document.hidden) this.stop()
    else if (this.isPaused) this.drawStill()
    else this.start()
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect()
    const was = { w: this.w, h: this.h }
    this.w = Math.max(1, r.width)
    this.h = Math.max(1, r.height)
    this.dpr = Math.min(this.maxDpr, window.devicePixelRatio || 1)
    this.canvas.width = Math.round(this.w * this.dpr)
    this.canvas.height = Math.round(this.h * this.dpr)
    this.layout()
    this.updateCenter(true)
    // a new size (not just a new pixel ratio): a fit nobody has moved is fitted to it, a dot flight's zoom clamped again
    // (followups-r6); a camera the person moved stays where they put it
    if (was.w !== this.w || was.h !== this.h) this.refit()
    // resizing clears the canvas: redraw the covered (paused) scene once
    if (this.isPaused && !document.hidden) this.drawStill()
  }

  setReducedMotion(v: boolean): void {
    this.reduced = v
    this.seedDust()
  }

  /**
   * Dim the scene while a full-screen view covers it, then stop the loop once the page has settled
   * over it (a few dimmed frames are drawn first so the frozen frame is the dimmed one).
   */
  setDimmed(v: boolean): void {
    this.dimmed = v
    this.fpsCap = v ? 24 : 0
    clearTimeout(this.pauseTimer)
    if (v) this.pauseTimer = setTimeout(() => this.pause(), PAUSE_AFTER_DIM_MS)
    else if (this.paused) this.resume()
  }

  setInsets(i: Insets): void {
    const was = this.insets
    this.insets = i
    this.updateCenter(false)
    // a fit nobody has moved away from yet is fitted again when the room above or below changes (the docked Ask reports
    // its room after the first fit, followups-r5): the galaxies' names keep clear of it. A right-only change (a desktop
    // sheet) never refits a fit. A dot flight's zoom is clamped again to the free region on any change (followups-r6).
    const vertical = was.top !== i.top || was.bottom !== i.bottom
    if (this.fit ? vertical : vertical || was.left !== i.left || was.right !== i.right) this.refit()
  }

  /** The camera the engine chose itself, fitted again: the fit nobody moved, or a dot flight's zoom. Never a moved camera. */
  private refit(): void {
    if (this.fit) {
      if (this.fit.galaxy) this.flyToGalaxy(this.fit.galaxy)
      else this.overview()
    } else if (this.dotFly && this.follow === this.dotFly.id) {
      this.camT.z = this.dotZoom(this.dotFly.from)
    }
  }

  /**
   * The zoom a dot flight uses: at least close enough to see the mind (2.1, or less where the free region is narrow or
   * short: what the insets leave, not the whole canvas, followups-r6), never closer than it already was, within 0.6–2.4.
   */
  private dotZoom(from: number): number {
    const i = this.insets
    const free = Math.min(this.w - i.left - i.right, this.h - i.top - i.bottom)
    return clamp(Math.max(from, Math.min(2.1, free / 300)), 0.6, 2.4)
  }

  /** The person moved the camera themselves: no fit is kept any more, and a dot flight's zoom is theirs now. */
  private userCamera(): void {
    this.fit = null
    this.dotFly = null
    this.cb.onUserCamera?.()
  }

  setChatAnchor(p: V2 | null): void {
    this.anchor = p
  }

  // ================================================================== data sync

  private makeCore(id: string, name: string, hue: number): Core {
    return { id, name, hue, x: 0, y: 0, tx: 0, ty: 0, motes: [], flash: 0, spin: Math.random() * TAU, spinBoost: 0, members: 0, sx: 0, sy: 0, hover: 0, hive: CLOUD_HIVE, slot: 120, lod: 2 }
  }

  setData(d: SceneData): void {
    this.universe = d.universe ?? { hiveOf: {}, labels: {}, wanderHive: null, placeholders: 0 }
    // swarms → cores
    const seenCores = new Set<string>()
    for (const s of d.swarms) {
      seenCores.add(s.id)
      let c = this.cores.get(s.id)
      if (!c) {
        c = this.makeCore(s.id, shown(s.name), s.hue)
        this.cores.set(s.id, c)
      }
      c.name = shown(s.name)
      c.hue = s.hue
      c.members = s.member_ids.length
      c.hive = this.universe.hiveOf[s.id] ?? CLOUD_HIVE
      this.syncMotes(c, d.beliefs[s.id])
    }
    for (const id of [...this.cores.keys()]) if (!seenCores.has(id)) this.cores.delete(id)
    this.wanderCount = d.agents.filter((a) => !a.swarm_id || !this.cores.has(a.swarm_id)).length
    this.layout()

    // agents → dots
    const seen = new Set<string>()
    const bySwarm = new Map<string, Agent[]>()
    for (const a of d.agents) {
      const k = a.swarm_id && this.cores.has(a.swarm_id) ? a.swarm_id : '__wander'
      if (!bySwarm.has(k)) bySwarm.set(k, [])
      bySwarm.get(k)!.push(a)
    }
    for (const [k, list] of bySwarm) {
      list.sort((a, b) => a.created_at.localeCompare(b.created_at))
      list.forEach((a, i) => {
        seen.add(a.id)
        let dot = this.dots.get(a.id)
        const h = hash(a.id)
        // sqrt growth keeps big swarms compact (50+ dots) while small ones stay airy
        const orbitR = (k === '__wander' ? 34 : 44) + Math.sqrt(i + 1) * 15 + h * 12
        if (!dot) {
          dot = {
            id: a.id,
            name: shown(a.name),
            hue: a.hue,
            swarmId: k === '__wander' ? null : k,
            status: a.status,
            thinking: null,
            orbitR,
            tilt: 0.95 + h * 0.5,
            node: hash(a.id + 'n') * TAU,
            angle: hash(a.id + 'a') * TAU,
            speed: STATUS_SPEED[a.status],
            wobble: hash(a.id + 'w') * TAU,
            glow: this.synced ? 0 : STATUS_GLOW[a.status],
            size: STATUS_SIZE[a.status],
            ring: 0,
            errorMix: a.status === 'error' ? 1 : 0,
            hover: 0,
            birth: this.synced ? 0 : 1,
            dying: 0,
            glitchUntil: 0,
            glitchX: 0,
            phase: h * TAU,
            tasks: 0, taskVis: 0, asking: 0, askVis: 0, wake: 0,
            x: 0, y: 0, z: 0, sx: 0, sy: 0, sr: 0, ox: 0, oy: 0,
            trail: new Float64Array(TRAIL_FRAMES * 3), trailAt: 0,
          }
          this.dots.set(a.id, dot)
          if (this.synced) this.spawnBirth(dot)
        }
        dot.name = shown(a.name)
        dot.hue = a.hue
        dot.status = a.status
        dot.orbitR = orbitR
        const newSwarm = k === '__wander' ? null : k
        if (dot.swarmId !== newSwarm) dot.swarmId = newSwarm
        dot.thinking = d.thinking[a.id] ?? null
        dot.asking = d.asking?.[a.id] ? 1 : 0
        dot.tasks = 0
      })
    }
    // folded request helpers: one quiet orb per team, on an inner orbit of its own (scene/helperGroups)
    for (const g of d.helperGroups ?? []) {
      if (!this.cores.has(g.teamId)) continue
      seen.add(g.id)
      const h = hash(g.id)
      let dot = this.dots.get(g.id)
      if (!dot) {
        dot = {
          id: g.id, name: g.label, hue: this.cores.get(g.teamId)!.hue, swarmId: g.teamId, status: 'asleep', thinking: null, group: true,
          orbitR: 30 + h * 6, tilt: 0.95 + h * 0.5, node: hash(g.id + 'n') * TAU, angle: hash(g.id + 'a') * TAU, speed: GROUP_SPEED,
          wobble: hash(g.id + 'w') * TAU, glow: GROUP_GLOW, size: GROUP_SIZE, ring: 0, errorMix: 0, hover: 0, birth: 1, dying: 0,
          glitchUntil: 0, glitchX: 0, phase: h * TAU, tasks: 0, taskVis: 0, asking: 0, askVis: 0, wake: 0,
          x: 0, y: 0, z: 0, sx: 0, sy: 0, sr: 0, ox: 0, oy: 0, trail: new Float64Array(TRAIL_FRAMES * 3), trailAt: 0,
        }
        this.dots.set(g.id, dot)
      }
      dot.name = g.label
      dot.hue = this.cores.get(g.teamId)!.hue
      dot.swarmId = g.teamId
      dot.dying = 0
    }
    if (d.claims) {
      // The store pushes data before the event reaches handleEvent, so only goals the engine has
      // never seen are seeded here; transitions of known goals are left for handleEvent to compare.
      for (const [goalId, agentId] of Object.entries(d.claims)) {
        const dot = agentId ? this.dots.get(agentId) : undefined
        if (dot) dot.tasks++
        if (!this.claimSeen.has(goalId)) this.claimSeen.set(goalId, agentId)
      }
    }
    for (const [id, dot] of this.dots) if (!seen.has(id) && dot.dying === 0) dot.dying = 0.0001
    this.wanderCore.members = bySwarm.get('__wander')?.length ?? 0
    this.synced = d.agents.length > 0 || this.synced
    // A held view has no animation step to settle new data or retire removed minds. Paint the
    // current shown set on a data change, never keep an earlier viewer's map until Pro resumes.
    if (this.drawingHolds.size) {
      for (const [id, dot] of this.dots) {
        if (!seen.has(id)) this.dots.delete(id)
        else dot.birth = 1
      }
      if (this.selected && !seen.has(this.selected)) this.setSelected(null, false)
      if (this.follow && !seen.has(this.follow)) { this.follow = null; this.dotFly = null }
      if ((this.hoverTarget?.kind === 'dot' || this.hoverTarget?.kind === 'group') && !seen.has(this.hoverTarget.id)) this.setHover(null)
      for (const [goalId, agentId] of this.claimSeen) {
        if ((agentId && !seen.has(agentId)) || (d.claims && !Object.hasOwn(d.claims, goalId))) this.claimSeen.delete(goalId)
      }
      for (const core of this.cores.values()) { core.x = core.tx; core.y = core.ty }
      this.cam = { ...this.camT }
      this.drawStill()
    }
  }

  private syncMotes(c: Core, beliefs: Record<string, Belief> | undefined) {
    if (!beliefs) return
    const list = Object.values(beliefs)
    const byStmt = new Map(c.motes.map((m) => [m.statement, m]))
    const next: Mote[] = []
    for (const b of list.slice(0, 64)) {
      const m = byStmt.get(b.statement)
      if (m) {
        m.f = b.tv.f
        m.c = b.tv.c
        next.push(m)
      } else {
        const h = hash(b.statement)
        next.push({
          statement: b.statement,
          r: 9 + h * 22,
          a: hash(b.statement + 'a') * TAU,
          w: (0.25 + hash(b.statement + 'w') * 0.6) * (h > 0.5 ? 1 : -1),
          incl: hash(b.statement + 'i') * Math.PI,
          f: b.tv.f,
          c: b.tv.c,
          born: c.motes.length ? this.time : -10,
        })
      }
    }
    c.motes = next
  }

  /**
   * Place swarm cores as a universe of galaxies (scene/rings): each person's hive one galaxy, the cloud hive in the
   * middle, the swarms of each packed without overlap, and the authorised placeholders in their own cluster beside it.
   * The same shown set always gives the same places, in any viewport (the camera fits it).
   */
  private layout() {
    const cores = [...this.cores.values()]
    const wanderHive = this.universe.wanderHive ?? CLOUD_HIVE
    const u = universeLayout({
      swarms: cores.map((c) => ({ id: c.id, members: c.members, hive: c.hive })),
      centre: this.wanderCount ? { hive: wanderHive, minds: this.wanderCount } : null,
      pinned: this.pinned,
      placeholders: this.universe.placeholders,
    })
    const prev = new Map(this.galaxies.map((g) => [g.id, g]))
    this.galaxies = u.galaxies.map((g) => {
      // the colour of its biggest swarm (deterministic), the cloud hive's own when it has none
      let lead: Core | null = null
      for (const c of cores) if (c.hive === g.id && (!lead || c.members > lead.members || (c.members === lead.members && c.id < lead.id))) lead = c
      const hue = lead ? lead.hue : g.cloud ? 250 : (hash(g.id) * 360) | 0
      const was = prev.get(g.id)
      return { ...g, label: this.universe.labels[g.id] ?? (g.cloud ? 'Cloud hive' : 'A hive'), hue, sx: was?.sx ?? 0, sy: was?.sy ?? 0, sr: was?.sr ?? 0, open: was?.open ?? true, visible: was?.visible ?? true }
    })
    this.privateCluster = u.privateCluster
    for (const c of cores) {
      const p = u.places.get(c.id)
      if (!p) continue
      c.tx = p.x
      c.ty = p.y
      c.slot = p.r
      if (c.x === 0 && c.y === 0) {
        c.x = c.tx
        c.y = c.ty
      }
    }
    const home = this.galaxies.find((g) => g.id === wanderHive) ?? this.galaxies.find((g) => g.cloud)
    this.wanderCore.hive = home?.id ?? CLOUD_HIVE
    this.wanderCore.tx = u.centre ? u.centre.x : home ? home.x : 0
    this.wanderCore.ty = u.centre ? u.centre.y : home ? home.y : 0
    this.wanderCore.slot = 34 + Math.sqrt(Math.max(1, this.wanderCount)) * 15 + 30
    if (this.wanderCore.x === 0 && this.wanderCore.y === 0) {
      this.wanderCore.x = this.wanderCore.tx
      this.wanderCore.y = this.wanderCore.ty
    }
  }

  private bounds() {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    const add = (x: number, y: number, r: number) => {
      minX = Math.min(minX, x - r)
      minY = Math.min(minY, y - r)
      maxX = Math.max(maxX, x + r)
      maxY = Math.max(maxY, y + r)
    }
    if (this.galaxies.length > 1) {
      // the universe: every galaxy's outline, with room for its label above it
      for (const g of this.galaxies) add(g.x, g.y - 12, g.r + 24)
    } else {
      // one galaxy (a small hive): fit its swarms' orbits, as before
      for (const c of this.cores.values()) {
        let r = 80
        for (const d of this.dots.values()) if (d.swarmId === c.id) r = Math.max(r, d.orbitR + 18)
        add(c.tx, c.ty, r)
      }
      for (const d of this.dots.values()) if (!d.swarmId) add(this.wanderCore.tx, this.wanderCore.ty, d.orbitR + 18)
    }
    const pc = this.privateCluster
    if (pc) add(pc.x, pc.y - 12, pc.r + 24)
    if (minX === Infinity) add(0, 0, 200)
    return { minX, minY, maxX, maxY }
  }

  /** The farthest the camera zooms out: the whole universe fits, with some room (never closer than 0.22). */
  private minZoom(): number {
    return Math.min(0.22, this.fitZoom().z * 0.7)
  }

  // ================================================================== camera

  private updateCenter(snap: boolean) {
    const i = this.insets
    this.centerT = { x: i.left + (this.w - i.left - i.right) / 2, y: i.top + (this.h - i.top - i.bottom) / 2 }
    if (snap) this.center = { ...this.centerT }
  }

  private fitZoom() {
    const b = this.bounds()
    const i = this.insets
    // the docked Ask reports its own room as the inset `ask` (followups-r5), so the bottom inset already keeps clear of
    // it: no guessed extra room below (followups-r6 removed the old 72 px "dock" guess, which came back whenever the
    // bottom inset was under 60 px and pushed the universe up and smaller)
    // the universe keeps screen room above it for the top galaxy's name (GALAXY_LABEL_ROOM)
    const label = this.galaxies.length > 1 ? GALAXY_LABEL_ROOM : 0
    const vw = Math.max(120, this.w - i.left - i.right - 24)
    const vh = Math.max(120, this.h - i.top - i.bottom - 24 - label)
    const z = clamp(Math.min(vw / (b.maxX - b.minX), vh / (b.maxY - b.minY)), this.galaxies.length > 1 ? 0.03 : 0.25, 1.6)
    return {
      z,
      x: (b.minX + b.maxX) / 2,
      y: (b.minY + b.maxY) / 2 - label / 2 / z,
    }
  }

  overview(instant = false): void {
    this.follow = null
    this.fit = { galaxy: null }
    this.dotFly = null
    const f = this.fitZoom()
    this.camT = { x: f.x, y: f.y, z: f.z }
    this.camK = 2.6
    if (instant) this.cam = { ...this.camT }
  }

  flyToDot(id: string): void {
    const d = this.dots.get(id)
    if (!d) return
    this.follow = id
    this.fit = null
    this.dotFly = { id, from: this.camT.z }
    this.camT.z = this.dotZoom(this.camT.z)
    this.camK = 2.8
  }

  flyToSwarm(id: string): void {
    const c = this.cores.get(id)
    if (!c) return
    this.follow = null
    this.fit = null
    this.dotFly = null
    let r = 100
    for (const d of this.dots.values()) if (d.swarmId === id) r = Math.max(r, d.orbitR + 30)
    const i = this.insets
    const vw = this.w - i.left - i.right
    const vh = this.h - i.top - i.bottom
    this.camT = { x: c.tx, y: c.ty, z: clamp(Math.min(vw, vh) / (r * 2.3), 0.5, 2.2) }
    this.camK = 2.6
  }

  /** Fly into one galaxy (a person's hive, or the cloud hive): it fills the view and its swarms open. */
  flyToGalaxy(id: string): boolean {
    const g = this.galaxies.find((x) => x.id === id)
    if (!g) return false
    this.follow = null
    this.fit = { galaxy: id }
    this.dotFly = null
    const i = this.insets
    // its name above it keeps its screen room too (GALAXY_LABEL_ROOM): the galaxy sits that much lower and smaller
    const vw = Math.max(120, this.w - i.left - i.right - 24)
    const vh = Math.max(120, this.h - i.top - i.bottom - 24 - GALAXY_LABEL_ROOM)
    const z = clamp(Math.min(vw, vh) / (g.r * 2.15), this.minZoom(), 1.6)
    this.camT = { x: g.x, y: g.y - GALAXY_LABEL_ROOM / 2 / z, z }
    this.camK = 2.6
    return true
  }

  /** Where a person lands: their own galaxy when it is on the map (and the universe has more than one), else the whole universe. */
  land(hive: string | null, instant = false): void {
    if (hive && this.galaxies.length > 1 && this.flyToGalaxy(hive)) {
      if (instant) this.cam = { ...this.camT }
      if (instant && this.isPaused) this.drawStill()
      return
    }
    this.overview(instant)
    if (instant && this.isPaused) this.drawStill()
  }

  /** The galaxies on the map, as the viewer may read them (ids of shown hives only; never a placeholder). */
  galaxyList(): { id: string; label: string; cloud: boolean }[] {
    return this.galaxies.map((g) => ({ id: g.id, label: g.label, cloud: g.cloud }))
  }

  /** The galaxies as drawn last frame (shown hives only), for read-only UI checks. */
  /** The galaxy names' screen boxes, as last drawn (CSS px). */
  galaxyLabelBoxes(): { id: string; left: number; top: number; right: number; bottom: number }[] {
    return this.galaxyLabelRects.map((r) => ({ ...r }))
  }

  galaxyScreens(): { id: string; cloud: boolean; x: number; y: number; r: number; sx: number; sy: number; sr: number; open: boolean; visible: boolean }[] {
    return this.galaxies.map((g) => ({ id: g.id, cloud: g.cloud, x: g.x, y: g.y, r: g.r, sx: g.sx, sy: g.sy, sr: g.sr, open: g.open, visible: g.visible }))
  }

  /** The galaxy the camera is in (zoomed into one), or null at universe level. */
  galaxyInView(): string | null {
    if (this.galaxies.length === 1) return this.galaxies[0].id
    const c = this.toWorld(this.center.x, this.center.y)
    let best: GalaxyView | null = null
    let bestD = Infinity
    for (const g of this.galaxies) {
      const dist = Math.hypot(g.x - c.x, g.y - c.y)
      if (dist < g.r && dist < bestD) {
        best = g
        bestD = dist
      }
    }
    return best && best.r * this.cam.z >= Math.min(this.w, this.h) * 0.25 ? best.id : null
  }

  /** Put galaxies where the person had them (scene/galaxyPositions); the others pack around them. */
  setPinned(p: Record<string, { x: number; y: number }>): void {
    this.pinned = { ...p }
    this.layout()
  }

  /**
   * A galaxy's drag handle under a screen point: its label, or the whole point of light while it is drawn as one.
   * Only when the map shows more than one galaxy; a placeholder is never one.
   */
  galaxyHandleAt(x: number, y: number): string | null {
    if (this.galaxies.length < 2) return null
    for (const g of [...this.galaxies].reverse()) {
      if (!g.visible) continue
      if (!g.open && Math.hypot(g.sx - x, g.sy - y) <= Math.max(16, g.sr)) return g.id
      const top = g.sy - g.sr - 30
      const half = Math.max(40, g.label.length * 4.6 + 12)
      if (g.sr >= 14 && y >= top && y <= top + 22 && Math.abs(x - g.sx) <= half) return g.id
    }
    return null
  }

  /** Start dragging a galaxy (from galaxyHandleAt). */
  beginGalaxyDrag(id: string, x: number, y: number): boolean {
    const g = this.galaxies.find((q) => q.id === id)
    if (!g) return false
    const w = this.toWorld(x, y)
    this.galaxyDrag = { id, dx: g.x - w.x, dy: g.y - w.y, sx: x, sy: y, moved: false }
    this.follow = null
    return true
  }

  /** Move the dragged galaxy with the pointer: it and everything in it, at once. */
  moveGalaxyDrag(x: number, y: number): void {
    const d = this.galaxyDrag
    const g = d ? this.galaxies.find((q) => q.id === d.id) : undefined
    if (!d || !g) return
    if (!d.moved && Math.hypot(x - d.sx, y - d.sy) <= 6) return
    d.moved = true
    const w = this.toWorld(x, y)
    const nx = w.x + d.dx
    const ny = w.y + d.dy
    const ox = nx - g.x
    const oy = ny - g.y
    g.x = nx
    g.y = ny
    for (const c of this.cores.values()) {
      if (c.hive !== g.id) continue
      c.tx += ox
      c.ty += oy
      c.x = c.tx
      c.y = c.ty
    }
    if (this.wanderCore.hive === g.id) {
      this.wanderCore.tx += ox
      this.wanderCore.ty += oy
      this.wanderCore.x = this.wanderCore.tx
      this.wanderCore.y = this.wanderCore.ty
    }
  }

  /** End a galaxy drag: a move keeps the galaxy where it was put (the others make room); a still press flies in. */
  endGalaxyDrag(): { id: string; moved: boolean; x: number; y: number } | null {
    const d = this.galaxyDrag
    this.galaxyDrag = null
    const g = d ? this.galaxies.find((q) => q.id === d.id) : undefined
    if (!d || !g) return null
    if (!d.moved) {
      this.flyToGalaxy(g.id)
      return { id: g.id, moved: false, x: g.x, y: g.y }
    }
    this.pinned = { ...this.pinned, [g.id]: { x: Math.round(g.x), y: Math.round(g.y) } }
    this.layout()
    return { id: g.id, moved: true, x: Math.round(g.x), y: Math.round(g.y) }
  }

  /**
   * Drop a drag in progress without keeping anything (an identity change, a cancelled pointer): the dragged galaxy goes
   * back to its packed (or pinned) place. Galaxies that earlier repacked around a pin stay where that repack put them.
   */
  cancelGalaxyDrag(): void {
    if (!this.galaxyDrag) return
    this.galaxyDrag = null
    this.layout()
  }

  get draggingGalaxy(): boolean {
    return !!this.galaxyDrag
  }

  setSelected(id: string | null, fly = true): void {
    this.selected = id
    if (id && fly) this.flyToDot(id)
    if (!id) this.follow = null
  }

  zoomBy(f: number): void {
    this.camT.z = clamp(this.camT.z * f, this.minZoom(), 4)
    this.userCamera()
  }

  panBy(dx: number, dy: number): void {
    this.follow = null
    this.camT.x += dx / this.camT.z
    this.camT.y += dy / this.camT.z
    this.userCamera()
  }

  private toScreen(x: number, y: number): V2 {
    return { x: (x - this.cam.x) * this.cam.z + this.center.x, y: (y - this.cam.y) * this.cam.z + this.center.y }
  }
  private toWorld(sx: number, sy: number): V2 {
    return { x: (sx - this.center.x) / this.cam.z + this.cam.x, y: (sy - this.center.y) / this.cam.z + this.cam.y }
  }

  /** Screen position of a dot (CSS px), for anchoring DOM overlays. */
  screenPos(id: string): { x: number; y: number; r: number } | null {
    const d = this.dots.get(id)
    if (!d) return null
    return { x: d.sx, y: d.sy, r: d.sr }
  }

  /** The swarm labels' screen boxes (CSS px), as drawLabels draws them: DOM hints stay off them (scene/mapLabels). */
  labelBoxes(): LabelBox[] {
    if (this.drawingHolds.size) return []
    return [...this.cores.values()].filter((c) => this.swarmLabelled(c)).map((c) => swarmLabelBox(c.sx, c.sy, this.cam.z, c.name.toUpperCase(), `${plural(c.motes.length, 'belief')} · ${plural(c.members, 'mind')}`))
  }

  /** Whether a swarm's name is drawn: its galaxy is open and its slot is big enough on screen. */
  private swarmLabelled(c: Core): boolean {
    return c.lod === 2 && c.slot * this.cam.z >= SWARM_LABEL_PX
  }

  /** Screen position of a swarm's core (CSS px) and the radius of its bright centre, for the tour's spotlight. */
  corePos(id: string): { x: number; y: number; r: number } | null {
    const c = this.cores.get(id)
    if (!c) return null
    return { x: c.sx, y: c.sy, r: 58 * Math.pow(this.cam.z, 0.8) * (1 + Math.min(0.4, c.motes.length / 90)) }
  }

  /** Keep a DOM element pinned to a dot; the engine writes its transform every frame. */
  track(el: HTMLElement, id: string | null): void {
    if (id) this.tracked.set(el, id)
    else this.tracked.delete(el)
  }

  // ================================================================== events

  handleEvent(e: HiveEvent): void {
    switch (e.type) {
      case 'belief.published': {
        const a = e.assertion
        const dot = this.dots.get(a.agent_id)
        const core = this.cores.get(e.swarm_id)
        if (!core) return
        const key = `${e.swarm_id}\u0000${a.statement}`
        this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1)
        this.addParticle({
          kind: 'belief',
          from: () => (dot && this.dots.has(dot.id) ? { x: dot.x, y: dot.y } : { x: core.x + 140, y: core.y }),
          to: () => ({ x: core.x, y: core.y }),
          t: 0,
          dur: this.reduced ? 1.6 : 1.15 + Math.random() * 0.35,
          hue: dot?.hue ?? core.hue,
          bend: (Math.random() - 0.5) * 0.9,
          trail: [],
          outcome: a.outcome,
          swarmId: e.swarm_id,
          f: a.tv.f,
          c: a.tv.c,
          key,
        })
        break
      }
      case 'belief.updated': {
        const key = `${e.belief.swarm_id}\u0000${e.belief.statement}`
        if (!this.inFlight.get(key)) this.coreEffect(e.belief.swarm_id, 'revised', undefined, null)
        break
      }
      case 'message': {
        const m = e.message
        const dot = this.dots.get(m.agent_id)
        if (!dot) return
        const peerId = m.sender.startsWith('agent:') ? m.sender.slice(6) : null
        if (m.direction === 'in' && peerId && peerId !== m.agent_id) {
          this.convPeer.set(m.conversation_id, peerId)
          const peer = this.dots.get(peerId)
          if (peer) this.addParticle(this.dotToDot(peer, dot))
        } else if (m.direction === 'out' && this.convPeer.has(m.conversation_id)) {
          const peer = this.dots.get(this.convPeer.get(m.conversation_id)!)
          if (peer) this.addParticle(this.dotToDot(dot, peer))
        } else {
          const edge = () => {
            const p = this.anchor ?? { x: this.w / 2, y: this.h + 30 }
            return this.toWorld(p.x, p.y)
          }
          const at = () => (this.dots.has(dot.id) ? { x: dot.x, y: dot.y } : null)
          this.addParticle({
            kind: 'msg',
            from: m.direction === 'in' ? edge : at,
            to: m.direction === 'in' ? at : edge,
            t: 0,
            dur: 1.25,
            hue: m.direction === 'in' ? 200 : dot.hue,
            bend: (Math.random() - 0.5) * 0.6,
            trail: [],
          })
        }
        break
      }
      case 'agent.updated': {
        const dot = this.dots.get(e.agent.id)
        if (dot && e.agent.status === 'error' && dot.status !== 'error') dot.glitchUntil = this.time + 0.4
        break
      }
      case 'goal.updated': {
        const g = e.goal
        const prev = this.claimSeen.get(g.id) ?? null
        const now = g.status === 'claimed' || g.status === 'waiting' ? g.claimed_by : null
        this.claimSeen.set(g.id, now)
        if (now && now !== prev) {
          // the task leaves the commons and lands on its claimant
          const dot = this.dots.get(now)
          const core = this.cores.get(g.swarm_id)
          if (dot && core) {
            this.addParticle({
              kind: 'task',
              from: () => ({ x: core.x, y: core.y }),
              to: () => (this.dots.has(dot.id) ? { x: dot.x, y: dot.y } : null),
              t: 0,
              dur: this.reduced ? 1.4 : 1.05,
              hue: TASK_HUE,
              bend: (Math.random() - 0.5) * 0.8,
              trail: [],
              target: dot.id,
            })
          }
        } else if ((g.status === 'done' || g.status === 'failed') && (g.claimed_by || prev)) {
          const dot = this.dots.get((g.claimed_by ?? prev)!)
          if (dot) this.dotSpark(dot, g.status === 'done' ? TASK_HUE : 350, g.status === 'done' ? 10 : 5)
        }
        break
      }
      case 'wakeup.fired': {
        const dot = this.dots.get(e.agent_id)
        if (!dot) break
        dot.wake = 1
        this.effects.push({ kind: 'wake', at: this.dotAt(dot), t: 0, dur: this.reduced ? 2 : 1.8, hue: WAKE_HUE, seed: Math.random() })
        break
      }
      case 'approval.created': {
        const dot = this.dots.get(e.approval.agent_id)
        if (dot) this.dotSpark(dot, 38, 6)
        break
      }
      default:
        break
    }
  }

  private dotAt(dot: Dot): () => V2 | null {
    return () => (this.dots.has(dot.id) ? { x: dot.x, y: dot.y } : null)
  }

  private dotSpark(dot: Dot, hue: number, n: number) {
    if (this.reduced) n = Math.min(n, 3)
    this.effects.push({
      kind: 'spark', at: this.dotAt(dot), t: 0, dur: 0.9, hue, seed: Math.random(),
      sparks: Array.from({ length: n }, () => ({ a: Math.random() * TAU, v: 26 + Math.random() * 34, s: 0.4 + Math.random() * 0.6 })),
    })
  }

  private dotToDot(a: Dot, b: Dot): Particle {
    return {
      kind: 'peer',
      from: () => (this.dots.has(a.id) ? { x: a.x, y: a.y } : null),
      to: () => (this.dots.has(b.id) ? { x: b.x, y: b.y } : null),
      t: 0,
      dur: 1.1,
      hue: a.hue,
      bend: 0.45 * (Math.random() > 0.5 ? 1 : -1),
      trail: [],
    }
  }

  private addParticle(p: Particle) {
    if (this.particles.length > (this.reduced ? 24 : 70)) {
      const old = this.particles.shift()
      if (old) this.finishParticle(old)
    }
    this.particles.push(p)
  }

  private finishParticle(p: Particle) {
    if (p.done) return
    p.done = true
    if (p.kind === 'belief' && p.swarmId) {
      if (p.key) {
        const n = (this.inFlight.get(p.key) ?? 1) - 1
        if (n <= 0) this.inFlight.delete(p.key)
        else this.inFlight.set(p.key, n)
      }
      // uifix-r3.4/r3.5: the adopt ring is coloured by how sure (the sureness decision's tone), never by likelihood alone
      this.coreEffect(p.swarmId, p.outcome ?? 'revised', p.hue, p.f !== undefined && p.c !== undefined ? surenessOf({ f: p.f, c: p.c }).tone : null)
    }
    if (p.kind === 'task' && p.target) {
      const dot = this.dots.get(p.target)
      if (dot) this.dotSpark(dot, TASK_HUE, 7)
    }
  }

  /** `tone`: the sureness tone of the belief that caused it (surenessOf), or null; required, so no caller can drop it. */
  private coreEffect(swarmId: string, outcome: AssertionOutcome, hue: number | undefined, tone: number | null) {
    const c = this.cores.get(swarmId)
    if (!c) return
    const at = () => ({ x: c.x, y: c.y })
    const seed = Math.random()
    switch (outcome) {
      case 'revised':
        c.flash = Math.min(1, c.flash + 0.55)
        this.effects.push({ kind: 'ripple', at, t: 0, dur: this.reduced ? 2.2 : 1.6, hue: c.hue, seed })
        break
      case 'chosen':
      case 'kept': {
        c.flash = 1
        c.spinBoost = this.reduced ? 0.6 : 3
        const jag = Array.from({ length: 14 }, () => 0.72 + Math.random() * 0.5)
        this.effects.push({ kind: 'choice', at, t: 0, dur: 1.3, hue: c.hue, seed, jag, rejected: outcome === 'kept' })
        if (outcome === 'kept' && !this.reduced) {
          this.effects.push({
            kind: 'spark', at, t: 0, dur: 0.9, hue: hue ?? 330, seed,
            sparks: Array.from({ length: 7 }, () => ({ a: Math.random() * TAU, v: 90 + Math.random() * 80, s: 0.6 + Math.random() })),
          })
        }
        break
      }
      case 'adopted':
        c.flash = Math.min(1, c.flash + 0.8)
        this.effects.push({
          kind: 'adopt', at, t: 0, dur: 1.4, hue: c.hue, seed, ...(tone !== null ? { tone } : {}),
          sparks: this.reduced ? [] : Array.from({ length: 12 }, () => ({ a: Math.random() * TAU, v: 30 + Math.random() * 60, s: 0.5 + Math.random() })),
        })
        break
      case 'quarantined':
      case 'denied':
        this.effects.push({ kind: 'quarantine', at, t: 0, dur: 1.5, hue: 18, seed })
        break
      case 'duplicate':
        this.effects.push({ kind: 'duplicate', at, t: 0, dur: 0.8, hue: c.hue, seed })
        break
    }
  }

  private spawnBirth(dot: Dot) {
    const core = (dot.swarmId && this.cores.get(dot.swarmId)) || this.wanderCore
    core.flash = 1
    const at = () => ({ x: core.x, y: core.y })
    this.effects.push({
      kind: 'birth', at, t: 0, dur: 2.2, hue: dot.hue, seed: Math.random(),
      sparks: this.reduced ? [] : Array.from({ length: 22 }, () => ({ a: Math.random() * TAU, v: 60 + Math.random() * 140, s: 0.5 + Math.random() * 1.2 })),
    })
  }

  // ================================================================== input

  private bindInput() {
    const c = this.canvas
    c.addEventListener('pointerdown', this.onDown)
    c.addEventListener('pointermove', this.onMove)
    c.addEventListener('pointerup', this.onUp)
    c.addEventListener('pointercancel', this.onCancel)
    c.addEventListener('pointerleave', this.onLeave)
    c.addEventListener('wheel', this.onWheel, { passive: false })
  }
  private unbindInput() {
    const c = this.canvas
    c.removeEventListener('pointerdown', this.onDown)
    c.removeEventListener('pointermove', this.onMove)
    c.removeEventListener('pointerup', this.onUp)
    c.removeEventListener('pointercancel', this.onCancel)
    c.removeEventListener('pointerleave', this.onLeave)
    c.removeEventListener('wheel', this.onWheel)
  }

  private local(e: PointerEvent | WheelEvent): V2 {
    const r = this.canvas.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  private onDown = (e: PointerEvent) => {
    const p = this.local(e)
    this.canvas.setPointerCapture?.(e.pointerId)
    // Pick at pointerdown, against the dots as last drawn: a drifting dot (or a camera still flying) may be elsewhere by
    // pointerup, and the person aimed at where they saw it.
    const hit = this.pointers.size === 0 ? this.hitTest(p.x, p.y, hitSlop(e.pointerType), performance.now() - PRESS_RECENT_MS) : null
    this.pointers.set(e.pointerId, { x: p.x, y: p.y, sx: p.x, sy: p.y, t: performance.now(), type: e.pointerType, hit })
    this.vel = { x: 0, y: 0 }
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()]
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), z: this.camT.z, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
      this.dragging = true
    }
  }

  private onMove = (e: PointerEvent) => {
    const p = this.local(e)
    const ptr = this.pointers.get(e.pointerId)
    if (!ptr) {
      if (e.pointerType === 'mouse') this.updateHover(p.x, p.y)
      return
    }
    const dx = p.x - ptr.x
    const dy = p.y - ptr.y
    ptr.x = p.x
    ptr.y = p.y
    if (this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()]
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const mx = (a.x + b.x) / 2
      const my = (a.y + b.y) / 2
      const before = this.toWorld(mx, my)
      const z = clamp((this.pinch.z * d) / Math.max(1, this.pinch.d), this.minZoom(), 4)
      this.cam.z = this.camT.z = z
      const after = this.toWorld(mx, my)
      this.cam.x = this.camT.x += before.x - after.x
      this.cam.y = this.camT.y += before.y - after.y
      this.cam.x = this.camT.x -= (mx - this.pinch.mx) / z
      this.cam.y = this.camT.y -= (my - this.pinch.my) / z
      this.pinch.mx = mx
      this.pinch.my = my
      this.follow = null
      this.userCamera()
      return
    }
    if (!this.dragging && Math.hypot(p.x - ptr.sx, p.y - ptr.sy) > 6) {
      this.dragging = true
      this.follow = null
      this.userCamera()
    }
    if (this.dragging) {
      this.cam.x = this.camT.x -= dx / this.cam.z
      this.cam.y = this.camT.y -= dy / this.cam.z
      this.vel = { x: (dx / this.cam.z) * 60 * 0.5 + this.vel.x * 0.5, y: (dy / this.cam.z) * 60 * 0.5 + this.vel.y * 0.5 }
    }
  }

  private onUp = (e: PointerEvent) => {
    const ptr = this.pointers.get(e.pointerId)
    this.pointers.delete(e.pointerId)
    if (this.pointers.size < 2) this.pinch = null
    if (!ptr) return
    const tap = !this.dragging && performance.now() - ptr.t < 600
    if (this.pointers.size === 0) {
      if (tap) {
        // what was picked at pointerdown, null included: an empty press stays empty, so a dot that drifts under the
        // pointer before release is never selected (followups r4)
        this.cb.onTap(ptr.hit, e.pointerType)
      }
      this.dragging = false
    }
  }

  private onCancel = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId)
    if (this.pointers.size < 2) this.pinch = null
    if (this.pointers.size === 0) this.dragging = false
  }

  private onLeave = (e: PointerEvent) => {
    if (e.pointerType === 'mouse' && !this.pointers.size) this.setHover(null)
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    const p = this.local(e)
    const before = this.toWorld(p.x, p.y)
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))
    const z = clamp(this.cam.z * f, this.minZoom(), 4)
    this.cam.z = this.camT.z = z
    const after = this.toWorld(p.x, p.y)
    this.cam.x = this.camT.x += before.x - after.x
    this.cam.y = this.camT.y += before.y - after.y
    this.follow = null
    this.userCamera()
  }

  private updateHover(x: number, y: number) {
    this.setHover(this.hitTest(x, y, HIT_SLOP_MOUSE))
  }

  private setHover(t: HitTarget | null) {
    const same = t?.kind === this.hoverTarget?.kind && t?.id === this.hoverTarget?.id
    if (same) return
    this.hoverTarget = t
    this.canvas.style.cursor = t ? 'pointer' : 'grab'
    this.cb.onHover(t)
  }

  /** `since` (a performance.now() time): also count where each dot was drawn since then (a press, PRESS_RECENT_MS). */
  hitTest(x: number, y: number, slop: number, since?: number): HitTarget | null {
    let best: HitTarget | null = null
    let bestD = Infinity
    for (const d of this.dots.values()) {
      if (d.dying) continue
      let dist = Math.hypot(d.sx - x, d.sy - y)
      if (since !== undefined) {
        for (let k = 0; k < d.trail.length; k += 3) if (d.trail[k] && d.trail[k] >= since) dist = Math.min(dist, Math.hypot(d.trail[k + 1] - x, d.trail[k + 2] - y))
      }
      const r = Math.max(slop, d.sr * 1.6)
      if (dist < r && dist < bestD) {
        best = d.group ? { kind: 'group', id: d.id } : { kind: 'dot', id: d.id }
        bestD = dist
      }
    }
    if (best) return best
    for (const c of this.cores.values()) {
      const dist = Math.hypot(c.sx - x, c.sy - y)
      if (dist < Math.max(26, 34 * this.cam.z)) return { kind: 'core', id: c.id }
    }
    return null
  }

  // ================================================================== frame

  private frame = (now: number) => {
    if (!this.running) return
    this.raf = requestAnimationFrame(this.frame)
    // A busy compositor can dispatch a queued timestamp older than resume's
    // performance.now(). Never rewind animation ages or the frame accumulator.
    const stamp = Math.max(now, this.last)
    let dt = (stamp - this.last) / 1000
    if (this.fpsCap) {
      this.frameAcc += dt
      this.last = stamp
      if (this.frameAcc < 1 / this.fpsCap) return
      dt = this.frameAcc
      this.frameAcc = 0
    } else {
      this.last = stamp
    }
    dt = Math.min(dt, 0.1)
    this.time += dt
    // expose measured fps for perf checks (read by tests and the README numbers)
    this.fpsFrames++
    if (now - this.fpsAt > 1000) {
      this.canvas.dataset.fps = String(Math.round((this.fpsFrames * 1000) / (now - this.fpsAt)))
      this.canvas.dataset.dpr = String(this.dpr)
      this.canvas.dataset.particles = String(this.particles.length)
      this.fpsFrames = 0
      this.fpsAt = now
    }
    this.adapt(dt)
    this.update(dt)
    this.render()
  }

  /** Adaptive resolution: if frames are consistently slow (judged over ~1s), render fewer pixels. */
  private adapt(dt: number) {
    if (this.fpsCap) return
    this.perf.push(dt)
    const now = performance.now()
    if (!this.perfAt) this.perfAt = now
    if (now - this.perfAt < 1200 || this.perf.length < 8) return
    const sorted = [...this.perf].sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)]
    this.perf.length = 0
    this.perfAt = now
    if (median > 0.021 && this.maxDpr > 1) {
      this.maxDpr = Math.max(1, Math.round((this.maxDpr - 0.25) * 4) / 4)
      this.resize()
    }
  }

  private update(dt: number) {
    const drawnAt = performance.now()
    const t = this.time
    // camera
    if (this.follow) {
      const d = this.dots.get(this.follow)
      if (d) {
        this.camT.x = d.x
        this.camT.y = d.y
      }
    }
    if (!this.dragging && !this.pinch && (Math.abs(this.vel.x) > 0.5 || Math.abs(this.vel.y) > 0.5)) {
      this.camT.x -= this.vel.x * dt
      this.camT.y -= this.vel.y * dt
      this.cam.x = this.camT.x
      this.cam.y = this.camT.y
      this.vel.x *= Math.exp(-4 * dt)
      this.vel.y *= Math.exp(-4 * dt)
    }
    const k = this.reduced ? 6 : this.camK
    if (!this.dragging) {
      this.cam.x = damp(this.cam.x, this.camT.x, k, dt)
      this.cam.y = damp(this.cam.y, this.camT.y, k, dt)
      this.cam.z = Math.exp(damp(Math.log(this.cam.z), Math.log(this.camT.z), k, dt))
    }
    this.center.x = damp(this.center.x, this.centerT.x, 5, dt)
    this.center.y = damp(this.center.y, this.centerT.y, 5, dt)

    // galaxies: where each is on screen, and whether it opens (shows its swarms) or is one point of light
    const zNow = this.cam.z
    const many = this.galaxies.length > 1
    const open = new Map<string, boolean>()
    for (const g of this.galaxies) {
      const s = this.toScreen(g.x, g.y)
      g.sx = s.x
      g.sy = s.y
      g.sr = g.r * zNow
      const m = g.sr + 60
      g.visible = g.sx > -m && g.sy > -m && g.sx < this.w + m && g.sy < this.h + m
      g.open = g.visible && (!many || g.sr >= GALAXY_POINT_PX)
      open.set(g.id, g.open)
    }

    // cores
    for (const c of [...this.cores.values(), this.wanderCore]) {
      c.x = damp(c.x, c.tx, 2, dt)
      c.y = damp(c.y, c.ty, 2, dt)
      c.flash = Math.max(0, c.flash - dt * 1.2)
      c.spinBoost = Math.max(0, c.spinBoost - dt * 2.2)
      c.spin += dt * (0.08 + c.spinBoost)
      for (const m of c.motes) m.a += dt * m.w * (this.reduced ? 0.3 : 1)
      const s = this.toScreen(c.x, c.y)
      c.sx = s.x
      c.sy = s.y
      const hovered = this.hoverTarget?.kind === 'core' && this.hoverTarget.id === c.id
      c.hover = damp(c.hover, hovered ? 1 : 0, 10, dt)
      // level of detail: nothing inside a galaxy that is a point or off screen; a far swarm is one point of light
      c.lod = open.get(c.hive) === false ? 0 : c.slot * zNow < SWARM_POINT_PX ? 1 : 2
      if (c.lod === 0 && c !== this.wanderCore) {
        // not drawn, not hit: a tap on the galaxy's point flies into it instead (galaxyHandleAt)
        c.sx = -1e5
        c.sy = -1e5
      }
    }

    // dots
    const motion = this.reduced ? 0.35 : 1
    for (const [id, d] of this.dots) {
      const core = (d.swarmId && this.cores.get(d.swarmId)) || this.wanderCore
      const spd = d.group ? GROUP_SPEED : STATUS_SPEED[d.status]
      d.speed = damp(d.speed, spd, 1.5, dt)
      d.angle += dt * d.speed * (26 / d.orbitR) * 0.55 * motion
      d.glow = damp(d.glow, d.group ? GROUP_GLOW : STATUS_GLOW[d.status], 2.2, dt)
      d.size = damp(d.size, d.group ? GROUP_SIZE : STATUS_SIZE[d.status], 3, dt)
      d.ring = damp(d.ring, d.thinking && d.thinking !== 'idle' ? 1 : 0, 5, dt)
      d.errorMix = damp(d.errorMix, d.status === 'error' ? 1 : 0, 4, dt)
      d.taskVis = damp(d.taskVis, Math.min(3, d.tasks), 3, dt)
      d.askVis = damp(d.askVis, d.asking, 4, dt)
      d.wake = Math.max(0, d.wake - dt * 0.55)
      const hovered = ((this.hoverTarget?.kind === 'dot' || this.hoverTarget?.kind === 'group') && this.hoverTarget.id === id) || this.selected === id
      d.hover = damp(d.hover, hovered ? 1 : 0, 10, dt)
      if (d.birth < 1) d.birth = Math.min(1, d.birth + dt / (this.reduced ? 1.2 : 2.4))
      if (d.dying > 0) {
        d.dying += dt / 0.9
        if (d.dying >= 1) {
          this.dots.delete(id)
          continue
        }
      }
      // culled: its swarm is a point of light, or its galaxy is a point or off screen. No orbit maths, not drawn, not hit.
      if (core.lod < 2) {
        d.culled = true
        d.x = core.x
        d.y = core.y
        d.sx = -1e5
        d.sy = -1e5
        d.sr = 0
        continue
      }
      d.culled = false
      // asleep dots drift: the orbit loosens and wobbles
      const loose = d.status === 'asleep' || d.status === 'stopped' ? 1.12 : 1
      const r = d.orbitR * loose + Math.sin(t * 0.3 + d.wobble) * 4 * motion
      const ca = Math.cos(d.angle)
      const sa = Math.sin(d.angle)
      let lx = ca * r
      let ly = sa * r * Math.cos(d.tilt)
      const lz = sa * Math.sin(d.tilt)
      const cn = Math.cos(d.node)
      const sn = Math.sin(d.node)
      const rx = lx * cn - ly * sn
      const ry = lx * sn + ly * cn
      lx = rx
      ly = ry
      let wx = core.x + lx
      let wy = core.y + ly
      if (d.birth < 1) {
        const e = easeOutBack(d.birth)
        wx = lerp(core.x, wx, e)
        wy = lerp(core.y, wy, e)
      }
      // error glitch: brief horizontal tears
      if (d.status === 'error' && !this.reduced) {
        if (t > d.glitchUntil && Math.random() < dt * 2.5) {
          d.glitchUntil = t + 0.06 + Math.random() * 0.1
          d.glitchX = (Math.random() - 0.5) * 10
        }
      }
      d.x = wx
      d.y = wy
      d.z = lz
      const s = this.toScreen(wx, wy)
      d.sx = s.x
      d.sy = s.y
      const depth = 1 + d.z * 0.22
      // linear in zoom when zoomed out (glows shrink with the spacing, so they never sum across a far view), gentler in
      d.sr = Math.max(0.8, 4.6 * Math.min(this.cam.z, Math.pow(this.cam.z, 0.6)) * depth * d.size)
      const k = (d.trailAt++ % TRAIL_FRAMES) * 3
      d.trail[k] = drawnAt
      d.trail[k + 1] = d.sx
      d.trail[k + 2] = d.sy
    }

    // particles
    for (const p of this.particles) {
      p.t += dt / p.dur
      if (p.t >= 1) this.finishParticle(p)
    }
    this.particles = this.particles.filter((p) => !p.done)

    // effects
    for (const e of this.effects) e.t += dt / e.dur
    this.effects = this.effects.filter((e) => e.t < 1)

    // dust
    for (const m of this.dust) {
      m.x += m.vx * dt
      m.y += m.vy * dt
    }

    // DOM trackers
    for (const [el, id] of this.tracked) {
      const d = this.dots.get(id)
      if (d) el.style.transform = `translate3d(${Math.round(d.sx)}px, ${Math.round(d.sy)}px, 0)`
    }
  }

  private seedDust() {
    const n = this.reduced ? 18 : Math.round(Math.min(90, (this.w * this.h) / 14000))
    this.dust = Array.from({ length: n }, () => ({
      x: Math.random() * 2000,
      y: Math.random() * 2000,
      z: 0.2 + Math.random() * 0.8,
      vx: (Math.random() - 0.5) * (this.reduced ? 2 : 8),
      vy: (Math.random() - 0.5) * (this.reduced ? 2 : 8) - 2,
      a: 0.15 + Math.random() * 0.4,
    }))
  }

  // ================================================================== render

  private render() {
    const ctx = this.ctx
    const { w, h } = this
    const t = this.time
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1

    // ---- deep space backdrop (cached at half resolution, redrawn only when the camera moves)
    this.drawBackdrop()
    this.drawStars(ctx, this.stars.nearPat, 640, 0.1, 0.8)

    ctx.globalCompositeOperation = 'lighter'
    // twinkles
    for (const s of this.twinkles) {
      const x = (((s.x * w - this.cam.x * 0.06) % w) + w) % w
      const y = (((s.y * h - this.cam.y * 0.06) % h) + h) % h
      const a = this.reduced ? 0.4 : 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * s.s + s.p))
      ctx.globalAlpha = a
      ctx.drawImage(glowSprite(225, 60), x - 5, y - 5, 10, 10)
    }


    // ---- dust (screen space with parallax)
    for (const m of this.dust) {
      const x = (((m.x - this.cam.x * m.z * 0.35) % w) + w) % w
      const y = (((m.y - this.cam.y * m.z * 0.35) % h) + h) % h
      ctx.globalAlpha = m.a * (this.dimmed ? 0.5 : 1)
      const r = 1.5 + m.z * 3
      ctx.drawImage(glowSprite(240, 50, false), x - r, y - r, r * 2, r * 2)
    }

    // ---- the universe: links to the cloud hive, galaxy outlines and far galaxies' points, the placeholders' cluster
    this.drawGalaxies()

    // ---- tethers
    ctx.lineWidth = 1
    for (const d of this.dots.values()) {
      const core = (d.swarmId && this.cores.get(d.swarmId)) || null
      if (!core || d.glow < 0.4 || d.culled) continue
      const a = 0.05 + 0.1 * d.hover + (d.ring > 0.1 ? 0.05 * d.ring : 0)
      ctx.globalAlpha = a * (d.birth < 1 ? d.birth : 1) * (1 - d.dying)
      ctx.strokeStyle = `hsl(${d.hue} 90% 70%)`
      ctx.beginPath()
      ctx.moveTo(core.sx, core.sy)
      ctx.lineTo(d.sx, d.sy)
      ctx.stroke()
    }

    // ---- dots behind cores
    const sorted = [...this.dots.values()].filter((d) => !d.culled).sort((a, b) => a.z - b.z)
    for (const d of sorted) if (d.z < 0) this.drawDot(d)
    for (const c of this.cores.values()) if (c.lod > 0) this.drawCore(c)
    if (this.wanderCore.members > 0 && this.wanderCore.lod > 0) this.drawWanderHub()
    for (const d of sorted) if (d.z >= 0) this.drawDot(d)

    // ---- particles & effects
    for (const p of this.particles) this.drawParticle(p)
    for (const e of this.effects) this.drawEffect(e)

    // ---- labels
    ctx.globalCompositeOperation = 'source-over'
    if (this.drawingHolds.size) this.galaxyLabelRects = []
    else this.drawLabels(sorted)

    ctx.globalAlpha = 1
    if (this.dimmed) {
      ctx.fillStyle = 'rgba(3,3,14,0.45)'
      ctx.fillRect(0, 0, w, h)
    }
  }

  private drawBackdrop() {
    const { w, h } = this
    const bg = this.bg
    const scale = 0.5
    const key = bg
      ? // bounded by the galaxies (not every swarm): one entry per galaxy
        [backdrop.join(''), Math.round(this.cam.x * 2), Math.round(this.cam.y * 2), Math.round(this.cam.z * 400), Math.round(this.center.x), Math.round(this.center.y), w, h, this.galaxies.length]
          .concat(this.galaxies.map((g) => Math.round(g.x) + Math.round(g.y) * 7 + g.hue))
          .join(',')
      : ''
    if (bg && bg.key === key) {
      this.ctx.drawImage(bg.canvas, 0, 0, w, h)
      return
    }
    let ctx: CanvasRenderingContext2D = this.ctx
    if (bg) {
      const cw = Math.max(1, Math.round(w * scale))
      const ch = Math.max(1, Math.round(h * scale))
      if (bg.canvas.width !== cw || bg.canvas.height !== ch) {
        bg.canvas.width = cw
        bg.canvas.height = ch
      }
      ctx = bg.ctx
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
    }
    const z = this.cam.z
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    const grad = ctx.createLinearGradient(0, 0, 0, h)
    grad.addColorStop(0, backdrop[0])
    grad.addColorStop(0.55, backdrop[1])
    grad.addColorStop(1, backdrop[2])
    ctx.fillStyle = grad
    ctx.fillRect(0, 0, w, h)
    this.drawStars(ctx, bg ? bg.farPat : this.stars.farPat, 512, 0.04, 0.9)
    // One nebula per galaxy, laid over, not added: added, 30+ swarms' glows sum past white and the map blows out. Its
    // size follows the galaxy, so each galaxy's glow is its own and bounded.
    ctx.globalCompositeOperation = 'source-over'
    // (a single galaxy keeps the old gentle parallax; in a universe each nebula sits on its own galaxy)
    const many = this.galaxies.length > 1
    const par = many ? 1 : 0.85
    for (const g of this.galaxies) {
      const s = this.toScreen(g.x * par + this.cam.x * (1 - par), g.y * par + this.cam.y * (1 - par))
      const R = many ? g.r * z * 1.6 : Math.max(g.r * z * 1.6, 620 * Math.pow(z, 0.75))
      if (s.x + R < 0 || s.y + R < 0 || s.x - R > w || s.y - R > h) continue
      ctx.globalAlpha = 0.85
      ctx.drawImage(nebulaSprite(g.hue), s.x - R, s.y - R * 0.8, R * 2, R * 1.6)
      ctx.globalAlpha = 0.5
      const R2 = R * 0.6
      ctx.drawImage(nebulaSprite(g.hue + 40), s.x - R2 + R * 0.25, s.y - R2 * 0.9 - R * 0.12, R2 * 2, R2 * 1.8)
    }
    ctx.globalCompositeOperation = 'source-over'
    ctx.globalAlpha = 1
    const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.78)
    vg.addColorStop(0, 'rgba(2,2,10,0)')
    vg.addColorStop(1, 'rgba(2,2,10,0.72)')
    ctx.fillStyle = vg
    ctx.fillRect(0, 0, w, h)
    if (bg) {
      bg.key = key
      this.ctx.drawImage(bg.canvas, 0, 0, w, h)
    }
  }

  private drawStars(ctx: CanvasRenderingContext2D, pat: CanvasPattern | null, size: number, parallax: number, alpha: number) {
    if (!pat) return
    const ox = -((this.cam.x * parallax) % size)
    const oy = -((this.cam.y * parallax) % size)
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.translate(ox, oy)
    ctx.fillStyle = pat
    ctx.fillRect(-ox - size, -oy - size, this.w + size * 2, this.h + size * 2)
    ctx.restore()
  }

  private drawCore(c: Core) {
    const ctx = this.ctx
    const z = this.cam.z
    const t = this.time
    const zs = Math.pow(z, 0.8)
    const breathe = this.reduced ? 1 : 1 + 0.04 * Math.sin(t * 0.9 + c.spin)
    const scale = (1 + Math.min(0.4, c.motes.length / 90)) * breathe
    const { sx, sy } = c
    if (sx < -400 || sy < -400 || sx > this.w + 400 || sy > this.h + 400) return

    // halo, capped at 1.1 × the swarm's packing slot, so neighbours' halos barely meet
    const slot = c.slot * z
    let R = Math.min(170 * zs * scale * (1 + c.flash * 0.15 + c.hover * 0.08), slot * 1.1)
    ctx.globalAlpha = 0.55 + c.flash * 0.3
    // the wide halo is laid over (many swarms' halos added together clip to white); the hot core, nucleus and dots
    // after it stay additive, so they keep their sparkle
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(glowSprite(c.hue, 95, false), sx - R, sy - R, R * 2, R * 2)
    ctx.globalCompositeOperation = 'lighter'
    if (c.lod === 1) {
      // level of detail: a far swarm is one point of light, no orbits, motes or minds
      R = Math.max(1.5, Math.min(58 * zs * scale, slot * 0.45))
      ctx.globalAlpha = 0.9
      ctx.drawImage(glowSprite(c.hue, 100), sx - R, sy - R, R * 2, R * 2)
      return
    }
    R = Math.min(58 * zs * scale, slot * 0.5)
    ctx.globalAlpha = 0.9
    ctx.drawImage(glowSprite(c.hue, 100), sx - R, sy - R, R * 2, R * 2)

    // orbit rings (tilted ellipses)
    ctx.lineWidth = 1
    for (let i = 0; i < 3; i++) {
      const rr = (30 + i * 15) * zs * scale
      ctx.globalAlpha = 0.16 + c.flash * 0.2 + c.hover * 0.15 - i * 0.03
      ctx.strokeStyle = `hsl(${c.hue + i * 18} 90% 75%)`
      ctx.beginPath()
      ctx.ellipse(sx, sy, rr, rr * (0.32 + i * 0.08), c.spin * (i % 2 ? -1 : 1) + i * 0.9, 0, TAU)
      ctx.stroke()
    }

    // belief motes orbiting inside the core
    for (const m of c.motes) {
      const age = this.time - m.born
      const appear = age < 1.2 ? easeOut(Math.max(0, age) / 1.2) : 1
      const x = Math.cos(m.a) * m.r
      const y = Math.sin(m.a) * m.r * Math.cos(m.incl)
      const mx = sx + x * zs * scale
      const my = sy + y * zs * scale
      // uifix-r3.4 (Kimi 3): colour is how sure (NAL expectation), alpha and size are how much evidence
      const [r, g, b] = surenessRgb({ f: m.f, c: m.c })
      ctx.globalAlpha = (0.35 + m.c * 0.65) * appear
      ctx.fillStyle = `rgb(${r},${g},${b})`
      const ms = (0.9 + m.c * 1.4) * Math.max(0.7, zs) * (age < 1.2 ? 1 + (1 - appear) * 3 : 1)
      ctx.beginPath()
      ctx.arc(mx, my, ms, 0, TAU)
      ctx.fill()
    }

    // nucleus
    R = (12 + c.flash * 10) * zs * scale
    ctx.globalAlpha = 1
    ctx.drawImage(glowSprite(c.hue, 60), sx - R, sy - R, R * 2, R * 2)
  }

  /**
   * The universe layer (only when the map shows more than one galaxy, or placeholders): a faint dashed link from the
   * cloud hive to each person's hive, each galaxy's outline, a far galaxy's single point of light, and the authorised
   * placeholders as fixed-size, inert "Private" nodes in their own cluster. All laid over ('source-over'): bounded.
   */
  private drawGalaxies() {
    const ctx = this.ctx
    const many = this.galaxies.length > 1
    const pc = this.privateCluster
    if (!many && !pc) return
    const z = this.cam.z
    ctx.globalCompositeOperation = 'source-over'
    ctx.lineWidth = 1
    if (many) {
      const cloud = this.galaxies.find((g) => g.cloud)
      if (cloud) {
        ctx.strokeStyle = 'rgb(150,170,255)'
        ctx.setLineDash([3, 5])
        for (const g of this.galaxies) {
          if (g.cloud || (!g.visible && !cloud.visible)) continue
          // from outline to outline, so the line never crosses a galaxy's own swarms
          const dx = g.x - cloud.x
          const dy = g.y - cloud.y
          const len = Math.hypot(dx, dy) || 1
          if (len <= cloud.r + g.r) continue
          ctx.globalAlpha = 0.16
          ctx.beginPath()
          ctx.moveTo(cloud.sx + (dx / len) * cloud.sr, cloud.sy + (dy / len) * cloud.sr)
          ctx.lineTo(g.sx - (dx / len) * g.sr, g.sy - (dy / len) * g.sr)
          ctx.stroke()
        }
        ctx.setLineDash([])
      }
      for (const g of this.galaxies) {
        if (!g.visible) continue
        if (g.open) {
          ctx.globalAlpha = g.cloud ? 0.32 : 0.2
          ctx.strokeStyle = g.cloud ? 'rgb(190,180,255)' : `hsl(${g.hue} 45% 78%)`
          ctx.beginPath()
          ctx.arc(g.sx, g.sy, g.sr, 0, TAU)
          ctx.stroke()
        } else {
          // a far galaxy: one point of light, sized by the galaxy, bounded by it
          const R = Math.max(3, Math.min(g.sr * 1.4, 26))
          ctx.globalAlpha = 0.5
          ctx.drawImage(glowSprite(g.hue, 95, false), g.sx - R * 2, g.sy - R * 2, R * 4, R * 4)
          ctx.globalAlpha = 0.95
          const C = Math.max(1.5, R * 0.45)
          ctx.drawImage(glowSprite(g.hue, 100), g.sx - C, g.sy - C, C * 2, C * 2)
        }
      }
    }
    // culled like a galaxy: nothing of the cluster is drawn while it is off screen
    const pcs = pc ? this.toScreen(pc.x, pc.y) : null
    const pcm = pc ? pc.r * z + 60 : 0
    if (pc && pcs && pcs.x > -pcm && pcs.y > -pcm && pcs.x < this.w + pcm && pcs.y < this.h + pcm) {
      const s = pcs
      ctx.globalAlpha = 0.18
      ctx.strokeStyle = 'rgb(170,172,200)'
      ctx.setLineDash([2, 4])
      ctx.beginPath()
      ctx.arc(s.x, s.y, pc.r * z, 0, TAU)
      ctx.stroke()
      ctx.setLineDash([])
      // fixed size, no status, no motion, no glow from membership: inert
      const r = Math.max(2, PLACEHOLDER_R * z)
      for (const p of pc.slots) {
        const q = this.toScreen(p.x, p.y)
        ctx.globalAlpha = 0.1
        ctx.fillStyle = 'rgb(180,182,210)'
        ctx.beginPath()
        ctx.arc(q.x, q.y, r, 0, TAU)
        ctx.fill()
        ctx.globalAlpha = 0.32
        ctx.beginPath()
        ctx.arc(q.x, q.y, r, 0, TAU)
        ctx.stroke()
      }
    }
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'lighter'
  }

  private drawWanderHub() {
    const ctx = this.ctx
    const s = this.toScreen(this.wanderCore.x, this.wanderCore.y)
    const R = 26 * Math.pow(this.cam.z, 0.8)
    ctx.globalAlpha = 0.25
    ctx.drawImage(glowSprite(this.wanderCore.hue, 40, false), s.x - R, s.y - R, R * 2, R * 2)
  }

  private drawDot(d: Dot) {
    const ctx = this.ctx
    const t = this.time
    const { sx, sy } = d
    if (sx < -60 || sy < -60 || sx > this.w + 60 || sy > this.h + 60) return
    const fade = (d.birth < 1 ? Math.min(1, d.birth * 3) : 1) * (1 - d.dying)
    const depthA = 0.72 + 0.28 * (d.z + 1) * 0.5
    let breathe = 1
    let alpha = d.glow * depthA * fade
    if (d.status === 'awake') breathe = 1 + (this.reduced ? 0.04 : 0.17) * Math.sin(t * 1.9 + d.phase)
    if (d.status === 'starting' || d.status === 'created') alpha *= 0.65 + 0.35 * Math.sin(t * (this.reduced ? 2 : 9) + d.phase)
    const r = d.sr * breathe * (1 + d.hover * 0.25) * (d.birth < 1 ? 0.4 + 0.6 * easeOutBack(d.birth) : 1)
    const hue = d.errorMix > 0.5 ? 0 : d.hue
    const gx = t < d.glitchUntil ? d.glitchX : 0

    // outer glow
    const G = r * (d.status === 'asleep' || d.status === 'stopped' ? 5 : 7.5) * (1 + d.hover * 0.3)
    ctx.globalAlpha = alpha * (0.75 + d.hover * 0.25)
    ctx.drawImage(glowSprite(hue, d.status === 'asleep' ? 55 : d.status === 'stopped' ? 15 : 100), sx - G + gx, sy - G, G * 2, G * 2)

    // error: chromatic split + scanline tears
    if (d.errorMix > 0.05) {
      const e = d.errorMix
      const split = this.reduced ? 1.5 : 2.5 + (t < d.glitchUntil ? 4 : 0)
      ctx.globalAlpha = 0.6 * e * fade
      ctx.drawImage(glowSprite(355, 100), sx - G * 0.5 - split + gx, sy - G * 0.5, G, G)
      ctx.drawImage(glowSprite(185, 100), sx - G * 0.5 + split + gx, sy - G * 0.5, G, G)
      if (!this.reduced && t < d.glitchUntil) {
        ctx.fillStyle = 'rgba(255,70,90,0.8)'
        for (let i = 0; i < 3; i++) {
          const yy = sy + (Math.random() - 0.5) * r * 6
          ctx.fillRect(sx - r * 4 + gx * 2, yy, r * 8 * Math.random(), 1)
        }
      }
    }

    // a folded helper group: a faint, still ring around a small dim core (no breath, no motion of its own)
    if (d.group) {
      ctx.globalAlpha = (0.32 + d.hover * 0.4) * fade
      ctx.strokeStyle = `hsl(${d.hue} 30% 74%)`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(sx, sy, r * 2.6 + 3, 0, TAU)
      ctx.stroke()
    }

    // stopped dots show as a hollow ring
    if (d.status === 'stopped') {
      ctx.globalAlpha = 0.4 * fade
      ctx.strokeStyle = `hsl(${d.hue} 25% 70%)`
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(sx, sy, r * 1.6, 0, TAU)
      ctx.stroke()
    }

    // hot core
    const C = r * 2.2
    ctx.globalAlpha = Math.min(1, alpha * 1.15)
    ctx.drawImage(glowSprite(hue, 100), sx - C + gx, sy - C, C * 2, C * 2)

    // thinking ring
    if (d.ring > 0.02) {
      const skills = d.thinking === 'skills'
      const ringHue = skills ? (d.hue + 55) % 360 : d.hue
      const rr = r * 3.3 + 3
      const spin = t * (skills ? 4.2 : 2.4) * (this.reduced ? 0.25 : 1)
      ctx.globalAlpha = 0.85 * d.ring * fade
      ctx.strokeStyle = `hsl(${ringHue} 100% 78%)`
      ctx.lineWidth = 1.4
      ctx.lineCap = 'round'
      const segs = skills ? 4 : 2
      for (let i = 0; i < segs; i++) {
        const a0 = spin + (i * TAU) / segs
        ctx.beginPath()
        ctx.ellipse(sx, sy, rr, rr * 0.42, -0.35, a0, a0 + (skills ? 0.7 : 1.5))
        ctx.stroke()
      }
      // satellite spark
      const sa = spin * 1.3
      const px = sx + Math.cos(sa) * rr * Math.cos(-0.35) - Math.sin(sa) * rr * 0.42 * Math.sin(-0.35)
      const py = sy + Math.cos(sa) * rr * Math.sin(-0.35) + Math.sin(sa) * rr * 0.42 * Math.cos(-0.35)
      const S = 6 + r
      ctx.globalAlpha = d.ring * fade
      ctx.drawImage(glowSprite(ringHue, 100), px - S / 2, py - S / 2, S, S)
      // shimmer
      if (!this.reduced) {
        ctx.globalAlpha = 0.25 * d.ring * (0.5 + 0.5 * Math.sin(t * 12 + d.phase)) * fade
        const SH = G * 1.1
        ctx.drawImage(glowSprite(ringHue, 100, false), sx - SH, sy - SH, SH * 2, SH * 2)
      }
    }

    // scheduled wake: a warm sunrise bloom that fades
    if (d.wake > 0.01) {
      const W = G * (1.1 + (1 - d.wake) * 0.9)
      ctx.globalAlpha = d.wake * 0.55 * fade
      ctx.drawImage(glowSprite(WAKE_HUE, 100, false), sx - W, sy - W, W * 2, W * 2)
    }

    // waiting on a human: a dashed amber halo that breathes
    if (d.askVis > 0.02) {
      const rr = r * 5 + 8
      const pulse = this.reduced ? 0.7 : 0.55 + 0.45 * Math.sin(t * 3.2 + d.phase)
      ctx.globalAlpha = d.askVis * pulse * 0.75 * fade
      ctx.strokeStyle = 'hsl(40 100% 66%)'
      ctx.lineWidth = 1.3
      ctx.setLineDash([2.5, 4])
      ctx.lineDashOffset = -t * (this.reduced ? 2 : 9)
      ctx.beginPath()
      ctx.arc(sx, sy, rr, 0, TAU)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.lineDashOffset = 0
    }

    // claimed goals: little gold diamonds on a slow, flatter orbit of their own
    if (d.taskVis > 0.02) {
      const n = Math.ceil(d.taskVis - 0.001)
      const rr = r * 4.3 + 9
      const tilt = 0.55
      const spin = t * (this.reduced ? 0.25 : 0.85) + d.phase
      for (let i = 0; i < n; i++) {
        const vis = clamp(d.taskVis - i, 0, 1)
        const a = spin + (i * TAU) / Math.max(n, 1)
        const ex = Math.cos(a) * rr
        const ey = Math.sin(a) * rr * 0.36
        const px = sx + ex * Math.cos(tilt) - ey * Math.sin(tilt)
        const py = sy + ex * Math.sin(tilt) + ey * Math.cos(tilt)
        const behind = Math.sin(a) < 0
        const k = vis * fade * (behind ? 0.45 : 1)
        const S = 11 + r * 0.8
        ctx.globalAlpha = k * 0.85
        ctx.drawImage(glowSprite(TASK_HUE, 100), px - S, py - S, S * 2, S * 2)
        const q = 3.1 + r * 0.24
        ctx.globalAlpha = k
        ctx.fillStyle = 'hsl(46 100% 88%)'
        ctx.beginPath()
        ctx.moveTo(px, py - q)
        ctx.lineTo(px + q * 0.8, py)
        ctx.lineTo(px, py + q)
        ctx.lineTo(px - q * 0.8, py)
        ctx.closePath()
        ctx.fill()
      }
    }

    // selection reticle
    if (this.selected === d.id) {
      const rr = r * 4.2 + 6 + Math.sin(t * 2.4) * 1.5
      ctx.globalAlpha = 0.7 * fade
      ctx.strokeStyle = `hsl(${d.hue} 100% 82%)`
      ctx.lineWidth = 1.2
      for (let i = 0; i < 4; i++) {
        const a0 = t * 0.6 + (i * TAU) / 4
        ctx.beginPath()
        ctx.arc(sx, sy, rr, a0, a0 + 0.9)
        ctx.stroke()
      }
    }
  }

  private particlePos(p: Particle, t: number): V2 | null {
    const a = p.from()
    const b = p.to()
    if (!a || !b) return null
    const mx = (a.x + b.x) / 2
    const my = (a.y + b.y) / 2
    const dx = b.x - a.x
    const dy = b.y - a.y
    const cx = mx - dy * p.bend
    const cy = my + dx * p.bend
    const u = 1 - t
    return { x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y }
  }

  private drawParticle(p: Particle) {
    const ctx = this.ctx
    const e = easeInOut(Math.min(1, p.t))
    const quarantine = p.outcome === 'quarantined' || p.outcome === 'denied'
    const tt = quarantine ? Math.min(e, 0.86) : e
    const pos = this.particlePos(p, tt)
    if (!pos) {
      p.done = true
      return
    }
    const s = this.toScreen(pos.x, pos.y)
    p.trail.push(s)
    const maxTrail = this.reduced ? 6 : p.kind === 'belief' ? 16 : 20
    if (p.trail.length > maxTrail) p.trail.shift()
    const hue = p.kind === 'belief' && p.f !== undefined ? p.hue : p.hue
    const zs = Math.pow(this.cam.z, 0.6)
    // trail
    ctx.lineCap = 'round'
    for (let i = 1; i < p.trail.length; i++) {
      const k = i / p.trail.length
      ctx.globalAlpha = k * 0.55
      ctx.strokeStyle = `hsl(${hue} 100% ${70 + k * 15}%)`
      ctx.lineWidth = (p.kind === 'msg' ? 2.6 : 2) * k * zs + 0.3
      ctx.beginPath()
      ctx.moveTo(p.trail[i - 1].x, p.trail[i - 1].y)
      ctx.lineTo(p.trail[i].x, p.trail[i].y)
      ctx.stroke()
    }
    // head
    const H = (p.kind === 'msg' ? 16 : 12) * zs
    ctx.globalAlpha = quarantine && p.t > 0.8 ? 1 - (p.t - 0.8) / 0.2 : 1
    ctx.drawImage(glowSprite(hue, 100), s.x - H, s.y - H, H * 2, H * 2)
    if (p.kind === 'task') {
      const q = 3.4 * zs + 1
      ctx.globalAlpha = 1
      ctx.fillStyle = 'hsl(46 100% 90%)'
      ctx.beginPath()
      ctx.moveTo(s.x, s.y - q)
      ctx.lineTo(s.x + q * 0.8, s.y)
      ctx.lineTo(s.x, s.y + q)
      ctx.lineTo(s.x - q * 0.8, s.y)
      ctx.closePath()
      ctx.fill()
    }
    if (p.kind === 'belief' && p.f !== undefined && p.c !== undefined) {
      const [r, g, b] = surenessRgb({ f: p.f, c: p.c })
      ctx.globalAlpha = 0.9
      ctx.fillStyle = `rgb(${r},${g},${b})`
      ctx.beginPath()
      ctx.arc(s.x, s.y, 1.6 * zs + 0.6, 0, TAU)
      ctx.fill()
    }
  }

  private drawEffect(e: Effect) {
    const ctx = this.ctx
    const at = e.at()
    if (!at) return
    const s = this.toScreen(at.x, at.y)
    // effects scale gently with zoom, but never balloon across the screen when zoomed in
    const zs = Math.min(1.35, Math.pow(this.cam.z, 0.8))
    const t = e.t
    ctx.lineCap = 'round'
    switch (e.kind) {
      case 'ripple': {
        for (let i = 0; i < (this.reduced ? 1 : 2); i++) {
          const u = clamp(t * 1.25 - i * 0.22, 0, 1)
          if (u <= 0) continue
          const r = (34 + easeOut(u) * 120) * zs
          ctx.globalAlpha = (1 - u) * 0.65
          ctx.strokeStyle = `hsl(${e.hue} 100% 78%)`
          ctx.lineWidth = 2.2 * (1 - u) + 0.4
          ctx.beginPath()
          ctx.ellipse(s.x, s.y, r, r * 0.92, 0, 0, TAU)
          ctx.stroke()
        }
        break
      }
      case 'choice': {
        // a jagged, angular shockwave with radial fracture lines: decisively not a revision
        const u = easeOut(t)
        const jag = e.jag!
        const n = jag.length
        const r0 = (26 + u * 72) * zs
        ctx.globalAlpha = Math.pow(1 - t, 1.5) * 0.9
        ctx.strokeStyle = e.rejected ? 'hsl(330 100% 78%)' : 'hsl(48 100% 80%)'
        ctx.lineWidth = 1.2
        ctx.beginPath()
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * TAU + e.seed * TAU
          const rr = r0 * jag[i % n]
          const x = s.x + Math.cos(a) * rr
          const y = s.y + Math.sin(a) * rr
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        }
        ctx.stroke()
        // fracture spikes
        ctx.lineWidth = 1.1
        for (let i = 0; i < 6; i++) {
          const a = e.seed * 7 + (i * TAU) / 6
          const a1 = (16 + u * 22) * zs
          const a2 = (26 + u * 54) * zs * jag[i]
          ctx.globalAlpha = Math.pow(1 - t, 1.5) * 0.75
          ctx.beginPath()
          ctx.moveTo(s.x + Math.cos(a) * a1, s.y + Math.sin(a) * a1)
          ctx.lineTo(s.x + Math.cos(a + 0.08) * a2, s.y + Math.sin(a + 0.08) * a2)
          ctx.stroke()
        }
        // white flash
        if (t < 0.25) {
          const R = 70 * zs
          ctx.globalAlpha = (0.25 - t) * 3
          ctx.drawImage(glowSprite(0, 0), s.x - R, s.y - R, R * 2, R * 2)
        }
        break
      }
      case 'spark':
      case 'adopt':
      case 'birth': {
        const u = easeOut(t)
        if (e.kind !== 'spark') {
          const r = (e.kind === 'birth' ? 18 + u * 110 : 16 + u * 60) * zs
          ctx.globalAlpha = Math.pow(1 - t, 1.6) * (e.kind === 'birth' ? 0.8 : 0.6)
          if (e.tone !== undefined) {
            // the adopted belief's sureness tone (surenessOf, via coreEffect): neutral when its word is "tentative"
            const [rr, gg, bb] = freqRgb(e.tone)
            ctx.strokeStyle = `rgb(${rr},${gg},${bb})`
          } else {
            ctx.strokeStyle = `hsl(${e.hue} 100% 80%)`
          }
          ctx.lineWidth = e.kind === 'birth' ? 1.6 * (1 - t) + 0.4 : 1.2
          ctx.beginPath()
          ctx.arc(s.x, s.y, r, 0, TAU)
          ctx.stroke()
          if (e.kind === 'birth' && t < 0.4) {
            const R = (80 + t * 200) * zs
            ctx.globalAlpha = (0.4 - t) * 2
            ctx.drawImage(glowSprite(e.hue, 100), s.x - R, s.y - R, R * 2, R * 2)
          }
        }
        for (const sp of e.sparks ?? []) {
          const d = sp.v * u * zs
          const x = s.x + Math.cos(sp.a) * d
          const y = s.y + Math.sin(sp.a) * d
          const S = 7 * sp.s * zs * (1 - t)
          ctx.globalAlpha = 1 - t
          // the sparks are the swarm's identity colour, never a sureness colour (they used to be blue for any adopt)
          ctx.drawImage(glowSprite(e.hue, 100), x - S, y - S, S * 2, S * 2)
        }
        break
      }
      case 'quarantine': {
        // the membrane holds: an amber ring that contracts and blinks
        const r = (52 - easeOut(t) * 10) * zs
        const blink = this.reduced ? 1 : 0.55 + 0.45 * Math.cos(t * TAU * 3)
        ctx.globalAlpha = (1 - t) * 0.85 * blink
        ctx.strokeStyle = 'hsl(28 100% 64%)'
        ctx.lineWidth = 1.6
        ctx.setLineDash([4, 5])
        ctx.beginPath()
        ctx.arc(s.x, s.y, r, e.seed * TAU, e.seed * TAU + TAU)
        ctx.stroke()
        ctx.setLineDash([])
        break
      }
      case 'wake': {
        // sunrise: two warm rings swell out of the dot, with short rays
        for (let i = 0; i < (this.reduced ? 1 : 2); i++) {
          const u = clamp(t * 1.3 - i * 0.25, 0, 1)
          if (u <= 0) continue
          const r = (10 + easeOut(u) * 46) * zs
          ctx.globalAlpha = (1 - u) * 0.8
          ctx.strokeStyle = `hsl(${e.hue} 100% 72%)`
          ctx.lineWidth = 1.8 * (1 - u) + 0.4
          ctx.beginPath()
          ctx.arc(s.x, s.y, r, 0, TAU)
          ctx.stroke()
        }
        if (!this.reduced) {
          const u = easeOut(Math.min(1, t * 1.6))
          ctx.globalAlpha = Math.pow(1 - t, 2) * 0.7
          ctx.lineWidth = 1.2
          for (let i = 0; i < 8; i++) {
            const a = e.seed * TAU + (i * TAU) / 8
            const r0 = (12 + u * 16) * zs
            const r1 = (18 + u * 30) * zs
            ctx.beginPath()
            ctx.moveTo(s.x + Math.cos(a) * r0, s.y + Math.sin(a) * r0)
            ctx.lineTo(s.x + Math.cos(a) * r1, s.y + Math.sin(a) * r1)
            ctx.stroke()
          }
        }
        break
      }
      case 'duplicate': {
        const R = (18 + t * 20) * zs
        ctx.globalAlpha = (1 - t) * 0.35
        ctx.drawImage(glowSprite(e.hue, 30, false), s.x - R, s.y - R, R * 2, R * 2)
        break
      }
    }
  }

  private drawLabels(sorted: Dot[]) {
    const ctx = this.ctx
    const z = this.cam.z
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    // Words in the scene are drawn solid, in the look's text tokens: the theme's rules guarantee those read against the
    // ground only at full opacity, so hierarchy comes from ink vs ink-2, never from stacking alphas (light-token R1.1).
    // galaxy names, above each outline (hidden while a galaxy is under 14 px across)
    const rects: typeof this.galaxyLabelRects = []
    if (this.galaxies.length > 1) {
      for (const g of this.galaxies) {
        if (!g.visible || g.sr < 14) continue
        ctx.globalAlpha = 1
        const px = g.cloud ? 13 : 11
        ctx.font = `600 ${px}px "Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif`
        ctx.fillStyle = g.cloud ? ink('ink', 1) : ink('ink2', 1)
        setSpacing(ctx, '0.14em')
        const text = g.label.toUpperCase()
        const top = g.sy - g.sr - GALAXY_LABEL_LIFT
        ctx.fillText(text, g.sx, top)
        const half = (ctx.measureText(text).width || text.length * px * 0.75) / 2
        rects.push({ id: g.id, left: g.sx - half, top, right: g.sx + half, bottom: top + px * 1.25 })
        setSpacing(ctx, '0px')
      }
    }
    this.galaxyLabelRects = rects
    const pc = this.privateCluster
    const pcc = pc ? this.toScreen(pc.x, pc.y) : null
    const pcr = pc ? pc.r * z + 60 : 0
    if (pc && pcc && pc.r * z >= 14 && pcc.x > -pcr && pcc.y > -pcr && pcc.x < this.w + pcr && pcc.y < this.h + pcr) {
      const s = this.toScreen(pc.x, pc.y - pc.r)
      ctx.globalAlpha = 1
      ctx.font = `600 11px "Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif`
      ctx.fillStyle = ink('ink2', 1)
      setSpacing(ctx, '0.14em')
      ctx.fillText('PRIVATE', s.x, s.y - 26)
      setSpacing(ctx, '0px')
    }
    // swarm names, once a swarm is big enough on screen (inside a zoomed galaxy)
    for (const c of this.cores.values()) {
      if (!this.swarmLabelled(c)) continue
      const zs = Math.pow(z, 0.8)
      const y = c.sy + 70 * zs + 8
      ctx.globalAlpha = 1
      ctx.font = `600 ${z < 0.6 ? 11 : 12}px "Space Grotesk Variable", "Space Grotesk", system-ui, sans-serif`
      ctx.fillStyle = ink('ink', 1)
      setSpacing(ctx, '0.18em')
      ctx.fillText(c.name.toUpperCase(), c.sx, y)
      setSpacing(ctx, '0px')
      ctx.font = `500 10px "Inter Variable", Inter, system-ui, sans-serif`
      ctx.fillStyle = ink('ink2', 1)
      ctx.fillText(`${plural(c.motes.length, 'belief')} · ${plural(c.members, 'mind')}`, c.sx, y + 16)
    }
    // dot names
    ctx.font = `500 ${z < 0.7 ? 10 : 11}px "Inter Variable", Inter, system-ui, sans-serif`
    for (const d of sorted) {
      const lit = d.status === 'awake' || d.status === 'error' || d.status === 'starting'
      const zMin = lit ? 0.42 : 0.75
      const show = z > zMin || d.hover > 0.05 || this.selected === d.id
      if (!show || d.dying) continue
      const base = z > zMin ? clamp((z - zMin) * 5, 0, 1) : 0
      const a = Math.max(base * (0.35 + 0.55 * d.glow) * ((d.z + 1.4) / 2.4), d.hover)
      if (a < 0.03) continue
      const ly = d.sy + d.sr * 2.2 + 6
      const core = d.swarmId ? this.cores.get(d.swarmId) : null
      if (core && d.hover < 0.5 && this.selected !== d.id) {
        const ty = core.sy + 70 * Math.pow(z, 0.8) + 8
        if (Math.abs(d.sx - core.sx) < 70 && ly > ty - 14 && ly < ty + 30) continue
      }
      // a settled name is solid; a quieter (far, dim) dot uses ink-2. The zoom fade-in and a new dot's birth are motion
      // (brief transitions to that solid state), so the floor applies to where they land, not to each frame on the way
      ctx.globalAlpha = (base < 1 && d.hover < 1 ? a : 1) * (d.birth < 1 ? d.birth : 1)
      ctx.fillStyle = d.status === 'error' ? ink('bad', 1) : ink(a >= 0.6 ? 'ink' : 'ink2', 1)
      ctx.fillText(d.name, d.sx, ly)
    }
  }
}

function setSpacing(ctx: CanvasRenderingContext2D, v: string) {
  const c = ctx as CanvasRenderingContext2D & { letterSpacing?: string }
  if ('letterSpacing' in c) c.letterSpacing = v
}
