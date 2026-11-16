import { describe, expect, it } from 'vitest'
import type { GoalGrant } from '../../api/types'
import { SimClient } from '../../api/sim/SimClient'
import { ARM_MS, accepts } from '../../lib/decisionGate'
import { grantBound, grantSeenOf, grantStanding, originLabel, parseSaved, revocableGrant, targetBound, targetSeenOf } from './editSessionRules'

// Surface request H (G1, G3, G4). INVENTED DATA only.
const NOW = 1_800_000_000
const own: GoalGrant = { id: 'gr_mine', goal_id: 'g_task', principal: 'user:operator', scope: 'edit', workspace_id: null, created_by: 'user:operator', created_at: '2026-10-05T10:00:00.000Z', expires_at: NOW + 3600, revoked_at: null, active: true }
const use = { task_id: 'g_task', grant_id: 'gr_mine' }

describe('G1: the revoke control is offered only for the viewer’s own active grant', () => {
  it('offers it for the viewer’s own active grant on this task', () => {
    expect(revocableGrant([own], use, 'user:operator', NOW)).toBe(own)
  })
  it('is absent for another person’s grant', () => {
    const theirs = { ...own, principal: 'user:u_someone' }
    expect(revocableGrant([theirs], use, 'user:operator', NOW)).toBeNull()
  })
  it('is absent for a revoked grant', () => {
    expect(revocableGrant([{ ...own, revoked_at: '2026-10-05T11:00:00.000Z', active: false }], use, 'user:operator', NOW)).toBeNull()
    // a host view that still says active but carries revoked_at is not trusted either
    expect(revocableGrant([{ ...own, revoked_at: '2026-10-05T11:00:00.000Z' }], use, 'user:operator', NOW)).toBeNull()
  })
  it('is absent for an expired grant', () => {
    expect(revocableGrant([{ ...own, expires_at: NOW - 1, active: false }], use, 'user:operator', NOW)).toBeNull()
    expect(revocableGrant([{ ...own, expires_at: NOW }], use, 'user:operator', NOW)).toBeNull()
  })
  it('is absent when the grant is not this workbench’s, is on another task, or the viewer is unknown', () => {
    expect(revocableGrant([own], { ...use, grant_id: 'gr_other' }, 'user:operator', NOW)).toBeNull()
    expect(revocableGrant([{ ...own, goal_id: 'g_other' }], use, 'user:operator', NOW)).toBeNull()
    expect(revocableGrant([own], use, null, NOW)).toBeNull()
    expect(revocableGrant(null, use, 'user:operator', NOW)).toBeNull()
  })
  it('says plainly where a grant stands', () => {
    expect(grantStanding(own, NOW)).toBeNull()
    expect(grantStanding({ ...own, revoked_at: 'x' }, NOW)).toEqual({ kind: 'revoked', at: 'x' })
    expect(grantStanding({ ...own, expires_at: NOW - 5 }, NOW)?.kind).toBe('expired')
  })
})

describe('G1: the revoke dialog binds to the grant as inspected', () => {
  const seen = grantSeenOf(own)
  it('is ready while the live grant is unchanged', () => expect(grantBound(seen, own, NOW)).toEqual({ kind: 'ready' }))
  it('refuses once the grant was revoked elsewhere, expired, changed or is gone', () => {
    expect(grantBound(seen, { ...own, revoked_at: 'r', active: false }, NOW)).toEqual({ kind: 'closed', why: 'This grant is already revoked.' })
    expect(grantBound(seen, own, NOW + 7200)).toEqual({ kind: 'closed', why: 'This grant has already expired.' })
    expect(grantBound(seen, { ...own, workspace_id: 'ws_x' }, NOW)).toEqual({ kind: 'changed', fields: ['workspace'] })
    expect(grantBound(seen, undefined, NOW)).toEqual({ kind: 'gone' })
  })
  it('a press inside the arming window or on a held key does not count', () => {
    expect(accepts({ at: 100 + ARM_MS - 1 }, 100)).toBe(false)
    expect(accepts({ at: 100 + ARM_MS, repeat: true }, 100)).toBe(false)
    expect(accepts({ at: 100 + ARM_MS }, 100)).toBe(true)
  })
})

describe('G4: reuse is labelled and deliberate; a saved session is read strictly', () => {
  it('labels where the task came from', () => {
    expect(originLabel('reused', 'g_task')).toBe('Reusing task g_task: you chose the task saved in this browser')
    expect(originLabel('new', 'g_task')).toBe('New task g_task, started here')
  })
  it('ignores anything that is not a saved session', () => {
    expect(parseSaved(null)).toBeNull()
    expect(parseSaved('nope')).toBeNull()
    expect(parseSaved(JSON.stringify({ task_id: 'x', grant_id: 'gr_1', repository_id: 'r' }))).toBeNull()
    expect(parseSaved(JSON.stringify({ task_id: 'g_1', grant_id: 'gr 1', repository_id: 'r' }))).toBeNull()
    expect(parseSaved(JSON.stringify({ task_id: 'g_1', grant_id: 'gr_1', repository_id: 'r', saved_at: 'then' }))).toEqual({ task_id: 'g_1', grant_id: 'gr_1', repository_id: 'r', saved_at: 'then' })
  })
  it('the start dialog binds to the target as read', () => {
    const t = { label: 'Repo', repository_id: 'r', repo: { commit: 'abc' }, openable: true }
    const seen = targetSeenOf(t)
    expect(targetBound(seen, seen)).toEqual({ kind: 'ready' })
    expect(targetBound(seen, targetSeenOf({ ...t, repo: { commit: 'def' } }))).toEqual({ kind: 'changed', fields: ['commit'] })
    expect(targetBound(seen, targetSeenOf({ ...t, openable: false })).kind).toBe('closed')
  })
})

