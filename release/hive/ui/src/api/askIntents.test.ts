import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveClient } from './live'
import { codeRequest, parseAdmission, parseIntentView, VIBE_REQUEST_LIMITS, type CodeTeamOffer } from './askIntents'
import { vibeAvailability, NO_INTENTS } from '../features/code/canvas/vibeRoute'

// The live client's linkage-intent routes, exactly as the host serves them at release main 39c0731 (app.py:1495-1527),
// over a stand-in fetch. INVENTED ids and tokens; nothing leaves the test.

const calls: { method: string; url: string; body: string | null; headers: Record<string, string> }[] = []
let answer: (url: string) => Response = () => new Response('{}', { status: 200 })
beforeEach(() => {
  calls.length = 0
  vi.stubGlobal('window', { location: { search: '' } })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    calls.push({ method: init.method ?? 'GET', url, body: (init.body as string) ?? null, headers: (init.headers ?? {}) as Record<string, string> })
    return answer(url)
  }))
})
afterEach(() => vi.unstubAllGlobals())

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } })
const VIEW = { intent_id: 'ai_0123456789abcdef01234567', turn_id: 'turn_x', kind: 'code.request', state: 'pending', request_operation_id: 'ask.ai_0123456789abcdef01234567', request_id: null, lease_id: null, receiving_goal: null, last_refusal: null, last_dispatch: null, until: null, links_rev: 1 }
const OFFER: CodeTeamOffer = { to_swarm: 's_team', team_name: 'Team', template_ids: ['tpl_a'] }

describe('live client: the intents routes', () => {
  it('record, submit, get and list hit exactly the host routes, with JSON bodies on the writes', async () => {
    const live = new LiveClient('http://hive.invalid')
    answer = () => json(VIEW, 201)
    const body = { kind: 'code.request' as const, request: codeRequest({ offer: OFFER, instruction: 'fix it', title: 'Whole file: a.py: fix it', origin: { task_id: 'g_t', repository_id: 'r', workspace_id: 'ws_w', scope_id: 'scope_s', scope_digest_hex: 'a'.repeat(64), generation: 3 }, now: Date.parse('2026-10-07T10:00:00Z') }) }
    await live.askRecordIntent('op.turn-1', body)
    await live.askSubmitIntent(VIEW.intent_id)
    await live.askIntent(VIEW.intent_id)
    await live.askIntents({ limit: 1 })
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST http://hive.invalid/api/ask/op.turn-1/intents',
      `POST http://hive.invalid/api/ask/intents/${VIEW.intent_id}/submit`,
      `GET http://hive.invalid/api/ask/intents/${VIEW.intent_id}`,
      'GET http://hive.invalid/api/ask/intents?limit=1',
    ])
    expect(JSON.parse(calls[0].body!)).toEqual({ kind: 'code.request', request: { to_swarm: 's_team', kind: 'code', title: 'Whole file: a.py: fix it', instruction: 'fix it', origin: { task_id: 'g_t', repository_id: 'r', workspace_id: 'ws_w', scope_id: 'scope_s', scope_digest: `sha256:${'a'.repeat(64)}`, generation: 3 }, budget: { limit_usd: 0.5 }, lifetime: { until: '2026-10-07T11:00:00.000Z' }, lease: { template_ids: ['tpl_a'], max_children: 1 } } })
    expect(calls[0].headers['Content-Type']).toBe('application/json')
    expect(calls[1].body).toBe('{}')
    expect(calls[2].body).toBeNull()
    expect(calls.some((c) => c.url.includes('/api/requests'))).toBe(false)
  })
  it('an older hive without the routes (a bare 404): not available on this hive', async () => {
    const live = new LiveClient('http://hive.invalid')
    answer = () => json({ detail: 'Not Found' }, 404)
    const r = await vibeAvailability(live, { task_id: 'g', grant_id: 'gr', repository_id: 'r' }, 'ws_w')
    expect(r).toEqual({ ok: false, text: NO_INTENTS })
  })
})

