import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../../api/client'
import type { ControllerState } from './controllerState'
import { ActionRefused, actionRefusalWords, APPLYING_OFF_LINE, driverOf, routeActions, UNTESTED_LINE } from './actions'

const state: ControllerState = { request_id: 'rq_1', engine: 'metta-coding-controller/3', phase: 'green', status: 'ready_for_you', known: true, candidate: 'suggestion_1', next_action: null, unreviewed: false, review_policy: null, review: null, review_notes: null, last_error: null, max_repairs: 3, repairs: 0, test: null, second_opinion: null, actions: {}, updated_at: null }
const legacy = () => ({ apply: vi.fn(), discard: vi.fn(), askChanges: vi.fn() })
const reads = { requestController: async () => state }
const view = (over: Record<string, unknown> = {}) => ({ request_id: 'rq_1', engine: 'metta-coding-controller/3', phase: 'ready', status: 'applied', ...over })
const engine = (s: Partial<ControllerState> = {}) => ({ kind: 'engine' as const, requestId: 'rq_1', state: { ...state, ...s } })
const routes = () => ({ ...reads, requestApply: vi.fn(async (_id: string) => view()), requestDiscard: vi.fn(async (_id: string) => view({ status: 'stopped' })), requestChanges: vi.fn(async (_id: string, _text: string) => view({ status: 'writing' })) })

describe('driverOf', () => {
  it('none without a controller read on the client, or with a 404', () => {
    expect(driverOf({}, 'rq_1', null)).toEqual({ kind: 'none' })
    expect(driverOf(reads, 'rq_1', { kind: 'none' })).toEqual({ kind: 'none' })
    expect(driverOf(reads, null, null)).toEqual({ kind: 'none' })
  })
  it('checking until the read answers, or while it is unreadable', () => {
    expect(driverOf(reads, 'rq_1', null)).toEqual({ kind: 'checking' })
    expect(driverOf(reads, 'rq_1', { kind: 'unknown' })).toEqual({ kind: 'checking' })
    expect(driverOf(reads, 'rq_1', { kind: 'engine', state: { ...state, request_id: 'rq_2' } })).toEqual({ kind: 'checking' })
  })
  it('engine for this request', () => {
    expect(driverOf(reads, 'rq_1', { kind: 'engine', state }).kind).toBe('engine')
  })
})

