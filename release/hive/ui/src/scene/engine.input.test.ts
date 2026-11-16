import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Agent, Swarm } from '../api/types'

/**
 * demo-polish r1: the hive map's engine, driven headless with a recording 2D context (no browser). Invented data only.
 * - item 6: a click or tap picks the dot that was under the pointer when it went down, even if the dot (or the camera)
 *   has moved by pointerup; the target is at least 32 px across for a mouse and 44 px for a finger.
 * - item 7: the wide glows (the per-swarm nebulae and the core halo) are laid over ('source-over'), not added
 *   ('lighter'), so 30+ swarms no longer sum to white; the small hot core stays additive.
 */

vi.mock('./sprites', () => ({
  glowSprite: (_hue: number, sat = 100, hot = true) => ({ tag: `glow:${sat}:${hot}`, width: 64, height: 64 }),
  nebulaSprite: () => ({ tag: 'nebula', width: 64, height: 64 }),
  starTile: () => ({ tag: 'stars', width: 64, height: 64 }),
}))

type Draw = { tag: string; op: string }
const draws: Draw[] = []

function mockCtx() {
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over', globalAlpha: 1 }
  const stub = () => ({ addColorStop: () => undefined })
  return new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k]
      if (k === 'drawImage') return (img: { tag?: string }) => void draws.push({ tag: img?.tag ?? 'canvas', op: String(t.globalCompositeOperation) })
      if (k === 'measureText') return () => ({ width: 10 })
      if (k === 'createPattern') return () => ({})
      return stub
    },
    set(t, k: string, v) {
      t[k] = v
      return true
    },
  })
}

function mockCanvas(w = 1440, h = 900) {
  const listeners = new Map<string, (e: unknown) => void>()
  return {
    width: w,
    height: h,
    style: {} as Record<string, string>,
    dataset: {} as Record<string, string>,
    getContext: () => mockCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h }),
    addEventListener: (k: string, f: (e: unknown) => void) => void listeners.set(k, f),
    removeEventListener: (k: string) => void listeners.delete(k),
    setPointerCapture: () => undefined,
    fire: (k: string, e: unknown) => listeners.get(k)?.(e),
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
const swarm = (i: number): Swarm => ({ id: `s_${i}`, name: `Invented ${i}`, description: '', hue: (i * 37) % 360, member_ids: [], created_at: NOW }) as unknown as Swarm
const agent = (id: string, swarmId: string): Agent => ({ id, name: id, kind: 'omega', swarm_id: swarmId, model: 'm', persona: '', hue: 200, status: 'awake', driver: 'local', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: NOW }) as unknown as Agent

async function engine(swarms = 1) {
  const { HiveEngine } = await import('./engine')
  const canvas = mockCanvas()
  const onTap = vi.fn()
  const e = new HiveEngine(canvas as unknown as HTMLCanvasElement, { onHover: () => undefined, onTap, onUserCamera: () => undefined }, { reducedMotion: true })
  const ss = Array.from({ length: swarms }, (_, i) => swarm(i))
  e.setData({ agents: [agent('a_one', 's_0')], swarms: ss, thinking: {}, beliefs: {} })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test drives the private frame steps
  const inner = e as any
  inner.update(0.016)
  return { e, inner, canvas, onTap }
}

const ptr = (type: string, x: number, y: number) => ({ pointerId: 1, pointerType: type, clientX: x, clientY: y })

