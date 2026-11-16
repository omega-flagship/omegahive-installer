import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Swarm } from '../api/types'
import type { Viewer } from './visibleSet'
import { PAGE_ROUTES } from '../lib/router'

/**
 * Jon's screenshot (Create, the Make bench, 9 Nov): a ghost "ASSIST 0 beliefs" behind the stuck banner and a person's
 * name behind the bottom card. A page over the map dims the scene, but the dimmed scene still drew its names, and
 * translucent cards let them read through. A covered map now draws no words at all: its dots and glow stay as backdrop.
 * The real engine, headless, with a recording 2D context. INVENTED data.
 */

vi.mock('./sprites', () => ({
  glowSprite: () => ({ width: 64, height: 64 }),
  nebulaSprite: () => ({ width: 64, height: 64 }),
  starTile: () => ({ width: 64, height: 64 }),
}))

const calls: { fn: string; args: unknown[] }[] = []
function mockCtx() {
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over', globalAlpha: 1 }
  return new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return () => ({ width: 10 })
      if (k === 'createPattern') return () => ({})
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: () => undefined })
      return (...args: unknown[]) => void calls.push({ fn: k, args })
    },
    set(t, k: string, v) {
      t[k] = v
      return true
    },
  })
}
function mockCanvas(w = 1440, h = 900) {
  return {
    width: w, height: h, style: {} as Record<string, string>, dataset: {} as Record<string, string>,
    getContext: () => mockCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
    addEventListener: () => undefined, removeEventListener: () => undefined, setPointerCapture: () => undefined,
  }
}

const g = globalThis as Record<string, unknown>
const saved: Record<string, unknown> = {}
beforeAll(() => {
  for (const k of ['window', 'document', 'requestAnimationFrame', 'cancelAnimationFrame']) saved[k] = g[k]
  g.window = { devicePixelRatio: 1, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined, location: { hash: '', search: '' } }
  g.document = { createElement: () => mockCanvas(64, 64), addEventListener: () => undefined, removeEventListener: () => undefined, hidden: false }
  g.requestAnimationFrame = () => 0
  g.cancelAnimationFrame = () => undefined
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) g[k] = v
})
beforeEach(() => {
  calls.length = 0
})

const NOW = '2026-10-01T00:00:00Z'
const A = 'user:p_ari'
const B = 'user:p_bo'
const sw = (id: string, owner: string, name: string): Swarm => ({ id, name, description: '', hue: 200, member_ids: [], created_at: NOW, owner, visibility: 'public' })
const ag = (id: string, swarm: string | null): Agent => ({ id, name: `Mind ${id}`, kind: 'omega', swarm_id: swarm, model: 'm', persona: '', hue: 200, status: 'awake', driver: 'local', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: NOW }) as Agent
const viewer: Viewer = { principal: A, admin: false, visitor: false, ownMind: null, privateHomes: new Set(), homesState: 'resolved' }

async function scene() {
  const { HiveEngine } = await import('./engine')
  const { mapScene } = await import('./sceneData')
  const swarms = [sw('s_1', A, 'Tidewater'), sw('s_2', B, 'Driftwood')]
  const agents: Agent[] = []
  for (const s of swarms) for (let k = 0; k < 3; k++) {
    const a = ag(`a_${s.id}_${k}`, s.id)
    agents.push(a)
    s.member_ids.push(a.id)
  }
  agents.push(ag('a_loose', null))
  const e = new HiveEngine(mockCanvas() as unknown as HTMLCanvasElement, { onHover: () => undefined, onTap: () => undefined }, { reducedMotion: true })
  const { shown, universe, claims } = mapScene(swarms, agents, [], { viewer, names: { [A]: 'Ari Ashdown', [B]: 'Bo Brackwater' } })
  e.setData({ agents: shown.agents, swarms: shown.swarms, thinking: {}, beliefs: {}, claims, universe })
  e.overview(true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test drives the engine's private frame
  const inner = e as any
  inner.update(0.016)
  return { e, inner }
}
const words = () => calls.filter((c) => c.fn === 'fillText' || c.fn === 'strokeText').map((c) => String(c.args[0]))

describe('a page over the map gets no words from under it', () => {
  it('open map: names are drawn; covered (dimmed): none, and no label boxes; uncovered: the names are back', async () => {
    const { e, inner } = await scene()
    inner.render()
    expect(words().length).toBeGreaterThan(0)
    // the screenshot's case: a swarm's name and its "n beliefs" line, drawn once the camera is in close
    const swarm = [...inner.cores.values()][0]
    inner.cam = { x: swarm.x, y: swarm.y, z: 3 }
    inner.camT = { ...inner.cam }
    inner.update(0.016)
    calls.length = 0
    inner.render()
    expect(words().some((w) => /belief/.test(w))).toBe(true)

    calls.length = 0
    e.setDimmed(true)   // the loop is stopped (reduced motion): dimming paints the covered frame itself
    expect(calls.some((c) => c.fn === 'fillRect')).toBe(true)
    expect(words()).toEqual([])
    calls.length = 0
    inner.render()
    expect(words()).toEqual([])
    expect(e.labelBoxes()).toEqual([])

    e.setDimmed(false)
    calls.length = 0
    inner.render()
    expect(words().some((w) => /belief/.test(w))).toBe(true)
    e.destroy()
  })
  it('the Make bench is a covering page: Create opens on a program route, which dims the map', () => {
    expect(PAGE_ROUTES).toContain('program')
  })
})
