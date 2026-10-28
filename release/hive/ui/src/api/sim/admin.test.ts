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

  it('lists, sets and removes spending limits, with the per-swarm default', async () => {
    const c = sim()
    const rows = await c.listBudgets()
    expect(rows.some((r) => r.origin === 'default' && r.limit_usd === 500)).toBe(true)
    expect(rows.find((r) => r.scope === 'hive')!.spent_usd).toBeGreaterThan(0)
    const added = await c.setBudget({ scope: 'swarm:s_lyra', period: 'month', limit_usd: 75 })
    const after = await c.listBudgets()
    expect(after.some((r) => r.id === `default:swarm:s_lyra`)).toBe(false)
    expect(after.find((r) => r.id === (added as { id: string }).id)!.limit_usd).toBe(75)
    await c.removeBudget((added as { id: string }).id)
    expect((await c.listBudgets()).some((r) => r.id === 'default:swarm:s_lyra')).toBe(true)
    await expect(c.removeBudget('default:swarm:s_lyra')).rejects.toMatchObject({ status: 400 })
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
