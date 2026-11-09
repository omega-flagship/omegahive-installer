import { describe, expect, it } from 'vitest'
import { ApiError } from '../client'
import type { HiveEvent } from '../types'
import { SimClient } from './SimClient'
import { pendingRemoval } from '../../features/assets/Cleanup'
import { groupNameProblem } from '../../features/explore/MyGroups'
import { revisionsOf } from '../../features/flow/Adoptions'
import { attemptLine } from '../../features/tasks/Attempts'
import { grantBody, grantLine } from '../../features/tasks/CodeAccess'
import { sortInvites } from '../../features/harness/OpenInvites'
import { grantsRefusal } from '../../features/programs/AppGrants'
import { frameLine, nextBefore } from '../../features/settings/AskAudit'
import { mergeConnection } from '../../features/swarm/connectionLive'
import { requestBlocked, requestBody } from '../../features/updates/RequestUpdate'
import { keptWords, turnOutcome } from '../../features/ask/Earlier'
import { appGrantsFrom, appGrantsWords } from '../../shell/liveNotices'

const sim = () => new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })
const asMember = (c: SimClient) => ((c as unknown as { simMember: boolean }).simMember = true)
const asPerson = (c: SimClient) => (c.simSession = 'person')
const code = async (p: Promise<unknown>) => {
  try {
    await p
  } catch (e) {
    return e instanceof ApiError ? e.code : String(e)
  }
  return 'ok'
}

