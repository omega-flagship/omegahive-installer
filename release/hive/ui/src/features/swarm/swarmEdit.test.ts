import { describe, expect, it } from 'vitest'
import type { ConnectionAgreement } from '../../api/types'
import { normKinds, notEmptyWords, parentProblem, serviceGrants } from './swarmEdit'

const minds = { a1: { id: 'a1', swarm_id: 's1' }, a2: { id: 'a2', swarm_id: 's2' }, a3: { id: 'a3', swarm_id: 's3' }, a4: { id: 'a4', swarm_id: 's4' }, a5: { id: 'a5', swarm_id: 's5' } }

describe('nesting a swarm inside a mind', () => {
  it('needs a mind in another swarm', () => {
    expect(parentProblem('s1', 'a1', {}, minds)).toMatch(/another swarm/)
    expect(parentProblem('s1', 'nope', {}, minds)).toMatch(/another swarm/)
    expect(parentProblem('s1', 'a2', {}, minds)).toBeNull()
  })
  it('never cycles', () => {
    // s2 sits inside a1 (of s1): putting s1 inside a2 would loop
    expect(parentProblem('s1', 'a2', { s2: { parent_mind_id: 'a1' } }, minds)).toMatch(/inside itself/)
  })
  it('is at most four levels deep', () => {
    const swarms = { s2: { parent_mind_id: 'a3' }, s3: { parent_mind_id: 'a4' }, s4: { parent_mind_id: null } }
    expect(parentProblem('s1', 'a2', swarms, minds)).toBeNull()
    expect(parentProblem('s1', 'a2', { ...swarms, s4: { parent_mind_id: 'a5' } }, minds)).toMatch(/four levels/)
  })
})

describe('swarm changes in words', () => {
  it('explains a refused delete', () => {
    expect(notEmptyWords('only an empty swarm can be deleted; this one has minds, goals')).toMatch(/still has minds, tasks\. Move/)
    expect(notEmptyWords('nope')).toMatch(/Only an empty swarm/)
  })
  it('normalises service kinds', () => {
    expect(normKinds(' plan, code-review  plan ')).toEqual(['code-review', 'plan'])
  })
})

describe('service grants through connections', () => {
  const c = (over: Partial<ConnectionAgreement>): ConnectionAgreement => ({
    id: 'c1', from_swarm: 's1', to_swarm: 's2', purpose: 'p', deliverable: 'd', success: 's', from_coordinator: 'a1', to_coordinator: 'a2', scopes: [],
    starts_at: '', ends_at: null, until_revoked: false, review_at: null, budget_usd: 1, allocated_usd: 0, on_end: 'drain', status: 'active', created_by: 'user:jon', created_at: '', history: [], summary: '', note: '', ...over,
  })
  it('splits by who may ask whom, and ignores ended ones', () => {
    const list = [
      c({ scopes: [{ kind: 'requests', direction: 'from->to', kinds: ['review', 'plan'] }] }),
      c({ id: 'c2', scopes: [{ kind: 'requests', direction: 'to->from', kinds: ['triage'] }] }),
      c({ id: 'c3', status: 'revoked', scopes: [{ kind: 'requests', direction: 'from->to', kinds: ['x'] }] }),
      c({ id: 'c4', from_swarm: 's8', to_swarm: 's9', scopes: [{ kind: 'requests', direction: 'from->to', kinds: ['y'] }] }),
    ]
    const g = serviceGrants('s2', list)
    expect(g.toUs.map((x) => [x.connection.id, x.asker, x.kinds])).toEqual([['c1', 's1', ['plan', 'review']]])
    expect(g.fromUs.map((x) => [x.connection.id, x.server, x.kinds])).toEqual([['c2', 's1', ['triage']]])
  })
})
