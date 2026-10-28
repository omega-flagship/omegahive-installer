import { describe, expect, it } from 'vitest'
import type { Agent, Swarm } from '../../api/types'
import { ancestorPath, teamStructure } from './team'
const swarm = (id: string, extra: Partial<Swarm> = {}): Swarm => ({ id, name: id, description: '', hue: 0, member_ids: [], created_at: '', ...extra })
const mind = (id: string, swarm_id: string): Agent => ({ id, name: id, swarm_id, kind: 'omega', model: 'mock', persona: '', hue: 0, status: 'created', driver: 'mock', budget_usd: 0, spent_usd: 0, connected: false, last_active_at: null, created_at: '' })
describe('explicit swarm hierarchy', () => {
  it('never promotes first member or a foreign mind to coordinator', () => {
    const a = mind('a', 's'), foreign = mind('foreign', 'other')
    expect(teamStructure(swarm('s', { member_ids: ['a'] }), { a }, {}).coordinator).toBeUndefined()
    expect(teamStructure(swarm('s', { member_ids: ['a', 'foreign'], coordinator_id: 'foreign' }), { a, foreign }, {}).coordinator).toBeUndefined()
  })
  it('separates the explicit coordinator and keeps child swarms under their actual parent mind', () => {
    const a = mind('a', 's'), b = mind('b', 's')
    const child = swarm('child', { parent_swarm_id: 's', parent_mind_id: 'b' })
    const wrong = swarm('wrong', { parent_swarm_id: 'other', parent_mind_id: 'a' })
    const team = teamStructure(swarm('s', { member_ids: ['a', 'b', 'a'], coordinator_id: 'a', child_swarm_ids: ['child', 'wrong', 'missing', 'child'] }), { a, b }, { child, wrong })
    expect(team.coordinator?.id).toBe('a')
    expect(team.workers.map((a) => a.id)).toEqual(['b'])
    expect(team.children.map((s) => s.id)).toEqual(['child'])
  })
  it('builds breadcrumbs in root-first order without synthesizing missing parents', () => {
    const root = swarm('root'), middle = swarm('middle', { parent_swarm_id: 'root' }), leaf = swarm('leaf', { parent_swarm_id: 'middle' })
    expect(ancestorPath(leaf, { root, middle, leaf })).toEqual({ ancestors: [root, middle], incomplete: false })
    expect(ancestorPath(leaf, { leaf })).toEqual({ ancestors: [], incomplete: true })
  })
  it('terminates cycles and reports incomplete hierarchy', () => {
    const a = swarm('a', { parent_swarm_id: 'b' }), b = swarm('b', { parent_swarm_id: 'a' })
    expect(ancestorPath(a, { a, b })).toEqual({ ancestors: [b], incomplete: true })
  })
})
