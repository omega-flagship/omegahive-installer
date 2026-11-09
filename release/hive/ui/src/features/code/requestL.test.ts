import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import type { GoalGrant } from '../../api/types'
import { SimClient } from '../../api/sim/SimClient'
import type { Target } from './CodePage'
import { NotEditableState } from './EditSession'
import { closedReason, grantRead, grantRefused, judgeSaved, notEditable, notEditableText, savedIdentity, targetBound, targetOpenable, targetSeenOf } from './editSessionRules'
import { dropSession, dropSessionIf, purgeUnkeyed, readSession, saveSession, sessionKey, workspaceKey, type SessionStore } from './savedSession'
import { readContext } from '../../lib/readContext'
import { TargetCard } from './TargetCard'

// Surface request L. INVENTED DATA only (sim targets, invented principals and ids).
const NOW = 1_800_000_000
const ME = 'user:operator'

const target = (over: Partial<Target> = {}): Target => ({
  id: 'repo:old-notebooks', kind: 'repository', label: 'Old notebooks', detail: 'Invented.', source: null, repository_id: 'old-notebooks',
  repo: { root: '/srv/x', commit: '0b7d41c2e9a8', branch: 'main', dirty: false, subdir: '' }, owner: 'operator', private: false,
  apply: { how: 'candidate', ready: false, note: 'candidate only' }, ...over,
})
const card = (t: Target) => renderToStaticMarkup(createElement(TargetCard, { t }))

class MemoryStore implements SessionStore {
  m = new Map<string, string>()
  get length() { return this.m.size }
  key(i: number) { return [...this.m.keys()][i] ?? null }
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
}

describe('L1: a target that cannot open says why on its card, with no dead Open button', () => {
  it('shows closed_reason in plain words and no button at all (next10)', () => {
    const html = card(target({ openable: false, closed_reason: 'the Code service has no editable copy of it registered' }))
    expect(html).toContain('Can’t be edited here: the Code service has no editable copy of it registered.')
    expect(html).toContain('Old notebooks')   // the card stays
    expect(html).not.toContain('<button')
  })
  it('an open target (closed_reason null) keeps its Edit code button', () => {
    const html = card(target({ openable: true, closed_reason: null }))
    expect(html).toContain('Edit code')
    expect(html).not.toContain('Can’t be edited here')
  })
  it('without closed_reason (live 0aa6330) the card is as today', () => {
    expect(card(target({ openable: true }))).toContain('Edit code')
    const off = card(target({ openable: false, repo: null }))
    expect(off).toMatch(/<button[^>]*disabled/)
    expect(off).toContain('No source control')
    expect(card(target({ openable: false, private: true }))).toContain('Owner must agree')
  })
  it('closed_reason decides openable; absent, openable (or a commit) does', () => {
    expect(closedReason(target({ closed_reason: '  it has no git source ' }))).toBe('it has no git source')
    expect(closedReason(target({ closed_reason: '' }))).toBeNull()
    expect(targetOpenable(target({ openable: true, closed_reason: 'it has no git source' }))).toBe(false)
    expect(targetOpenable(target({ openable: true, closed_reason: null }))).toBe(true)
    expect(targetOpenable(target())).toBe(true)   // live: a commit
    expect(targetOpenable(target({ repo: null }))).toBe(false)
  })
  it('the start dialog binding treats a closed target as closed', () => {
    const seen = targetSeenOf(target({ openable: true, closed_reason: null }))
    expect(targetBound(seen, targetSeenOf(target({ openable: false, closed_reason: 'the Code service has no editable copy of it registered' })))).toEqual({ kind: 'closed', why: 'This target cannot be opened for editing now.' })
    expect(targetSeenOf(target({ closed_reason: 'x' })).openable).toBe(false)
  })
})

