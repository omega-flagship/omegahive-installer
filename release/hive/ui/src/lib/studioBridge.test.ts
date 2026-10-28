import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { conflictRevision, draftConflict, DRAFT_MAX_BYTES } from '../api/appDrafts'
import { LiveClient } from '../api/live'
import { SimClient } from '../api/sim/SimClient'
import { SimDrafts } from '../api/sim/drafts'
import { appContext, appPerson, assetCandidates, MAX_BRIDGE_MESSAGE, pickedReply } from './appBridge'
import {
  ASSET_MIMES,
  draftError,
  FrameAssetGrants,
  invalidReply,
  MAX_ASSET_BYTES,
  MAX_ASSET_INFLIGHT,
  parseStudioMessage,
  rateLimitedReply,
  sniffImage,
  STUDIO_LIMITS,
  studioReply,
  type StudioClient,
  type StudioEnv,
  type StudioRequest,
} from './studioBridge'

afterEach(() => vi.unstubAllGlobals())

const ch = '12345678-1234-1234-1234-123456789abc'
const D = `sha256:${'a'.repeat(64)}`
const REF = { artifact_id: 'ar_simposter', revision: 4, digest: D }
const H1 = 'ab'.repeat(32)
const H2 = 'cd'.repeat(32)
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16])
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

const plain = (v: unknown): boolean =>
  v === null || ['string', 'boolean'].includes(typeof v) || (typeof v === 'number' && Number.isFinite(v)) ||
  (Array.isArray(v) ? v.every(plain) : typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype && Object.values(v as object).every(plain))

function ok(data: unknown): StudioRequest {
  const p = parseStudioMessage(data)
  if (!p || !p.ok) throw new Error(`expected a valid message: ${JSON.stringify(p)}`)
  return p.msg
}
function personSim() {
  const sim = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
  sim.simSession = 'person'
  return sim
}
const env = (client: StudioClient, more: Partial<StudioEnv> = {}): StudioEnv => ({ client, programId: 'contract-fixture', swarmId: 's_lyra', draftSave: true, grants: new FrameAssetGrants(), ...more })

describe('context: person and draftSave (data only)', () => {
  const base = { experience: 'classic', chrome: null, identity: null, reducedMotion: false, picker: true }

  it('reads person_kind and local_operator from /api/auth/me, nothing else', () => {
    expect(appPerson({ person_kind: 'person', local_operator: false, principal: 'user:p_ada', email: 'x' } as never)).toEqual({ kind: 'person', localOperator: false })
    expect(appPerson({ person_kind: 'operator', local_operator: true })).toEqual({ kind: 'operator', localOperator: true })
    expect(appPerson({ person_kind: 'operator', local_operator: 'yes' })).toEqual({ kind: 'operator', localOperator: false })
    expect(appPerson({ principal: 'operator' } as never)).toBeNull()   // an older host: unknown, not guessed
    expect(appPerson({ person_kind: 'admin' })).toBeNull()
    expect(appPerson(null)).toBeNull()
  })

  it('draftSave only with the draft routes AND a signed-in person', () => {
    const person = { kind: 'person' as const, localOperator: false }
    const c = appContext({ ...base, drafts: true, person })
    expect(c.capabilities.draftSave).toBe(true)
    expect(c.person).toEqual(person)
    expect(Object.keys(c.person!).sort()).toEqual(['kind', 'localOperator'])
    expect(plain(c)).toBe(true)
    expect(appContext({ ...base, drafts: false, person }).capabilities.draftSave).toBe(false)
    expect(appContext({ ...base, drafts: true, person: { kind: 'operator', localOperator: true } }).capabilities.draftSave).toBe(false)
    expect(appContext({ ...base, drafts: true, person: null }).capabilities.draftSave).toBe(false)
    expect(appContext({ ...base, drafts: true }).person).toBeNull()
    expect(appContext({ ...base, drafts: true, person: { kind: 'robot', localOperator: 1 } as never }).person).toBeNull()
  })

  it('the sim reports the operator by default and a person when signed in as one', async () => {
    const sim = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
    expect(appPerson(await sim.me())).toEqual({ kind: 'operator', localOperator: true })
    sim.simSession = 'person'
    expect(appPerson(await sim.me())).toEqual({ kind: 'person', localOperator: false })
  })
})

