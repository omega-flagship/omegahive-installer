import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Swarm } from '../api/types'

/**
 * followups-r5, the hive map's fit, driven headless with a recording 2D context (no browser). INVENTED data only.
 * - item 1: a galaxy's name is drawn in screen px above its outline, so the fit keeps screen room for it: no name runs
 *   above the top inset (under the HUD's stats tile), in the universe overview or landed in one galaxy, 1440 and 390.
 * - item 2: the docked Ask reports its room as a scene inset (AskHost), and a fit nobody has moved away from is fitted
 *   again when that room arrives: no galaxy, and so no name, lies under the docked Ask.
 */

vi.mock('./sprites', () => ({
  glowSprite: () => ({ tag: 'glow', width: 64, height: 64 }),
  nebulaSprite: () => ({ tag: 'nebula', width: 64, height: 64 }),
  starTile: () => ({ tag: 'stars', width: 64, height: 64 }),
}))

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

function mockCanvas(w: number, h: number) {
  return {
    width: w,
    height: h,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    getContext: () => mockCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
  }
}

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

const NOW = '2026-10-01T00:00:00Z'
const swarm = (id: string, members: string[]): Swarm => ({ id, name: `Invented ${id}`, description: '', hue: 120, member_ids: members, created_at: NOW }) as unknown as Swarm
const agent = (id: string, swarmId: string): Agent => ({ id, name: id, kind: 'omega', swarm_id: swarmId, model: 'm', persona: '', hue: 200, status: 'awake', driver: 'local', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: NOW }) as unknown as Agent

