import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent, Swarm } from '../api/types'
import { releasePersons, signInAs, switchPerson, testPerson } from '../lib/identityEpoch.testkit'
import { attachGalaxyDrag, type DragEngine } from './galaxyDrag'
import { homesBefore, resolvePrivateHomes } from './privateHomes'
import { NO_VIEWER, visibleSet, type Viewer } from './visibleSet'

/**
 * Hive scale r1.1 (stand-in r1 FIX-FIRST): private-app homes fail CLOSED until known (P1-1), and a galaxy drag never
 * crosses an identity change (P1-2). Plus Kimi's notes. Synthetic SimClients and INVENTED names only.
 */

beforeEach(() => {
  vi.stubGlobal('window', { location: { search: '' } })
})
afterEach(() => {
  releasePersons()
  vi.unstubAllGlobals()
})

const NOW = '2026-10-01T00:00:00Z'
const ME = 'user:p_me'
// a private app's home with a custom name, owned by the viewer (the stand-in's probe), and an ordinary team swarm
const home: Swarm = { id: 's_ledger', name: 'Ledger room', description: '', hue: 10, member_ids: ['a_l1', 'a_l2'], created_at: NOW, owner: ME, visibility: 'private' }
const team: Swarm = { id: 's_team', name: 'Harbor', description: '', hue: 200, member_ids: ['a_t1'], created_at: NOW }
const ag = (id: string, swarm: string): Agent => ({ id, name: `Mind ${id}`, kind: 'omega', swarm_id: swarm, model: 'm', persona: '', hue: 0, status: 'awake', driver: 'local', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: NOW }) as Agent
const agents = [ag('a_l1', 's_ledger'), ag('a_l2', 's_ledger'), ag('a_t1', 's_team')]
const viewer = (homesState: Viewer['homesState'], ids: string[] = [], visitor = false): Viewer => ({ ...NO_VIEWER, principal: ME, admin: true, visitor, privateHomes: new Set(ids), homesState })
const PRIVATE_APP = 'atlas'

function named(v: Viewer) {
  const out: string[] = []
  for (const map of [true, false]) {
    const s = visibleSet([home, team], agents, v, { map })
    out.push(...s.swarms.map((x) => x.name), ...s.agents.map((a) => a.id))
  }
  return out
}

describe('P1-1: a private app’s home is never shown by name before its homes are known', () => {
  it('pending (the app list or a home read still in flight): nothing that could be a home is shown, not even counted', () => {
    const s = visibleSet([home, team], agents, viewer('pending'))
    expect(s.swarms).toEqual([])
    expect(s.agents).toEqual([])
    expect(s.placeholders).toBe(0)
    expect(named(viewer('pending'))).toEqual([])
    // the default (no state said) is pending
    expect(named({ ...viewer('resolved'), homesState: undefined })).toEqual([])
  })
  it('failed (a refused or failed read): at most unattributed placeholders, none in visitor mode; never a name', () => {
    const s = visibleSet([home, team], agents, viewer('failed'))
    expect([s.swarms.length, s.agents.length, s.placeholders]).toEqual([0, 0, 2])
    expect(named(viewer('failed'))).toEqual([])
    expect(visibleSet([home, team], agents, viewer('failed', [], true)).placeholders).toBe(0)
  })
  it('resolved: the home is a placeholder, the team swarm is shown', () => {
    const s = visibleSet([home, team], agents, viewer('resolved', ['s_ledger']))
    expect(s.swarms.map((x) => x.id)).toEqual(['s_team'])
    expect(s.agents.map((a) => a.id)).toEqual(['a_t1'])
    expect(s.placeholders).toBe(1)
  })
  it('homesBefore: no app list yet is pending, an unreadable list is failed, no private app is resolved', () => {
    expect(homesBefore(null, null, true).state).toBe('pending')
    expect(homesBefore(null, 'refused', true).state).toBe('failed')
    expect(homesBefore([{ id: 'design' }], null, true).state).toBe('resolved')
    expect(homesBefore([{ id: PRIVATE_APP }], null, true).state).toBe('pending')
    expect(homesBefore([{ id: PRIVATE_APP }], null, false).state).toBe('failed')
    expect(homesBefore([{ id: '%61tlas' }], null, true).state).toBe('pending')
  })
  it('a rejected home read fails closed; a late answer resolves; a malformed answer fails', async () => {
    expect((await resolvePrivateHomes({ programHomes: () => Promise.reject(new Error('403')) }, [PRIVATE_APP])).state).toBe('failed')
    expect((await resolvePrivateHomes({ programHomes: () => Promise.resolve({ homes: 'x' as never }) }, [PRIVATE_APP])).state).toBe('failed')
    expect((await resolvePrivateHomes(null, [PRIVATE_APP])).state).toBe('failed')
    let answer!: (v: { homes: { swarm_id: string }[] }) => void
    const late = resolvePrivateHomes({ programHomes: () => new Promise((r) => (answer = r)) }, [PRIVATE_APP])
    // still in flight: the viewer stays pending, nothing named
    expect(named(viewer(homesBefore([{ id: PRIVATE_APP }], null, true).state))).toEqual([])
    answer({ homes: [{ swarm_id: 's_ledger' }] })
    const done = await late
    expect(done.state).toBe('resolved')
    expect([...done.ids]).toEqual(['s_ledger'])
    expect(named(viewer(done.state, [...done.ids]))).not.toContain('Ledger room')
    expect(named(viewer(done.state, [...done.ids]))).toContain('Harbor')
  })
})