describe('slice 2 messages from a frame', () => {
  it('accepts every well-formed shape', () => {
    expect(ok({ type: 'draft-save', channel: ch, id: 's1', draft_key: 'poster-main', expected_revision: null, body: { a: [1, 'x', true, null] } }))
      .toEqual({ type: 'draft-save', id: 's1', draft_key: 'poster-main', expected_revision: null, body: { a: [1, 'x', true, null] }, source_ref: null })
    expect(ok({ type: 'draft-save', id: 's2', draft_key: 'a', expected_revision: 3, body: {}, source_ref: REF })).toMatchObject({ expected_revision: 3, source_ref: REF })
    expect(ok({ type: 'draft-list', channel: ch, id: 'l1' })).toEqual({ type: 'draft-list', id: 'l1' })
    expect(ok({ type: 'draft-load', id: 'g1', draft_key: 'poster_2' })).toEqual({ type: 'draft-load', id: 'g1', draft_key: 'poster_2' })
    expect(ok({ type: 'draft-delete', id: 'd1', draft_key: 'x'.repeat(80) })).toEqual({ type: 'draft-delete', id: 'd1', draft_key: 'x'.repeat(80) })
    expect(ok({ type: 'asset-bytes', id: 'b1', handle: H1 })).toEqual({ type: 'asset-bytes', id: 'b1', handle: H1 })
  })

  it('leaves unknown and slice-1 types to their own handling (null)', () => {
    for (const m of [{ type: 'pick', id: 'p', accept: ['asset'] }, { type: 'context?' }, { type: 'app-request', id: 'x' }, { type: 'draft-publish', id: 'x' }, { type: 'DRAFT-SAVE', id: 'x' }, { type: 'asset' }, null, 'draft-save', [], 1])
      expect(parseStudioMessage(m)).toBeNull()
  })

  it('refuses a program, swarm or person named by the frame (exact keys only)', () => {
    const bad = [
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: {}, program_id: 'other' },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: {}, swarm_id: 's_other' },
      { type: 'draft-list', id: 'x', swarm_id: 's_other' },
      { type: 'draft-load', id: 'x', draft_key: 'k', principal: 'user:p_other' },
      { type: 'draft-delete', id: 'x', draft_key: 'k', program: 'omegacode' },
      { type: 'asset-bytes', id: 'x', handle: H1, swarm_id: 's_other' },
    ]
    for (const m of bad) expect(parseStudioMessage(m)).toMatchObject({ ok: false, id: 'x', reason: 'invalid' })
  })

  it('refuses bad shapes, naming the request when its id is usable', () => {
    const bad = [
      { type: 'draft-save', id: 'x', draft_key: 'k', body: {} },   // expected_revision is required (null to create)
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: 0, body: {} },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: 1.5, body: {} },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: '2', body: {} },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: [] },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: null },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: { at: new Date(0) } },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: { m: new Map() } },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: { n: NaN } },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: { b: new ArrayBuffer(2) } },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: {}, source_ref: { ...REF, revision: 0 } },
      { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: {}, source_ref: 'ar_simposter' },
      { type: 'draft-load', id: 'x', draft_key: 'Upper' },
      { type: 'draft-load', id: 'x', draft_key: '../etc' },
      { type: 'draft-load', id: 'x', draft_key: '-lead' },
      { type: 'draft-load', id: 'x', draft_key: 'x'.repeat(81) },
      { type: 'draft-delete', id: 'x' },
      { type: 'asset-bytes', id: 'x', handle: 'AB'.repeat(32) },
      { type: 'asset-bytes', id: 'x', handle: '../x' },
      { type: 'asset-bytes', id: 'x' },
    ]
    for (const m of bad) expect(parseStudioMessage(m)).toMatchObject({ ok: false, id: 'x', reason: 'invalid' })
    let deep: Record<string, unknown> = {}
    for (let i = 0; i < 70; i++) deep = { d: deep }
    expect(parseStudioMessage({ type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: deep })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(parseStudioMessage({ type: 'draft-list', id: 'has space' })).toEqual({ ok: false, type: 'draft-list', id: null, reason: 'invalid' })
    expect(invalidReply({ type: 'draft-list', id: null, reason: 'invalid' })).toBeNull()   // nothing to answer
  })

  it('refuses oversize messages: drafts over 256 KB, other messages over 2048 bytes', () => {
    const fits = { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: { s: 'x'.repeat(DRAFT_MAX_BYTES - 20) } }
    expect(parseStudioMessage(fits)).toMatchObject({ ok: true })
    const over = { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: { s: 'x'.repeat(DRAFT_MAX_BYTES) } }
    expect(parseStudioMessage(over)).toEqual({ ok: false, type: 'draft-save', id: 'x', reason: 'too-large' })
    const multibyte = { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null, body: { s: 'é'.repeat(DRAFT_MAX_BYTES / 2) } }   // 256 KB of UTF-8, fewer UTF-16 units
    expect(parseStudioMessage(multibyte)).toMatchObject({ ok: false, reason: 'too-large' })
    expect(parseStudioMessage({ type: 'draft-load', id: 'x', draft_key: 'k', pad: 'x'.repeat(MAX_BRIDGE_MESSAGE) })).toMatchObject({ ok: false, reason: 'too-large' })
    expect(parseStudioMessage({ type: 'asset-bytes', id: 'x', handle: H1, pad: 'x'.repeat(MAX_BRIDGE_MESSAGE) })).toMatchObject({ ok: false, reason: 'too-large' })
    const cyclic: Record<string, unknown> = { type: 'draft-save', id: 'x', draft_key: 'k', expected_revision: null }
    cyclic.body = cyclic
    expect(parseStudioMessage(cyclic)).toMatchObject({ ok: false, id: 'x', reason: 'too-large' })
  })

  it('answers refusals in the request’s own reply type', () => {
    expect(invalidReply({ type: 'draft-save', id: 'x', reason: 'too-large' })).toEqual({ type: 'draft-refused', id: 'x', op: 'save', reason: 'too-large' })
    expect(invalidReply({ type: 'asset-bytes', id: 'x', reason: 'invalid' })).toEqual({ type: 'asset-refused', id: 'x', reason: 'invalid' })
    expect(rateLimitedReply(ok({ type: 'draft-list', id: 'l' }))).toEqual({ type: 'draft-refused', id: 'l', op: 'list', reason: 'rate-limited' })
    expect(rateLimitedReply(ok({ type: 'asset-bytes', id: 'b', handle: H1 }))).toEqual({ type: 'asset-refused', id: 'b', handle: H1, reason: 'rate-limited' })
    expect(STUDIO_LIMITS['draft-save'][0]).toBeGreaterThanOrEqual(5)   // a 2 s autosave fits in the window
  })
})

