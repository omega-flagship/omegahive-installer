// Purpose: tests of the simulator's admin surfaces (health, people, roles, code targets, the stored spending rules, the Limits view and what is held against each limit) and of the store's roles state.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../client'
import { useHive } from '../../store/store'
import { SimClient } from './SimClient'

const sim = () => new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })

describe('simulator admin surfaces', () => {
  it('reports health per mind, worst first, with totals that add up', async () => {
    const c = sim()
    const h = await c.health()
    expect(h.minds.length).toBe(c.agents.size)
    expect(h.totals.high + h.totals.medium + h.totals.low + h.totals.ok).toBe(h.minds.length)
    expect(h.minds[0].health).toBe('high')
    expect(h.minds.some((m) => m.issues.some((i) => !i.recent))).toBe(true)
    const lyra = await c.health('s_lyra')
    expect(lyra.minds.every((m) => m.swarm_id === 's_lyra')).toBe(true)
  })

  it('lists people and invitations (read-only)', async () => {
    const c = sim()
    const p = await c.listPeople()
    expect(p.people.length).toBeGreaterThan(0)
    expect(p.invites.some((i) => i.status === 'pending')).toBe(true)
    expect((c as unknown as Record<string, unknown>).invite).toBeUndefined()
    expect(await c.me()).toMatchObject({ kind: 'password', role: 'admin' })
  })

  it('keeps roles in memory: create, update, duplicate, remove', async () => {
    const c = sim()
    const before = await c.listRoles()
    expect(before.length).toBeGreaterThan(0)
    expect(before.find((r) => r.id === 'r_analyst')!.minds).toContain('a_vega01')
    const r = await c.createRole({ name: 'Scout', prompt: 'You are {name}.' })
    await expect(c.createRole({ name: 'scout' })).rejects.toBeInstanceOf(ApiError)
    const u = await c.updateRole(r.id, { summary: 'Finds things', rules: [{ skill: 'web-search', mode: 'allow' }] })
    expect(u).toMatchObject({ summary: 'Finds things', rules: [{ skill: 'web-search', mode: 'allow' }] })
    const d = await c.duplicateRole(r.id)
    expect(d.name).toBe('Scout copy')
    expect((await c.removeRole(r.id)).ok).toBe(true)
    expect((await c.listRoles()).map((x) => x.id)).not.toContain(r.id)
    await expect(c.updateRole(r.id, {})).rejects.toMatchObject({ status: 404 })
  })

  it('lists code targets that cannot be opened in the demo, except the one invented fixture repository', async () => {
    const t = await sim().codeTargets()
    expect(t.length).toBeGreaterThan(0)
    expect(t.filter((x) => x.id !== 'repo:sim-suggestions').every((x) => x.openable === false)).toBe(true)
    expect(t.filter((x) => x.openable).map((x) => x.id)).toEqual(['repo:sim-suggestions'])
  })

  it('lists, sets and removes the stored spending rules, with nothing derived', async () => {
    const c = sim()
    const rows = await c.listBudgets()
    expect(rows.every((r) => r.origin === 'rule')).toBe(true)                  // no default row for a swarm
    expect(rows.some((r) => r.scope === 'swarm:s_lyra')).toBe(false)
    expect(rows.find((r) => r.scope === 'hive')!.spent_usd).toBeGreaterThan(0)
    const added = await c.setBudget({ scope: 'swarm:s_lyra', period: 'month', limit_usd: 75 })
    expect((await c.listBudgets()).find((r) => r.id === (added as { id: string }).id)!.limit_usd).toBe(75)
    await c.removeBudget((added as { id: string }).id)
    expect((await c.listBudgets()).some((r) => r.scope === 'swarm:s_lyra')).toBe(false)
    await expect(c.removeBudget((added as { id: string }).id)).rejects.toMatchObject({ status: 404 })
  })

  it('answers the Limits view in three parts and lists an old form default on a mind once it has one', async () => {
    const c = sim()
    const view = (await c.budgetLimitsView()) as { hive: { cap: { key: string } }; people: { person_id: string }[]; caps: { key: string }[]; old_defaults: { kind: string; agent_id?: string }[] }
    expect(view.hive.cap.key).toBe('hive:month')
    expect(view.people.map((p) => p.person_id).sort()).toEqual(['p_ada', 'p_ines', 'p_tomas'])
    expect(view.old_defaults.map((o) => o.agent_id ?? o.kind)).toEqual(['a_qnch11', 'a_wisp12', 'swarm'])   // $10 and $5 caps, and Kelp's $500
    await c.patchAgent('a_nori06', { budget_usd: 5 })
    const after = (await c.budgetLimitsView()) as typeof view
    expect(after.old_defaults.find((o) => o.kind === 'mind')).toMatchObject({ agent_id: 'a_nori06' })
  })

  it('shows what open calls hold against each limit, as the hive does, until they settle by themselves', async () => {
    const c = sim()
    const held = async (scope: string, period = 'month') => (await c.listBudgets()).find((r) => r.scope === scope && r.period === period)!.held_usd
    // the hive settles a call unknown for an hour at its worst case (cost_reservations.expire_unknown), so of the seeded
    // calls the ones unknown for 2, 18 and 33 minutes (the last a free model's one-micro-dollar floor) and the two in
    // flight are still held
    expect(await held('hive')).toBeCloseTo(0.175401, 6)          // every open call counts against the hive
    expect(await held('swarm:s_forge')).toBeCloseTo(0.0405, 6)   // the two Forge calls still in flight
    await c.setBudget({ scope: 'swarm:s_lyra', period: 'month', limit_usd: 75 })
    expect(await held('swarm:s_lyra')).toBeCloseTo(0.1349, 6)    // a rule set after the calls counts them too (Deneb's, Mira's)
    expect(await held('agent:a_deneb2', 'day')).toBeCloseTo(0.0731, 6)   // and so does each of the mind's own limits
    // nobody releases a held call by hand: an hour on, the hive settles every unknown one by itself; calls in flight stay
    const realNow = Date.now
    Date.now = () => realNow() + 61 * 60_000
    try {
      expect(await held('swarm:s_lyra')).toBe(0)
      expect(await held('agent:a_deneb2', 'day')).toBe(0)
      expect(await held('hive')).toBeCloseTo(0.0405, 6)
    } finally {
      Date.now = realNow
    }
  })
})

describe('store roles never stay null forever', () => {
  afterEach(() => {
    useHive.getState().client?.disconnect()
    vi.unstubAllGlobals()
  })
  it('marks a client without roles as unsupported, and a failure as an error', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    const c = sim()
    useHive.setState({ client: c, roles: null, rolesState: 'idle' })
    await useHive.getState().loadRoles()
    expect(useHive.getState()).toMatchObject({ rolesState: 'ready' })
    expect(useHive.getState().roles!.length).toBeGreaterThan(0)

    const broken = sim()
    broken.listRoles = () => Promise.reject(new ApiError(500, 'internal', 'boom'))
    useHive.setState({ client: broken, roles: null, rolesState: 'idle' })
    await expect(useHive.getState().loadRoles()).rejects.toBeInstanceOf(ApiError)
    expect(useHive.getState()).toMatchObject({ rolesState: 'error', roles: null })

    const bare = sim() as unknown as Record<string, unknown>
    bare.listRoles = undefined
    useHive.setState({ client: bare as unknown as SimClient, roles: null, rolesState: 'idle' })
    await useHive.getState().loadRoles()
    expect(useHive.getState().rolesState).toBe('unsupported')
  })
})
