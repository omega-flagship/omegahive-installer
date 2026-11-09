import { describe, expect, it } from 'vitest'
import type { ProjectTestEvidence } from '../../suggestions/projectTestEvidence'
import type { VibePhase } from '../vibeSession'
import type { ControllerState, ControllerTest } from './controllerState'
import { decisiveLine, liveWords, nextRoundInstruction, roundOf, testFromController, testFromEvidence, workStages, type StageKey, type TestView, type WorkInput } from './stages'

const scope = { path: 'calc.py', lines: { first: 1, last: 2 }, fn: 'add' }
const proposal = { changes: 1, file: 'calc.py', elsewhere: 0, verified: true }
function input(phase: VibePhase, over: Partial<WorkInput> = {}): WorkInput {
  const after = !['working', 'error', 'unavailable'].includes(phase.kind)
  return { phase, instruction: 'Fix add() in the calculator', scope, team: 'Code team', mind: after ? 'Anvil' : null, sent: phase.kind !== 'working' || !['scope', 'turn', 'send'].includes(phase.step), proposal: after ? proposal : null, blocked: null, test: { kind: 'idle' }, ...over }
}
const states = (w: ReturnType<typeof workStages>) => Object.fromEntries(w.stages.map((s) => [s.key, s.state])) as Record<StageKey, string>
const stage = (w: ReturnType<typeof workStages>, k: StageKey) => w.stages.find((s) => s.key === k)!
const NO_IDS = /suggestion_|rq_|sha256|generation|digest|[a-f0-9]{16}/