/** A universe: the cloud hive and four invented people's hives, each with a couple of swarms. */
function universe() {
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

/** The insets App (the HUD) and AskHost (the docked Ask) report, as combineInsets merges them. */
const DESKTOP = { hud: { top: 76, right: 0, bottom: 20, left: 60 }, askRoom: 18 + 64 }
const PHONE = { hud: { top: 150, right: 0, bottom: 128, left: 0 }, askRoom: 74 + 64 }
/** The dock layout (shell/layout: the HUD's inset leaves the dock, not the Ask above it; placeAsk lifts the Ask over the dock) */
const DOCK = { hud: { top: 76, right: 0, bottom: 12 + 60 + 8 + 20, left: 0 }, askRoom: 12 + 60 + 8 + 6 + 64 }

async function engine(w: number, h: number) {
  const { HiveEngine } = await import('./engine')
  const e = new HiveEngine(mockCanvas(w, h) as unknown as HTMLCanvasElement, { onHover: () => undefined, onTap: () => undefined, onUserCamera: () => undefined }, { reducedMotion: true })
  const u = universe()
  e.setData({ agents: u.agents, swarms: u.swarms, thinking: {}, beliefs: {}, universe: u.universe })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test drives the private frame steps
  const inner = e as any
  return { e, inner }
}

/** Snap the camera to where it is going and draw one frame: what the person sees once it settles. */
function settle(inner: { cam: unknown; camT: object; center: unknown; centerT: object; update(dt: number): void; render(): void }) {
  inner.cam = { ...inner.camT }
  inner.center = { ...inner.centerT }
  inner.update(0.016)
  inner.render()
}

const sizes = [
  { name: '1440x900', w: 1440, h: 900, ...DESKTOP },
  { name: '390x844', w: 390, h: 844, ...PHONE },
  { name: '1440x900 dock layout', w: 1440, h: 900, ...DOCK },
]

describe('item 1: galaxy names keep clear of the HUD above (the stats tile)', () => {
  for (const s of sizes) {
    it(`${s.name}: the universe overview draws every name below the top inset, and on screen`, async () => {
      const { e, inner } = await engine(s.w, s.h)
      e.setInsets({ ...s.hud, bottom: Math.max(s.hud.bottom, s.askRoom) })
      e.overview(true)
      settle(inner)
      const boxes = e.galaxyLabelBoxes()
      expect(boxes.length).toBeGreaterThanOrEqual(2)
      for (const b of boxes) {
        expect(b.top).toBeGreaterThanOrEqual(s.hud.top)
        expect(b.left).toBeGreaterThanOrEqual(0)
        expect(b.right).toBeLessThanOrEqual(s.w)
      }
    })
    it(`${s.name}: landed in a galaxy, its name is below the top inset`, async () => {
      const { e, inner } = await engine(s.w, s.h)
      e.setInsets({ ...s.hud, bottom: Math.max(s.hud.bottom, s.askRoom) })
      expect(e.flyToGalaxy('hive:user:p_ada')).toBe(true)
      settle(inner)
      const own = e.galaxyLabelBoxes().find((b) => b.id === 'hive:user:p_ada')
      expect(own).toBeDefined()
      expect(own!.top).toBeGreaterThanOrEqual(s.hud.top)
    })
  }
})

describe('item 2: galaxy names keep clear of the docked Ask below', () => {
  for (const s of sizes) {
    it(`${s.name}: the Ask's room arrives after the first fit; the untouched fit is fitted again and every galaxy (and name) is above the Ask`, async () => {
      const { e, inner } = await engine(s.w, s.h)
      e.setInsets(s.hud)
      e.overview(true)
      settle(inner)
      // AskHost mounts and reports its room: the camera refits
      e.setInsets({ ...s.hud, bottom: Math.max(s.hud.bottom, s.askRoom) })
      settle(inner)
      const askTop = s.h - s.askRoom
      for (const gx of e.galaxyScreens().filter((x) => x.visible)) expect(gx.sy + gx.sr).toBeLessThanOrEqual(askTop)
      for (const b of e.galaxyLabelBoxes()) expect(b.bottom).toBeLessThanOrEqual(askTop)
    })
  }
  it('landed in a galaxy, the refit keeps that galaxy (it does not jump to the overview)', async () => {
    const { e, inner } = await engine(1440, 900)
    e.setInsets(DESKTOP.hud)
    e.flyToGalaxy('hive:user:p_ada')
    settle(inner)
    e.setInsets({ ...DESKTOP.hud, bottom: DESKTOP.askRoom })
    settle(inner)
    expect(e.galaxyInView()).toBe('hive:user:p_ada')
    const own = e.galaxyScreens().find((x) => x.id === 'hive:user:p_ada')!
    expect(own.sy + own.sr).toBeLessThanOrEqual(900 - DESKTOP.askRoom)
  })
  it('a camera the person moved is never refitted under them', async () => {
    const { e, inner } = await engine(1440, 900)
    e.setInsets(DESKTOP.hud)
    e.overview(true)
    settle(inner)
    e.panBy(120, 40)
    const before = { ...inner.camT }
    e.setInsets({ ...DESKTOP.hud, bottom: DESKTOP.askRoom })
    expect(inner.camT).toEqual(before)
  })
  it('flying to a dot or a swarm ends the fit: a later inset change does not pull the camera back out', async () => {
    const { e, inner } = await engine(1440, 900)
    e.setInsets(DESKTOP.hud)
    e.overview(true)
    e.flyToSwarm('s_1_0')
    const before = { ...inner.camT }
    e.setInsets({ ...DESKTOP.hud, bottom: DESKTOP.askRoom })
    expect(inner.camT).toEqual(before)
  })
  it('AskHost reports the room it takes (askRoom) through setAskRoom, which sets the scene inset "ask" and withdraws it', async () => {
    const { askRoom, setAskRoom } = await import('../features/ask/askRoom')
    const { useScene } = await import('./sceneStore')
    const root = { style: { setProperty: () => undefined, removeProperty: () => '' } }
    setAskRoom(root, askRoom({ bottom: 18 }, false, 0))
    expect(useScene.getState().insetSources.ask).toEqual({ bottom: DESKTOP.askRoom })
    setAskRoom(root, null)
    expect(useScene.getState().insetSources.ask).toBeUndefined()
  })
})