describe('drafts end to end against the faithful sim', () => {
  const save = (id: string, exp: number | null, body: Record<string, unknown>, more: Record<string, unknown> = {}) =>
    ok({ type: 'draft-save', id, draft_key: 'poster', expected_revision: exp, body, ...more })

  it('save, update, conflict, list, load, delete', async () => {
    const sim = personSim()
    const e = env(sim)
    expect((await studioReply(save('s1', null, { headline: 'Night sky' }, { source_ref: REF }), e)).reply).toMatchObject({ type: 'draft-saved', id: 's1', draft_key: 'poster', revision: 1 })
    expect((await studioReply(save('s2', 1, { headline: 'Night sky fest' }), e)).reply).toMatchObject({ type: 'draft-saved', revision: 2 })
    // a stale save (another tab wrote revision 2) and a create over an existing draft are refused, never overwritten
    expect((await studioReply(save('s3', 1, { headline: 'stale' }), e)).reply).toEqual({ type: 'draft-refused', id: 's3', op: 'save', reason: 'conflict', current_revision: 2 })
    expect((await studioReply(save('s4', null, { headline: 'stale' }), e)).reply).toEqual({ type: 'draft-refused', id: 's4', op: 'save', reason: 'conflict', current_revision: 2 })
    const list = (await studioReply(ok({ type: 'draft-list', id: 'l1' }), e)).reply
    expect(list).toMatchObject({ type: 'drafts', id: 'l1', drafts: [{ draft_key: 'poster', revision: 2 }] })
    const loaded = (await studioReply(ok({ type: 'draft-load', id: 'g1', draft_key: 'poster' }), e)).reply
    expect(loaded).toMatchObject({ type: 'draft', id: 'g1', draft_key: 'poster', revision: 2, body: { headline: 'Night sky fest' }, source_ref: null })
    expect(plain(loaded)).toBe(true)
    expect((await studioReply(ok({ type: 'draft-delete', id: 'd1', draft_key: 'poster' }), e)).reply).toEqual({ type: 'draft-deleted', id: 'd1', draft_key: 'poster' })
    expect((await studioReply(ok({ type: 'draft-load', id: 'g2', draft_key: 'poster' }), e)).reply).toEqual({ type: 'draft-refused', id: 'g2', op: 'load', reason: 'not-found' })
    expect((await studioReply(ok({ type: 'draft-delete', id: 'd2', draft_key: 'poster' }), e)).reply).toEqual({ type: 'draft-refused', id: 'd2', op: 'delete', reason: 'not-found' })
    // saving to a draft deleted elsewhere is a conflict with no current revision
    expect((await studioReply(save('s5', 2, { headline: 'x' }), e)).reply).toEqual({ type: 'draft-refused', id: 's5', op: 'save', reason: 'conflict', current_revision: null })
  })

  it('keeps the source reference with the draft', async () => {
    const e = env(personSim())
    await studioReply(save('s1', null, { a: 1 }, { source_ref: REF }), e)
    expect((await studioReply(ok({ type: 'draft-load', id: 'g', draft_key: 'poster' }), e)).reply).toMatchObject({ source_ref: REF })
  })

  it('too large at the hive maps to too-large (the host check and the hive agree)', async () => {
    const msg = { type: 'draft-save' as const, id: 's', draft_key: 'big', expected_revision: null, body: { s: 'x'.repeat(DRAFT_MAX_BYTES) }, source_ref: null }
    expect((await studioReply(msg, env(personSim()))).reply).toEqual({ type: 'draft-refused', id: 's', op: 'save', reason: 'too-large' })
  })

  it('scope comes from the host: another swarm or app sees nothing, and the frame cannot name one', async () => {
    const sim = personSim()
    await studioReply(save('s1', null, { a: 1 }), env(sim))
    expect((await studioReply(ok({ type: 'draft-list', id: 'l' }), env(sim, { swarmId: 's_kelp' }))).reply).toEqual({ type: 'drafts', id: 'l', drafts: [] })
    expect((await studioReply(ok({ type: 'draft-list', id: 'l' }), env(sim, { programId: 'commons-explorer' }))).reply).toEqual({ type: 'drafts', id: 'l', drafts: [] })
    // the client is called with the host's program and swarm, whatever the frame put in its body
    const calls: unknown[][] = []
    const spy: StudioClient = {
      putAppDraft: async (...a) => (calls.push(a), { draft_key: 'poster', revision: 1, saved_at: 't' }),
      listAppDrafts: async (...a) => (calls.push(a), { drafts: [] }),
      getAppDraft: async () => { throw new Error('unused') },
      deleteAppDraft: async () => ({}),
    }
    await studioReply(save('s', null, { swarm_id: 's_other', program_id: 'evil' }), env(spy))
    await studioReply(ok({ type: 'draft-list', id: 'l' }), env(spy))
    expect(calls[0]).toEqual(['contract-fixture', 'poster', { swarm_id: 's_lyra', expected_revision: null, body: { swarm_id: 's_other', program_id: 'evil' } }])
    expect(calls[1]).toEqual(['contract-fixture', 's_lyra'])
  })

  it('unavailable: no person, operator session, app disabled or unknown, swarm unknown, no routes', async () => {
    const operator = new SimClient({ seed: 42, latency: false, autoStart: false, historyDays: 1 })
    expect((await studioReply(save('s', null, {}), env(operator))).reply).toMatchObject({ reason: 'unavailable' })   // the hive refuses 403
    expect((await studioReply(save('s', null, {}), env(personSim(), { draftSave: false }))).reply).toMatchObject({ reason: 'unavailable' })
    expect((await studioReply(save('s', null, {}), env(personSim(), { programId: 'no-such-app' }))).reply).toMatchObject({ reason: 'unavailable' })
    expect((await studioReply(save('s', null, {}), env(personSim(), { swarmId: 's_nope' }))).reply).toMatchObject({ reason: 'unavailable' })
    const disabled = personSim()
    const first = (await disabled.programs())[0]
    await disabled.programDisable(first.id)
    expect((await studioReply(save('s', null, {}), env(disabled, { programId: first.id }))).reply).toMatchObject({ reason: 'unavailable' })
    expect((await studioReply(ok({ type: 'draft-list', id: 'l' }), env({}))).reply).toEqual({ type: 'draft-refused', id: 'l', op: 'list', reason: 'unavailable' })
  })

  it('a malformed hive answer is not forwarded', async () => {
    const odd: StudioClient = {
      putAppDraft: async () => ({ draft_key: 'other', revision: 1, saved_at: 't' }),
      listAppDrafts: async () => ({ drafts: [{ draft_key: 'ok', revision: 1, saved_at: 't' }, { draft_key: '../x', revision: 1, saved_at: 't' }, { draft_key: 'z', revision: 0, saved_at: 't' }] }),
      getAppDraft: async () => ({ draft_key: 'poster', revision: 1, saved_at: 't', body: [] as never, source_ref: null }),
      deleteAppDraft: async () => ({}),
    }
    expect((await studioReply(save('s', null, {}), env(odd))).reply).toMatchObject({ reason: 'unavailable' })
    expect((await studioReply(ok({ type: 'draft-list', id: 'l' }), env(odd))).reply).toEqual({ type: 'drafts', id: 'l', drafts: [{ draft_key: 'ok', revision: 1, saved_at: 't' }] })
    expect((await studioReply(ok({ type: 'draft-load', id: 'g', draft_key: 'poster' }), env(odd))).reply).toMatchObject({ reason: 'unavailable' })
  })

  it('the sim keeps the last 20 revisions and expires a draft idle for 30 days', async () => {
    let t = Date.parse('2026-10-05T10:00:00Z')
    const d = new SimDrafts({ person: () => 'user:p_ada', program: async () => 'enabled', swarmVisible: () => true }, () => t)
    let rev: number | null = null
    for (let i = 0; i < 25; i++) rev = (await d.put('omegadesign', 'poster', { swarm_id: 's_lyra', expected_revision: rev, body: { i } })).revision
    expect(rev).toBe(25)
    expect(d.retained('user:p_ada', 'omegadesign', 's_lyra', 'poster')).toBe(20)
    t += 29 * 86_400_000
    expect((await d.list('omegadesign', 's_lyra')).drafts).toHaveLength(1)
    t += 2 * 86_400_000
    expect((await d.list('omegadesign', 's_lyra')).drafts).toHaveLength(0)
    // another person never sees Ada's drafts
    const other = new SimDrafts({ person: () => 'user:p_tomas', program: async () => 'enabled', swarmVisible: () => true }, () => t)
    expect((await other.list('omegadesign', 's_lyra')).drafts).toHaveLength(0)
  })
})