describe('workStages: every phase', () => {
  it('asking: scope, turn, send', () => {
    for (const step of ['scope', 'turn', 'send'] as const) {
      const w = workStages(input({ kind: 'working', step }))
      expect(states(w)).toEqual({ ask: 'active', mind: 'waiting', change: 'waiting', test: 'waiting', review: 'waiting', ready: 'waiting' })
      expect(w.next).toBe('wait')
    }
    expect(stage(workStages(input({ kind: 'working', step: 'scope' })), 'ask').words).toBe('Marking function add (lines 1–2) of calc.py for the mind…')
    expect(stage(workStages(input({ kind: 'working', step: 'send' })), 'ask').words).toBe('Sending it to Code team…')
  })
  it('the helper mind: starting, thinking, reading', () => {
    expect(states(workStages(input({ kind: 'working', step: 'starting' })))).toMatchObject({ ask: 'done', mind: 'active', change: 'waiting' })
    expect(stage(workStages(input({ kind: 'working', step: 'mind' })), 'mind').words).toBe('Code team is thinking it through…')
    expect(stage(workStages(input({ kind: 'working', step: 'read' }, { mind: 'Anvil' })), 'mind').words).toBe('Anvil has an answer. Reading it…')
    expect(stage(workStages(input({ kind: 'working', step: 'mind' })), 'ask').detail).toBe('Function add (lines 1–2) of calc.py')
  })
  it('writing: the change is going in', () => {
    const w = workStages(input({ kind: 'writing' }))
    expect(states(w)).toMatchObject({ mind: 'done', change: 'active', test: 'waiting', ready: 'waiting' })
    expect(stage(w, 'change').words).toBe('Anvil is writing it into calc.py…')
  })
  it('review: ready for the person, with the change, test and review slots', () => {
    const w = workStages(input({ kind: 'review' }, { test: { kind: 'unavailable' } }))
    expect(states(w)).toEqual({ ask: 'done', mind: 'done', change: 'done', test: 'skipped', review: 'skipped', ready: 'active' })
    expect(stage(w, 'change').words).toBe('Proposes one change in calc.py')
    expect(w.next).toBe('decide')
  })
  it('review, unverified: cannot be applied', () => {
    const w = workStages(input({ kind: 'review' }, { proposal: { ...proposal, verified: false } }))
    expect(states(w)).toMatchObject({ change: 'failed', test: 'waiting', ready: 'failed' })
    expect(w.next).toBe('none')
  })
  it('review, blocked: says why on the ready step', () => {
    const w = workStages(input({ kind: 'review' }, { blocked: 'calc.py changed since this was proposed.' }))
    expect(stage(w, 'ready')).toMatchObject({ state: 'active', detail: 'calc.py changed since this was proposed.' })
  })
  it('after the decision: consented, applying, applied, done, declined, undone', () => {
    expect(stage(workStages(input({ kind: 'consented', valid: 'valid for 10 minutes', expires_at: '2026-11-08T10:10:00Z' })), 'ready').state).toBe('active')
    expect(stage(workStages(input({ kind: 'applying' })), 'ready').state).toBe('active')
    expect(stage(workStages(input({ kind: 'applied', words: [], currency: 'current', authorization: 'consented' })), 'ready')).toMatchObject({ state: 'done', words: 'Applied to your copy' })
    expect(stage(workStages(input({ kind: 'applied', words: [], currency: 'current', authorization: 'unconsented' })), 'ready').state).toBe('failed')
    expect(stage(workStages(input({ kind: 'done', kept: 2, skipped: 1 }, { proposal: { ...proposal, changes: 3 } })), 'ready')).toMatchObject({ state: 'done', words: 'Applied: 2 changes kept, 1 skipped' })
    expect(stage(workStages(input({ kind: 'done', kept: 0, skipped: 1 })), 'ready')).toMatchObject({ state: 'skipped', words: 'Discarded' })
    expect(workStages(input({ kind: 'declined', checking: true })).next).toBe('wait')
    expect(stage(workStages(input({ kind: 'declined', checking: false })), 'ready').words).toBe('Discarded')
    expect(stage(workStages(input({ kind: 'undone' })), 'ready').state).toBe('skipped')
    // an untested proposal, decided: not tested
    expect(stage(workStages(input({ kind: 'done', kept: 1, skipped: 0 })), 'test')).toMatchObject({ state: 'skipped', words: 'Not tested' })
  })
  it('errors land on the step they happened at', () => {
    const before = workStages(input({ kind: 'error', text: 'Nothing was handed to Code team: refused' }, { sent: false }))
    expect(states(before)).toMatchObject({ ask: 'failed', mind: 'waiting' })
    expect(stage(before, 'ask').detail).toBe('Nothing was handed to Code team: refused')
    const waiting = workStages(input({ kind: 'unavailable', text: 'No mind started.' }, { sent: true }))
    expect(states(waiting)).toMatchObject({ ask: 'done', mind: 'failed' })
    const late = workStages(input({ kind: 'error', text: 'The source moved.' }, { proposal, mind: 'Anvil' }))
    expect(stage(late, 'ready')).toMatchObject({ state: 'failed', detail: 'The source moved.' })
    expect(late.next).toBe('none')
  })
  it('no ids, digests or codes in any words', () => {
    const phases: VibePhase[] = [{ kind: 'working', step: 'scope' }, { kind: 'working', step: 'mind' }, { kind: 'writing' }, { kind: 'review' }, { kind: 'done', kept: 1, skipped: 0 }]
    for (const ph of phases) for (const s of workStages(input(ph, { test: { kind: 'failed', line: 'assert add(2, 3) == 5' } })).stages) expect(`${s.words} ${s.detail ?? ''}`).not.toMatch(NO_IDS)
  })
  it('liveWords: the moving step, with its decisive line', () => {
    expect(liveWords(workStages(input({ kind: 'working', step: 'mind' })))).toBe('Code team is thinking it through…')
    expect(liveWords(workStages(input({ kind: 'done', kept: 1, skipped: 0 }, { test: { kind: 'passed', line: '1 passed in 0.02s' } })))).toBe('Applied: one change kept')
  })
})

