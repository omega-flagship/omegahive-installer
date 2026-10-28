import { describe, expect, it } from 'vitest'
import type { Goal } from '../api/types'
import { ARM_MS } from './decisionGate'
import { confirmGoalChange, GOAL_TO, goalBound, goalDrift, goalEffect, seenOf, verbFor } from './goalDecision'

const goal = (over: Partial<Goal> = {}): Goal => ({
  id: 'g_sheliak',
  swarm_id: 's_lyra',
  parent_id: null,
  title: 'Book telescope time for the Sheliak eclipse',
  detail: '',
  priority: 0.5,
  status: 'stalled',
  created_by: 'user:operator',
  claimed_by: 'agent:a_vega01',
  result: null,
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-05T09:00:00Z',
  ...over,
})

describe('Review D1: goal decisions bind to the goal as inspected', () => {
  const seen = seenOf(goal())

  it('the same goal is ready; every inspected field that moves refuses, by name', () => {
    expect(goalBound(seen, goal(), 'cancelled')).toEqual({ kind: 'ready' })
    expect(goalBound(seen, goal({ status: 'claimed' }), 'cancelled')).toEqual({ kind: 'changed', fields: ['status'] })
    expect(goalBound(seen, goal({ claimed_by: 'agent:a_other' }), 'cancelled')).toEqual({ kind: 'changed', fields: ['holder'] })
    expect(goalBound(seen, goal({ claimed_by: null }), 'cancelled')).toEqual({ kind: 'changed', fields: ['holder'] })
    expect(goalBound(seen, goal({ swarm_id: 's_other' }), 'cancelled')).toEqual({ kind: 'changed', fields: ['swarm'] })
    expect(goalBound(seen, goal({ updated_at: '2026-10-05T09:01:00Z' }), 'cancelled')).toEqual({ kind: 'changed', fields: ['version'] })
    expect(goalBound(seen, goal({ title: 'Something else' }), 'cancelled').kind).toBe('changed')
  })

  it('a goal that is gone, or already where the change would put it, refuses', () => {
    expect(goalBound(seen, undefined, 'cancelled')).toEqual({ kind: 'gone' })
    expect(goalBound(seen, goal({ status: 'cancelled' }), 'cancelled').kind).toBe('closed')
    expect(goalDrift(seen, goal({ status: 'cancelled' }), 'cancelled')).toMatch(/cancelled now.*Nothing was decided/)
    expect(goalDrift(seen, undefined, 'done')).toMatch(/no longer on the hive/)
    expect(goalDrift(seen, goal(), 'done')).toBeNull()
  })

  it('the inline confirm needs a fresh, non-repeat activation and an unchanged goal', () => {
    const t = 1000
    expect(confirmGoalChange(seen, 'cancelled', t, goal(), { at: t + 10 })).toMatchObject({ ok: false, why: expect.stringMatching(/just appeared/) })
    expect(confirmGoalChange(seen, 'cancelled', t, goal(), { at: t + ARM_MS, repeat: true })).toMatchObject({ ok: false, why: expect.stringMatching(/held key/i) })
    expect(confirmGoalChange(seen, 'cancelled', t, goal({ status: 'open', claimed_by: null }), { at: t + ARM_MS })).toMatchObject({ ok: false, why: expect.stringMatching(/changed while it was open \(status, holder\)/) })
    expect(confirmGoalChange(seen, 'cancelled', t, goal(), { at: t + ARM_MS })).toEqual({ ok: true })
  })

  it('verbs map both ways', () => {
    for (const [v, to] of Object.entries(GOAL_TO)) expect(verbFor(to)).toBe(v)
    expect(verbFor('claimed')).toBeNull()
  })

  it('says what is affected, following the hive’s own rules', () => {
    expect(goalEffect(goal(), 'cancelled', 'Vega')).toMatch(/cannot be re-opened.*Vega is told to stop and acknowledge/)
    expect(goalEffect(goal({ status: 'done' }), 'open', null)).toMatch(/refuses to re-open/)
    expect(goalEffect(goal({ status: 'stalled' }), 'open', 'Vega')).toMatch(/no holder.*Vega no longer holds it/)
    expect(goalEffect(goal({ status: 'submitted' }), 'done', null)).toMatch(/waiting for its reviewer/)
    expect(goalEffect(goal({ claimed_by: null }), 'failed', null)).toMatch(/re-opened later/)
  })
})
