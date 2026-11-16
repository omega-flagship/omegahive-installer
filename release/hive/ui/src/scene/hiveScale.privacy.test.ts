import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Goal, HiveEvent, Swarm } from '../api/types'
import type { Viewer } from './visibleSet'

/**
 * Hive scaling r1, runtime privacy (PLAN_HIVE_VIEW_SCALING r2 §6 P1–P8) and bounded glow, on the real engine driven
 * headless with a recording 2D context, fed exactly what the page feeds it (scene/sceneData mapScene). INVENTED data.
 *
 * The invariance tests compare a full snapshot of what the map shows (every galaxy's id, place, size, label and
 * swarm count; every swarm's place and slot; the centre; the placeholders; the label boxes; the hive list the Ask
 * names; the drawn link segments) with and without the hidden objects. They must be byte-identical.
 */

vi.mock('./sprites', () => ({
  glowSprite: (_hue: number, sat = 100, hot = true) => ({ tag: `glow:${sat}:${hot}`, width: 64, height: 64 }),
  nebulaSprite: () => ({ tag: 'nebula', width: 64, height: 64 }),
  starTile: () => ({ tag: 'stars', width: 64, height: 64 }),
}))

type Call = { fn: string; args: unknown[]; op: string; dash: boolean }
const calls: Call[] = []

function mockCtx() {
  const state: Record<string, unknown> = { globalCompositeOperation: 'source-over', globalAlpha: 1 }
  let dash = false
  return new Proxy(state, {
    get(t, k: string) {
      if (k in t) return t[k]
      if (k === 'measureText') return () => ({ width: 10 })
      if (k === 'createPattern') return () => ({})
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop: () => undefined })
      if (k === 'setLineDash') return (a: number[]) => void (dash = a.length > 0)
      return (...args: unknown[]) => void calls.push({ fn: k, args, op: String(t.globalCompositeOperation), dash })
    },
    set(t, k: string, v) {
      t[k] = v
      return true
    },
  })
}