describe('conflict mapping (hive errors to frame reasons)', () => {
  it('maps the hive’s error codes, and never forwards hive text', () => {
    expect(draftError(draftConflict('at 7', 7), 'save')).toEqual({ reason: 'conflict', current: 7 })
    expect(draftError(draftConflict('gone', null), 'save')).toEqual({ reason: 'conflict', current: null })
    expect(draftError(new ApiError(409, 'other_conflict', 'x'), 'save')).toEqual({ reason: 'unavailable' })
    expect(draftError(new ApiError(413, 'draft_too_large', 'x'), 'save')).toEqual({ reason: 'too-large' })
    expect(draftError(new ApiError(400, 'bad_request', 'x'), 'save')).toEqual({ reason: 'invalid' })
    expect(draftError(new ApiError(404, 'not_found', 'x'), 'load')).toEqual({ reason: 'not-found' })
    expect(draftError(new ApiError(404, 'not_found', 'x'), 'save')).toEqual({ reason: 'unavailable' })
    expect(draftError(new ApiError(403, 'person_required', 'x'), 'list')).toEqual({ reason: 'unavailable' })
    expect(draftError(new Error('boom'), 'save')).toEqual({ reason: 'unavailable' })
    expect(conflictRevision(new ApiError(409, 'draft_conflict', 'no number'))).toBeNull()
  })

  it('the live client sends the exact route and body, and keeps current_revision from a 409', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'synthetic-token', setItem: () => undefined, removeItem: () => undefined })
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: 'draft_conflict', message: 'stale', current_revision: 7 } }), { status: 409 }))
    vi.stubGlobal('fetch', fetcher)
    const live = new LiveClient('https://example.test/')
    const body = { swarm_id: 's_lyra', expected_revision: 3, body: { a: 1 }, source_ref: REF }
    const err = await live.putAppDraft('omegadesign', 'poster', body).catch((e: unknown) => e)
    expect(conflictRevision(err)).toBe(7)
    expect(fetcher).toHaveBeenCalledWith('https://example.test/api/apps/omegadesign/drafts/poster', expect.objectContaining({ method: 'PUT', body: JSON.stringify(body) }))
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'draft_too_large', message: 'big' } }), { status: 413 }))
    expect(draftError(await live.putAppDraft('omegadesign', 'poster', body).catch((e: unknown) => e), 'save')).toEqual({ reason: 'too-large' })
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ drafts: [] }), { status: 200 }))
    await live.listAppDrafts('omegadesign', 's lyra')
    expect(fetcher.mock.calls[2][0]).toBe('https://example.test/api/apps/omegadesign/drafts?swarm_id=s%20lyra')
    fetcher.mockResolvedValueOnce(new Response(null, { status: 204 }))
    await live.deleteAppDraft('omegadesign', 'poster', 's_lyra')
    expect(fetcher.mock.calls[3]).toEqual(['https://example.test/api/apps/omegadesign/drafts/poster?swarm_id=s_lyra', expect.objectContaining({ method: 'DELETE' })])
  })
})

