import { PINNED_AXIS_SHIFT } from '../../features/ask/placement'
import type { ShellPhase } from '../../shell/phase'
import { plural } from '../../lib/plural'

/**
 * Cosmos's rest → awake → Pro (CANDIDATE, cosmos-rest-r1): what the one scene (Scene.tsx) and Cosmos's own rest and
 * awake renderers (phases.tsx) share. The Ω is the galaxy's own core, at the origin of the same seeded galaxy Pro
 * flies through: rest is a quiet far view of it, awake an intimate orbit around it, Pro the whole galaxy. One camera
 * controller (Scene CameraRig) owns every camera write; this is only its goals and the fades it eases.
 */

/** Shared uniforms (one object, used by every material that fades): 1 in Pro, so Pro draws exactly as before. */
export const uGalaxy = { value: 1 }
export const uSky = { value: 1 }

/** The local orbit the apps keep around the Ω (world units; the galaxy's systems start at 30). */
export const APP_ORBIT = 3
/** The orbit's own clock (s), advanced by the scene; held while a person points at or focuses an app. */
export const appClock = { t: 0, hold: 0 }
/** One orbit takes about three minutes: gentle, and a label never runs from a finger. */
export const APP_SPEED = 0.035

/** How far each state's fades go (eased by the scene). */
export const FADES: Record<ShellPhase, { galaxy: number; sky: number }> = {
  rest: { galaxy: 0, sky: 0.5 },
  // awake keeps the galaxy alive behind the Ω, dimmed (quality pass r1, 3 Nov: never a near-black void)
  awake: { galaxy: 0.6, sky: 1 },
  pro: { galaxy: 1, sky: 1 },
}

/**
 * Camera polar angle (from straight above) for rest and awake: rest is low and far, awake leans over the orbit; on a
 * tall screen (a phone) it looks further down, so the orbit opens into a near circle that uses the height.
 */
export const PHI = { rest: 1.02, awake: 0.8, awakeTall: 0.5 } as const
const TAN = Math.tan((50 / 2) * (Math.PI / 180))

/**
 * Where the camera sits for rest and awake, framed for the actual viewport (never a fixed distance): the orbit fits
 * the width and leaves the lower part of the screen to the field. `offY` (px) lifts the Ω above the centre through the
 * camera's view offset. Pure (phaseRig.test.ts).
 */
export function phaseFrame(phase: 'rest' | 'awake', width: number, height: number): { radius: number; phi: number; offY: number } {
  const aspect = Math.max(0.3, width / Math.max(1, height))
  const tall = aspect < 0.8
  const phi = tall ? PHI.awakeTall : PHI.awake
  const ratio = Math.cos(phi)
  // the orbit's half-width within 62% of the half-screen (72% when tall), its half-height within 40% (46% when tall)
  const byWidth = APP_ORBIT / ((tall ? 0.72 : 0.62) * TAN * aspect)
  const byHeight = (APP_ORBIT * ratio) / ((tall ? 0.46 : 0.4) * TAN)
  const awake = Math.max(byWidth, byHeight)
  if (phase === 'awake') return { radius: awake, phi, offY: Math.round(height * (tall ? 0.07 : 0.06)) }
  return { radius: awake * 2.6, phi: PHI.rest, offY: Math.round(height * 0.04) }
}

/**
 * The fades for a state at this screen: as FADES, except a tall screen (a phone) looking down into the core keeps the
 * awake galaxy lower, so the dust behind the Ω stays a backdrop and the name and status keep their contrast.
 */
export function fadesFor(phase: ShellPhase, width: number, height: number): { galaxy: number; sky: number } {
  const f = FADES[phase]
  return phase === 'awake' && width / Math.max(1, height) < 0.8 ? { galaxy: 0.2, sky: 0.55 } : f
}