describe('routeActions: three branches', () => {
  it('no controller run: the canvas’s existing paths, exactly', () => {
    const l = legacy()
    const r = routeActions({}, { kind: 'none' }, l, vi.fn())
    expect(r).toMatchObject({ via: 'canvas', line: null, noteMax: 600 })
    r.apply!(); r.discard!(); r.askChanges!('smaller')
    expect(l.apply).toHaveBeenCalled(); expect(l.discard).toHaveBeenCalled(); expect(l.askChanges).toHaveBeenCalledWith('smaller')
  })
  it('engine with its person routes: only those, each answered view handed back at once; never the old paths', async () => {
    const l = legacy(), after = vi.fn()
    const client = routes()
    const r = routeActions(client, engine(), l, after)
    expect(r).toMatchObject({ via: 'engine', line: null, noteMax: 4000 })
    await r.apply!()
    expect(client.requestApply).toHaveBeenCalledWith('rq_1')
    expect(after).toHaveBeenLastCalledWith(expect.objectContaining({ request_id: 'rq_1', status: 'applied' }))
    await r.discard!()
    expect(client.requestDiscard).toHaveBeenCalledWith('rq_1')
    expect(after).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'stopped' }))
    await r.askChanges!('  keep the docstring ')
    expect(client.requestChanges).toHaveBeenCalledWith('rq_1', 'keep the docstring')
    expect(after).toHaveBeenCalledTimes(3)
    expect(l.apply).not.toHaveBeenCalled(); expect(l.discard).not.toHaveBeenCalled(); expect(l.askChanges).not.toHaveBeenCalled()
  })
  it('an answer it can’t trust (or for another request) hands back null: the caller reads again', async () => {
    const after = vi.fn()
    await routeActions({ ...routes(), requestApply: async () => ({ nope: 1 }) }, engine(), legacy(), after).apply!()
    expect(after).toHaveBeenLastCalledWith(null)
    await routeActions({ ...routes(), requestApply: async () => view({ request_id: 'rq_2' }) }, engine(), legacy(), after).apply!()
    expect(after).toHaveBeenLastCalledWith(null)
  })
  it('R3.12 unreviewed: Apply stays "Apply", with the plain line beside it; a reason Apply is held back takes the place', () => {
    const client = routes()
    const ready = { status: 'ready_for_you', unreviewed: true, review: 'unavailable', review_policy: 'review-waivable' }
    const u = routeActions(client, engine({ ...ready, actions: { apply: { available: true, why_not: null, label: 'Apply' }, changes: { available: true, why_not: null, label: null }, discard: { available: true, why_not: null, label: null } } }), legacy(), vi.fn())
    expect(u.apply).not.toBeNull()
    expect(u.line).toBe('Not reviewed. Look it over before you apply.')
    const off = routeActions(client, engine({ ...ready, actions: { apply: { available: false, why_not: 'applying is off on this hive', label: 'Apply' } } }), legacy(), vi.fn())
    expect(off.apply).toBeNull()
    expect(off.line).toBe('Applying is off on this hive.')
    // reviewed: no such line
    expect(routeActions(client, engine({ status: 'ready_for_you', actions: { apply: { available: true, why_not: null, label: 'Apply' } } }), legacy(), vi.fn()).line).toBeNull()
    // review required and none available (needs_you): the engine does not offer Apply; Discard stays
    const blocked = routeActions(client, engine({ status: 'needs_you', phase: 'blocked', review: 'unavailable', actions: { apply: { available: false, why_not: 'nothing is ready to apply', label: 'Apply' }, changes: { available: false, why_not: 'changes can be asked for once a tested proposal is waiting', label: null }, discard: { available: true, why_not: null, label: null } } }), legacy(), vi.fn())
    expect(blocked.apply).toBeNull(); expect(blocked.discard).not.toBeNull()
  })
  it('the engine’s own word: an action it says is not available is disabled, and its why_not is the line (Apply first; an older host’s review_unavailable)', () => {
    const client = routes()
    const r = routeActions(client, engine({ status: 'review_unavailable', actions: { apply: { available: false, why_not: 'applying is off on this hive', label: 'Apply' }, changes: { available: true, why_not: null, label: 'Ask for changes' }, discard: { available: false, why_not: 'this request is finished', label: 'Discard' } } }), legacy(), vi.fn())
    expect(r.apply).toBeNull(); expect(r.discard).toBeNull(); expect(r.askChanges).not.toBeNull()
    expect(r.line).toBe('Applying is off on this hive.')
    const s = routeActions(client, engine({ actions: { apply: { available: true, why_not: null, label: null }, discard: { available: false, why_not: 'this request is finished', label: null } } }), legacy(), vi.fn())
    expect(s.apply).not.toBeNull(); expect(s.discard).toBeNull()
    expect(s.line).toBe('This request is finished.')
    const t = routeActions(client, engine({ actions: { apply: { available: false, why_not: 'Applying isn’t switched on for this project yet.', label: null } } }), legacy(), vi.fn())
    expect(t.line).toBe('Applying isn’t switched on for this project yet.')
  })
  it('engine without the routes: nothing offered, one calm line, no fallback (even if the engine says available)', () => {
    const l = legacy()
    const avail = { apply: { available: true, why_not: null, label: null } }
    const r = routeActions(reads, engine({ actions: avail }), l, vi.fn())
    expect(r).toMatchObject({ via: 'engine', apply: null, discard: null, askChanges: null, line: 'Apply arrives here as soon as this hive offers it.' })
    const some = routeActions({ ...reads, requestApply: vi.fn() }, engine(), l, vi.fn())
    expect(some.line).toBe('Ask for changes and Discard arrive here as soon as this hive offers them.')
  })
  it('a failed engine route rejects in plain words and does not hand anything back', async () => {
    const after = vi.fn()
    const r = routeActions({ ...routes(), requestApply: async () => { throw new ApiError(503, 'copy_apply_off', 'applying is off on this hive (HIVE_COPY_APPLY_CLAIMS)') } }, engine(), legacy(), after)
    const e = await Promise.resolve(r.apply!()).then(() => null, (x: unknown) => x)
    expect(e).toBeInstanceOf(ActionRefused)
    expect((e as Error).message).toBe('Applying isn’t switched on for this project yet.')
    expect((e as Error).message).not.toMatch(/HIVE_|copy_apply/)
    expect(after).not.toHaveBeenCalled()
  })
  it('Ask for changes refuses an empty or over-long note before sending', async () => {
    const client = routes()
    const r = routeActions(client, engine(), legacy(), vi.fn())
    await expect(r.askChanges!('   ')).rejects.toThrow('Say what should change in a few words (up to 4000 characters).')
    await expect(r.askChanges!('x'.repeat(4001))).rejects.toBeInstanceOf(ActionRefused)
    expect(client.requestChanges).not.toHaveBeenCalled()
  })
  it('while checking: nothing offered yet', () => {
    expect(routeActions(reads, { kind: 'checking' }, legacy(), vi.fn())).toMatchObject({ apply: null, discard: null, askChanges: null, via: 'checking' })
  })
})

