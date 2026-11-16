import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../api/client'
import { parseControllerState, readController } from './controllerState'

// the host's view() shape (hive/core/code_controller_engine.py), synthetic values
const full = {
  request_id: 'rq_1', engine: 'metta-coding-controller/3', reducer_sha256: 'f'.repeat(64), profile: 'python-pytest', phase: 'red', status: 'repairing',
  candidate: 'suggestion_1', next_action: '(think repair "suggestion_1")', review: null, last_error: null, max_repairs: 3, updated_at: '2026-11-08T10:00:00Z',
  test: { state: 'done', test_id: 't1', fork: 'fk1', status: 'CONTROLLER_TEST_OBSERVED', tested: false, command_outcome: 'not_succeeded', exit_code: 1, receipt_digest: 'sha256:' + 'e'.repeat(64), command: 'pytest -q',
    streams: { stdout: { digest: 'sha256:' + 'a'.repeat(64), retained_bytes: 80 } }, logs: { stdout: { text: 'E   assert -1 == 5\n1 failed in 0.02s', classification: 'untrusted' } } },
  journal: [{ seq: 1, id: 'o1', kind: 'proposal', fields: '()', verdict: 'accepted', at: '2026-11-08T09:59:00Z', evidence: null },
    { seq: 2, id: 'o2', kind: 'tests-fail', fields: '()', verdict: 'accepted', at: '2026-11-08T10:00:00Z', evidence: { exit: 1 } }],
  effects: [{ kind: 'test', seq: 1, state: 'done' }],
}

