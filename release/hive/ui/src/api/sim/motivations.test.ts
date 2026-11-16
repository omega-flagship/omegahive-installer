import { describe, expect, it } from 'vitest'
import { ApiError, type Me } from '../client'
import type { Goal, HiveEvent, Swarm } from '../types'
import { SimMotivations } from './motivations'

/**
 * The simulator keeps the built host's rules for Motivations above Tasks (hive/core/motivations.py at a17bdda), on
 * INVENTED data: hidden answers as missing, content revisions vs link versions, all-or-nothing idempotent links, and the
 * Tasks query's Unsorted. Synthetic rows only.
 */
const swarm = (id: string, owner: string | null, extra: Partial<Swarm> = {}) => ({ id, name: id, owner, visibility: 'public', created_at: '2026-10-01T00:00:00Z', ...extra }) as unknown as Swarm
const goal = (id: string, swarm_id: string, parent_id: string | null = null): Goal => ({ id, swarm_id, parent_id, title: `task ${id}`, detail: '', priority: 0.5, status: 'open', created_by: 'user:operator', claimed_by: null, result: null, created_at: `2026-10-01T00:00:0${id.length}Z`, updated_at: '2026-10-01T00:00:00Z' })

function world(me: Partial<Me> = {}) {
  const swarms = new Map([
    ['s_a', swarm('s_a', 'user:p_owner')],
    ['s_b', swarm('s_b', 'user:p_other')],
    ['s_hidden', swarm('s_hidden', 'user:p_other', { visibility: 'private' } as Partial<Swarm>)],
  ])
  const goals = new Map<string, Goal>([
    ['g_1', goal('g_1', 's_a')],
    ['g_2', goal('g_2', 's_a')],
    ['g_2a', goal('g_2a', 's_a', 'g_2')],
    ['g_3', goal('g_3', 's_b')],
    ['g_h', goal('g_h', 's_hidden')],
  ])
  const events: HiveEvent[] = []
  let viewer: Me = { principal: 'user:p_owner', kind: 'sso', role: 'member', expires_at: null, person: { id: 'p_owner', email: null, name: 'Owner' }, ...me }
  let t = 0
  const sim = new SimMotivations({
    me: () => viewer,
    swarms: () => swarms,
    goals: () => goals,
    goalRow: (g) => g,
    requestsFor: () => [],
    emit: (e) => events.push(e),
    now: () => `2026-10-07T00:00:${String(++t).padStart(2, '0')}Z`,
  })
  return { sim, events, swarms, as: (m: Partial<Me>) => (viewer = { ...viewer, ...m }) }
}
const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (e) {
    return e instanceof ApiError ? `${e.status} ${e.code}` : String(e)
  }
  return 'ok'
}
const linkBody = (rev: number, ids: string[], extra = {}) => ({ operation_id: 'ui.test.0001', op: 'link' as const, goal_ids: ids, cascade: false, expected_to_rev: rev, ...extra })