describe('testing on a copy', () => {
  const at = (test: TestView) => stage(workStages(input({ kind: 'review' }, { test })), 'test')
  it('each test state', () => {
    expect(at({ kind: 'idle' })).toMatchObject({ state: 'active', words: 'Getting a copy ready to test on…' })
    expect(at({ kind: 'asking' }).state).toBe('active')
    expect(at({ kind: 'waiting' }).state).toBe('active')
    expect(at({ kind: 'running' })).toMatchObject({ state: 'active', words: 'Testing on a copy…' })
    expect(at({ kind: 'passed', line: '1 passed in 0.02s' })).toMatchObject({ state: 'done', words: 'Tests passed on a copy', line: '1 passed in 0.02s' })
    expect(at({ kind: 'failed', line: 'assert add(2, 3) == 5' })).toMatchObject({ state: 'failed', words: 'A test failed on a copy', line: 'assert add(2, 3) == 5' })
    expect(at({ kind: 'unknown', line: null }).state).toBe('failed')
    expect(at({ kind: 'stale' }).state).toBe('skipped')
    expect(at({ kind: 'slow' }).state).toBe('skipped')
    expect(at({ kind: 'error', text: 'Not confirmed.' })).toMatchObject({ state: 'failed', detail: 'Not confirmed.' })
  })
  it('a failed test cautions on the ready step; a running one says so', () => {
    expect(stage(workStages(input({ kind: 'review' }, { test: { kind: 'failed', line: null } })), 'ready').detail).toBe('A test failed on a copy, so Apply waits: ask for changes, or discard it.')
    expect(stage(workStages(input({ kind: 'review' }, { test: { kind: 'running' } })), 'ready').detail).toBe('Apply opens once the test on a copy passes.')
  })
  it('decisiveLine: the tally for a pass, the first failing assertion for a failure', () => {
    expect(decisiveLine(['collected 1 item\n\ntest_calc.py .\n\n============ 1 passed in 0.02s ============\n'], true)).toBe('1 passed in 0.02s')
    const pytestFail = 'test_calc.py F\n\n    def test_add():\n>       assert add(2, 3) == 5\nE       assert -1 == 5\nE        +  where -1 = add(2, 3)\n\n=========== 1 failed in 0.05s ===========\n'
    expect(decisiveLine([pytestFail], false)).toBe('assert -1 == 5')
    expect(decisiveLine(['Traceback (most recent call last):\nAssertionError: expected 5\n'], false)).toBe('AssertionError: expected 5')
    expect(decisiveLine(['ran\n2 failed, 3 passed\n'], false)).toBe('2 failed, 3 passed')
    expect(decisiveLine(['', '  '], true)).toBeNull()
    expect(decisiveLine(['x'.repeat(400)], true)!.length).toBeLessThanOrEqual(180)
  })
  const row = (over: Partial<ProjectTestEvidence>): ProjectTestEvidence => ({ test_id: 't1', launch_key: 'launch_key_1', source_currency: 'current', execution_currency: 'current', currency: 'current', tested: false, outcome: 'unknown', receipt_digest: null, logs: [], ...over })
  const log = (name: 'stdout' | 'stderr', text: string) => ({ name, bytes: text.length, digest: 'sha256:' + 'e'.repeat(64), text, preview_truncated: false, complete: true })
  it('testFromEvidence: from the verified rows for this proposal', () => {
    expect(testFromEvidence(null)).toEqual({ kind: 'waiting' })
    expect(testFromEvidence([])).toEqual({ kind: 'waiting' })
    expect(testFromEvidence([row({})])).toEqual({ kind: 'running' })
    expect(testFromEvidence([row({ receipt_digest: 'sha256:' + 'f'.repeat(64), tested: true, outcome: 'succeeded', logs: [log('stdout', '== 1 passed in 0.01s =='), log('stderr', '')] })])).toEqual({ kind: 'passed', line: '1 passed in 0.01s' })
    expect(testFromEvidence([row({ receipt_digest: 'sha256:' + 'f'.repeat(64), outcome: 'not_succeeded', logs: [log('stdout', 'E   assert -1 == 5\n1 failed')] })])).toEqual({ kind: 'failed', line: 'assert -1 == 5' })
    expect(testFromEvidence([row({ receipt_digest: 'sha256:' + 'f'.repeat(64), outcome: 'succeeded', logs: [] })])).toEqual({ kind: 'unknown', line: null })
    expect(testFromEvidence([row({ receipt_digest: 'sha256:' + 'f'.repeat(64), currency: 'stale', outcome: 'succeeded' })])).toMatchObject({ kind: 'stale', was: 'passed' })
    expect(testFromEvidence([row({ receipt_digest: 'sha256:' + 'f'.repeat(64), currency: 'stale', outcome: 'unknown' })])).toEqual({ kind: 'stale' })
    // a run on this very change, once it went in: the code moved on, and what the run found is kept
    expect(testFromEvidence([row({ receipt_digest: 'sha256:' + 'f'.repeat(64), currency: 'stale', outcome: 'succeeded', tested: true })])).toMatchObject({ kind: 'stale', was: 'passed' })
  })
})