describe('missing-UI batch 1: simulator mirrors the host routes', () => {
  it('Ask history lists only my turns, newest first, and keeps a deleted thread’s row without words', async () => {
    const c = sim()
    const mine = await c.askHistory(50)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((t, i) => i === 0 || mine[i - 1].created_at >= t.created_at)).toBe(true)
    expect(mine.some((t) => t.text === '')).toBe(true)
    expect(mine.some((t) => t.text.includes('forge swarm'))).toBe(false)
    expect((await c.askHistory(1)).length).toBe(1)
  })

  it('Ask audit: admins only; everyone’s turns; strict `before`; one turn’s frames', async () => {
    const c = sim()
    const all = await c.askAudit({ limit: 100 })
    expect(new Set(all.map((r) => r.principal)).size).toBeGreaterThan(1)
    const rowan = await c.askAudit({ principal: 'user:p_rowan' })
    expect(rowan.every((r) => r.principal === 'user:p_rowan')).toBe(true)
    const older = await c.askAudit({ before: all[0].created_at })
    expect(older.some((r) => r.turn_id === all[0].turn_id)).toBe(false)
    const t = await c.askAuditTurn(all[0].turn_id)
    expect(t.events.length).toBeGreaterThan(0)
    expect(await code(c.askAuditTurn('turn_nope'))).toBe('not_available')
    asMember(c)
    expect(await code(c.askAudit())).toBe('admin_only')
  })

  it('task attempts are verbatim, valid or not; unknown task is 404', async () => {
    const c = sim()
    const goals = [...c.goals.values()]
    const withAttempts = (await Promise.all(goals.map(async (g) => ({ g, a: await c.goalAttempts(g.id) })))).find((x) => x.a.length)
    expect(withAttempts).toBeTruthy()
    expect(withAttempts!.a.some((a) => !a.ok && a.errors.length > 0)).toBe(true)
    expect(withAttempts!.a.some((a) => a.ok)).toBe(true)
    expect(await code(c.goalAttempts('g_nope'))).toBe('not_found')
  })

  it('adding a task grant: admins only, people only, ttl clamped', async () => {
    const c = sim()
    const g = [...c.goals.values()][0]
    const out = await c.addGoalGrant(g.id, { principal: 'user:p_ada', scope: 'read', ttl_minutes: 99999 })
    expect(out).toMatchObject({ principal: 'user:p_ada', scope: 'read', active: true })
    expect(out.expires_at * 1000 - Date.now()).toBeLessThanOrEqual(1440 * 60_000 + 5000)
    expect(await code(c.addGoalGrant(g.id, { principal: 'agent:a_vega01', scope: 'edit', ttl_minutes: 30 }))).toBe('bad_principal')
    expect(await code(c.addGoalGrant('g_nope', { principal: 'user:p_ada', scope: 'edit', ttl_minutes: 30 }))).toBe('not_found')
    asMember(c)
    expect(await code(c.addGoalGrant(g.id, { principal: 'user:p_ada', scope: 'edit', ttl_minutes: 30 }))).toBe('admin_only')
  })

  it('app grants: the owner pauses and restores; the operator may only pause; others are refused', async () => {
    const c = sim()
    const apps = await c.programs()
    const id = apps.find((a) => c.simAppGrants(a.id))!.id
    const other = apps.find((a) => !c.simAppGrants(a.id))
    const seen: HiveEvent[] = []
    c.subscribe((e) => seen.push(e))
    expect(await c.revokeProgramGrants(id)).toEqual({ program: id, grants_revoked: true })
    expect(await code(c.restoreProgramGrants(id))).toBe('owner_required')
    asPerson(c)
    expect(await c.restoreProgramGrants(id)).toMatchObject({ grants_revoked: false, takes_effect: 'next restart' })
    expect(c.simAppGrants(id)?.revoked).toBe(false)
    if (other) expect(await code(c.revokeProgramGrants(other.id))).toBe('no_grants')
    expect(seen.map((e) => e.type)).toEqual(expect.arrayContaining(['app.grants_revoked', 'app.grants_restored']))
    asMember(c)
    expect(await code(c.revokeProgramGrants(id))).toBe('owner_required')
  })

  it('update requests: admins only; a valid target; shown beside it; closed when applied', async () => {
    const c = sim()
    const r = await c.requestUpdate({ target: 'platform', note: '  Invented: fix it  ', receipts: ['a'] })
    expect(r).toMatchObject({ target: 'platform', note: 'Invented: fix it', status: 'pending' })
    expect((await c.updates()).platform.request?.id).toBe(r.id)
    expect(await code(c.requestUpdate({ target: 'program:nope', note: 'x' }))).toBe('bad_target')
    asMember(c)
    expect(await code(c.requestUpdate({ target: 'platform', note: 'x' }))).toBe('admin_only')
  })

  it('harness invitations: admins list them (no join code in the list); withdraw keeps the row', async () => {
    const c = sim()
    const rows = await c.harnessInvites()
    expect(rows.some((r) => r.status === 'waiting')).toBe(true)
    expect(rows.every((r) => !('code' in r))).toBe(true)
    const w = rows.find((r) => r.status === 'waiting')!
    expect((await c.revokeHarnessInvite(w.id)).status).toBe('revoked')
    expect((await c.harnessInvites()).find((r) => r.id === w.id)?.status).toBe('revoked')
    asMember(c)
    expect(await code(c.harnessInvites())).toBe('admin_only')
  })

  it('capability catalogue: a scope is required; never lists the requester itself', async () => {
    const c = sim()
    const sw = [...c.swarms.values()][0]
    const cat = await c.capabilityCatalogue(sw.id)
    expect(cat.requester_swarm).toBe(sw.id)
    expect(cat.offers.every((o) => !(o.provider.kind === 'swarm' && o.provider.id === sw.id))).toBe(true)
    expect(await code(c.capabilityCatalogue(''))).toBe('scope_required')
  })

  it('flows: an adoption is read, taken back by a named admin, and reads as not adopted', async () => {
    const c = sim()
    const sw = [...c.swarms.values()][0]
    const flows = await c.flowList(sw.id)
    const f = flows.find((x) => x.revision >= 3)!
    expect((await c.flowRevision(f.artifact_id, 3)).adoption).not.toBeNull()
    expect(await code(c.unadoptFlow(f.artifact_id, 3))).toBe('named_person_required')
    asPerson(c)
    expect(await c.unadoptFlow(f.artifact_id, 3)).toEqual({ revoked: true })
    expect((await c.flowRevision(f.artifact_id, 3)).adoption).toBeNull()
    expect(await code(c.flowRevision(f.artifact_id, 99))).toBe('not_found')
  })

  it('explore groups: rename and delete only my own; duplicate names refused', async () => {
    const c = sim()
    const gs = await c.exploreGroups!()
    expect(gs.some((g) => g.id === 'grp_simother')).toBe(false)
    const [a, b] = gs
    expect((await c.renameExploreGroup(a.id, 'Invented: renamed')).name).toBe('Invented: renamed')
    expect(await code(c.renameExploreGroup(b.id, 'invented: RENAMED'))).toBe('exists')
    expect(await code(c.renameExploreGroup('grp_simother', 'mine now'))).toBe('not_found')
    expect(await c.deleteExploreGroup(b.id)).toEqual({ id: b.id, deleted: true })
    expect((await c.exploreGroups!()).some((g) => g.id === b.id)).toBe(false)
  })

  it('asset cleanup: admins only; removes the pending copies and records it', async () => {
    const c = sim()
    const stores = await c.assetStores!()
    const list = await c.listAssets!()
    const a = list.find((x) => pendingRemoval(x, stores).length > 0)!
    expect(a).toBeTruthy()
    const out = await c.cleanupAsset(a.sha256)
    expect(pendingRemoval(out, stores)).toEqual([])
    expect(out.history.at(-1)?.event).toBe('local_only_cleanup')
    asMember(c)
    expect(await code(c.cleanupAsset(a.sha256))).toBe('admin_only')
  })

  it('registered services refuse members, as the host does', async () => {
    const c = sim()
    expect(Array.isArray(await c.registeredServices())).toBe(true)
    asMember(c)
    expect(await code(c.registeredServices())).toBe('admin_only')
  })

  it('revoking a connection records its reason and sends connection.updated', async () => {
    const c = sim()
    const sw = [...c.swarms.values()][0]
    const active = (await c.listConnections(sw.id)).find((x) => x.status === 'active')
    if (!active) return
    const seen: HiveEvent[] = []
    c.subscribe((e) => seen.push(e))
    const out = await c.connectionAction(active.id, 'revoke', undefined, 'Invented: review finished')
    expect(out.status).toBe('revoked')
    expect(out.history.at(-1)).toMatchObject({ event: 'revoked', reason: 'Invented: review finished' })
    expect(seen.some((e) => e.type === 'connection.updated')).toBe(true)
  })
})