describe('asset bytes: only files picked in this frame session', () => {
  const blobClient = (bytes: Uint8Array, calls: string[] = []): StudioClient => ({ assetBlob: async (h: string) => (calls.push(h), new Blob([bytes as Uint8Array<ArrayBuffer>])) })
  const picked = (handle = H1, mime = 'image/png', size = 12) => {
    const g = new FrameAssetGrants()
    g.grant({ handle, name: 'x', mime, size })
    return g
  }
  const ask = (handle = H1, id = 'b1') => ok({ type: 'asset-bytes', id, handle })

  it('sends the bytes of a picked raster image, transferred, with its checked type', async () => {
    const calls: string[] = []
    const out = await studioReply(ask(), env(blobClient(PNG, calls), { grants: picked() }))
    expect(out.reply).toMatchObject({ type: 'asset', id: 'b1', handle: H1, mime: 'image/png', size: PNG.length })
    const bytes = (out.reply as { bytes: ArrayBuffer }).bytes
    expect(bytes).toBeInstanceOf(ArrayBuffer)
    expect(out.transfer).toEqual([bytes])
    expect(calls).toEqual([H1])
  })

  it('refuses a handle not picked here, or picked in another frame', async () => {
    const calls: string[] = []
    const other = picked(H2)   // another frame's session picked H2
    expect((await studioReply(ask(H2), env(blobClient(PNG, calls), { grants: picked(H1) }))).reply).toEqual({ type: 'asset-refused', id: 'b1', handle: H2, reason: 'not-picked' })
    expect((await studioReply(ask(H1), env(blobClient(PNG, calls), { grants: other }))).reply).toMatchObject({ reason: 'not-picked' })
    expect((await studioReply(ask(H1), env(blobClient(PNG, calls)))).reply).toMatchObject({ reason: 'not-picked' })
    const cleared = picked(H1)
    cleared.clear()   // the frame reloaded
    expect((await studioReply(ask(H1), env(blobClient(PNG, calls), { grants: cleared }))).reply).toMatchObject({ reason: 'not-picked' })
    expect(calls).toEqual([])   // nothing was fetched for any of them
  })

  it('records grants only from the host’s own picked reply', () => {
    const [f] = assetCandidates([{ sha256: H1, mime: 'image/png', bytes: 10, name: 'a.png', owner_swarm: 's', owners: ['s'], created_by: 'x', created_at: 't', local_only: false, placements: [], history: [] }], 's', null)
    const reply = pickedReply('p', f)
    const g = new FrameAssetGrants()
    if ('asset' in reply) g.grant(reply.asset)
    expect(g.get(H1)).toEqual({ mime: 'image/png', size: 10 })
    g.grant({ handle: '../x', name: '', mime: 'image/png', size: 1 })
    expect(g.get('../x')).toBeNull()
    const small = new FrameAssetGrants(2)
    for (const h of [H1, H2, 'ef'.repeat(32)]) small.grant({ handle: h, name: '', mime: 'image/png', size: 1 })
    expect(small.get(H1)).toBeNull()   // bounded: the oldest grant goes first
  })

  it('raster images only: SVG and other types are refused before any fetch', async () => {
    const calls: string[] = []
    for (const mime of ['image/svg+xml', 'application/pdf', 'text/html', 'image/x-icon', 'image/avif'])
      expect((await studioReply(ask(), env(blobClient(PNG, calls), { grants: picked(H1, mime) }))).reply).toMatchObject({ reason: 'unsupported-type' })
    expect(calls).toEqual([])
    expect(ASSET_MIMES).not.toContain('image/svg+xml')
  })

  it('size caps: by the listed size before fetching, and by the bytes received', async () => {
    const calls: string[] = []
    expect((await studioReply(ask(), env(blobClient(PNG, calls), { grants: picked(H1, 'image/png', MAX_ASSET_BYTES + 1) }))).reply).toMatchObject({ reason: 'too-large' })
    expect(calls).toEqual([])
    const big = new Uint8Array(MAX_ASSET_BYTES + 1)
    big.set(PNG)
    expect((await studioReply(ask(), env(blobClient(big), { grants: picked() }))).reply).toMatchObject({ reason: 'too-large' })
  })

  it('the bytes must be what the listing says (signature check)', async () => {
    expect((await studioReply(ask(), env(blobClient(new TextEncoder().encode('<svg onload=alert(1)>')), { grants: picked() }))).reply).toMatchObject({ reason: 'mismatch' })
    expect((await studioReply(ask(), env(blobClient(JPG), { grants: picked() }))).reply).toMatchObject({ reason: 'mismatch' })
    expect(sniffImage(PNG)).toBe('image/png')
    expect(sniffImage(JPG)).toBe('image/jpeg')
    expect(sniffImage(GIF)).toBe('image/gif')
    expect(sniffImage(WEBP)).toBe('image/webp')
    expect(sniffImage(new Uint8Array([0x3c, 0x73, 0x76, 0x67]))).toBeNull()
    expect(sniffImage(new Uint8Array())).toBeNull()
  })

  it('unavailable without a download route or when it fails; busy past 3 at once', async () => {
    expect((await studioReply(ask(), env({}, { grants: picked() }))).reply).toMatchObject({ reason: 'unavailable' })
    expect((await studioReply(ask(), env({ assetBlob: async () => { throw new ApiError(404, 'not_found', 'gone') } }, { grants: picked() }))).reply).toMatchObject({ reason: 'unavailable' })
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const slow: StudioClient = { assetBlob: async () => (await gate, new Blob([PNG])) }
    const g = picked()
    const pending = Array.from({ length: MAX_ASSET_INFLIGHT }, (_, i) => studioReply(ask(H1, `b${i}`), env(slow, { grants: g })))
    expect((await studioReply(ask(H1, 'late'), env(slow, { grants: g }))).reply).toMatchObject({ id: 'late', reason: 'busy' })
    release()
    for (const r of await Promise.all(pending)) expect(r.reply).toMatchObject({ type: 'asset' })
    expect(g.inflight).toBe(0)
  })

  it('the sim downloads its invented images as real image bytes', async () => {
    const sim = personSim()
    const files = assetCandidates(await sim.listAssets('s_lyra'), 's_lyra', ['image/*'])
    const g = new FrameAssetGrants()
    for (const f of files) {
      const r = pickedReply('p', f)
      if ('asset' in r) g.grant(r.asset)
    }
    const png = files.find((f) => f.kind === 'image/png')!
    const svg = files.find((f) => f.kind === 'image/svg+xml')!
    expect((await studioReply(ask(png.key.slice(6)), env(sim, { grants: g }))).reply).toMatchObject({ type: 'asset', mime: 'image/png' })
    expect((await studioReply(ask(svg.key.slice(6)), env(sim, { grants: g }))).reply).toMatchObject({ reason: 'unsupported-type' })
  })
})