/** An app body's place on the orbit (i of n), at orbit time t (writes into out). */
export function appPos(i: number, n: number, t: number, out: { x: number; y: number; z: number }) {
  const a = (i / Math.max(1, n)) * Math.PI * 2 + 0.55 + t * APP_SPEED
  out.x = Math.cos(a) * APP_ORBIT
  out.y = Math.sin(a * 2 + i) * 0.12
  out.z = Math.sin(a) * APP_ORBIT
  return out
}

/** How many app bodies the orbit carries at this width: fewer on a phone (the field and touch targets come first). */
export const orbitCount = (width: number) => (width < 600 ? 4 : width < 1000 ? 5 : 6)

/**
 * DOM that follows the scene in rest and awake (the scene writes it each frame, no React render): the Ω's screen
 * point as CSS variables (--cx-ox, --cx-oy) on each registered root, and each app's label transform.
 */
export const follow: { roots: Set<HTMLElement>; apps: Map<number, HTMLElement> } = { roots: new Set(), apps: new Map() }

/** Exponential rates for each journey, tuned to the motion score (≈95% of the way in rest→awake 1.25 s, etc.). */
export const RATE = { wake: 2.4, settle: 3.2, 'fly-out': 2.15, 'fly-in': 2.7 } as const

/**
 * The polite live line for one state's layer, derived from the shell's state (no effect, no extra render): its words
 * while that state is the one just arrived in by a real move, empty otherwise (and on the opening paint, when there was
 * no move). A live region speaks only when its text changes, so each real move into the state is said exactly once.
 */
export function announcement(phase: ShellPhase, from: ShellPhase | null, when: ShellPhase, words: string): string {
  return phase === when && from !== null && from !== phase ? words : ''
}

/* ---------------- r2: the scene's pacing, flights, ignition and focus, as pure rules (phaseRig.test.ts) ---------------- */

export interface Pacing {
  hidden: boolean
  reduced: boolean
  phased: boolean
  phase: ShellPhase
}
/**
 * How the scene draws: never while hidden or covered; on demand under reduced motion; on demand at rest from the
 * first moment (Kimi r1 #10: no full-rate interval while a rest settles; RestPace draws it); always otherwise.
 */
export function frameloopFor(p: Pacing): 'never' | 'demand' | 'always' {
  if (p.hidden) return 'never'
  if (p.reduced) return 'demand'
  // awake is paced too (contract R1.1 #3, the weakest device): at most 30 frames a second, by Pace below
  return p.phased && (p.phase === 'rest' || p.phase === 'awake') ? 'demand' : 'always'
}
/** Whether the slow rest pacing runs: only at rest, only while the scene can be seen, never under reduced motion. */
export const restPaced = (p: Pacing): boolean => !p.hidden && !p.reduced && p.phased && p.phase === 'rest'
/** The frames a second the scene is drawn at while paced: 22 at rest, 18 awake; null (not paced) otherwise. */
export function pacedFps(p: Pacing): number | null {
  if (p.hidden || p.reduced || !p.phased) return null
  // awake 18: with the one living Ω (~18) the awake page stays near 35 frames a second (the counted gate, Dot 3 Nov)
  return p.phase === 'rest' ? 22 : p.phase === 'awake' ? 18 : null
}

/**
 * The camera's journey rate after a change of view goal: the fly-out only for the move from awake into Pro itself;
 * any ordinary Pro navigation or recenter clears it (stand-in r1 P2), so no cinematic easing or lens hold lingers.
 */
export function flightAfterViewChange(leavingAwake: boolean, snap: boolean, reduced: boolean): number {
  return leavingAwake && !snap && !reduced ? RATE['fly-out'] : 0
}

/** The ignition veil is lifted only by first light of the CURRENT scene (a context restore is a new epoch), or a failure. */
export const ignitionLit = (litEpoch: number, epoch: number, failed: boolean): boolean => failed || litEpoch === epoch

/**
 * Where focus lands when Pro takes over from an awake control (Kimi r1 #4): the first present, live element of the
 * chain; null means the caller names the Pro root itself.
 */