describe('the engine (controller) view, preferred where it speaks', () => {
  const base: ControllerState = { request_id: 'rq_1', engine: 'metta-coding-controller/3', phase: 'green', status: 'ready_for_you', known: true, candidate: 'suggestion_1', next_action: null, unreviewed: false, review_policy: null, review: null, review_notes: null, last_error: null, max_repairs: 3, repairs: 0, test: null, second_opinion: null, actions: {}, updated_at: null }
  const ct = (over: Partial<ControllerTest>): ControllerTest => ({ state: 'done', status: 'CONTROLLER_TEST_OBSERVED', tested: null, command_outcome: null, exit_code: null, stdout: null, stderr: null, ...over })
  const w = (c: Partial<ControllerState>, test: TestView = { kind: 'idle' }, ph: VibePhase = { kind: 'review' }) => workStages(input(ph, { test, controller: { ...base, ...c } }))
  it('its test wins over the derived one, with the decisive line from its logs', () => {
    expect(stage(w({ test: ct({ tested: true, command_outcome: 'succeeded', exit_code: 0, stdout: '== 3 passed in 0.10s ==' }) }, { kind: 'running' }), 'test')).toMatchObject({ state: 'done', line: '3 passed in 0.10s' })
    expect(stage(w({ status: 'repairing', phase: 'red', test: ct({ command_outcome: 'not_succeeded', exit_code: 1, stdout: 'E   assert -1 == 5\n1 failed' }) }), 'test')).toMatchObject({ state: 'failed', line: 'assert -1 == 5' })
    expect(stage(w({ test: ct({ state: 'journaled' }) }), 'test').state).toBe('active')
  })
  it('falls back to the exit code when there is no output', () => {
    expect(testFromController(ct({ tested: true, exit_code: 0 }))).toEqual({ kind: 'passed', line: 'Tests passed' })
    expect(testFromController(ct({ command_outcome: 'not_succeeded', exit_code: 1 }))).toEqual({ kind: 'failed', line: 'Tests failed (exit 1)' })
    expect(testFromController(ct({ state: 'refused' })).kind).toBe('error')
  })
  it('testing with no test yet is running', () => {
    expect(stage(w({ status: 'testing', phase: 'edited' }), 'test').state).toBe('active')
  })
  it('repairing: the helper is fixing what the test found, bounded by its repair limit', () => {
    const r = w({ status: 'repairing', phase: 'red', repairs: 1, test: ct({ command_outcome: 'not_succeeded', exit_code: 1 }) })
    expect(stage(r, 'change')).toMatchObject({ state: 'active', words: 'Anvil is fixing what the test found…', detail: 'Repair 1 of 3' })
    expect(stage(r, 'ready').state).toBe('waiting')
    expect(r.next).toBe('wait')
  })
  it('review: passed, failed, not set up yet, under way', () => {
    expect(stage(w({ review: 'review-pass', review_notes: 'Small and correct.' }), 'review')).toMatchObject({ state: 'done', words: 'Reviewed: looks right', detail: 'Small and correct.' })
    expect(stage(w({ review: 'review-fail' }), 'review').state).toBe('failed')
    const notSetUp = w({ status: 'tested_review_not_configured', review: 'not_configured' })
    expect(stage(notSetUp, 'review')).toMatchObject({ state: 'skipped', words: 'Review isn’t set up yet' })
    expect(notSetUp.next).toBe('decide')
    expect(stage(w({ status: 'reviewing' }), 'review').state).toBe('active')
    expect(w({ status: 'reviewing' }).next).toBe('wait')
  })
  it('ready_for_you and waiting_for_your_apply: the person decides', () => {
    expect(w({ status: 'ready_for_you' }).next).toBe('decide')
    expect(stage(w({ status: 'waiting_for_your_apply' }), 'ready').state).toBe('active')
  })
  it('needs_you, applied, stopped', () => {
    expect(stage(w({ status: 'needs_you', phase: 'blocked', last_error: 'The tests could not start.' }), 'ready')).toMatchObject({ state: 'failed', words: 'It needs you', detail: 'The tests could not start.' })
    expect(stage(w({ status: 'applied', phase: 'delivered' }), 'ready')).toMatchObject({ state: 'done', words: 'Applied to your copy' })
    expect(w({ status: 'stopped', phase: 'stopped' }).next).toBe('none')
  })
  it('review_unavailable: the second opinion is skipped, and the person still decides', () => {
    const r = w({ status: 'review_unavailable', review: 'unavailable' })
    expect(stage(r, 'review')).toMatchObject({ state: 'skipped', words: 'A second opinion isn’t available right now' })
    expect(r.next).toBe('decide')
    expect(stage(r, 'ready').state).toBe('active')
  })
  it('the second opinion speaks for the review stage when present', () => {
    const so = (o: Partial<NonNullable<ControllerState['second_opinion']>>) => ({ state: 'done', decision: null, notes: null, ...o })
    expect(stage(w({ second_opinion: so({ decision: 'pass', notes: 'Small and right.' }) }), 'review')).toMatchObject({ state: 'done', words: 'Reviewed: looks right', detail: 'Small and right.' })
    expect(stage(w({ review: 'review-pass', second_opinion: so({ decision: 'fail', notes: 'Keep the docstring.' }) }), 'review')).toMatchObject({ state: 'failed', detail: 'Keep the docstring.' })
    expect(stage(w({ status: 'testing', second_opinion: so({ state: 'journaled' }) }), 'review').state).toBe('active')
  })
  it('engine_error: said plainly with its detail; Discard stays reachable', () => {
    const e = w({ status: 'engine_error', last_error: 'The helper stopped answering.' })
    expect(stage(e, 'ready')).toMatchObject({ state: 'failed', words: 'Something went wrong in the work; you can discard it or ask again', detail: 'The helper stopped answering.' })
    expect(e.next).toBe('decide')
    expect(w({ status: 'engine_error' }, { kind: 'idle' }, { kind: 'writing' }).next).toBe('none')
  })
  it('checking: the ready step says so and waits', () => {
    const c = w({ status: 'checking', phase: 'reconcile' })
    expect(stage(c, 'ready')).toMatchObject({ state: 'active', words: 'Checking where things stand…' })
    expect(c.next).toBe('wait')
  })
  it('R3.12 awaiting a helper: the mind step waits for one, and only it moves', () => {
    const a = w({ status: 'writing', phase: 'open', candidate: null, next_action: '(rest awaiting-helper)' }, { kind: 'idle' }, { kind: 'working', step: 'mind' })
    expect(stage(a, 'mind')).toMatchObject({ state: 'active', words: 'Waiting for a helper to pick it up…' })
    expect(a.stages.filter((s) => s.state === 'active').map((s) => s.key)).toEqual(['mind'])
    expect(a.next).toBe('wait')
  })
  it('R3.12 unreviewed: review skipped under the review setting; the ready step asks for a look; Apply stays the engine\'s word', () => {
    const u = w({ status: 'ready_for_you', phase: 'ready', test: ct({ tested: true, command_outcome: 'succeeded', exit_code: 0 }), review: 'unavailable', unreviewed: true, review_policy: 'review-waivable', next_action: '(tell confirm-unreviewed-to-apply "suggestion_1")' })
    expect(stage(u, 'review')).toMatchObject({ state: 'skipped', words: 'Not reviewed: your review setting lets you apply without a second opinion' })
    expect(stage(u, 'ready')).toMatchObject({ state: 'active', words: 'Ready for you', detail: 'No one else has checked this change.' })
    expect(u.next).toBe('decide')
    // from next_action alone (an older parse without the flag)
    expect(stage(w({ status: 'ready_for_you', next_action: '(tell confirm-unreviewed-to-apply "suggestion_1")' }), 'review').words).toMatch(/^Not reviewed/)
  })
  it('R3.12 review values: requested, changes_requested, unavailable', () => {
    expect(stage(w({ status: 'reviewing', review: 'requested' }), 'review')).toMatchObject({ state: 'active', words: 'A second opinion is looking at it…' })
    expect(stage(w({ status: 'testing', review: 'requested' }), 'review').state).toBe('active')
    const so = { state: 'done', decision: 'fail', notes: 'Keep the docstring.' }
    expect(stage(w({ status: 'writing', review: 'changes_requested', second_opinion: so }, { kind: 'idle' }, { kind: 'writing' }), 'review')).toMatchObject({ state: 'failed', words: 'The reviewer asked for changes', detail: 'Keep the docstring.' })
    // the person asked for changes after a pass: the pass was for the earlier version
    expect(stage(w({ status: 'writing', review: 'changes_requested', second_opinion: { ...so, decision: 'pass' } }, { kind: 'idle' }, { kind: 'writing' }), 'review').state).toBe('waiting')
    // an older host's review_unavailable status, worded as before
    expect(stage(w({ status: 'review_unavailable', review: 'unavailable' }), 'review')).toMatchObject({ state: 'skipped', words: 'A second opinion isn’t available right now' })
  })
  it('R3.12 review required and no second opinion can run: needs_you, said plainly; Discard stays reachable', () => {
    const n = w({ status: 'needs_you', phase: 'blocked', review: 'unavailable', review_policy: 'review-required', test: ct({ tested: true, command_outcome: 'succeeded', exit_code: 0 }) })
    expect(stage(n, 'review')).toMatchObject({ state: 'failed', words: 'A second opinion is needed before this can go in, and none is available right now' })
    expect(stage(n, 'ready')).toMatchObject({ state: 'failed', words: 'A second opinion is needed before this can go in, and none is available right now' })
    expect(stage(n, 'ready').detail).toBeUndefined()
    expect(n.next).toBe('decide')
    expect(stage(w({ status: 'needs_you', phase: 'blocked', review: 'unavailable', last_error: 'No reviewer on this team can run.' }), 'ready').detail).toBe('No reviewer on this team can run.')
    // another reason to need the person: as before
    expect(stage(w({ status: 'needs_you', phase: 'blocked', last_error: 'The tests could not start.' }), 'ready').words).toBe('It needs you')
  })
  it('R3.12 applied_unrecorded: it is in; the hive is still recording it', () => {
    const a = w({ status: 'applied_unrecorded', phase: 'ready' })
    expect(stage(a, 'ready')).toMatchObject({ state: 'done', words: 'Applied to your copy', detail: 'It’s in your copy. The hive is still recording it.' })
    expect(a.next).toBe('none')
  })
  it('no ids or codes reach any R3.12 word, and one step moves at a time (review exempt)', () => {
    const cases = [
      w({ status: 'writing', next_action: '(rest awaiting-helper)' }, { kind: 'idle' }, { kind: 'working', step: 'mind' }),
      w({ status: 'ready_for_you', unreviewed: true, review: 'unavailable' }),
      w({ status: 'reviewing', review: 'requested' }, { kind: 'running' }),
      w({ status: 'applied_unrecorded' }),
      w({ status: 'checking' }),
    ]
    for (const c of cases) {
      for (const s of c.stages) expect(`${s.words} ${s.detail ?? ''}`).not.toMatch(NO_IDS)
      expect(c.stages.filter((s) => s.state === 'active' && s.key !== 'review' && s.key !== 'ready').length).toBeLessThanOrEqual(1)
    }
  })
  it('an unknown status falls back to the derived stages entirely', () => {
    const u = w({ status: 'pondering', known: false, review: 'review-fail', test: ct({ tested: true }) }, { kind: 'failed', line: 'assert x' })
    expect(stage(u, 'test')).toMatchObject({ state: 'failed', line: 'assert x' })
    expect(stage(u, 'review').state).toBe('skipped')
    expect(u.next).toBe('decide')
  })
})