describe('actionRefusalWords: plain words, never codes', () => {
  const E = (status: number, code: string) => new ApiError(status, code, `${code} raw message`)
  it('each refusal the host gives', () => {
    expect(actionRefusalWords('apply', E(503, 'copy_apply_off'))).toBe('Applying isn’t switched on for this project yet.')
    expect(actionRefusalWords('apply', E(409, 'not_ready'))).toBe('It isn’t ready to apply yet — the work is still moving.')
    expect(actionRefusalWords('discard', E(403, 'not_request_person'))).toBe('Only the person who asked can decide on this change.')
    expect(actionRefusalWords('changes', E(404, 'not_found'))).toBe('This request is no longer here.')
    for (const [s, c] of [[403, 'lease_required'], [403, 'not_controller'], [409, 'request_closed'], [400, 'bad_request']] as const) expect(actionRefusalWords('apply', E(s, c)), c).toBe('Your OK couldn’t be recorded, so nothing was applied.')
    expect(actionRefusalWords('changes', E(400, 'bad_request'))).toBe('Say what should change in a few words (up to 4000 characters).')
  })
  it('anything else: one calm line', () => {
    expect(actionRefusalWords('apply', E(409, 'controller_refused'))).toBe('That didn’t go through. Nothing changed.')
    expect(actionRefusalWords('discard', E(500, 'internal'))).toBe('That didn’t go through. Nothing changed.')
    expect(actionRefusalWords('apply', new Error('offline'))).toBe('That didn’t go through. Nothing changed.')
    expect(actionRefusalWords('apply', 'weird')).toBe('That didn’t go through. Nothing changed.')
  })
})

describe('the canvas path holds Apply until the test on a copy passed', () => {
  const st = (test: string, review = 'skipped') => [{ key: 'test', state: test }, { key: 'review', state: review }]
  it('waits while the test is running, holds on a failure or an active review, and lets a passed one through', async () => {
    const { canvasApplyGate } = await import('./actions')
    expect(canvasApplyGate(st('active'), true)).toEqual({ ok: false, why: 'Waiting for the test on a copy.' })
    expect(canvasApplyGate(st('waiting'), true)).toEqual({ ok: false, why: 'Waiting for the test on a copy.' })
    expect(canvasApplyGate(st('failed'), true)).toMatchObject({ ok: false })
    expect(canvasApplyGate(st('done', 'active'), true)).toEqual({ ok: false, why: 'Waiting for the review.' })
    expect(canvasApplyGate(st('done'), true)).toEqual({ ok: true })
    // a hive that runs no tests on a copy never holds Apply on a test it cannot run
    expect(canvasApplyGate(st('skipped'), false)).toEqual({ ok: true })
  })
})