describe('L1: 409 not_editable (next10) and 403 repository_unregistered (live 0aa6330)', () => {
  const sim = () => new SimClient({ seed: 1, latency: false, autoStart: false, historyDays: 1, codeMode: 'person' })
  it('the sim lists the unregistered repository closed, with the host’s reason', async () => {
    const t = (await sim().codeTargets()).find((x) => x.id === 'repo:old-notebooks')!
    expect(t).toMatchObject({ openable: false, closed_reason: 'the Code service has no editable copy of it registered' })
    expect(card(t)).not.toContain('<button')
  })
  it('next10: code/open is refused 409 not_editable and no task or grant is created', async () => {
    const c = sim()
    const before = c.goals.size
    const e = await c.codeOpen('repo:old-notebooks').catch((x: unknown) => x)
    expect(e).toMatchObject({ status: 409, code: 'not_editable', message: 'Old notebooks cannot be opened for editing: the Code service has no editable copy of it registered' })
    expect(c.goals.size).toBe(before)
    const r = notEditable(e)!
    expect(r.kind).toBe('not_editable')
    const text = notEditableText(r, 'Old notebooks')
    expect(text.title).toBe('This repository isn’t editable in the hive')
    expect(text.body).toBe('Old notebooks cannot be opened for editing: the Code service has no editable copy of it registered. The hive refused before making anything: no task or edit grant was created.')
  })
  it('live 0aa6330 shape: no closed_reason, open succeeds, then the service refuses 403 repository_unregistered', async () => {
    const c = sim()
    c.codeClosedReasons = false
    const t = (await c.codeTargets()).find((x) => x.id === 'repo:old-notebooks')!
    expect('closed_reason' in t).toBe(false)
    expect(targetOpenable(t)).toBe(true)
    const o = await c.codeOpen('repo:old-notebooks')
    const e = await c.codeProxy('POST', '/v1/workspaces', { task_id: o.task_id, grant_id: o.grant_id, repository_id: o.repository_id }, {}).catch((x: unknown) => x)
    expect(e).toMatchObject({ status: 403, code: 'repository_unregistered', source: 'omegacode' })
    const r = notEditable(e)!
    expect(r.kind).toBe('repository_unregistered')
    const text = notEditableText(r, 'Old notebooks', o)
    expect(text.body).toContain(`The hive had already made task ${o.task_id} with edit grant ${o.grant_id}`)
    expect(notEditableText(r, 'Old notebooks').body).toMatch(/Nothing was opened\.$/)
  })
  it('the refusal page says why and offers the targets list', () => {
    const html = renderToStaticMarkup(createElement(NotEditableState, { refusal: { kind: 'not_editable', message: 'Old notebooks cannot be opened for editing: it has no git source' }, label: 'Old notebooks' }))
    expect(html).toContain('This repository isn’t editable in the hive')
    expect(html).toContain('Back to the targets list')
    expect(html).toContain('no task or edit grant was created')
  })
  it('other errors are not read as "not editable"', () => {
    expect(notEditable(new ApiError(503, 'service_unavailable', 'x'))).toBeNull()
    expect(notEditable(new Error('boom'))).toBeNull()
  })
})

describe('L2: the saved session is keyed by principal and target', () => {
  const o = { task_id: 'g_simcode01', grant_id: 'grant_simcode01', repository_id: 'sim-suggestions', swarm_id: 's_forge', base_commit: 'abc' }
  it('another principal’s saved session is never read', () => {
    const st = new MemoryStore()
    saveSession('user:p_former', 'repo:sim-suggestions', o, true, st)
    expect(readSession(ME, 'repo:sim-suggestions', st)).toBeNull()
    expect(readSession('user:p_former', 'repo:sim-suggestions', st)).toMatchObject({ ...o, principal: 'user:p_former' })
    expect(readSession(null, 'repo:sim-suggestions', st)).toBeNull()
    expect(readSession(ME, 'repo:other', st)).toBeNull()
  })
  it('keys carry both principal and target, and a principal cannot forge another’s key', () => {
    expect(sessionKey('user:jon', 'repo:a')).toBe('omegadots.code.session.user%3Ajon|repo%3Aa')
    expect(sessionKey('user:a|b', 'c')).not.toBe(sessionKey('user:a', 'b|c'))
    expect(workspaceKey(ME, 'repo:a')).toBe(`${sessionKey(ME, 'repo:a')}.ws`)
  })
  it('old unkeyed entries (request H and before) are ignored and removed; keyed ones stay', () => {
    const st = new MemoryStore()
    st.setItem('omegadots.code.repo:sim-suggestions', JSON.stringify(o))
    st.setItem('omegadots.code.repo:sim-suggestions.ws', 'ws_simsuggest01')
    st.setItem('omegadots.code.repo:sim-suggestions@g_x', JSON.stringify(o))
    st.setItem('omegadots.intro.welcome.v1', 'explore')
    saveSession(ME, 'repo:sim-suggestions', o, true, st)
    expect(readSession(ME, 'repo:sim-suggestions', st)?.task_id).toBe('g_simcode01')
    expect([...st.m.keys()].sort()).toEqual(['omegadots.code.session.user%3Aoperator|repo%3Asim-suggestions', 'omegadots.intro.welcome.v1'])
    expect(purgeUnkeyed(st)).toBe(0)
  })
  it('a new task forgets the old workspace; dropping forgets both', () => {
    const st = new MemoryStore()
    st.setItem(workspaceKey(ME, 't'), 'ws_old')
    saveSession(ME, 't', o, true, st)
    expect(st.getItem(workspaceKey(ME, 't'))).toBeNull()
    st.setItem(workspaceKey(ME, 't'), 'ws_new')
    dropSession(ME, 't', st)
    expect(st.m.size).toBe(0)
  })
})