describe('missing-UI batch 1: pure helpers', () => {
  it('words and bodies', () => {
    expect(keptWords({ text: '' }).removed).toBe(true)
    expect(turnOutcome({ state: 'done', reason: null })).toBe('answered')
    expect(attemptLine({ ok: false, errors: ['a', 'b'] })).toBe('not valid: a; b')
    expect(grantBody('p_ada', 'edit', 5000)).toEqual({ principal: 'user:p_ada', scope: 'edit', ttl_minutes: 1440 })
    expect(grantLine({ active: false, revoked_at: null, expires_at: 0, scope: 'read' })).toBe('read, expired')
    expect(revisionsOf(7)).toEqual([7, 6, 5, 4, 3])
    expect(revisionsOf(2)).toEqual([2, 1])
    expect(groupNameProblem('  ', [])).toBeTruthy()
    expect(groupNameProblem('A', [{ id: 'x', name: 'a', members: [] }], 'y')).toMatch(/already/)
    expect(groupNameProblem('A', [{ id: 'x', name: 'a', members: [] }], 'x')).toBeNull()
    expect(requestBody('platform', ' n ', 'a\n\n b ')).toEqual({ target: 'platform', note: 'n', receipts: ['a', 'b'] })
    expect(requestBlocked({ target: 'platform', note: '' })).toMatch(/Say/)
    expect(requestBlocked({ target: 'platform', note: 'x', receipts: ['y'.repeat(301)] })).toMatch(/receipt/)
    expect(nextBefore([{ created_at: 'b' }, { created_at: 'a' }])).toBe('a')
    expect(frameLine({ phase: 'answer', seq: 1, text: '' } as never)).toBe('answer: (words removed)')
    expect(grantsRefusal(new ApiError(404, 'no_grants', 'x'))).toMatch(/nothing to pause/)
  })

  it('invitations sort waiting first; connection updates merge only into the swarm they touch', () => {
    const base = { harness: 'mcp', harness_label: '', name: '', swarm_id: 's', role_id: null, created_by: '', expires_at: 0, redeemed_at: null, agent_id: null, revoked_at: null } as const
    const rows = sortInvites([
      { ...base, id: '1', status: 'revoked', created_at: '3' },
      { ...base, id: '2', status: 'waiting', created_at: '1' },
    ])
    expect(rows[0].id).toBe('2')
    const c = { id: 'cn', from_swarm: 'a', to_swarm: 'b', status: 'revoked' } as never
    expect(mergeConnection([], c, 'z')).toEqual([])
    expect(mergeConnection([{ id: 'cn', from_swarm: 'a', to_swarm: 'b', status: 'active' } as never], c, 'a')).toEqual([c])
  })

  it('app.grants_* events become plain notes', () => {
    const n = appGrantsFrom({ type: 'app.grants_restore_applied', at: 't', program: 'p', restored_by: 'user:jon' } as HiveEvent, 's1')
    expect(n).toMatchObject({ kind: 'restore_applied', by: 'user:jon', session: 's1' })
    expect(appGrantsWords({ kind: 'revoked', by: 'user:jon' }, 'Atlas')).toMatch(/paused by jon/)
    expect(appGrantsFrom({ type: 'hive.power', at: 't', state: 'on', since: null } as HiveEvent, 's')).toBeNull()
  })
})