export const PRO_FOCUS_CHAIN = ['[data-cx-back-to-omega]', '.ask-root .ask-input', '[data-cx-pro-root]'] as const
export function firstLive(chain: readonly string[], find: (sel: string) => { isConnected: boolean; closest(sel: string): unknown } | null): string | null {
  for (const sel of chain) {
    const el = find(sel)
    if (el && el.isConnected && !el.closest('[inert]')) return sel
  }
  return null
}

/**
 * The view's lift aside for an Ask thread pinned beside it (smoke r1: the pinned thread covered awake chrome): half the
 * column's width, so the Ω, its name and the orbit sit centred in the space that is left. Pixels; 0 when nothing is pinned.
 */
export function askSideShift(askSide: string | undefined, width: number): number {
  if (askSide === 'desktop') return PINNED_AXIS_SHIFT
  if (askSide === 'landscape') return Math.round(width / 4)
  return 0
}

/** The awake status line, plainly (no "1 minds"): real counts only. */
export function awakeStatus(minds: number, lit: number): string {
  return minds > 0 ? `${lit} of ${plural(minds, 'mind')} lit` : 'No minds yet'
}

/**
 * Which side of its body an app's name sits (screen px; dx, dy from the Ω): on the outer side, left or right when the
 * body is to the side and there is room before the edge of `room` (the screen less a pinned thread), else above or
 * below. A body near the Ω's line takes its name ABOVE, since the Ω's own name and status sit just below it (r2).
 */
export function labelSide(dx: number, dy: number, sx: number, labelWidth: number, room: number): 'l' | 'r' | 't' | 'b' {
  const side = Math.abs(dx) > Math.abs(dy) * 1.6 ? (dx < 0 ? 'l' : 'r') : dy < 0 ? 't' : 'b'
  if ((side === 'l' && sx - 14 - labelWidth < 8) || (side === 'r' && sx + 14 + labelWidth > room - 8)) return dy < 40 ? 't' : 'b'
  return side
}

export interface RootState {
  phased: boolean
  gl: 'ok' | 'lost' | 'failed'
  /** the scene epoch whose first light was last reported (-1: none yet) */
  litEpoch: number
  epoch: number
  /** any scene has reported first light, or failed, on this page (the released latch) */
  everLit: boolean
}
/**
 * How Cosmos's root presents the scene's lifecycle (r2.1, stand-in FIX-FIRST). Only an activated (phased) Cosmos gets
 * the r2 recovery: the veil re-armed per scene epoch and retired once lit, and the lost canvas hidden (`data-gl`).
 * Unphased, Cosmos behaves exactly as released: one latch (first light once, or a failure), no `data-gl`, the veil only fades.
 */
export function rootPresentation(s: RootState): { lit: boolean; dataGl: 'lost' | 'failed' | undefined; retireVeil: boolean } {
  if (!s.phased) return { lit: s.everLit || s.gl === 'failed', dataGl: undefined, retireVeil: false }
  return { lit: ignitionLit(s.litEpoch, s.epoch, s.gl === 'failed'), dataGl: s.gl === 'ok' ? undefined : s.gl, retireVeil: true }
}

/**
 * Whether Cosmos's living Ω is on screen at rest or awake (LiveOmega onLive). While it is, the scene draws no star or
 * glow behind it: the mark sits on the space with no lamp (Jon, 3 Nov). While it can't run, the scene's own star is the Ω.
 */
const liveMarks = new Set<string>()
const markListeners = new Set<() => void>()
export const omegaMarkLive = {
  /** each phase layer's mark by name ('rest', 'awake'): both may be mounted while they cross-fade */
  set(who: string, live: boolean) {
    const was = liveMarks.size > 0
    if (live) liveMarks.add(who); else liveMarks.delete(who)
    if (was !== liveMarks.size > 0) markListeners.forEach((f) => f())
  },
  get value() { return liveMarks.size > 0 },
  /** told when `value` changes, so a scene drawing on demand draws the frame that brings the star back */
  subscribe(f: () => void): () => void { markListeners.add(f); return () => { markListeners.delete(f) } },
}