describe('L2: reuse is offered only for this principal’s active grant on that task; every other case is dropped with its reason', () => {
  const saved = { task_id: 'g_task', grant_id: 'gr_mine', repository_id: 'r', principal: ME }
  const own: GoalGrant = { id: 'gr_mine', goal_id: 'g_task', principal: ME, scope: 'edit', workspace_id: null, created_by: ME, created_at: '2026-10-05T10:00:00.000Z', expires_at: NOW + 3600, revoked_at: null, active: true }
  const j = (grants: GoalGrant[], principal: string | null | undefined = ME, s = saved) => judgeSaved(s, { grants }, principal, NOW)
  it('offers the viewer’s own active grant', () => expect(j([own])).toEqual({ kind: 'offer', grant: own }))
  it('another sign-in: saved under another principal, or the grant is another principal’s', () => {
    expect(j([own], ME, { ...saved, principal: 'user:jon' })).toEqual({ kind: 'drop', why: 'The task saved in this browser belongs to another sign-in.' })
    expect(j([{ ...own, principal: 'user:jon' }])).toEqual({ kind: 'drop', why: 'The task saved in this browser belongs to another sign-in.' })
  })
  it('its edit grant has ended', () => {
    expect(j([{ ...own, expires_at: NOW - 10, active: false }])).toEqual({ kind: 'drop', why: `The task saved in this browser can’t be reused: its edit grant has ended (${new Date((NOW - 10) * 1000).toISOString()}).` })
    expect(j([{ ...own, expires_at: NOW }]).kind).toBe('drop')
  })
  it('its edit grant was revoked (even if a view still says active)', () => {
    expect(j([{ ...own, revoked_at: '2026-10-05T11:00:00.000Z', active: false }])).toEqual({ kind: 'drop', why: 'The task saved in this browser can’t be reused: its edit grant was revoked (2026-10-05T11:00:00.000Z).' })
    expect(j([{ ...own, revoked_at: '2026-10-05T11:00:00.000Z' }]).kind).toBe('drop')
  })
  it('its edit grant is not on that task, or belongs to another task', () => {
    expect(j([])).toEqual({ kind: 'drop', why: 'The task saved in this browser can’t be reused: its edit grant is no longer on that task.' })
    expect(j([{ ...own, goal_id: 'g_other' }])).toEqual({ kind: 'drop', why: 'The task saved in this browser can’t be reused: its edit grant belongs to a different task.' })
  })
  it('the task is gone (404)', () => {
    expect(judgeSaved(saved, { error: new ApiError(404, 'not_found', 'no goal g_task') }, ME, NOW)).toEqual({ kind: 'drop', why: 'The task saved in this browser is no longer in the hive.' })
  })
  it('an unanswered check neither offers nor drops; an unknown sign-in offers nothing', () => {
    expect(judgeSaved(saved, { error: new ApiError(503, 'unavailable', 'try later') }, ME, NOW)).toEqual({ kind: 'unchecked', why: 'Its edit grant could not be checked (try later), so it is not offered.' })
    expect(j([own], null).kind).toBe('unchecked')
    expect(judgeSaved(saved, { grants: [own] }, undefined, NOW)).toEqual({ kind: 'checking' })
    expect(judgeSaved(saved, null, ME, NOW)).toEqual({ kind: 'checking' })
  })
  it('formats times with the given formatter', () => {
    expect(judgeSaved(saved, { grants: [{ ...own, revoked_at: 'R' }] }, ME, NOW, (x) => `<${x}>`)).toMatchObject({ why: expect.stringContaining('revoked (<R>)') })
  })
})

