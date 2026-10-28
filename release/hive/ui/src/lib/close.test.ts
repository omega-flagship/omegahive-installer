import { describe, expect, it } from 'vitest'
import { closeDelta, href, parentOf, parse } from './router'

describe('closing a page', () => {
  it('steps back to the previous in-app page (swarm, then tasks, then close lands on the swarm)', () => {
    const trail = ['#/', '#/swarms/s1', '#/goals/s1']
    expect(closeDelta(trail, 2, parse('#/goals/s1'))).toBe(-1)
  })
  it('skips entries of the same page so a Lab run closes the whole Lab', () => {
    const trail = ['#/swarms', '#/lab', '#/lab/suite-a', '#/lab/run/r1']
    expect(closeDelta(trail, 3, parse('#/lab/run/r1'))).toBe(-3)
  })
  it('has nowhere to go back to on a deep link', () => {
    expect(closeDelta(['#/usage'], 0, parse('#/usage'))).toBeNull()
    expect(closeDelta(['#/lab', '#/lab/x'], 1, parse('#/lab/x'))).toBeNull()
  })
  it('does not guess past entries it never saw (history from before a reload without storage)', () => {
    expect(closeDelta([undefined, '#/goals'], 1, parse('#/goals'))).toBeNull()
  })
  it('falls back to the logical parent', () => {
    expect(parentOf(parse('#/swarms/s1'))).toEqual({ name: 'swarms' })
    expect(parentOf(parse('#/swarms/new'))).toEqual({ name: 'swarms' })
    expect(parentOf(parse('#/connect?swarm=s1'))).toEqual({ name: 'swarm', id: 's1' })
    expect(parentOf(parse('#/connect'))).toEqual({ name: 'swarms' })
    expect(parentOf(parse('#/lab/run/r1'))).toEqual({ name: 'lab' })
    expect(parentOf(parse('#/roles/r1'))).toEqual({ name: 'roles' })
    expect(parentOf(parse('#/program/p1/s1'))).toEqual({ name: 'programs' })
    expect(parentOf(parse('#/usage'))).toEqual({ name: 'hive' })
    expect(parentOf(parse('#/goals/s1'))).toEqual({ name: 'hive' })
  })
  it('every parent is a real route', () => {
    for (const h of ['#/swarms/s1', '#/connect?swarm=s1', '#/lab/dim/x', '#/models/openrouter', '#/code/t1', '#/approvals/rules', '#/dot/a1/program/p1']) {
      const p = parentOf(parse(h))
      expect(parse(href(p))).toMatchObject({ name: p.name })
    }
  })
})