describe('strict reads', () => {
  it('an intent view must be the owner view of a code.request with its host-derived key', () => {
    expect(parseIntentView(VIEW).state).toBe('pending')
    expect(() => parseIntentView({ ...VIEW, request_operation_id: 'other' })).toThrow()
    expect(() => parseIntentView({ ...VIEW, state: 'linked' })).toThrow() // linked without its request
    expect(() => parseIntentView({ ...VIEW, kind: 'design.request' })).toThrow()
  })
  it('the admission is r2.13’s recorded 201, closed', () => {
    const a = { request_id: 'rq_1', receiving_goal: 'g_r', lease_id: 'ls_1', state: 'accepted', budget: { root: 'rq_1', limit_usd: 0.5 }, until: '2026-10-07T11:00:00Z' }
    expect(parseAdmission(a).request_id).toBe('rq_1')
    expect(() => parseAdmission({ ...a, extra: 1 })).toThrow()
    expect(() => parseAdmission({ ...a, budget: { root: 'rq_2', limit_usd: 0.5 } })).toThrow()
  })
  it('the request body refuses an instruction over 8 KB rather than cut it', () => {
    expect(() => codeRequest({ offer: OFFER, instruction: 'x'.repeat(8193), title: 't', origin: { task_id: 'g', repository_id: 'r', workspace_id: 'w', scope_id: 's', scope_digest_hex: 'a'.repeat(64), generation: 1 }, now: 0 })).toThrow(/8 KB/)
  })
})

// r3: the live Code team read (GET /api/teams/{swarm_id}/templates, release 37e606f), over a stand-in fetch
const TEMPLATE = { template_id: 'tpl_coder', harness: 'native', model_id: 'm', role_id: null, max_allocation_usd: 3, overridable: { model_id: [] }, controls: ['stop', 'retire'], lifecycle_modes: ['bounded'] }
const SWARMS = [
  { id: 's_task', name: 'Forge', coordinator_id: 'a_1' },
  { id: 's_code', name: 'Coders', coordinator_id: 'a_2' },
  { id: 's_old', name: 'Old', coordinator_id: 'a_3', archived_at: '2026-10-01T00:00:00Z' },
  { id: 's_nocoord', name: 'Loose', coordinator_id: null },
]
function teamHive(templates: (url: string) => Response, offering = ['s_code']) {
  answer = (url) => {
    if (url.endsWith('/api/swarms')) return json(SWARMS)
    const m = /\/api\/swarms\/([^/]+)\/services$/.exec(url)
    if (m) return json({ swarm_id: m[1], kinds: offering.includes(m[1]) ? ['code'] : ['review'], connection_only_kinds: [] })
    if (url.includes('/api/teams/')) return templates(url)
    if (url.includes('/api/ask/intents')) return json({ intents: [] })
    return json({ error: { code: 'not_relayed', message: 'held' } }, 404)
  }
}
const CTX0 = { task_id: 'g', grant_id: 'gr', repository_id: 'r' }