describe('parseControllerState (host view(), strict types, tolerant of absent and added fields)', () => {
  it('accepts the host shape', () => {
    const s = parseControllerState(full)!
    expect(s).toMatchObject({ request_id: 'rq_1', phase: 'red', status: 'repairing', known: true, candidate: 'suggestion_1', max_repairs: 3, repairs: 1, review: null })
    expect(s.test).toEqual({ state: 'done', status: 'CONTROLLER_TEST_OBSERVED', tested: false, command_outcome: 'not_succeeded', exit_code: 1, stdout: 'E   assert -1 == 5\n1 failed in 0.02s', stderr: null })
  })
  it('accepts the minimal shape and ignores fields the host adds later', () => {
    expect(parseControllerState({ request_id: 'rq_1', engine: 'metta-coding-controller/3', phase: 'open', status: 'writing', added_later: { x: 1 } })).toMatchObject({ status: 'writing', known: true, test: null, repairs: 0, candidate: null })
  })
  it('keeps an unknown status or phase, marked as not known', () => {
    expect(parseControllerState({ ...full, status: 'pondering', phase: 'later' })).toMatchObject({ status: 'pondering', phase: 'later', known: false })
  })
  it('reads the reviewer notes from the latest review observation', () => {
    const s = parseControllerState({ ...full, status: 'ready_for_you', review: 'review-pass', journal: [...full.journal, { seq: 3, id: 'o3', kind: 'review-pass', fields: '()', verdict: 'accepted', at: '2026-11-08T10:01:00Z', evidence: { notes: 'Small and correct.' } }] })
    expect(s).toMatchObject({ review: 'review-pass', review_notes: 'Small and correct.' })
  })
  it('knows the newer statuses', () => {
    for (const status of ['review_unavailable', 'engine_error', 'checking', 'tested_review_not_configured', 'applied_unrecorded']) expect(parseControllerState({ ...full, status })!.known, status).toBe(true)
  })
  it('R3.12: unreviewed, review_policy and the review values', () => {
    const ready = { ...full, status: 'ready_for_you', phase: 'ready', review: 'unavailable', review_policy: 'review-waivable', unreviewed: true, next_action: '(tell confirm-unreviewed-to-apply "suggestion_1")' }
    expect(parseControllerState(ready)).toMatchObject({ unreviewed: true, review_policy: 'review-waivable', review: 'unavailable' })
    // absent on an older host: not unreviewed, no policy
    expect(parseControllerState(full)).toMatchObject({ unreviewed: false, review_policy: null })
    // derived from next_action when the flag is absent
    expect(parseControllerState({ ...ready, unreviewed: undefined })!.unreviewed).toBe(true)
    // review_policy: a small object is tolerated; a strange shape is dropped, never fatal
    expect(parseControllerState({ ...ready, review_policy: { policy: 'review-required' } })!.review_policy).toBe('review-required')
    expect(parseControllerState({ ...ready, review_policy: 7 })!.review_policy).toBeNull()
    // unreviewed of the wrong type: nothing is claimed from a shape it does not know
    expect(parseControllerState({ ...ready, unreviewed: 'yes' })).toBeNull()
    for (const review of ['requested', 'changes_requested', 'review-pass', 'review-fail']) expect(parseControllerState({ ...full, review })!.review).toBe(review)
  })
  it('reads the actions: known names only; a malformed one is absent, never a whole-state failure', () => {
    const actions = [
      { name: 'apply', label: 'Apply', method: 'POST', path: '/api/requests/rq_1/controller/apply', body: {}, available: false, why_not: 'applying is off on this hive' },
      { name: 'changes', label: 'Ask for changes', method: 'POST', path: '/api/requests/rq_1/controller/changes', body: { text: 'string, 1-4000 characters' }, available: true, why_not: null },
      { name: 'discard', label: 'Discard', available: 'yes', why_not: null },
      { name: 'merge', label: 'Merge', available: true, why_not: null },
      'apply', null,
    ]
    const s = parseControllerState({ ...full, actions })!
    expect(s.actions).toEqual({ apply: { available: false, why_not: 'applying is off on this hive', label: 'Apply' }, changes: { available: true, why_not: null, label: 'Ask for changes' } })
    expect(parseControllerState({ ...full, actions: [{ name: 'apply', available: true, why_not: 7 }] })!.actions).toEqual({})
    expect(parseControllerState({ ...full, actions: 'all' })!.actions).toEqual({})
    expect(parseControllerState(full)!.actions).toEqual({})
  })
  it('reads the second opinion (state, decision, notes); malformed → null', () => {
    expect(parseControllerState({ ...full, second_opinion: { state: 'done', candidate: 'suggestion_1', reviewer_id: 'agent:r', decision: 'PASS', notes: 'Small and correct.' } })!.second_opinion).toEqual({ state: 'done', decision: 'pass', notes: 'Small and correct.' })
    expect(parseControllerState({ ...full, second_opinion: { state: 'journaled', reviewer_id: 'agent:r' } })!.second_opinion).toEqual({ state: 'journaled', decision: null, notes: null })
    for (const so of [{ decision: 'pass' }, { state: 'done', notes: 9 }, 'done', []]) expect(parseControllerState({ ...full, second_opinion: so })!.second_opinion).toBeNull()
  })
  it('refuses anything it cannot trust', () => {
    const bad: unknown[] = [
      null, 'rq_1', [], 7,
      { ...full, request_id: '' }, { ...full, request_id: 'rq 1' }, { ...full, request_id: undefined },
      { ...full, engine: 'other-engine/1' }, { ...full, engine: undefined },
      { ...full, phase: '' }, { ...full, status: 3 },
      { ...full, candidate: { id: 'x' } }, { ...full, review: true }, { ...full, max_repairs: 1.5 }, { ...full, updated_at: 'yesterday' },
      { ...full, last_error: 7 }, { ...full, next_action: ['think'] },
      { ...full, test: 'done' }, { ...full, test: { tested: true } }, { ...full, test: { ...full.test, exit_code: '1' } }, { ...full, test: { ...full.test, tested: 'yes' } },
      { ...full, test: { ...full.test, logs: { stdout: { text: 9 } } } }, { ...full, test: { ...full.test, logs: 'x' } },
      { ...full, journal: {} }, { ...full, journal: [{ seq: 1 }] }, { ...full, effects: [1] },
    ]
    for (const b of bad) expect(parseControllerState(b), JSON.stringify(b).slice(0, 120)).toBeNull()
  })
})

describe('readController (engine / none / unknown)', () => {
  it('none when the client has no controller read, or the host says 404', async () => {
    expect(await readController({}, 'rq_1')).toEqual({ kind: 'none' })
    expect(await readController(null, 'rq_1')).toEqual({ kind: 'none' })
    expect(await readController({ requestController: async () => { throw new ApiError(404, 'not_found', 'no controller run') } }, 'rq_1')).toEqual({ kind: 'none' })
  })
  it('engine for exactly this request', async () => {
    const r = await readController({ requestController: async (id: string) => ({ ...full, request_id: id }) }, 'rq_1')
    expect(r.kind === 'engine' && r.state.status).toBe('repairing')
  })
  it('unknown for another request, a bad shape, or any other failure (nothing claimed)', async () => {
    expect(await readController({ requestController: async () => ({ ...full, request_id: 'rq_2' }) }, 'rq_1')).toEqual({ kind: 'unknown' })
    expect(await readController({ requestController: async () => ({ nope: 1 }) }, 'rq_1')).toEqual({ kind: 'unknown' })
    expect(await readController({ requestController: async () => { throw new ApiError(500, 'internal', 'boom') } }, 'rq_1')).toEqual({ kind: 'unknown' })
    expect(await readController({ requestController: async () => { throw new Error('offline') } }, 'rq_1')).toEqual({ kind: 'unknown' })
  })
})