describe('P1 for placeholder-classified objects (Kimi): only the count may change', () => {
  it('a private app’s home and an admin-sight-only swarm of someone else: the shown set is identical, only the count moves', () => {
    const other: Swarm = { id: 's_other', name: 'Kestrel', description: '', hue: 1, member_ids: [], created_at: NOW, owner: 'user:p_x', visibility: 'private' }
    const v = viewer('resolved', ['s_ledger'])
    const without = visibleSet([team], [agents[2]], v)
    const withThem = visibleSet([home, team, other], agents, v)
    expect(JSON.stringify({ ...withThem, placeholders: 0 })).toBe(JSON.stringify({ ...without, placeholders: 0 }))
    expect([without.placeholders, withThem.placeholders]).toEqual([0, 2])
  })
})

/** A region and canvas that record listeners and pointer capture, and an engine that records the drag. */
function rig() {
  const listeners = new Map<string, ((e: unknown) => void)[]>()
  const region = {
    addEventListener: (k: string, f: (e: unknown) => void) => void listeners.set(k, [...(listeners.get(k) ?? []), f]),
    removeEventListener: (k: string, f: (e: unknown) => void) => void listeners.set(k, (listeners.get(k) ?? []).filter((x) => x !== f)),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  }
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0 }), style: { cursor: 'grab' } }
  const engine: DragEngine & { [k: string]: ReturnType<typeof vi.fn> } = {
    galaxyHandleAt: vi.fn(() => 'hive:cloud'),
    beginGalaxyDrag: vi.fn(() => true),
    moveGalaxyDrag: vi.fn(),
    endGalaxyDrag: vi.fn(() => ({ id: 'hive:cloud', moved: true, x: 300, y: 200 })),
    cancelGalaxyDrag: vi.fn(),
  }
  const fire = (k: string, e: Record<string, unknown>) => {
    for (const f of listeners.get(k) ?? []) f({ pointerId: 1, button: 0, clientX: 10, clientY: 10, pointerType: 'mouse', target: canvas, stopPropagation: () => undefined, type: k, ...e })
  }
  return { region, canvas, engine, fire }
}

describe('P1-2: a galaxy drag never crosses an identity change', () => {
  it('without a change: the drag is saved once, under the principal that started it', async () => {
    await signInAs(testPerson('a'))
    const r = rig()
    const save = vi.fn()
    let who = 'user:p_a'
    const off = attachGalaxyDrag(r.region as never, r.canvas, r.engine, { principal: () => who, save })
    r.fire('pointerdown', {})
    who = 'user:p_b' // what the viewer says later never moves the write
    r.fire('pointermove', { clientX: 200 })
    r.fire('pointerup', {})
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toBe('user:p_a')
    off()
  }, 24000)   // followups-r6: measured worst 7951 ms (caps lifted; 1 and 3 workers, load to 9.3), about 3x
  it('identity changes mid-drag: cancelled at once, capture released, nothing written under either principal', async () => {
    const a = testPerson('a')
    const b = testPerson('b')
    await signInAs(a)
    const r = rig()
    const save = vi.fn()
    let who = 'user:p_a'
    const off = attachGalaxyDrag(r.region as never, r.canvas, r.engine, { principal: () => who, save })
    r.fire('pointerdown', {})
    r.fire('pointermove', { clientX: 120 })
    expect(r.region.setPointerCapture).toHaveBeenCalledWith(1)
    const done = switchPerson(a, b)
    who = 'user:p_b'
    // synchronously, inside the change itself
    expect(r.engine.cancelGalaxyDrag).toHaveBeenCalledTimes(1)
    expect(r.region.releasePointerCapture).toHaveBeenCalledWith(1)
    await done
    r.fire('pointermove', { clientX: 300 })
    r.fire('pointerup', {})
    expect(r.engine.moveGalaxyDrag).toHaveBeenCalledTimes(1)
    expect(r.engine.endGalaxyDrag).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
    off()
  }, 17000)   // followups-r6: measured worst 5567 ms (caps lifted; 1 and 3 workers, load to 9.3), about 3x
})

describe('r1.3: the drag starts only on the canvas itself (typed identity check)', () => {
  it('a press on anything else (an overlay, the region) starts nothing; on the canvas it starts', async () => {
    await signInAs(testPerson('a'))
    const r = rig()
    const off = attachGalaxyDrag(r.region as never, r.canvas, r.engine, { principal: () => 'user:p_a', save: vi.fn() })
    r.fire('pointerdown', { target: { notTheCanvas: true } })
    r.fire('pointerdown', { target: null })
    expect(r.engine.beginGalaxyDrag).not.toHaveBeenCalled()
    r.fire('pointerdown', {})
    expect(r.engine.beginGalaxyDrag).toHaveBeenCalledTimes(1)
    off()
  }, 10000)   // followups-r6: measured worst 2815 ms (caps lifted; 1 and 3 workers, load to 9.3), about 3x
})

describe('Kimi notes', () => {
  it('no audit or operator surface takes the list helper: only Still’s sheets and Professional’s Swarms', () => {
    // every source file under src, as text, through vite's own glob (no node APIs: the build type-checks this file)
    const sources = import.meta.glob('../**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
    const users = Object.entries(sources)
      .filter(([f, text]) => !/\.test\.tsx?$/.test(f) && text.includes('useShownSwarms'))
      // keys are relative to this folder: '../x/y.ts' is src/x/y.ts, './y.ts' is src/scene/y.ts
      .map(([f]) => (f.startsWith('./') ? `scene/${f.slice(2)}` : f.replace(/^\.\.\//, '')))
    expect(users.sort()).toEqual(['experiences/professional/index.tsx', 'experiences/still/Sheets.tsx', 'scene/viewer.ts'])
  })
})