describe('sim motivations keep the host contract', () => {
  it('a team motivation is made by its owner; a member is refused in the host words; a person makes their own', () => {
    const w = world()
    const m = w.sim.create({ title: 'Why A', owner: 'swarm:s_a', swarm_id: 's_a' })
    expect(m).toMatchObject({ owner: 'swarm:s_a', visibility: 'public', rev: 1, editable: true, links_version: 0, created_by: 'user:p_owner' })
    w.as({ principal: 'user:p_member', person: { id: 'p_member', email: null, name: 'M' } })
    expect(code(() => w.sim.create({ title: 'x', owner: 'swarm:s_a', swarm_id: 's_a' }))).toBe('403 owner_only')
    expect(w.sim.create({ title: 'Mine' })).toMatchObject({ owner: 'user:p_member', visibility: 'private', swarm_id: null })
    expect(code(() => w.sim.create({ title: 'x', parent_id: 'mo_1' } as never))).toBe('400 parent_disabled')
  })

  it('the hive password is not a person; a hidden swarm answers as missing', () => {
    const w = world({ principal: 'user:operator', kind: 'password', role: null, person: null })
    expect(code(() => w.sim.create({ title: 'x' }))).toBe('400 bad_scope')
    const v = world({ principal: 'user:p_stranger' })
    expect(code(() => v.sim.create({ title: 'x', swarm_id: 's_hidden' }))).toBe('404 not_found')
  })

  it('a private motivation is missing to everyone else; a stale revision is refused, never applied', () => {
    const w = world()
    const mine = w.sim.create({ title: 'Private why' })
    w.as({ principal: 'user:p_member' })
    expect(code(() => w.sim.get(mine.id))).toBe('404 not_found')
    expect(w.sim.list().items.map((x) => x.id)).not.toContain(mine.id)
    w.as({ principal: 'user:p_owner' })
    const edited = w.sim.patch(mine.id, { title: 'Clearer why', expected_rev: 1 })
    expect(edited.rev).toBe(2)
    expect(code(() => w.sim.patch(mine.id, { status: 'paused', expected_rev: 1 }))).toBe('409 motivation_changed')
    expect(w.sim.get(mine.id)).toMatchObject({ status: 'active', title: 'Clearer why' })
  })

  it('links move links_version, never rev; a replay answers the same; a reused id for something else is refused', () => {
    const w = world()
    const m = w.sim.create({ title: 'Why A', owner: 'swarm:s_a', swarm_id: 's_a' })
    const r = w.sim.link(m.id, linkBody(1, ['g_1']))
    expect(r).toMatchObject({ applied: ['g_1'], unchanged: [] })
    expect(r.motivation).toMatchObject({ rev: 1, links_version: 1 })
    expect(w.events.some((e) => e.type === 'motivation.links' && e.swarm_id === 's_a')).toBe(true)
    expect(w.sim.link(m.id, linkBody(1, ['g_1']))).toMatchObject({ applied: ['g_1'], replayed: true })
    expect(code(() => w.sim.link(m.id, linkBody(1, ['g_2'])))).toBe('409 operation_conflict')
  })

  it('a team motivation never takes another team’s task; a closed one takes none; a cascade takes subtasks', () => {
    const w = world()
    const m = w.sim.create({ title: 'Why A', owner: 'swarm:s_a', swarm_id: 's_a' })
    expect(code(() => w.sim.link(m.id, { ...linkBody(1, ['g_3']), operation_id: 'ui.test.0002' }))).toBe('400 scope_mismatch')
    expect(w.sim.link(m.id, { ...linkBody(1, ['g_2'], { cascade: true }), operation_id: 'ui.test.0003' }).applied.sort()).toEqual(['g_2', 'g_2a'])
    const done = w.sim.patch(m.id, { status: 'achieved', expected_rev: 1 })
    expect(code(() => w.sim.link(m.id, { ...linkBody(done.rev, ['g_1']), operation_id: 'ui.test.0004' }))).toBe('409 motivation_closed')
  })

  it('Tasks: one filter for items and counts; Unsorted is no link this viewer can read; a hidden id is missing', () => {
    const w = world()
    const m = w.sim.create({ title: 'Why A', owner: 'swarm:s_a', swarm_id: 's_a' })
    w.sim.link(m.id, linkBody(1, ['g_1']))
    const under = w.sim.tasks({ motivation: m.id })
    expect(under.items.map((g) => g.id)).toEqual(['g_1'])
    expect(under.counts.total).toBe(1)
    expect(under.items[0].motivations).toEqual([{ id: m.id, title: 'Why A', status: 'active' }])
    const unsorted = w.sim.tasks({ motivation: 'none' }).items.map((g) => g.id)
    expect(unsorted).not.toContain('g_1')
    expect(unsorted).toContain('g_2')
    const priv = w.sim.create({ title: 'mine only' })
    w.as({ principal: 'user:p_member' })
    expect(code(() => w.sim.tasks({ motivation: priv.id }))).toBe('404 not_found')
    expect(code(() => w.sim.tasks({ cursor: 'forged' }))).toBe('400 cursor_invalid')
  })
})