describe('r3 live: the Code team’s offer', () => {
  it('reads the one visible code team’s templates with the Bearer header, and offers their ids (no display name)', async () => {
    teamHive(() => json({ to_swarm: 's_code', templates: [TEMPLATE, { ...TEMPLATE, template_id: 'tpl_second' }] }))
    const live = new LiveClient('http://hive.invalid')
    ;(live as unknown as { token: string }).token = 'tok-invented'
    const offer = await live.codeTeamOffer()
    expect(offer).toEqual({ to_swarm: 's_code', team_name: 'Coders', template_ids: ['tpl_coder', 'tpl_second'] })
    const read = calls.find((c) => c.url.includes('/api/teams/'))!
    expect(`${read.method} ${read.url}`).toBe('GET http://hive.invalid/api/teams/s_code/templates')
    expect(read.headers.Authorization).toBe('Bearer tok-invented')
    expect(read.url).not.toContain('token=')
    // archived and coordinator-less swarms are never asked about
    expect(calls.some((c) => /s_old|s_nocoord/.test(c.url))).toBe(false)
    const r = await vibeAvailability(live, CTX0, 'ws_w')
    expect(r).toMatchObject({ ok: true, offer })
  })
  it('a templates answer for another team, or without template ids, is refused', async () => {
    teamHive(() => json({ to_swarm: 's_other', templates: [TEMPLATE] }))
    await expect(new LiveClient('http://hive.invalid').codeTeamOffer()).rejects.toThrow(/another swarm/)
    teamHive(() => json({ to_swarm: 's_code', templates: [{ harness: 'native' }] }))
    await expect(new LiveClient('http://hive.invalid').codeTeamOffer()).rejects.toThrow(/template_id/)
  })
  for (const [name, status, code, words] of [
    ['401 (no session, ?token=, a mind’s token)', 401, 'unauthorized', /^Sign in again to hand a change to a Code swarm\.$/],
    ['403 person_required (the password login)', 403, 'person_required', /^Only a named, signed-in person can hand a change to a Code swarm/],
    ['404 (an invisible or missing team)', 404, 'not_found', /^The Code swarm is not visible to you, or no longer exists\./],
  ] as const)
    it(`maps ${name} to plain words`, async () => {
      teamHive(() => json({ error: { code, message: 'invented' } }, status))
      const r = await vibeAvailability(new LiveClient('http://hive.invalid'), CTX0, 'ws_w')
      expect(r.ok).toBe(false)
      expect((r as { text: string }).text).toMatch(words)
    })
  it('no code team, or several: says so instead of choosing', async () => {
    teamHive(() => json({ to_swarm: 's_code', templates: [TEMPLATE] }), [])
    expect(await vibeAvailability(new LiveClient('http://hive.invalid'), CTX0, 'ws_w')).toMatchObject({ ok: false, text: expect.stringMatching(/No swarm on this hive takes code changes yet/) })
    teamHive(() => json({ to_swarm: 's_code', templates: [TEMPLATE] }), ['s_code', 's_task'])
    expect(await vibeAvailability(new LiveClient('http://hive.invalid'), CTX0, 'ws_w')).toMatchObject({ ok: false, text: expect.stringMatching(/More than one swarm takes code changes here \(Forge, Coders\)/) })
    expect(calls.some((c) => c.url.includes('/api/teams/'))).toBe(false)
  })
  it('how many minds, how much money and how long are set per request, never read from the template', () => {
    const req = codeRequest({ offer: { to_swarm: 's_code', team_name: 'Coders', template_ids: ['tpl_coder'] }, instruction: 'fix it', title: 't', origin: { task_id: 'g', repository_id: 'r', workspace_id: 'w', scope_id: 's', scope_digest_hex: 'a'.repeat(64), generation: 1 }, now: Date.parse('2026-10-07T10:00:00Z') })
    expect(req.lease).toEqual({ template_ids: ['tpl_coder'], max_children: VIBE_REQUEST_LIMITS.max_children })
    expect(req.budget).toEqual({ limit_usd: VIBE_REQUEST_LIMITS.limit_usd })
    expect(req.budget.limit_usd).not.toBe(TEMPLATE.max_allocation_usd)
    expect(req.lifetime.until).toBe(new Date(Date.parse('2026-10-07T10:00:00Z') + VIBE_REQUEST_LIMITS.lifetime_minutes * 60_000).toISOString())
    const own = codeRequest({ offer: { to_swarm: 's_code', team_name: 'Coders', template_ids: ['tpl_coder'] }, limits: { max_children: 2, limit_usd: 0.25, lifetime_minutes: 30 }, instruction: 'fix it', title: 't', origin: { task_id: 'g', repository_id: 'r', workspace_id: 'w', scope_id: 's', scope_digest_hex: 'a'.repeat(64), generation: 1 }, now: 0 })
    expect(own.lease.max_children).toBe(2)
    expect(own.budget.limit_usd).toBe(0.25)
    expect(own.lifetime.until).toBe(new Date(30 * 60_000).toISOString())
  })
})

