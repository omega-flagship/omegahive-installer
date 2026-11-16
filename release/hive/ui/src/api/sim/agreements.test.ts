import { describe, expect, it, vi } from 'vitest'
import { SimClient } from './SimClient'
import { SimAgreements } from './agreements'
import type { CreateRequestConnection } from '../types'

// Backstop (sim-commons r2.1): this file runs the sim's real MeTTa commons (a first seed per process, or live
// publishes); its slowest test took 1705 ms in a full default-worker run under load 26, so 3x that. The default seed is
// cached per process (SimClient seed cache), so this only matters under heavy load.
vi.setConfig({ testTimeout: 45000 }) // ~3x the worst case measured under load (followups-r5)
const make = (): CreateRequestConnection => ({ from_swarm: 's_lyra', to_swarm: 's_forge', from_coordinator: 'a_vega01', to_coordinator: 'a_anvl09', purpose: 'Synthetic code review', deliverable: 'Review findings', success: 'Source-bound findings', scopes: [{ kind: 'requests', direction: 'from->to', kinds: ['code-review'] }], days: 7, budget_usd: 0, on_end: 'drain' })
const client = () => new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })
describe('disposable connection review flow', () => {
  it('keeps scopes, coordinators, duration, budget and lifecycle history attached to the exact agreement', async () => {
    const c = client(), body = make(), first = await c.createConnection(body)
    expect(first).toMatchObject({ status: 'active', scopes: body.scopes, budget_usd: 0, allocated_usd: 0, from_coordinator: body.from_coordinator, to_coordinator: body.to_coordinator })
    expect(await c.listConnections('s_kelp')).toEqual([])
    expect((await c.connectionAction(first.id, 'pause')).status).toBe('paused')
    expect((await c.connectionAction(first.id, 'resume')).status).toBe('active')
    expect((await c.connectionAction(first.id, 'renew', 2)).history.map((h) => h.event)).toEqual(['created', 'pause', 'resume', 'renew'])
    await c.connectionAction(first.id, 'revoke')
    await expect(c.connectionAction(first.id, 'renew', 2)).rejects.toMatchObject({ status: 409 })
  })
  it('refuses foreign coordinator, invalid duration and non-finite allocations', async () => {
    const c = client()
    const before = await c.listConnections('s_lyra') // the sim seeds one connection so service grants are visible
    await expect(c.createConnection({ ...make(), from_coordinator: 'a_anvl09' })).rejects.toMatchObject({ status: 400 })
    for (const days of [0, -1, Infinity, 366]) await expect(c.createConnection({ ...make(), days })).rejects.toMatchObject({ status: 400 })
    for (const budget_usd of [-1, Infinity, NaN]) await expect(c.createConnection({ ...make(), budget_usd })).rejects.toMatchObject({ status: 400 })
    expect(await c.listConnections('s_lyra')).toEqual(before) // no refused request created anything
  })
  it('refuses resume after expiry while allowing explicit renewal from now', () => {
    const c = client(); let moment = '2026-10-04T00:00:00Z'
    const agreements = new SimAgreements(c.swarms, () => moment), one = agreements.create(make())
    agreements.action(one.id, 'pause'); moment = '2026-10-12T00:00:00Z'
    expect(() => agreements.action(one.id, 'resume')).toThrow()
    expect(agreements.action(one.id, 'renew', 2).ends_at).toBe('2026-10-14T00:00:00.000Z')
  })
})