describe('platform next8: drafts only where the app is set up', () => {
  it('app_not_here reads as not-set-up for every op, never as a missing draft', async () => {
    const { draftError } = await import('./studioBridge')
    const { ApiError } = await import('../api/client')
    for (const op of ['save', 'list', 'load', 'delete'] as const) expect(draftError(new ApiError(404, 'app_not_here', 'not here'), op).reason).toBe('not-set-up')
    expect(draftError(new ApiError(404, 'not_found', 'gone'), 'load').reason).toBe('not-found')
  })
})

describe('platform next8 Review fix: app admission and revisions never reused', () => {
  it('app_not_opened reads as not-opened for every op', async () => {
    const { draftError } = await import('./studioBridge')
    const { ApiError } = await import('../api/client')
    for (const op of ['save', 'list', 'load', 'delete'] as const) expect(draftError(new ApiError(403, 'app_not_opened', 'open it'), op).reason).toBe('not-opened')
  })
})

describe('sim drafts follow the host: a recreated key continues its revision sequence', () => {
  it('1, delete, then 2; a stale expected revision conflicts', async () => {
    const { SimDrafts } = await import('../api/sim/drafts')
    const d = new SimDrafts({ person: () => 'user:u_ana', program: async () => 'enabled', swarmVisible: () => true })
    const a = await d.put('omegadesign', 'poster', { swarm_id: 's_lyra', expected_revision: null, body: { v: 1 } })
    expect(a.revision).toBe(1)
    await d.remove('omegadesign', 'poster', 's_lyra')
    const b = await d.put('omegadesign', 'poster', { swarm_id: 's_lyra', expected_revision: null, body: { v: 2 } })
    expect(b.revision).toBe(2)
    await expect(d.put('omegadesign', 'poster', { swarm_id: 's_lyra', expected_revision: 1, body: { v: 3 } })).rejects.toMatchObject({ status: 409 })
  })
})