// The simulator mirrors the live host's g_person (hive/core/app.py): every intent route is a named, signed-in person's.
// The r3 smoke found the sim letting the password (operator) session record and submit, so its proposals carried an
// issuer (user:operator) the canvas rightly refuses as not this person's request.
describe('sim intent routes: a named person only, as on the live host', () => {
  it('the operator session is refused with 403 person_required on list, get, record and submit', async () => {
    const { SimClient } = await import('./sim/SimClient')
    const { ApiError } = await import('./client')
    const a = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
    a.simSession = 'operator'
    for (const call of [() => a.askIntents({ limit: 1 }), () => a.askIntent('ai_' + '0'.repeat(24)), () => a.askSubmitIntent('ai_' + '0'.repeat(24)), () => a.askRecordIntent('op', { kind: 'code.request', request: {} as never })]) {
      const e = await call().then(() => null, (x: unknown) => x)
      expect(e).toBeInstanceOf(ApiError)
      expect((e as InstanceType<typeof ApiError>).code).toBe('person_required')
    }
    a.simSession = 'person'
    expect(await a.askIntents({ limit: 1 })).toEqual({ intents: [] })
  })
})

// r4 [P2] (stand-in r3): a services read that fails must never let the page pick a team from partial reads
describe('r4 live: failed eligibility reads fail closed', () => {
  function failing(failOn: string[], offering: string[]) {
    answer = (url) => {
      if (url.endsWith('/api/swarms')) return json(SWARMS)
      const m = /\/api\/swarms\/([^/]+)\/services$/.exec(url)
      if (m && failOn.includes(m[1])) return json({ error: { code: 'internal', message: 'invented failure' } }, 500)
      if (m) return json({ swarm_id: m[1], kinds: offering.includes(m[1]) ? ['code'] : ['review'], connection_only_kinds: [] })
      if (url.includes('/api/teams/')) return json({ to_swarm: 's_code', templates: [TEMPLATE] })
      if (url.includes('/api/ask/intents')) return json({ intents: [] })
      return json({ error: { code: 'not_relayed', message: 'held' } }, 404)
    }
  }
  it('two swarms offer Code and one services read fails: nothing is chosen, "Couldn’t check which swarms offer Code. Try again."', async () => {
    failing(['s_task'], ['s_task', 's_code'])
    const r = await vibeAvailability(new LiveClient('http://hive.invalid'), CTX0, 'ws_w')
    expect(r).toEqual({ ok: false, text: 'Couldn’t check which swarms offer Code. Try again.' })
    expect(calls.some((c) => c.url.includes('/api/teams/'))).toBe(false)
  })
  it('every services read fails: not "no team offers Code", but the same fail-closed words', async () => {
    failing(['s_task', 's_code'], ['s_code'])
    const r = await vibeAvailability(new LiveClient('http://hive.invalid'), CTX0, 'ws_w')
    expect(r).toEqual({ ok: false, text: 'Couldn’t check which swarms offer Code. Try again.' })
  })
  it('the swarm list itself fails: the same words; a 401 still says sign in again', async () => {
    answer = (url) => (url.endsWith('/api/swarms') ? json({ error: { code: 'internal', message: 'x' } }, 500) : url.includes('/api/ask/intents') ? json({ intents: [] }) : json({}, 404))
    expect(await vibeAvailability(new LiveClient('http://hive.invalid'), CTX0, 'ws_w')).toEqual({ ok: false, text: 'Couldn’t check which swarms offer Code. Try again.' })
    answer = (url) => (url.endsWith('/api/swarms') ? json({ error: { code: 'unauthorized', message: 'x' } }, 401) : url.includes('/api/ask/intents') ? json({ intents: [] }) : json({}, 404))
    expect(await vibeAvailability(new LiveClient('http://hive.invalid'), CTX0, 'ws_w')).toMatchObject({ ok: false, text: expect.stringMatching(/^Sign in again/) })
  })
})
