import { describe, expect, it, vi } from 'vitest'

/**
 * The awake apps (Ask-and-apps contract R1.1 §3): the simulator answers GET /api/me/apps like the host's shape (person
 * apps first, then swarm apps with where they work; ordered), and opening goes to the app's own page (a swarm app in its
 * swarm), "more" to the full Apps page. INVENTED data, no network.
 */
const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
const { SimClient } = await import('../api/sim/SimClient')
const { openAwakeRow, openAllApps, startAwakeApps } = await import('./awakeApps')
const { useHive } = await import('../store/store')
const { useMyApps } = await import('../features/apps/myApps')

describe('the simulator’s GET /api/me/apps', () => {
  it('lists enabled apps in the host’s shape: person apps first, swarm apps with their swarm, ordered', async () => {
    const sim = new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })
    const { apps } = await sim.myApps()
    expect(apps.length).toBeGreaterThan(0)
    expect(apps.map((a) => a.order)).toEqual(apps.map((_, i) => i))
    const firstSwarm = apps.findIndex((a) => a.placement === 'swarm')
    if (firstSwarm >= 0) expect(apps.slice(firstSwarm).every((a) => a.placement === 'swarm' && a.open.kind === 'swarm' && !!a.open.swarm_id)).toBe(true)
    for (const a of apps) expect(a.open.kind).toBe(a.placement)
  })
})

describe('opening from the awake state', () => {
  it('a person app opens its page; a swarm app opens in its swarm; more opens the full list', () => {
    openAwakeRow({ id: 'notes', name: 'Notes', placement: 'person', open: { kind: 'person' } })
    expect(loc.hash).toMatch(/notes/)
    expect(loc.hash).not.toMatch(/s1/)
    openAwakeRow({ id: 'board', name: 'Board', placement: 'swarm', open: { kind: 'swarm', swarm_id: 's1', swarm_name: 'Studio' } })
    expect(loc.hash).toMatch(/board/)
    expect(loc.hash).toMatch(/s1/)
    openAllApps()
    expect(loc.hash).toMatch(/programs|apps/)
  })
})

describe('two clients (Codex 3 Nov): a switch of client never loads, or commits, through the old one', () => {
  const row = (id: string) => ({ id, name: id, placement: 'person' as const, open: { kind: 'person' as const } })

  it('A is slow; the client becomes B; A is never asked again, its late list is dropped, and B’s list stands', async () => {
    let releaseA!: (v: { apps: ReturnType<typeof row>[] }) => void
    let askedA = 0, askedB = 0
    const A = { myApps: () => { askedA++; return new Promise<{ apps: ReturnType<typeof row>[] }>((r) => { releaseA = r }) } }
    const B = { myApps: async () => { askedB++; return { apps: [row('b-app')] } } }
    useHive.setState({ client: A as never })
    const stopA = startAwakeApps(A)
    expect(askedA).toBe(1)
    useHive.setState({ client: B as never })
    expect(askedA).toBe(1)
    stopA()
    const stopB = startAwakeApps(B)
    await Promise.resolve(); await Promise.resolve()
    expect(askedB).toBe(1)
    releaseA({ apps: [row('a-secret')] })
    await new Promise((r) => setTimeout(r, 0))
    expect(useMyApps.getState().apps.map((a) => a.id)).toEqual(['b-app'])
    stopB()
  })
})

describe('identity colour (contract R1.1 §3): always a CSS colour the shell resolved', () => {
  it('the app’s accent in the chosen identity set, else a stable colour from its id', async () => {
    const { identityColourOf } = await import('./awakeApps')
    const progs = [{ id: 'notes', app: { theme: { accent: '#ff7a00' } } }] as never
    expect(identityColourOf('notes', progs, 'owner')).toBe('#ff7a00')
    const a = identityColourOf('board', progs, 'owner')
    expect(a).toMatch(/^#[0-9a-f]{6}$/)
    expect(identityColourOf('board', null, 'owner')).toBe(a)
  })
})
