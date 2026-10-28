import { describe, expect, it } from 'vitest'
import { SimClient } from './SimClient'

const make = () => new SimClient({seed: 42, latency: false, autoStart: false})
describe('simulated canonical boards and offers', () => {
  it('projects the same goal without changing responsibility during matching', async () => {
    const sim = make()
    const [mind] = await sim.listAgents()
    if (!mind.swarm_id) throw new Error('Seed mind must belong to a swarm')
    const goal = await sim.createGoal(mind.swarm_id, {title: 'Synthetic board continuity', assignee: mind.id})
    const before = await sim.listGoals(mind.swarm_id)
    for (const [scope, entity] of [['grand', undefined], ['swarm', mind.swarm_id], ['mind', mind.id]] as const) {
      expect((await sim.board(scope, entity)).goals.find(g => g.id === goal.id)?.assignee).toBe(mind.id)
    }
    const offers = await sim.matchServices('code-review')
    expect(offers.candidates.length).toBeGreaterThan(0)
    expect(offers.candidates.every(c => c.eligibility === 'unverified' && c.capacity === 'unknown' && !c.verified_capabilities.length)).toBe(true)
    expect(await sim.listGoals(mind.swarm_id)).toEqual(before)
    expect((await sim.matchServices('not-offered')).candidates).toEqual([])
    const [role] = await sim.listRoles()
    const created = await sim.createAgent({name: 'Synthetic role candidate', kind: 'module', model: mind.model, swarm_id: mind.swarm_id, role_id: role.id})
    const roleOffers = await sim.matchServices(role.name.toLowerCase(), 'mind')
    expect(roleOffers.candidates.some(c => c.entity_id === created.id)).toBe(true)
    expect(roleOffers.candidates.every(c => !c.verified_capabilities.length && c.eligibility === 'unverified')).toBe(true)
    expect((await sim.matchServices('not-a-role', 'mind')).candidates).toEqual([])
  })
})
