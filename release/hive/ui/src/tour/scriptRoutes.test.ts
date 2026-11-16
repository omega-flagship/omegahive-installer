import { describe, expect, it } from 'vitest'
import type { Route } from '../lib/router'
import type { Store } from '../store/store'
import { buildChapters, type TourCtx } from './script'

/**
 * Demo walk (demo-p2): the tour pointed at stars while the commons opens as a table, and its apps chapter opened the
 * contract fixture in a swarm where it is not set up, in its case-file form, so none of its stage targets existed.
 */
function harness() {
  const went: Route[] = []
  const clicks: string[] = []
  const swarms = {
    s_lyra: { id: 's_lyra', name: 'Lyra', created_at: '2026-01-01', archived_at: null },
    s_kelp: { id: 's_kelp', name: 'Kelp', created_at: '2026-02-01', archived_at: null },
    s_priv: { id: 's_priv', name: 'Quiet room', created_at: '2026-03-01', archived_at: null, visibility: 'private' },
  }
  const store = {
    swarms, agents: {}, beliefs: {}, goals: {}, programs: [{ id: 'contract-fixture', enabled: true }], programSessions: {},
    stopAllOpen: false, paletteOpen: false,
    client: { programHomes: async () => ({ program: 'contract-fixture', homes: [{ swarm_id: 's_gone', why: 'x' }, { swarm_id: 's_priv', why: 'configured' }, { swarm_id: 's_kelp', why: 'configured' }] }) },
  } as unknown as Store
  const el = (name: string) => ({ getAttribute: () => 'false', click: () => clicks.push(name) }) as unknown as HTMLElement
  const ctx: TourCtx = {
    mobile: false, sim: true, store: () => store, go: (r) => went.push(r), sleep: async () => undefined,
    find: (n) => (n === 'commons-view-sky' ? el(n) : null), waitFor: async () => null, freshProgram: () => undefined,
    scene: { overview: () => undefined, dot: () => null, core: () => null },
  }
  return { chapters: buildChapters(ctx), went, clicks, ctx }
}

describe('the tour, as the app is now', () => {
  it('the swarm and commons chapters open the commons by its route (?tab=commons: the constellation), never by a click', async () => {
    const { chapters, went, clicks, ctx } = harness()
    await chapters.find((c) => c.id === 'swarm')!.setup(ctx)
    await chapters.find((c) => c.id === 'commons')!.setup(ctx)
    expect(went).toEqual([{ name: 'swarm', id: 's_lyra', tab: 'commons' }, { name: 'swarm', id: 's_lyra', tab: 'commons' }])
    expect(clicks).toEqual([])
  })
  it('the apps chapter opens the app in its first home the page would open automatically (existing, never private), in the graph view', async () => {
    const { chapters, went, ctx } = harness()
    const apps = chapters.find((c) => c.id === 'programs')!
    await apps.setup(ctx)
    await apps.beats[1].do!(ctx)
    expect(went.at(-1)).toEqual({ name: 'program', id: 'contract-fixture', swarm: 's_kelp', view: 'graph' })
  })
  it('followups-r5: the swarm and commons chapters wait on and show the Constellation itself (swarm-constellation), not the frame that also holds the table', async () => {
    const { ctx } = harness()
    const waited: string[] = []
    const beliefs = { s_lyra: { 'b1': { statement: '(likes a b)', sources: ['x'], tv: { s: 0.9, c: 0.8 } } } }
    const store = { ...ctx.store(), beliefs } as unknown as Store
    const c2: TourCtx = { ...ctx, store: () => store, waitFor: async (n) => { waited.push(n); return null } }
    const chapters = buildChapters(c2)
    await chapters.find((c) => c.id === 'swarm')!.setup(c2)
    await chapters.find((c) => c.id === 'commons')!.setup(c2)
    expect(waited).toEqual(['swarm-constellation', 'swarm-constellation'])
    expect(chapters.find((c) => c.id === 'swarm')!.beats[0].show).toBe('swarm-constellation')
    // no beliefs: no stars are drawn, so the commons' frame (its empty sky) is shown instead of waiting on nothing
    const empty: string[] = []
    const c3: TourCtx = { ...ctx, waitFor: async (n) => { empty.push(n); return null } }
    const bare = buildChapters(c3)
    await bare.find((c) => c.id === 'swarm')!.setup(c3)
    expect(empty).toEqual(['swarm-sky'])
    expect(bare.find((c) => c.id === 'swarm')!.beats[0].show).toBe('swarm-sky')
  })
  it('followups-r5: the Constellation branch carries its own target; the guided demos try it first', async () => {
    const fsName = 'node:fs'
    const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
    const read = (rel: string) => readFileSync(new URL(rel, import.meta.url).pathname, 'utf8')
    expect(read('../features/swarm/SwarmView.tsx')).toMatch(/<Constellation [^\n]*tour="swarm-constellation" \/>/)
    expect(read('../features/swarm/Constellation.tsx')).toContain('className="relative h-full w-full" data-tour={tour}')
    for (const f of ['../features/guided/scripts/brain.ts', '../features/guided/scripts/hive.ts']) {
      const src = read(f)
      expect(src).not.toMatch(/target: \[\{ tour: 'swarm-sky' \}/)
      expect(src).toContain("{ tour: 'swarm-constellation' }, { tour: 'swarm-sky' }")
    }
  })
})
