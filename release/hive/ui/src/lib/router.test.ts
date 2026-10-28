import { describe, expect, it } from 'vitest'
import { href, openInDesign, parse, sameCreation } from './router'

describe('shared coding workspace links', () => {
  it('retains a mind Tools tab across navigation', () => {
    const route = { name: 'dot' as const, id: 'synthetic', tab: 'tools' as const }
    expect(parse(href(route))).toEqual(route)
  })
  it('retains the existing task, workspace and repository across navigation', () => {
    const route = { name: 'code' as const, task: 'g_existing', workspace: 'ws_shared', repository: 'synthetic + metta' }
    expect(parse(href(route))).toEqual({ ...route, target: undefined })
  })
  it('retains ordinary target navigation', () => {
    expect(parse(href({ name: 'code', target: 'repo:synthetic' }))).toMatchObject({ name: 'code', target: 'repo:synthetic', workspace: undefined })
  })
})

describe('canonical board links (Boards is now a view of Tasks)', () => {
  it('preserves mind and swarm scope without losing escaped identifiers, now on Tasks', () => {
    for (const [route, task] of [[{ name: 'boards' as const, mind: 'mind + one' }, { name: 'tasks', mind: 'mind + one' }], [{ name: 'boards' as const, swarm: 'swarm/one' }, { name: 'tasks', swarm: 'swarm/one' }]] as const) {
      expect(href(route)).toMatch(/^#\/tasks\?/)
      expect(parse(href(route))).toEqual(task)
    }
    expect(parse(href({ name: 'boards' }))).toEqual({ name: 'tasks' })
  })
})

describe('Motivations above Tasks: routes and redirects', () => {
  it('round-trips every Tasks filter, escaped', () => {
    const route = { name: 'tasks' as const, swarm: 's/1', mind: 'a 2', motivation: 'mo_x&y', view: 'list' as const, task: 'g?1' }
    expect(parse(href(route))).toEqual(route)
    expect(href({ name: 'tasks', view: 'board' })).toBe('#/tasks')
    expect(parse('#/tasks?motivation=none')).toEqual({ name: 'tasks', motivation: 'none' })
  })
  it('old Goals and Boards links land on Tasks with the same filter (links never break)', () => {
    expect(parse('#/goals')).toEqual({ name: 'tasks' })
    expect(parse('#/goals/s_lyra')).toEqual({ name: 'tasks', swarm: 's_lyra' })
    expect(parse('#/goals/s_lyra?goal=g_1')).toEqual({ name: 'tasks', swarm: 's_lyra', task: 'g_1' })
    expect(parse('#/boards?mind=a_1')).toEqual({ name: 'tasks', mind: 'a_1' })
    expect(parse('#/boards?swarm=s_1')).toEqual({ name: 'tasks', swarm: 's_1' })
    expect(href({ name: 'goals', swarm: 's_lyra', goal: 'g_1' })).toBe('#/tasks?swarm=s_lyra&task=g_1')
    expect(href({ name: 'goals' })).toBe('#/tasks')
  })
  it('motivations open one by id', () => {
    expect(parse(href({ name: 'motivations', id: 'mo_a b' }))).toEqual({ name: 'motivations', id: 'mo_a b' })
    expect(parse('#/motivations')).toEqual({ name: 'motivations' })
  })
})

describe('open a creation in Design', () => {
  const ref = { artifact_id: 'art_1', revision: 3, digest: 'sha256:' + 'a'.repeat(64) }
  it('round-trips the exact artifact revision through the route', () => {
    const route = openInDesign(ref, 'sw_1')!
    expect(parse(href(route))).toMatchObject({ name: 'program', id: 'omegadesign', swarm: 'sw_1', source: ref })
  })
  it('refuses a malformed or widened reference', () => {
    expect(openInDesign({ ...ref, extra: 1 }, 'sw_1')).toBeUndefined()
    expect(openInDesign({ ...ref, digest: 'sha256:abc' }, 'sw_1')).toBeUndefined()
    expect(openInDesign({ ...ref, revision: 0 }, 'sw_1')).toBeUndefined()
    expect(parse('#/program/design/sw_1?source=%7Bnope')).not.toHaveProperty('source')
  })
  it('compares references exactly', () => {
    expect(sameCreation(ref, { ...ref })).toBe(true)
    expect(sameCreation(ref, { ...ref, revision: 4 })).toBe(false)
    expect(sameCreation(undefined, ref)).toBe(false)
    expect(sameCreation(undefined, undefined)).toBe(true)
  })
})

describe('code: an existing task with no workspace', () => {
  it('keeps the exact task through target choice and repository selection', () => {
    expect(parse(href({ name: 'code', task: 'g_af900c75' }))).toMatchObject({ name: 'code', task: 'g_af900c75', repository: undefined, workspace: undefined })
    expect(parse(href({ name: 'code', task: 'g_af900c75', repository: 'synthetic' }))).toMatchObject({ name: 'code', task: 'g_af900c75', repository: 'synthetic', workspace: undefined })
  })
})

describe('an app’s graph view by link (the tour)', () => {
  it('round-trips view=graph, alone and beside a source', () => {
    expect(href({ name: 'program', id: 'contract-fixture', swarm: 's_kelp', view: 'graph' })).toBe('#/program/contract-fixture/s_kelp?view=graph')
    expect(parse('#/program/contract-fixture/s_kelp?view=graph')).toEqual({ name: 'program', id: 'contract-fixture', swarm: 's_kelp', view: 'graph' })
    expect(parse('#/program/contract-fixture/s_kelp?view=list')).toEqual({ name: 'program', id: 'contract-fixture', swarm: 's_kelp' })
  })
})