describe('ask for changes: rounds', () => {
  it('the next round carries the note; the timeline counts it', () => {
    const two = nextRoundInstruction('Fix add() in the calculator', '  keep the docstring ')
    expect(two).toBe('Fix add() in the calculator\n\nChanges asked for: keep the docstring')
    expect(roundOf(two)).toEqual({ round: 2, asked: 'Fix add() in the calculator', note: 'keep the docstring' })
    const three = nextRoundInstruction(two, 'and a test')
    expect(roundOf(three)).toEqual({ round: 3, asked: 'Fix add() in the calculator', note: 'and a test' })
    const w = workStages(input({ kind: 'working', step: 'mind' }, { instruction: two }))
    expect(w).toMatchObject({ round: 2, asked: 'Fix add() in the calculator', changesAsked: 'keep the docstring' })
    expect(stage(w, 'ask').words).toBe('Asked again (round 2)')
    expect(roundOf(null)).toEqual({ round: 1, asked: null, note: null })
  })
})

describe('one step moves at a time', () => {
  it('a later active step waits its turn, except Ready alongside a running test', async () => {
    const { oneMoving } = await import('./stages')
    const out = oneMoving([
      { key: 'ask', state: 'done', words: 'Asked' },
      { key: 'mind', state: 'active', words: 'Lyra is thinking it through…' },
      { key: 'change', state: 'active', words: 'Lyra is writing the change…' },
      { key: 'test', state: 'active', words: 'Waiting for the test run to start…' },
      { key: 'review', state: 'waiting', words: 'Review' },
      { key: 'ready', state: 'active', words: 'Ready for you' },
    ])
    expect(out.map((s) => s.state)).toEqual(['done', 'active', 'waiting', 'waiting', 'waiting', 'active'])
    expect(out[3].words).toBe('Testing on a copy')
  })
})