describe('item 6: clicks and taps on a moving dot', () => {
  it('the hit area is at least 32 px across for a mouse and 44 px for a finger', async () => {
    const { hitSlop } = await import('./engine')
    expect(hitSlop('mouse') * 2).toBeGreaterThanOrEqual(32)
    expect(hitSlop('touch') * 2).toBeGreaterThanOrEqual(44)
    expect(hitSlop('pen') * 2).toBeGreaterThanOrEqual(44)
  })

  for (const type of ['mouse', 'touch']) {
    it(`${type}: the dot under the pointer at pointerdown is the one tapped, though it moved away before pointerup`, async () => {
      const { inner, canvas, onTap } = await engine()
      const d = inner.dots.get('a_one')
      const at = { x: d.sx, y: d.sy }
      canvas.fire('pointerdown', ptr(type, at.x, at.y))
      // the dot drifts (or the camera flies) 60 px before the button comes up
      d.sx += 60
      d.sy += 20
      canvas.fire('pointerup', ptr(type, at.x, at.y))
      expect(onTap).toHaveBeenCalledTimes(1)
      expect(onTap.mock.calls[0][0]).toEqual({ kind: 'dot', id: 'a_one' })
    })

    it(`${type}: a press near (not on) the small dot still picks it`, async () => {
      const { hitSlop } = await import('./engine')
      const { inner, canvas, onTap } = await engine()
      const d = inner.dots.get('a_one')
      const off = hitSlop(type) - 1
      canvas.fire('pointerdown', ptr(type, d.sx + off, d.sy))
      canvas.fire('pointerup', ptr(type, d.sx + off, d.sy))
      expect(onTap.mock.calls[0][0]).toEqual({ kind: 'dot', id: 'a_one' })
    })
  }

  it('a press where the dot was drawn a moment ago (it has since moved on, e.g. riding a camera move) picks it', async () => {
    const { inner, canvas, onTap } = await engine()
    const d = inner.dots.get('a_one')
    const seen = { x: d.sx, y: d.sy }
    // the next frames draw it 90 px away before the press lands
    d.angle += 0.0001
    inner.cam.x -= 90 / inner.cam.z
    inner.camT.x = inner.cam.x
    inner.update(0.016)
    expect(Math.hypot(d.sx - seen.x, d.sy - seen.y)).toBeGreaterThan(60)
    canvas.fire('pointerdown', ptr('mouse', seen.x, seen.y))
    canvas.fire('pointerup', ptr('mouse', seen.x, seen.y))
    expect(onTap.mock.calls[0][0]).toEqual({ kind: 'dot', id: 'a_one' })
  })

  it('hover (no press) uses only where the dot is now', async () => {
    const { HIT_SLOP_MOUSE } = await import('./engine')
    const { inner } = await engine()
    const d = inner.dots.get('a_one')
    const seen = { x: d.sx, y: d.sy }
    inner.cam.x -= 90 / inner.cam.z
    inner.camT.x = inner.cam.x
    inner.update(0.016)
    for (const c of inner.cores.values()) {
      c.sx = -1000
      c.sy = -1000
    }
    expect(inner.hitTest(seen.x, seen.y, HIT_SLOP_MOUSE)).toBeNull()
  })

  it('a press on empty space is still empty (a dot drifting under the pointer later is not picked)', async () => {
    const { inner, canvas, onTap } = await engine()
    const d = inner.dots.get('a_one')
    const at = { x: d.sx + 200, y: d.sy + 200 }
    // keep clear of the swarm's core too
    for (const c of inner.cores.values()) {
      c.sx = -1000
      c.sy = -1000
    }
    canvas.fire('pointerdown', ptr('mouse', at.x, at.y))
    canvas.fire('pointerup', ptr('mouse', at.x, at.y))
    expect(onTap.mock.calls[0][0]).toBeNull()
  })

  for (const type of ['mouse', 'touch']) {
    it(`${type}: followups r4: an empty press stays empty when a dot drifts under the pointer before release`, async () => {
      const { inner, canvas, onTap } = await engine()
      const d = inner.dots.get('a_one')
      for (const c of inner.cores.values()) {
        c.sx = -1000
        c.sy = -1000
      }
      const at = { x: d.sx + 200, y: d.sy + 200 }
      canvas.fire('pointerdown', ptr(type, at.x, at.y))
      // the dot drifts right under the pointer while it is held
      d.sx = at.x
      d.sy = at.y
      canvas.fire('pointerup', ptr(type, at.x, at.y))
      expect(onTap).toHaveBeenCalledTimes(1)
      expect(onTap.mock.calls[0][0]).toBeNull()
    })
  }
})

describe('item 7: wide glows are laid over, not added', () => {
  it('the nebulae and the core halo draw with source-over; the hot core stays additive', async () => {
    const { inner } = await engine(40)
    draws.length = 0
    inner.render()
    const nebula = draws.filter((d) => d.tag === 'nebula')
    const halo = draws.filter((d) => d.tag === 'glow:95:false')
    const hot = draws.filter((d) => d.tag === 'glow:100:true')
    expect(nebula.length).toBeGreaterThanOrEqual(2)
    expect(halo.length).toBeGreaterThanOrEqual(1)
    expect(hot.length).toBeGreaterThanOrEqual(1)
    expect(nebula.every((d) => d.op === 'source-over')).toBe(true)
    expect(halo.every((d) => d.op === 'source-over')).toBe(true)
    expect(hot.every((d) => d.op === 'lighter')).toBe(true)
  })
})
