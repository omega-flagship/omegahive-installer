import { afterAll, beforeAll } from 'vitest'
import type { Agent, Swarm } from '../api/types'

/**
 * The hive map's engine, driven headless with a recording 2D context (no browser), for the fit tests. INVENTED data only.
 * The same harness galaxyFit.r5.test.ts builds inline; a test file using it also mocks './sprites' (vi.mock is per file):
 *   vi.mock('./sprites', () => SPRITES_MOCK)
 */

export const SPRITES_MOCK = {
  glowSprite: () => ({ tag: 'glow', width: 64, height: 64 }),
  nebulaSprite: () => ({ tag: 'nebula', width: 64, height: 64 }),
  starTile: () => ({ tag: 'stars', width: 64, height: 64 }),
}

function mockCtx() {
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over', globalAlpha: 1 }
  const stub = () => ({ addColorStop: () => undefined })
  return new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return (s: string) => ({ width: s.length * 8 })
      if (k === 'createPattern') return () => ({})
      return stub
    },
    set(t, k: string, v) {
      t[k] = v
      return true
    },
  })
}

/** A canvas whose size can change (a window resize): set `size.w` / `size.h`, then call the engine's resize(). */
export function mockCanvas(w: number, h: number) {
  const size = { w, h }
  return {
    size,
    width: w,
    height: h,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    getContext: () => mockCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: size.w, height: size.h, right: size.w, bottom: size.h }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
  }
}

/** Install the few browser globals the engine touches, for the whole test file. */
export function installSceneGlobals(): void {
  const g = globalThis as Record<string, unknown>
  const saved: Record<string, unknown> = {}
  beforeAll(() => {
    for (const k of ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[k] = g[k]
    g.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }) }
    g.document = { createElement: () => mockCanvas(64, 64), addEventListener: () => undefined, removeEventListener: () => undefined, hidden: false }
    g.requestAnimationFrame = () => 0
    g.cancelAnimationFrame = () => undefined
  })
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) g[k] = v
  })
}

const NOW = '2026-10-01T00:00:00Z'
const swarm = (id: string, members: string[]): Swarm => ({ id, name: `Invented ${id}`, description: '', hue: 120, member_ids: members, created_at: NOW }) as unknown as Swarm
const agent = (id: string, swarmId: string): Agent => ({ id, name: id, kind: 'omega', swarm_id: swarmId, model: 'm', persona: '', hue: 200, status: 'awake', driver: 'local', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: NOW }) as unknown as Agent

/** A universe: the cloud hive and four invented people's hives, each with a couple of swarms. */
export function universe() {
  const hives = ['hive:cloud', 'hive:user:p_ada', 'hive:user:p_bo', 'hive:user:p_cy', 'hive:user:p_di']
  const swarms: Swarm[] = []
  const agents: Agent[] = []
  const hiveOf: Record<string, string> = {}
  const labels: Record<string, string> = { 'hive:cloud': 'Cloud hive', 'hive:user:p_ada': 'Your hive', 'hive:user:p_bo': 'Bo’s hive', 'hive:user:p_cy': 'Cy’s hive', 'hive:user:p_di': 'Di’s hive' }
  hives.forEach((h, i) => {
    for (let k = 0; k < (i === 0 ? 4 : 2); k++) {
      const id = `s_${i}_${k}`
      const members = Array.from({ length: 3 + k }, (_, n) => `a_${i}_${k}_${n}`)
      swarms.push(swarm(id, members))
      for (const m of members) agents.push(agent(m, id))
      hiveOf[id] = h
    }
  })
  return { swarms, agents, universe: { hiveOf, labels, wanderHive: null, placeholders: 0 } }
}

/** The insets App (the HUD) reports, and the room AskHost reports (askRoom), as combineInsets merges them. */
export const DESKTOP = { hud: { top: 76, right: 0, bottom: 20, left: 60 }, askRoom: 18 + 64 }
export const PHONE = { hud: { top: 150, right: 0, bottom: 128, left: 0 }, askRoom: 74 + 64 }

/** The private camera and frame steps a fit test reads and drives. */
export interface EngineInner {
  cam: { x: number; y: number; z: number }
  camT: { x: number; y: number; z: number }
  center: { x: number; y: number }
  centerT: { x: number; y: number }
  w: number
  h: number
  update(dt: number): void
  render(): void
  onDown(e: unknown): void
  onMove(e: unknown): void
  onUp(e: unknown): void
  onWheel(e: unknown): void
}

export async function makeEngine(w: number, h: number) {
  const { HiveEngine } = await import('./engine')
  const canvas = mockCanvas(w, h)
  const moved: number[] = []
  const e = new HiveEngine(canvas as unknown as HTMLCanvasElement, { onHover: () => undefined, onTap: () => undefined, onUserCamera: () => moved.push(1) }, { reducedMotion: true })
  const u = universe()
  e.setData({ agents: u.agents, swarms: u.swarms, thinking: {}, beliefs: {}, universe: u.universe })
  const inner = e as unknown as EngineInner
  return { e, inner, canvas, moved, agents: u.agents }
}

/** Snap the camera to where it is going and draw one frame: what the person sees once it settles. */
export function settle(inner: EngineInner): void {
  inner.cam = { ...inner.camT }
  inner.center = { ...inner.centerT }
  inner.update(0.016)
  inner.render()
}

/** A pointer event as the engine reads it (clientX/Y against the canvas at 0,0). */
export const pointer = (pointerId: number, x: number, y: number, pointerType = 'touch') => ({ pointerId, clientX: x, clientY: y, pointerType, preventDefault: () => undefined })