// a hive that cannot test proposals (HIVE_PROPOSAL_TEST_CLAIMS off): the controller's test is refused, it stops at
// needs_you and can never apply, so Apply is the person's own decision (the drawer's route), said as untested
describe('routeActions: the untested Apply', () => {
  const refused = { state: 'refused', status: null, tested: null, command_outcome: null, exit_code: null, stdout: null, stderr: null }
  const blocked = (over: Partial<ControllerState> = {}) => engine({ phase: 'blocked', status: 'needs_you', test: refused,
    actions: { apply: { available: false, why_not: 'nothing is ready to apply', label: 'Apply' } }, ...over })
  it('stopped at needs_you because its test was refused: Apply is the person’s own decision, said as untested', () => {
    const l = { ...legacy(), decide: vi.fn() }
    const r = routeActions(routes(), blocked(), l, vi.fn())
    expect(r).toMatchObject({ via: 'engine', untested: true, line: UNTESTED_LINE })
    r.apply!()
    expect(l.decide).toHaveBeenCalledTimes(1)
    expect(l.apply).not.toHaveBeenCalled()
  })
  it('never where its tests ran and failed, while it is not stopped, or without the person’s own route', () => {
    const l = { ...legacy(), decide: vi.fn() }
    const failed = { ...refused, state: 'done', status: 'failed', tested: true, command_outcome: 'failed', exit_code: 1 }
    expect(routeActions(routes(), blocked({ test: failed }), l, vi.fn())).toMatchObject({ apply: null, line: 'Nothing is ready to apply.' })
    expect(routeActions(routes(), blocked({ status: 'testing', phase: 'edited' }), l, vi.fn()).untested).toBeUndefined()
    expect(routeActions(routes(), blocked(), legacy(), vi.fn())).toMatchObject({ apply: null })
    // a ready engine applies itself, through its own route
    const r = routeActions(routes(), engine(), l, vi.fn())
    expect(r.untested).toBeUndefined()
    expect(r.apply).not.toBe(l.decide)
  })
})

// 2026-11-11 Create e2e: tested and reviewed, ready for the person, but the hive does not let the engine apply
// (HIVE_COPY_APPLY_CLAIMS off): Apply was offered nowhere. The person's own decision puts it in.
describe('routeActions: tested, but applying is off on this hive', () => {
  const off = (over: Partial<ControllerState> = {}) => engine({ status: 'ready_for_you',
    actions: { apply: { available: false, why_not: 'applying is off on this hive', label: 'Apply' } }, ...over })
  it('offers the person’s own decision, said plainly', () => {
    const l = { ...legacy(), decide: vi.fn() }
    const r = routeActions(routes(), off(), l, vi.fn())
    expect(r).toMatchObject({ via: 'engine', line: APPLYING_OFF_LINE })
    expect(r.untested).toBeUndefined()
    r.apply!()
    expect(l.decide).toHaveBeenCalledTimes(1)
  })
  it('never while it is not ready, while the engine can apply, or without the person’s own route', () => {
    const l = { ...legacy(), decide: vi.fn() }
    expect(routeActions(routes(), off({ status: 'testing', phase: 'edited' }), l, vi.fn()).apply).toBeNull()
    expect(routeActions(routes(), off(), legacy(), vi.fn())).toMatchObject({ apply: null })
    expect(routeActions(routes(), engine(), l, vi.fn()).apply).not.toBe(l.decide)
  })
})
