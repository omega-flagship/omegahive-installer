import { describe, expect, it } from 'vitest'
import type { Goal, GoalGrant, Swarm } from '../../api/types'
import { CODE_SWARM_NAME, grantProbe, liveCodingWork } from './codingWork'

const at = '2026-10-03T12:00:00.000Z'
const swarm = (id: string, name: string): Swarm => ({ id, name, description: '', hue: 200, member_ids: [], created_at: at })
const goal = (id: string, swarm_id: string, p: Partial<Goal> = {}): Goal => ({
  id, swarm_id, parent_id: null, title: id, detail: '', priority: 0.5, status: 'open', created_by: 'user:operator', claimed_by: null, result: null, created_at: at, updated_at: at, ...p,
})
const grant = (goal_id: string, workspace_id: string | null, created_at = at): GoalGrant => ({
  id: `gr_${goal_id}_${workspace_id}`, goal_id, principal: 'user:operator', scope: 'edit', workspace_id, created_by: 'user:operator', created_at, expires_at: 0, revoked_at: null, active: false,
})

describe('live coding work', () => {
  const swarms = { s_code: swarm('s_code', CODE_SWARM_NAME), s_a: swarm('s_a', 'Alpha'), s_b: swarm('s_b', 'Beta') }
  const goals = {
    g1: goal('g1', 's_code', { detail: 'target=repo:omegacode repository=omegacode commit=abc' }),
    g2: goal('g2', 's_code', { status: 'done' }),
    g3: goal('g3', 's_a', { status: 'claimed', claimed_by: 'a_1' }),
    g4: goal('g4', 's_a'),
    g5: goal('g5', 's_b', { status: 'claimed', claimed_by: 'a_2' }),
  }

  it('probes code-swarm goals and goals a mind holds, never finished or unheld ones elsewhere', () => {
    expect(grantProbe(goals, swarms)).toEqual(['g1', 'g3', 'g5'])
    expect(grantProbe(goals, swarms, 1)).toEqual(['g1'])
  })

  it('lists open work in coding swarms, known workspaces first, newest grant first', () => {
    const items = liveCodingWork(goals, swarms, {
      g3: [grant('g3', 'ws_old', '2026-10-01T00:00:00Z'), grant('g3', 'ws_new', '2026-10-02T00:00:00Z'), grant('g3', null)],
      g5: [],
    })
    // s_a becomes a coding swarm through g3's grant, so its open g4 is listed too; s_b has no grants
    expect(items.map((i) => i.goal.id)).toEqual(['g3', 'g1', 'g4'])
    expect(items[0].workspaces).toEqual(['ws_new', 'ws_old'])
    expect(items.find((i) => i.goal.id === 'g1')?.repository).toBe('omegacode')
  })

  it('is empty without a code swarm or grants', () => {
    expect(liveCodingWork({ g4: goals.g4 }, { s_a: swarms.s_a }, {})).toEqual([])
  })
})