describe('L2: the sim’s stale sessions, and a grant the hive refuses later', () => {
  const sim = () => new SimClient({ seed: 1, latency: false, autoStart: false, historyDays: 1, codeMode: 'person' })
  it('plays each earlier session as the hive would judge it', async () => {
    const c = sim()
    const me = (await c.me()).principal
    const now = Date.now() / 1000
    const judge = async (k: Parameters<SimClient['simStaleCodeSession']>[0]) => {
      const s = c.simStaleCodeSession(k)
      return judgeSaved({ ...s, principal: me }, { grants: await c.goalGrants(s.task_id) }, me, now)
    }
    expect(await judge('own')).toMatchObject({ kind: 'offer' })
    expect(await judge('other-principal')).toEqual({ kind: 'drop', why: 'The task saved in this browser belongs to another sign-in.' })
    expect((await judge('expired')) as { why: string }).toMatchObject({ why: expect.stringContaining('its edit grant has ended') })
    expect((await judge('revoked')) as { why: string }).toMatchObject({ why: expect.stringContaining('its edit grant was revoked') })
  })
  it('a reused own session opens; once the grant is revoked elsewhere every call is refused grant_invalid and judged revoked', async () => {
    const c = sim()
    const me = (await c.me()).principal
    const s = c.simStaleCodeSession('own')
    const ctx = { task_id: s.task_id, grant_id: s.grant_id, repository_id: s.repository_id }
    await expect(c.codeProxy('POST', '/v1/workspaces', ctx, {})).resolves.toMatchObject({ task_id: s.task_id })
    await c.revokeGoalGrant(s.task_id, s.grant_id)
    const e = await c.codeProxy('GET', '/v1/workspaces/ws_simstale01/tree', ctx).catch((x: unknown) => x)
    expect(e).toMatchObject({ status: 403, code: 'grant_invalid' })
    expect(grantRefused(e)).toBe(true)
    expect(judgeSaved(ctx, { grants: await c.goalGrants(s.task_id) }, me, Date.now() / 1000)).toMatchObject({ kind: 'drop', why: expect.stringContaining('its edit grant was revoked') })
  })
  it('only grant refusals count as a refused grant', () => {
    for (const code of ['grant_invalid', 'grant_revoked', 'grant_required']) expect(grantRefused(new ApiError(403, code, 'x'))).toBe(true)
    for (const code of ['repository_unregistered', 'not_editable', 'forbidden']) expect(grantRefused(new ApiError(403, code, 'x'))).toBe(false)
    expect(grantRefused(new Error('grant_invalid'))).toBe(false)
  })
})

describe('L1 correction: grant judgements are bound to the identity they were made for', () => {
  const T = 'repo:sim-suggestions'
  const B = 'user:review_fixture_b'
  const grant = (over: Partial<GoalGrant> = {}): GoalGrant => ({ id: 'grant_b', goal_id: 'g_task', principal: B, scope: 'edit', active: true, expires_at: NOW + 3600, revoked_at: null, ...over }) as GoalGrant
  const saved = { task_id: 'g_task', grant_id: 'grant_b', repository_id: 'sim-suggestions', principal: B }

  it('the lookup identity names principal, target, task AND grant: a same-task grant replacement is another identity', () => {
    const c = {}
    const one = readContext(c, savedIdentity(B, T, saved))
    expect(readContext(c, savedIdentity(B, T, { ...saved, grant_id: 'grant_b2' }))).not.toBe(one)
    expect(readContext(c, savedIdentity('user:a', T, saved))).not.toBe(one)
    expect(readContext(c, savedIdentity(B, 'repo:other', saved))).not.toBe(one)
    expect(readContext({}, savedIdentity(B, T, saved))).not.toBe(one)
    expect(readContext(c, savedIdentity(B, T, { ...saved }))).toBe(one)
  })

  it('while the current identity’s answer is pending there is nothing to judge: checking, never offer or drop', () => {
    const read = grantRead({ status: 'loading', data: undefined, error: undefined })
    expect(read).toBeNull()
    expect(judgeSaved(saved, read, B, NOW)).toEqual({ kind: 'checking' })
  })

  it('a success and a failure for the current identity are both judged; unsupported is "unchecked", never a drop', () => {
    expect(judgeSaved(saved, grantRead({ status: 'ready', data: [grant()], error: undefined }), B, NOW)).toMatchObject({ kind: 'offer' })
    expect(judgeSaved(saved, grantRead({ status: 'ready', data: [], error: undefined }), B, NOW)).toMatchObject({ kind: 'drop' })
    expect(judgeSaved(saved, grantRead({ status: 'error', data: undefined, error: new ApiError(404, 'not_found', 'gone') }), B, NOW)).toMatchObject({ kind: 'drop' })
    expect(judgeSaved(saved, grantRead({ status: 'error', data: undefined, error: new ApiError(500, 'boom', 'down') }), B, NOW)).toMatchObject({ kind: 'unchecked' })
    expect(judgeSaved(saved, grantRead({ status: 'unsupported', data: undefined, error: undefined }), B, NOW)).toMatchObject({ kind: 'unchecked' })
  })

  it('dropSessionIf forgets only the exact task and grant judged, never an entry that replaced it', () => {
    const store = new MemoryStore()
    saveSession(B, T, { ...saved, grant_id: 'grant_b2' }, true, store)
    expect(dropSessionIf(B, T, { task_id: 'g_task', grant_id: 'grant_b' }, store)).toBe(false)
    expect(readSession(B, T, store)?.grant_id).toBe('grant_b2')
    expect(dropSessionIf(B, T, { task_id: 'g_other', grant_id: 'grant_b2' }, store)).toBe(false)
    expect(dropSessionIf(B, T, { task_id: 'g_task', grant_id: 'grant_b2' }, store)).toBe(true)
    expect(readSession(B, T, store)).toBeNull()
    expect(dropSessionIf(null, T, saved, store)).toBe(false)
  })
})