function mockCanvas(w = 1440, h = 900) {
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

// ------------------------------------------------------------------ the invented hive

const NOW = '2026-10-01T00:00:00Z'
const A = 'user:p_ari'
const B = 'user:p_bo'
const C = 'user:p_cass'
const sw = (id: string, owner: string | null, extra: Partial<Swarm> = {}): Swarm => ({ id, name: `Team ${id}`, description: '', hue: (id.length * 47) % 360, member_ids: [], created_at: NOW, ...(owner ? { owner } : {}), visibility: 'public', ...extra })
const ag = (id: string, swarm: string | null, extra: Partial<Agent> = {}): Agent => ({ id, name: `Mind ${id}`, kind: 'omega', swarm_id: swarm, model: 'm', persona: '', hue: 200, status: 'awake', driver: 'local', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: NOW, ...extra }) as Agent

function base(): { swarms: Swarm[]; agents: Agent[] } {
  const swarms = [sw('s_c1', null), sw('s_c2', 'user:operator'), sw('s_a1', A), sw('s_a2', A, { visibility: 'shared', shared_with: [B] }), sw('s_k1', C), sw('s_b1', B)]
  const agents: Agent[] = []
  let i = 0
  for (const s of swarms) for (let k = 0; k < 2 + (i++ % 3); k++) {
    const a = ag(`a_${s.id}_${k}`, s.id)
    agents.push(a)
    s.member_ids.push(a.id)
  }
  agents.push(ag('a_wander', null))
  return { swarms, agents }
}

/** A's things viewer B may not see, as a careless host might still list them. */
function withHidden(h: { swarms: Swarm[]; agents: Agent[] }, kind: 'personal' | 'archived' | 'visitor-private') {
  const swarms = [...h.swarms]
  const agents = [...h.agents]
  const extra: Partial<Swarm> =
    kind === 'personal' ? { personal_of: A, visibility: 'private' } : kind === 'archived' ? { archived_at: NOW } : { visibility: 'private' }
  const s = sw('s_hidden', A, extra)
  for (let k = 0; k < 7; k++) {
    const a = ag(`a_hidden_${k}`, s.id, kind === 'personal' ? { personal_of: A } : {})
    s.member_ids.push(a.id)
    agents.push(a)
  }
  swarms.push(s)
  // a hidden mind of A's outside any swarm, too
  agents.push(ag('a_hidden_loose', null, { personal_of: A }))
  return { swarms, agents }
}

const viewerB: Viewer = { principal: B, admin: false, visitor: false, ownMind: null, privateHomes: new Set(), homesState: 'resolved' }
const names = { [A]: 'Ari Ashdown', [B]: 'Bo Brackwater', [C]: 'Cass Cindervale' }

async function scene(h: { swarms: Swarm[]; agents: Agent[] }, viewer: Viewer, opts: { goals?: Goal[]; beliefs?: Record<string, Record<string, never>> } = {}) {
  const { HiveEngine } = await import('./engine')
  const { mapScene } = await import('./sceneData')
  const e = new HiveEngine(mockCanvas() as unknown as HTMLCanvasElement, { onHover: () => undefined, onTap: () => undefined }, { reducedMotion: true })
  const { shown, universe, claims } = mapScene(h.swarms, h.agents, opts.goals ?? [], { viewer, names })
  e.setData({ agents: shown.agents, swarms: shown.swarms, thinking: {}, beliefs: opts.beliefs ?? {}, claims, universe })
  e.overview(true)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the test reads the engine's private state
  const inner = e as any
  inner.update(0.016)
  return { e, inner, shown, universe }
}

/** Everything the map shows of the layout, as one string. */
function snapshot(s: Awaited<ReturnType<typeof scene>>, camera?: { x: number; y: number; z: number }) {
  const { e, inner } = s
  if (camera) {
    inner.cam = { ...camera }
    inner.camT = { ...camera }
    inner.update(0.016)
  }
  calls.length = 0
  inner.render()
  const links = calls.filter((c) => c.dash && (c.fn === 'moveTo' || c.fn === 'lineTo')).map((c) => c.args.map((v) => Math.round(Number(v))))
  return JSON.stringify({
    galaxies: inner.galaxies.map((g: Record<string, unknown>) => [g.id, g.x, g.y, g.r, g.label, g.swarms, g.hue]),
    cores: [...inner.cores.values()].map((c: Record<string, unknown>) => [c.id, c.tx, c.ty, c.slot, c.members, c.hive]),
    dots: [...inner.dots.keys()].sort(),
    wander: [inner.wanderCore.tx, inner.wanderCore.ty, inner.wanderCore.hive, inner.wanderCount],
    placeholders: inner.privateCluster,
    labels: e.labelBoxes(),
    list: e.galaxyList(),
    camera: [inner.camT.x, inner.camT.y, inner.camT.z],
    links,
  })
}

describe('P1: an object hidden from the viewer changes nothing on the map', () => {
  for (const kind of ['personal', 'archived'] as const) {
    it(`A's ${kind} swarm, its 8 minds and their beliefs: B's map is byte-identical`, async () => {
      const without = snapshot(await scene(base(), viewerB))
      const h = withHidden(base(), kind)
      const withIt = snapshot(await scene(h, viewerB, { beliefs: { s_hidden: { x: {} as never } } }))
      expect(withIt).toBe(without)
    })
  }
  it('a hidden mind listed as a member of a shown swarm: no count, size or place changes', async () => {
    const without = snapshot(await scene(base(), viewerB))
    const h = base()
    const s = h.swarms.find((x) => x.id === 's_a1')!
    for (let k = 0; k < 9; k++) {
      h.agents.push(ag(`a_ghost_${k}`, 's_a1', { personal_of: A }))
      s.member_ids.push(`a_ghost_${k}`)
    }
    expect(snapshot(await scene(h, viewerB))).toBe(without)
  })
  it('in visitor mode, A’s private swarm: byte-identical (and no placeholder)', async () => {
    const visitor = { ...viewerB, visitor: true }
    const without = snapshot(await scene(base(), visitor))
    const withIt = await scene(withHidden(base(), 'visitor-private'), visitor)
    expect(withIt.shown.placeholders).toBe(0)
    expect(snapshot(withIt)).toBe(without)
  })
  it('the swarm lists and the Ask’s counts take the same shown set', async () => {
    const { visibleSet } = await import('./visibleSet')
    const a = visibleSet(base().swarms, base().agents, viewerB, { map: false, keepArchived: false })
    const h = withHidden(base(), 'personal')
    const b = visibleSet(h.swarms, h.agents, viewerB, { map: false, keepArchived: false })
    expect(b.swarms.map((s) => s.id)).toEqual(a.swarms.map((s) => s.id))
    expect(b.agents.map((x) => x.id)).toEqual(a.agents.map((x) => x.id))
  })
})

describe('P2 / P6: activity of hidden or unknown objects draws nothing', () => {
  const events = (): HiveEvent[] => [
    { type: 'message', at: NOW, message: { id: 'm1', agent_id: 'a_hidden_0', conversation_id: 'c1', direction: 'in', sender: 'agent:a_s_k1_0', text: 'x', created_at: NOW } },
    { type: 'message', at: NOW, message: { id: 'm2', agent_id: 'a_s_k1_0', conversation_id: 'c2', direction: 'in', sender: 'agent:a_hidden_1', text: 'x', created_at: NOW } },
    { type: 'message', at: NOW, message: { id: 'm3', agent_id: 'a_nobody', conversation_id: 'c3', direction: 'out', sender: 'agent:a_nobody', text: 'x', created_at: NOW } },
    { type: 'belief.published', at: NOW, swarm_id: 's_hidden', assertion: { agent_id: 'a_hidden_0', statement: '(x)', tv: { f: 1, c: 0.9 }, outcome: 'adopted' } as never },
    { type: 'belief.updated', at: NOW, belief: { swarm_id: 's_unknown', statement: '(y)', tv: { f: 1, c: 0.5 } } as never },
    { type: 'goal.updated', at: NOW, goal: { id: 'g1', swarm_id: 's_hidden', status: 'claimed', claimed_by: 'a_hidden_2' } as never },
    { type: 'wakeup.fired', at: NOW, wakeup_id: 'w1', agent_id: 'a_hidden_3' },
    { type: 'approval.created', at: NOW, approval: { agent_id: 'a_hidden_4' } as never },
  ]
  it('no particle, effect or flash; the map is byte-identical after the events', async () => {
    const s = await scene(withHidden(base(), 'personal'), viewerB)
    const before = snapshot(s)
    for (const ev of events()) s.e.handleEvent(ev)
    expect(s.inner.particles).toHaveLength(0)
    expect(s.inner.effects).toHaveLength(0)
    for (const c of s.inner.cores.values()) expect(c.flash).toBe(0)
    s.inner.update(0.016)
    expect(snapshot(s)).toBe(before)
  })
  it('a task claimed by a hidden mind leaves no glyph on any shown mind', async () => {
    const goals = [{ id: 'g1', swarm_id: 's_hidden', status: 'claimed', claimed_by: 'a_hidden_2' } as Goal]
    const s = await scene(withHidden(base(), 'personal'), viewerB, { goals })
    for (const d of s.inner.dots.values()) expect(d.tasks).toBe(0)
    const { mapScene } = await import('./sceneData')
    const h = withHidden(base(), 'personal')
    expect(mapScene(h.swarms, h.agents, goals, { viewer: viewerB, names }).claims).toEqual({ g1: null })
  })
})

describe('P3: links only between shown objects', () => {
  it('the drawn links are the cloud hive to each shown person’s hive, nothing between people’s hives', async () => {
    const s = await scene(base(), viewerB)
    s.inner.render()
    const segs = calls.filter((c) => c.dash && c.fn === 'lineTo').length
    const people = s.inner.galaxies.filter((x: { cloud: boolean }) => !x.cloud).length
    expect(segs).toBeLessThanOrEqual(people)
    expect(people).toBe(3)
  })
  it('a hidden exchange between A and C adds no link and no weight', async () => {
    const s = await scene(withHidden(base(), 'personal'), viewerB)
    const before = snapshot(s)
    s.e.handleEvent({ type: 'message', at: NOW, message: { id: 'm9', agent_id: 'a_hidden_0', conversation_id: 'c9', direction: 'out', sender: 'agent:a_hidden_0', text: 'x', created_at: NOW } })
    expect(snapshot(s)).toBe(before)
  })
})

describe('P4: authorised placeholders are inert and unattributed', () => {
  const admin: Viewer = { principal: 'user:p_dee', admin: true, visitor: false, ownMind: null, privateHomes: new Set(['s_home']), homesState: 'resolved' }
  function withPrivate() {
    const h = base()
    const priv = sw('s_priv', A, { visibility: 'private' })
    const home = sw('s_home', C)
    for (const s of [priv, home]) for (let k = 0; k < 5; k++) {
      const a = ag(`a_${s.id}_${k}`, s.id)
      s.member_ids.push(a.id)
      h.agents.push(a)
    }
    h.swarms.push(priv, home)
    return h
  }
  it('counted, never shown as a swarm; no galaxy moves, grows or counts because of them', async () => {
    const plain = await scene(base(), admin)
    const s = await scene(withPrivate(), admin)
    expect(s.shown.placeholders).toBe(2)
    expect(s.inner.cores.has('s_priv')).toBe(false)
    expect(s.inner.cores.has('s_home')).toBe(false)
    expect([...s.inner.dots.keys()].some((id: string) => id.startsWith('a_s_priv') || id.startsWith('a_s_home'))).toBe(false)
    const strip = (x: string) => {
      const o = JSON.parse(x)
      delete o.placeholders
      delete o.camera
      return JSON.stringify(o)
    }
    // the same camera for both: the fit zoom widens to include the cluster (a camera change, not a layout one)
    const cam = { x: 0, y: 0, z: 0.4 }
    expect(strip(snapshot(s, cam))).toBe(strip(snapshot(plain, cam)))
  })
  it('in their own cluster outside every galaxy, fixed size, never a hit, a handle or a named hive', async () => {
    const s = await scene(withPrivate(), admin)
    const pc = s.inner.privateCluster
    expect(pc.slots).toHaveLength(2)
    for (const gx of s.inner.galaxies) expect(Math.hypot(pc.x - gx.x, pc.y - gx.y)).toBeGreaterThan(pc.r + gx.r)
    for (const p of pc.slots) {
      const q = s.inner.toScreen(p.x, p.y)
      expect(s.e.hitTest(q.x, q.y, 16)).toBeNull()
      expect(s.e.galaxyHandleAt(q.x, q.y)).toBeNull()
    }
    expect(s.e.galaxyList().map((x) => x.id)).not.toContain('s_priv')
    const text = calls.filter((c) => c.fn === 'fillText').map((c) => String(c.args[0]))
    expect(text.join('|')).not.toMatch(/s_priv|s_home|Team s_priv|Team s_home/)
  })
  it('absent in visitor mode', async () => {
    const s = await scene(withPrivate(), { ...admin, visitor: true })
    expect(s.shown.placeholders).toBe(0)
    expect(s.inner.privateCluster).toBeNull()
  })
  it('a swarm named exactly like a private app is a placeholder even where the hive did not say it is a home', async () => {
    const { visibleSet, NO_VIEWER } = await import('./visibleSet')
    const { PRIVATE_APPS } = await import('../features/ask/view')
    const name = [...PRIVATE_APPS][0]
    const v = visibleSet([sw('s_x', null, { name: ` ${name.toUpperCase()} ` })], [], { ...NO_VIEWER, admin: true, homesState: 'resolved' })
    expect([v.swarms.length, v.placeholders]).toEqual([0, 1])
  })
})

describe('P7: names', () => {
  it('a hive is named only for a person the viewer may see; visitors see no person’s name', async () => {
    const { hiveLabel } = await import('./hiveNames')
    expect(hiveLabel(`hive:${A}`, { viewer: viewerB, names }, `hive:${B}`)).toBe('Ashdown hive')
    expect(hiveLabel(`hive:${A}`, { viewer: viewerB, names: {} }, `hive:${B}`)).toBe('A hive')
    expect(hiveLabel(`hive:${A}`, { viewer: { ...viewerB, visitor: true }, names }, `hive:${B}`)).toBe('A hive')
    expect(hiveLabel(`hive:${B}`, { viewer: viewerB, names }, `hive:${B}`)).toBe('Your hive')
    expect(hiveLabel('hive:cloud', { viewer: viewerB, names }, `hive:${B}`)).toBe('Cloud hive')
  })
  it('the drawn labels are only the shown hives’ and swarms’ names', async () => {
    const s = await scene(withHidden(base(), 'personal'), viewerB)
    s.inner.cam.z = s.inner.camT.z = 1.2
    s.inner.update(0.016)
    calls.length = 0
    s.inner.render()
    const text = calls.filter((c) => c.fn === 'fillText').map((c) => String(c.args[0]))
    expect(text.join('|')).not.toMatch(/HIDDEN|s_hidden|Mind a_hidden/i)
  })
})

describe('P8: another person’s personal mind never appears, even when the host lists it', () => {
  it('for a member and for an admin', async () => {
    const { visibleSet } = await import('./visibleSet')
    const h = withHidden(base(), 'personal')
    for (const viewer of [viewerB, { ...viewerB, admin: true }]) {
      for (const map of [true, false]) {
        const v = visibleSet(h.swarms, h.agents, viewer, { map })
        expect(v.swarms.some((s) => s.personal_of)).toBe(false)
        expect(v.agents.some((a) => a.personal_of)).toBe(false)
      }
    }
  })
  it('the viewer’s own mind is drawn as "You", at the centre of their own hive', async () => {
    const h = base()
    h.swarms.push(sw('s_mine', B, { personal_of: B, visibility: 'private' }))
    h.agents.push(ag('a_me', 's_mine', { personal_of: B }))
    h.agents.splice(h.agents.findIndex((a) => a.id === 'a_wander'), 1)
    const s = await scene(h, { ...viewerB, ownMind: { id: 'a_me', swarm_id: 's_mine' } })
    expect(s.shown.agents.find((a) => a.id === 'a_me')).toMatchObject({ name: 'You', swarm_id: null })
    expect(s.inner.cores.has('s_mine')).toBe(false)
    const mine = s.inner.galaxies.find((x: { id: string }) => x.id === `hive:${B}`)
    expect([s.inner.wanderCore.tx, s.inner.wanderCore.ty]).toEqual([mine.x, mine.y])
  })
})

describe('glow is bounded per galaxy, never summed across the view', () => {
  it('one nebula pair per galaxy (not per swarm), laid over; halos capped by the slot; hot cores additive', async () => {
    const big = base()
    for (let i = 0; i < 40; i++) big.swarms.push(sw(`s_x${i}`, i % 2 ? A : C))
    const s = await scene(big, viewerB)
    s.inner.cam.z = s.inner.camT.z = 0.5
    s.inner.update(0.016)
    calls.length = 0
    s.inner.drawBackdrop()
    const nebulae = calls.filter((c) => c.fn === 'drawImage' && (c.args[0] as { tag?: string })?.tag === 'nebula')
    expect(nebulae.length).toBeLessThanOrEqual(2 * s.inner.galaxies.length)
    expect(nebulae.length).toBeGreaterThan(0)
    expect(nebulae.every((c) => c.op === 'source-over')).toBe(true)
    calls.length = 0
    for (const c of s.inner.cores.values()) if (c.lod > 0) s.inner.drawCore(c)
    const halos = calls.filter((c) => c.fn === 'drawImage' && (c.args[0] as { tag?: string })?.tag === 'glow:95:false')
    expect(halos.length).toBeGreaterThan(0)
    expect(halos.every((c) => c.op === 'source-over')).toBe(true)
    const maxSlot = Math.max(...[...s.inner.cores.values()].map((c: { slot: number }) => c.slot))
    for (const h of halos) expect(Number(h.args[3]) / 2).toBeLessThanOrEqual(maxSlot * 0.5 * 1.1 + 1e-6)
  })
  it('the universe layer (links, outlines, far points) is laid over too', async () => {
    const s = await scene(base(), viewerB)
    s.inner.cam.z = s.inner.camT.z = 0.05
    s.inner.update(0.016)
    calls.length = 0
    s.inner.drawGalaxies()
    const wide = calls.filter((c) => (c.fn === 'drawImage' && (c.args[0] as { tag?: string })?.tag === 'glow:95:false') || c.fn === 'stroke')
    expect(wide.length).toBeGreaterThan(0)
    expect(wide.every((c) => c.op === 'source-over')).toBe(true)
  })
})

describe('level of detail and culling', () => {
  it('zoomed out, a galaxy is one point: its swarms and minds are not drawn or hit; zoomed in, they are', async () => {
    const s = await scene(base(), viewerB)
    s.inner.cam.z = s.inner.camT.z = 0.03
    s.inner.update(0.016)
    expect([...s.inner.galaxies].every((x: { open: boolean }) => !x.open)).toBe(true)
    expect([...s.inner.dots.values()].every((d: { culled: boolean }) => d.culled)).toBe(true)
    expect([...s.inner.cores.values()].every((c: { lod: number }) => c.lod === 0)).toBe(true)
    s.e.flyToGalaxy(`hive:${A}`)
    s.inner.cam = { ...s.inner.camT }
    s.inner.update(0.016)
    const a = s.inner.galaxies.find((x: { id: string }) => x.id === `hive:${A}`)
    expect(a.open).toBe(true)
    expect(s.inner.cores.get('s_a1').lod).toBe(2)
    expect(s.inner.dots.get('a_s_a1_0').culled).toBe(false)
    expect(s.e.galaxyInView()).toBe(`hive:${A}`)
  })
  it('the wheel and pinch can zoom out as far as the whole universe needs', async () => {
    const big = base()
    for (let i = 0; i < 150; i++) big.swarms.push(sw(`s_y${i}`, `user:p_${i % 40}`))
    const s = await scene(big, viewerB)
    expect(s.inner.minZoom()).toBeLessThan(s.inner.fitZoom().z)
    s.e.zoomBy(0.0001)
    expect(s.inner.camT.z).toBeCloseTo(s.inner.minZoom(), 6)
  })
})

describe('drag to rearrange (UI-only)', () => {
  it('a galaxy dragged by its name stays where it was put; a still press flies into it', async () => {
    const s = await scene(base(), viewerB)
    s.inner.cam.z = s.inner.camT.z = 0.35
    s.inner.update(0.016)
    const a = s.inner.galaxies.find((x: { id: string }) => x.id === `hive:${A}`)
    const hx = a.sx
    const hy = a.sy - a.sr - 20
    expect(s.e.galaxyHandleAt(hx, hy)).toBe(`hive:${A}`)
    expect(s.e.beginGalaxyDrag(`hive:${A}`, hx, hy)).toBe(true)
    s.e.moveGalaxyDrag(hx + 200, hy + 100)
    const r = s.e.endGalaxyDrag()!
    expect(r.moved).toBe(true)
    expect(s.inner.pinned[`hive:${A}`]).toEqual({ x: r.x, y: r.y })
    const after = s.inner.galaxies.find((x: { id: string }) => x.id === `hive:${A}`)
    expect([after.x, after.y]).toEqual([r.x, r.y])
    // the cores came with it
    const core = s.inner.cores.get('s_a1')
    expect(Math.hypot(core.tx - after.x, core.ty - after.y)).toBeLessThanOrEqual(after.r)
    // a still press: no move, the camera flies in
    s.inner.update(0.016)
    const b = s.inner.galaxies.find((x: { id: string }) => x.id === `hive:${C}`)
    s.e.beginGalaxyDrag(b.id, b.sx, b.sy - b.sr - 20)
    expect(s.e.endGalaxyDrag()).toMatchObject({ id: b.id, moved: false })
    // (followups-r5: it flies to the galaxy with screen room above it kept for its name, GALAXY_LABEL_ROOM)
    const { GALAXY_LABEL_ROOM } = await import('./engine')
    expect(s.inner.camT.x).toBe(b.x)
    expect(s.inner.camT.y).toBeCloseTo(b.y - GALAXY_LABEL_ROOM / 2 / s.inner.camT.z, 6)
  })
  it('a single-galaxy map (a small hive) has nothing to drag', async () => {
    const one = { swarms: [sw('s_1', null), sw('s_2', null)], agents: [ag('a_1', 's_1')] }
    one.swarms[0].member_ids.push('a_1')
    const s = await scene(one, viewerB)
    expect(s.inner.galaxies).toHaveLength(1)
    expect(s.e.galaxyHandleAt(720, 450)).toBeNull()
  })
})
