import { describe, expect, it } from 'vitest'
import type { Agent, Approval, Goal, Swarm } from '../sdk'
import { buildOutline } from './outline'
import { computeLayout, FREE, pendingDecisions } from './layout'

const agent = (id: string, name: string, swarm_id: string | null, status: Agent['status'] = 'awake'): Agent =>
  ({ id, name, swarm_id, status, kind: 'omega', model: 'x/m', persona: '', hue: 200, driver: 'd', budget_usd: 1, spent_usd: 0, connected: true, last_active_at: null, created_at: '2026-10-01T00:00:00Z' }) as Agent
const swarm = (id: string, name: string, member_ids: string[]): Swarm => ({ id, name, description: '', hue: 120, member_ids, created_at: '2026-10-01T00:00:00Z' })
const goal = (id: string, swarm_id: string, status: Goal['status'], updated = '2026-10-02T00:00:00Z'): Goal =>
  ({ id, swarm_id, parent_id: null, title: `Goal ${id} with a long, long title that would never fit a sticky`, detail: '', priority: 0.5, status, created_by: 'user:operator', claimed_by: null, result: null, created_at: updated, updated_at: updated }) as Goal
const approval = (id: string, agent_id: string, status: Approval['status'] = 'pending', risk: Approval['risk'] = 'high'): Approval => ({ id, agent_id, skill: 'shell', command: `(shell "${id}")`, reason: 'r', risk, status, decided_by: null, created_at: '2026-10-04T10:00:00Z', decided_at: null })

function hive() {
  const agents: Record<string, Agent> = {}
  for (const a of [
    agent('m1', 'Mira', 's1'),
    agent('m2', 'Mira', 's2', 'asleep'), // same name, other swarm
    agent('m3', 'Orin', 's1'),
    agent('m4', 'Loner', null, 'asleep'),
    agent('m5', 'Stray', 'gone-swarm'),
  ])
    agents[a.id] = a
  const swarms: Record<string, Swarm> = { s1: swarm('s1', 'Research', ['m1', 'm3']), s2: swarm('s2', 'Ops', ['m2']), s3: swarm('s3', 'Empty', []) }
  const goals: Record<string, Goal> = {}
  // s1 gets 14 goals: more than the board pins (8 active + done), so some are off the board
  for (let i = 0; i < 10; i++) goals[`g${i}`] = goal(`g${i}`, 's1', 'open', `2026-10-02T00:00:0${i}Z`)
  for (let i = 10; i < 14; i++) goals[`g${i}`] = goal(`g${i}`, 's1', 'done')
  goals.g20 = goal('g20', 's2', 'stalled')
  goals.g30 = goal('g30', 'unknown-swarm', 'open') // a goal whose swarm is not loaded
  const approvals: Record<string, Approval> = {
    p1: approval('p1', 'm1', 'pending', 'low'),
    p2: approval('p2', 'm1', 'pending', 'high'),
    p3: approval('p3', 'm2'),
    p4: approval('p4', 'm3', 'approved'),
    p5: approval('p5', 'ghost'), // requester not on the board
  }
  return { agents, swarms, goals, approvals }
}

describe('board outline', () => {
  it('lists every swarm, mind, goal and pending decision exactly once', () => {
    const h = hive()
    const layout = computeLayout(Object.values(h.agents), Object.values(h.swarms), Object.values(h.goals), pendingDecisions(h.approvals))
    const o = buildOutline(h.agents, h.swarms, h.goals, h.approvals, (k) => layout.items.has(k))

    const minds = o.groups.flatMap((g) => g.minds.map((m) => m.id)).sort()
    expect(minds).toEqual(Object.keys(h.agents).sort())
    const goals = o.groups.flatMap((g) => g.goals.map((x) => x.id)).sort()
    expect(goals).toEqual(Object.keys(h.goals).sort())
    expect(o.decisions.map((d) => d.id).sort()).toEqual(['p1', 'p2', 'p3', 'p5'])
    expect(o.groups.filter((g) => g.isSwarm).map((g) => g.id).sort()).toEqual(['s1', 's2', 's3'])
    expect(o.count).toBe(4 + 3 + 5 + 16)
  })

  it('keeps entities the board does not draw reachable, and marks them', () => {
    const h = hive()
    const layout = computeLayout(Object.values(h.agents), Object.values(h.swarms), Object.values(h.goals), pendingDecisions(h.approvals))
    const o = buildOutline(h.agents, h.swarms, h.goals, h.approvals, (k) => layout.items.has(k))
    const s1 = o.groups.find((g) => g.id === 's1')!
    expect(s1.goals.filter((g) => g.onBoard).length).toBeLessThan(s1.goals.length)
    expect(s1.goals.filter((g) => !g.onBoard).length).toBeGreaterThan(0)
    // every mind has a board position, so every mind can be located and opened
    expect(o.groups.flatMap((g) => g.minds).every((m) => m.onBoard)).toBe(true)
    // stray minds and goals land under Unassigned rather than vanishing
    const free = o.groups.find((g) => g.id === FREE)!
    expect(free.isSwarm).toBe(false)
    expect(free.minds.map((m) => m.id).sort()).toEqual(['m4', 'm5'])
    expect(free.goals.map((g) => g.id)).toEqual(['g30'])
  })

  it('decisions carry requester, swarm and risk order; minds carry what they wait on', () => {
    const h = hive()
    const o = buildOutline(h.agents, h.swarms, h.goals, h.approvals, () => true)
    expect(o.decisions[0].risk).toBe('high')
    const p3 = o.decisions.find((d) => d.id === 'p3')!
    expect(p3).toMatchObject({ agentId: 'm2', agentName: 'Mira', swarmName: 'Ops', key: 'decision:p3' })
    expect(o.decisions.find((d) => d.id === 'p5')).toMatchObject({ agentName: null, swarmName: null })
    const mira1 = o.groups.flatMap((g) => g.minds).find((m) => m.id === 'm1')!
    expect(mira1.asks).toBe(2)
    // two minds named Mira stay distinct entries with their own keys
    expect(o.groups.flatMap((g) => g.minds).filter((m) => m.name === 'Mira').map((m) => m.key).sort()).toEqual(['mind:m1', 'mind:m2'])
  })

  it('an empty hive is an empty outline', () => {
    expect(buildOutline({}, {}, {}, {}, () => false)).toEqual({ decisions: [], groups: [], count: 0 })
  })
})