describe('sim plays the host (hive/core/code.py:221-232, app.py:431-434, services.py:199-205 at 60fa650)', () => {
  const sim = () => new SimClient({ seed: 1, latency: false, autoStart: false, historyDays: 1, codeMode: 'person' })
  it('code/open always makes a new task and a new 12-hour edit grant for the caller', async () => {
    const c = sim()
    const a = await c.codeOpen('repo:sim-suggestions')
    const b = await c.codeOpen('repo:sim-suggestions')
    expect([a.task_id, a.grant_id]).toEqual(['g_simcode01', 'grant_simcode01'])
    expect(b.task_id).not.toBe(a.task_id)
    expect(b.grant_id).not.toBe(a.grant_id)
    const [g] = await c.goalGrants(b.task_id)
    expect(g).toMatchObject({ id: b.grant_id, goal_id: b.task_id, principal: (await c.me()).principal, scope: 'edit', revoked_at: null, active: true })
    expect(g.expires_at - Date.now() / 1000).toBeGreaterThan(11.9 * 3600)
    expect(c.goals.get(b.task_id)).toMatchObject({ title: 'Edit code: Invented fixture repository', priority: 0.5, assignee: null, status: 'open' })
  })
  it('DELETE grant: 404 not_found unless on that goal; idempotent; then every relayed call is refused grant_invalid, other grants unaffected', async () => {
    const c = sim()
    const a = await c.codeOpen('repo:sim-suggestions')
    const b = await c.codeOpen('repo:sim-suggestions')
    const ctx = (o: typeof a) => ({ task_id: o.task_id, grant_id: o.grant_id, repository_id: o.repository_id })
    await c.codeProxy('POST', '/v1/workspaces', ctx(a), {})
    await expect(c.revokeGoalGrant(b.task_id, a.grant_id)).rejects.toMatchObject({ status: 404, code: 'not_found', message: `no grant ${a.grant_id}` })
    await expect(c.revokeGoalGrant('g_nothing', 'gr_nothing')).rejects.toMatchObject({ status: 404, code: 'not_found', message: 'no grant gr_nothing' })
    const r = await c.revokeGoalGrant(a.task_id, a.grant_id)
    expect(r).toMatchObject({ id: a.grant_id, goal_id: a.task_id, active: false })
    expect(r.revoked_at).toMatch(/^\d{4}-\d\d-\d\dT/)
    const again = await c.revokeGoalGrant(a.task_id, a.grant_id)
    expect(again.revoked_at).toBe(r.revoked_at)
    for (const call of [() => c.codeProxy('GET', '/v1/workspaces/ws_simsuggest01', ctx(a)), () => c.codeSuggestionHistory(ctx(a), 'ws_simsuggest01')])
      await expect(call()).rejects.toMatchObject({ status: 403, code: 'grant_invalid' })
    await expect(c.codeProxy('POST', '/v1/workspaces', ctx(b), {})).resolves.toMatchObject({ id: 'ws_simsuggest02', task_id: b.task_id })
    const view = await c.goalGrants(a.task_id)
    expect(revocableGrant(view, ctx(a), (await c.me()).principal, Date.now() / 1000)).toBeNull()
  })
  it('the relay refuses another person’s grant and an expired grant on the task', async () => {
    const c = sim()
    const a = await c.codeOpen('repo:sim-suggestions')
    c.simAddGrant({ id: 'gr_theirs', goal_id: a.task_id, principal: 'user:u_someone', scope: 'edit', workspace_id: null, created_by: 'user:u_someone', created_at: new Date().toISOString(), expires_at: Date.now() / 1000 + 600, revoked_at: null })
    c.simAddGrant({ id: 'gr_old', goal_id: a.task_id, principal: 'user:operator', scope: 'edit', workspace_id: null, created_by: 'user:operator', created_at: new Date().toISOString(), expires_at: Date.now() / 1000 - 1, revoked_at: null })
    for (const grant_id of ['gr_theirs', 'gr_old'])
      await expect(c.codeProxy('POST', '/v1/workspaces', { task_id: a.task_id, grant_id, repository_id: a.repository_id }, {})).rejects.toMatchObject({ status: 403, code: 'grant_invalid' })
    const view = await c.goalGrants(a.task_id)
    const me = (await c.me()).principal
    expect(revocableGrant(view, { task_id: a.task_id, grant_id: 'gr_theirs' }, me, Date.now() / 1000)).toBeNull()
    expect(revocableGrant(view, { task_id: a.task_id, grant_id: 'gr_old' }, me, Date.now() / 1000)).toBeNull()
    expect(revocableGrant(view, { task_id: a.task_id, grant_id: a.grant_id }, me, Date.now() / 1000)?.id).toBe(a.grant_id)
  })
})
