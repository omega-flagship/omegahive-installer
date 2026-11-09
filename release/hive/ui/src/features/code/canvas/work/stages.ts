/**
 * The work on one request as a timeline (pure; no React, no reads): asking → the helper mind thinking → its proposed
 * change → testing on a copy → review → ready for the person. Derived from what the canvas already knows (the vibe
 * session's phase and result, the sandbox test request and its project-test evidence) and, when the host serves it,
 * the request controller's own view (./controllerState; preferred stage by stage where it speaks).
 *
 * Plain words only: no ids, digests, generations or internal codes reach a stage.
 */
import type { VibePhase } from '../vibeSession'
import { scopeWords, type ScopeShown } from '../vibe'
import type { ProjectTestEvidence } from '../../suggestions/projectTestEvidence'
import type { ControllerState, ControllerTest } from './controllerState'

export type StageKey = 'ask' | 'mind' | 'change' | 'test' | 'review' | 'ready'
export type StageState = 'waiting' | 'active' | 'done' | 'failed' | 'skipped'
export interface Stage {
  key: StageKey
  state: StageState
  words: string
  detail?: string
  /** the decisive output line (the test's), shown in mono */
  line?: string
}
/** The sandbox test on a copy, as the canvas knows it. */
export type TestView =
  | { kind: 'unavailable' }
  | { kind: 'idle' }
  /** the test request is being admitted */
  | { kind: 'asking' }
  /** admitted; no run recorded for this proposal yet */
  | { kind: 'waiting' }
  | { kind: 'running' }
  | { kind: 'passed'; line: string | null }
  | { kind: 'failed'; line: string | null }
  /** it ran, but its result could not be fully verified */
  | { kind: 'unknown'; line: string | null }
  /** the run is for an earlier version of the code */
  | { kind: 'stale'; was?: 'passed' | 'failed'; line?: string | null }
  | { kind: 'error'; text: string }
  /** no result arrived in the time the canvas waits */
  | { kind: 'slow' }

export interface WorkInput {
  phase: VibePhase
  /** the instruction as sent (round 2+ carry "Changes asked for: …" notes) */
  instruction: string | null
  scope: ScopeShown | null
  /** the team the request went to (known once it is sent) */
  team: string | null
  /** the helper mind's name (known once its proposal is read) */
  mind: string | null
  /** whether the request was sent (a route exists) */
  sent: boolean
  /** the proposal, once read: how many changes, in which file, and whether it passed its integrity check here */
  proposal: { changes: number; file: string; elsewhere: number; verified: boolean } | null
  /** why the proposal can't be decided now, or null */
  blocked: string | null
  test: TestView
  controller?: ControllerState | null
}
export type NextAction = 'wait' | 'decide' | 'none'
export interface Work {
  stages: Stage[]
  round: number
  /** the person's original words (without the notes) */
  asked: string | null
  /** the latest "changes asked for" note, on round 2+ */
  changesAsked: string | null
  next: NextAction
}

export const CHANGES_ASKED = '\n\nChanges asked for: '
/** The instruction for another round: the words so far plus the person's note. */
export function nextRoundInstruction(instruction: string, note: string): string {
  return `${instruction.trimEnd()}${CHANGES_ASKED}${note.trim()}`
}
/** Round 1 is the first ask; every "Changes asked for" note adds one. */
export function roundOf(instruction: string | null): { round: number; asked: string | null; note: string | null } {
  if (!instruction) return { round: 1, asked: null, note: null }
  const parts = instruction.split(CHANGES_ASKED)
  return { round: parts.length, asked: parts[0].trim(), note: parts.length > 1 ? parts[parts.length - 1].trim() : null }
}

const MAX_LINE = 180
const clip = (s: string) => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s)
const bare = (s: string) => s.replace(/^[=\-_*\s]+|[=\-_*\s]+$/g, '').trim()

/**
 * The one line that says how a run went: for a pass, the tally ("1 passed in 0.02s"); for a failure, the first failing
 * assertion ("assert add(2, 3) == 5"), else the failure tally, else the last thing it said.
 */
export function decisiveLine(texts: string[], ok: boolean): string | null {
  const lines = texts.flatMap((t) => t.split(/\r?\n/)).map((l) => l.trimEnd()).filter((l) => l.trim())
  if (!lines.length) return null
  const tally = [...lines].reverse().find((l) => /\b\d+ (passed|failed|errors?)\b/.test(l))
  if (ok) return clip(bare(tally ?? lines[lines.length - 1]))
  const pytestE = lines.find((l) => /^E\s+\S/.test(l))
  if (pytestE) return clip(pytestE.replace(/^E\s+/, '').trim())
  const assertion = lines.find((l) => /AssertionError|\bassert\b|\bFAILED\b|\bFAIL:|Error:/.test(l))
  if (assertion) return clip(assertion.trim())
  return clip(bare(tally ?? lines[lines.length - 1]))
}

/** The test on a copy, from the verified project-test evidence for exactly this proposal. */
export function testFromEvidence(rows: ProjectTestEvidence[] | null): TestView {
  if (!rows || !rows.length) return { kind: 'waiting' }
  const done = rows.find((r) => r.receipt_digest !== null)
  if (!done) return { kind: 'running' }
  const texts = [...done.logs.filter((l) => l.name === 'stdout'), ...done.logs.filter((l) => l.name === 'stderr')].map((l) => l.text)
  // stale: the code moved on since (for instance, this very change was applied); what that run found is kept
  // (a stale row is never `tested`, which holds only for the current source: its command outcome says what the run found)
  if (done.currency === 'stale') return done.tested || done.outcome === 'succeeded' ? { kind: 'stale', was: 'passed', line: decisiveLine(texts, true) } : done.outcome === 'not_succeeded' ? { kind: 'stale', was: 'failed', line: decisiveLine(texts, false) } : { kind: 'stale' }
  if (done.tested) return { kind: 'passed', line: decisiveLine(texts, true) }
  if (done.outcome === 'not_succeeded') return { kind: 'failed', line: decisiveLine(texts, false) }
  return { kind: 'unknown', line: decisiveLine(texts, done.outcome === 'succeeded') }
}

/** The controller's test effect, as a TestView (preferred over the derived one when the engine drives the request). */
export function testFromController(t: ControllerTest): TestView {
  const texts = [t.stdout, t.stderr].filter((x): x is string => !!x)
  const exit = t.exit_code
  if (t.state === 'journaled') return { kind: 'running' }
  if (t.state === 'refused') return { kind: 'error', text: 'The test run was refused.' }
  if (t.tested === true) return { kind: 'passed', line: decisiveLine(texts, true) ?? 'Tests passed' }
  if (t.command_outcome === 'not_succeeded') return { kind: 'failed', line: decisiveLine(texts, false) ?? (exit !== null ? `Tests failed (exit ${exit})` : null) }
  if (t.state === 'done' || t.state === 'unknown') return { kind: 'unknown', line: decisiveLine(texts, exit === 0) ?? (exit !== null ? `Exit ${exit}` : null) }
  return { kind: 'running' }
}

/** review-required, and no second opinion can run (the engine blocks) */
export const REVIEW_NEEDED = 'A second opinion is needed before this can go in, and none is available right now'

type Reached = 'ask' | 'mind' | 'change' | 'after'
const AFTER: VibePhase['kind'][] = ['applying', 'consented', 'declined', 'applied', 'undone', 'done']

/** The timeline for one request. */
export function workStages(input: WorkInput): Work {
  const { phase, scope, proposal } = input
  // the engine's view counts only for a status this UI words; otherwise the derived stages stand
  const c = input.controller?.known ? input.controller : null
  const status = c?.status ?? null
  const { round, asked, note } = roundOf(input.instruction)
  const team = input.team ?? 'the Code team'
  const helper = input.mind ?? team
  const where = scope ? scopeWords(scope) : null
  const reached: Reached = proposal ? (AFTER.includes(phase.kind) ? 'after' : 'change') : input.sent ? 'mind' : 'ask'
  const failed = phase.kind === 'error' || phase.kind === 'unavailable' ? phase.text : null

  // 1. asking
  const ask: Stage = { key: 'ask', state: 'done', words: round > 1 ? `Asked again (round ${round})` : 'Asked', ...(where ? { detail: where } : {}) }
  if (phase.kind === 'working' && (phase.step === 'scope' || phase.step === 'turn' || phase.step === 'send')) {
    ask.state = 'active'
    ask.words = phase.step === 'scope' ? `Marking ${where ? where.charAt(0).toLowerCase() + where.slice(1) : 'the code'} for the mind…` : phase.step === 'turn' ? 'Putting your words into the Ask…' : `Sending it to ${team}…`
  } else if (failed && reached === 'ask') {
    ask.state = 'failed'
    ask.words = 'Your request could not be sent'
    ask.detail = failed
  }

  // 2. the helper mind thinking
  const mind: Stage = { key: 'mind', state: 'waiting', words: 'A helper mind takes it' }
  if (phase.kind === 'working' && phase.step === 'starting') Object.assign(mind, { state: 'active', words: `Sent to ${team}. A mind is getting started…` })
  else if (phase.kind === 'working' && phase.step === 'mind') Object.assign(mind, { state: 'active', words: `${helper} is thinking it through…` })
  else if (phase.kind === 'working' && phase.step === 'read') Object.assign(mind, { state: 'active', words: `${helper} has an answer. Reading it…` })
  else if (reached === 'change' || reached === 'after') Object.assign(mind, { state: 'done', words: `${helper} worked it out` })
  else if (failed && reached === 'mind') Object.assign(mind, { state: 'failed', words: 'No change came back', detail: failed })
  // R3.12: the engine opened a helper attempt and waits for a helper mind to take it
  const awaitingHelper = status === 'writing' && !!c?.next_action && c.next_action.startsWith('(rest awaiting-helper')
  // never behind what is on screen: once a change has come back, the helper's step is done whatever a stale read says
  if (awaitingHelper && reached !== 'change' && reached !== 'after') Object.assign(mind, { state: 'active', words: 'Waiting for a helper to pick it up…', detail: undefined })

  // 3. the proposed change
  const change: Stage = { key: 'change', state: 'waiting', words: 'The proposed change' }
  if (proposal) {
    const n = proposal.changes
    const count = n === 1 ? 'one change' : `${n} changes`
    const file = proposal.file.split('/').pop() ?? proposal.file
    if (phase.kind === 'writing') Object.assign(change, { state: 'active', words: `${helper} is writing it into ${file}…` })
    else if (!proposal.verified) Object.assign(change, { state: 'failed', words: 'This change did not pass its integrity check', detail: 'It can’t be applied. Discard it or ask again.' })
    else Object.assign(change, { state: 'done', words: n ? `Proposes ${count} in ${file}` : 'Proposes changes in other files', ...(proposal.elsewhere ? { detail: `Also touches ${proposal.elsewhere === 1 ? 'one other file' : `${proposal.elsewhere} other files`}` } : {}) })
  }
  // the engine's repair loop: a test failed, and the helper is fixing what it found (bounded by its repair limit)
  if (status === 'repairing') Object.assign(change, { state: 'active', words: `${helper} is fixing what the test found…`, ...(c!.max_repairs ? { detail: `Repair ${Math.max(1, Math.min(c!.repairs, c!.max_repairs))} of ${c!.max_repairs}` } : {}) })
  else if (status === 'writing' && !proposal) Object.assign(change, { state: 'active', words: `${helper} is writing the change…` })

  // 4. testing on a copy (the controller's word first)
  const tv: TestView = c?.test ? testFromController(c.test) : status === 'testing' ? { kind: 'running' } : input.test
  const test: Stage = { key: 'test', state: 'waiting', words: 'Testing on a copy' }
  const proposalIn = !!proposal && phase.kind !== 'writing' && proposal.verified
  if (tv.kind === 'unavailable') Object.assign(test, { state: 'skipped', words: 'Tests can’t run here' })
  else if (!proposalIn && tv.kind === 'idle') test.state = 'waiting'
  else if (tv.kind === 'idle') Object.assign(test, { state: proposalIn && reached === 'change' ? 'active' : 'skipped', words: proposalIn && reached === 'change' ? 'Getting a copy ready to test on…' : 'Not tested' })
  else if (tv.kind === 'asking') Object.assign(test, { state: 'active', words: 'Asking for a test run on a copy…' })
  else if (tv.kind === 'waiting') Object.assign(test, { state: 'active', words: 'Waiting for the test run to start…' })
  else if (tv.kind === 'running') Object.assign(test, { state: 'active', words: 'Testing on a copy…', detail: 'Your code is untouched while it runs.' })
  else if (tv.kind === 'passed') Object.assign(test, { state: 'done', words: 'Tests passed on a copy', ...(tv.line ? { line: tv.line } : {}) })
  else if (tv.kind === 'failed') Object.assign(test, { state: 'failed', words: 'A test failed on a copy', ...(tv.line ? { line: tv.line } : {}) })
  else if (tv.kind === 'unknown') Object.assign(test, { state: 'failed', words: 'The run finished, but its result couldn’t be confirmed', ...(tv.line ? { line: tv.line } : {}) })
  else if (tv.kind === 'stale' && tv.was && (phase.kind === 'applied' || phase.kind === 'done')) Object.assign(test, tv.was === 'passed'
    ? { state: 'done', words: 'Tests passed on a copy before it went in', ...(tv.line ? { line: tv.line } : {}) }
    : { state: 'failed', words: 'A test failed on a copy before it went in', ...(tv.line ? { line: tv.line } : {}) })
  else if (tv.kind === 'stale') Object.assign(test, { state: 'skipped', words: 'The last run was for an earlier version' })
  else if (tv.kind === 'slow') Object.assign(test, { state: 'skipped', words: 'No test result yet', detail: 'It will appear under Tests in the drawer.' })
  else if (tv.kind === 'error') Object.assign(test, { state: 'failed', words: 'The test run wasn’t started', detail: tv.text })

  // 5. review (only the controller reports one today; its second opinion, when present, says it best)
  const review: Stage = { key: 'review', state: 'waiting', words: 'Review' }
  const so = c?.second_opinion ?? null
  const decision = so?.decision === 'pass' ? 'review-pass' : so?.decision === 'fail' ? 'review-fail' : null
  // changes asked for after a second opinion: a reviewer's "fail" says so; a pass was for the earlier version
  const rv = c?.review === 'changes_requested' ? 'changes_requested' : decision ?? c?.review ?? null
  const noteText = so?.notes ?? c?.review_notes ?? null
  const notes = noteText ? { detail: noteText } : {}
  // R3.12: no reviewer could run and the person's review setting lets them apply without one
  const unreviewed = !!c && status === 'ready_for_you' && (c.unreviewed || (!!c.next_action && c.next_action.startsWith('(tell confirm-unreviewed-to-apply')))
  // review-required and no reviewer can run: the engine blocks (needs_you, review unavailable)
  const reviewNeeded = status === 'needs_you' && c?.review === 'unavailable'
  if (unreviewed) Object.assign(review, { state: 'skipped', words: 'Not reviewed: your review setting lets you apply without a second opinion' })
  else if (reviewNeeded) Object.assign(review, { state: 'failed', words: REVIEW_NEEDED })
  else if (rv === 'review-pass') Object.assign(review, { state: 'done', words: 'Reviewed: looks right', ...notes })
  else if (rv === 'review-fail') Object.assign(review, { state: 'failed', words: 'The reviewer suggests changes', ...notes })
  else if (rv === 'changes_requested') Object.assign(review, decision === 'review-fail' ? { state: 'failed', words: 'The reviewer asked for changes', ...notes } : { state: 'waiting', words: 'You asked for changes; the new version gets its own look' })
  else if (rv === 'unavailable' || status === 'review_unavailable') Object.assign(review, { state: 'skipped', words: 'A second opinion isn’t available right now' })
  else if (rv === 'not_configured' || status === 'tested_review_not_configured') Object.assign(review, { state: 'skipped', words: 'Review isn’t set up yet' })
  else if (rv === 'requested' || status === 'reviewing' || so?.state === 'journaled') Object.assign(review, { state: 'active', words: 'A second opinion is looking at it…' })
  else if (proposalIn) Object.assign(review, { state: 'skipped', words: 'No review on this one' })

  // 6. ready for the person
  const ready: Stage = { key: 'ready', state: 'waiting', words: 'Ready for you' }
  let next: NextAction = failed ? 'none' : 'wait'
  if (phase.kind === 'review' && proposal) {
    if (!proposal.verified) Object.assign(ready, { state: 'failed', words: 'This one can’t be applied' })
    else if (input.blocked) Object.assign(ready, { state: 'active', words: 'Ready, once this is sorted', detail: input.blocked })
    else {
      const caution = test.state === 'failed' ? 'A test failed on a copy, so Apply waits: ask for changes, or discard it.' : test.state === 'active' ? 'Apply opens once the test on a copy passes.' : review.state === 'failed' ? 'The reviewer suggests changes.' : undefined
      Object.assign(ready, { state: 'active', words: 'Ready for you', ...(caution ? { detail: caution } : {}) })
    }
    next = proposal.verified ? 'decide' : 'none'
  } else if (phase.kind === 'consented') Object.assign(ready, { state: 'active', words: 'You said yes. It’s going into your copy…' })
  else if (phase.kind === 'applying') Object.assign(ready, { state: 'active', words: 'Going into your copy…' })
  else if (phase.kind === 'applied') {
    next = 'none'
    if (phase.authorization === 'unconsented' || phase.beforeDecline) Object.assign(ready, { state: 'failed', words: 'Your copy was changed without your OK' })
    else Object.assign(ready, { state: 'done', words: phase.currency === 'stale' ? 'Applied earlier; your copy has moved on' : 'Applied to your copy' })
  } else if (phase.kind === 'done') {
    next = 'none'
    Object.assign(ready, phase.kept ? { state: 'done', words: `Applied: ${phase.kept === 1 ? 'one change' : `${phase.kept} changes`} kept${phase.skipped ? `, ${phase.skipped} skipped` : ''}` } : { state: 'skipped', words: 'Discarded' })
  } else if (phase.kind === 'declined') {
    Object.assign(ready, { state: 'skipped', words: phase.checking ? 'Discarded. Checking nothing went in…' : 'Discarded' })
    next = phase.checking ? 'wait' : 'none'
  } else if (phase.kind === 'undone') {
    Object.assign(ready, { state: 'skipped', words: 'Undone: your copy is as it was' })
    next = 'none'
  }
  // a failure after the proposal arrived (a re-read, a refusal): said on the last step, so it is never lost
  if (failed && (reached === 'change' || reached === 'after')) Object.assign(ready, { state: 'failed', words: 'This didn’t go through', detail: failed })
  // the engine's own word on where the request stands (it owns test, review and apply on the requests it drives)
  const settle = (patch: Partial<Stage>, n: NextAction) => {
    Object.assign(ready, { detail: undefined }, patch)
    next = n
  }
  if (c && !failed) {
    if ((status === 'ready_for_you' || status === 'waiting_for_your_apply' || status === 'tested_review_not_configured' || status === 'review_unavailable') && phase.kind === 'review' && proposal?.verified) {
      next = 'decide'
      if (ready.state !== 'active') Object.assign(ready, { state: 'active', words: 'Ready for you' })
      if (unreviewed && !ready.detail) ready.detail = 'No one else has checked this change.'
    } else if (status === 'writing' || status === 'testing' || status === 'repairing' || status === 'reviewing') {
      if (phase.kind === 'review') settle({ state: 'waiting', words: 'Ready for you', detail: undefined }, 'wait')
    } else if (status === 'checking') settle({ state: 'active', words: 'Checking where things stand…', detail: undefined }, 'wait')
    // the work broke inside the engine: said plainly; the decision stays open so the person can discard it
    else if (status === 'engine_error') settle({ state: 'failed', words: 'Something went wrong in the work; you can discard it or ask again', ...(c.last_error ? { detail: c.last_error } : {}) }, phase.kind === 'review' && proposal ? 'decide' : 'none')
    else if (status === 'needs_you') settle({ state: 'failed', words: reviewNeeded ? REVIEW_NEEDED : 'It needs you', ...(c.last_error ? { detail: c.last_error } : {}) }, reviewNeeded && phase.kind === 'review' && proposal ? 'decide' : 'none')
    else if (status === 'applied') settle({ state: 'done', words: 'Applied to your copy', detail: undefined }, 'none')
    // the Apply landed after an outcome that was unknown at first: it is in; the hive is still writing it down
    else if (status === 'applied_unrecorded') settle({ state: 'done', words: 'Applied to your copy', detail: 'It’s in your copy. The hive is still recording it.' }, 'none')
    else if (status === 'stopped') settle({ state: 'skipped', words: 'Stopped', ...(c.last_error ? { detail: c.last_error } : {}) }, 'none')
  }
  return { stages: oneMoving([ask, mind, change, test, review, ready]), round, asked, changesAsked: note, next }
}

/** The active stage's words, for the polite live region (or the last settled one). */
export function liveWords(work: Work): string {
  const active = work.stages.find((s) => s.state === 'active') ?? [...work.stages].reverse().find((s) => s.state === 'done' || s.state === 'failed')
  if (!active) return ''
  return [active.words, active.line, active.detail].filter(Boolean).join('. ')
}

/** The words a step reads while it waits its turn. */
const WAITING_WORDS: Record<Stage['key'], string> = { ask: 'Asking', mind: 'The mind', change: 'The proposed change', test: 'Testing on a copy', review: 'Review', ready: 'Ready for you' }

/**
 * One step moves at a time: the first active step stays active, and a later step that also reads as active (for
 * instance a test still "waiting to start" while the controller says the change is being written) waits its turn,
 * except review and ready, which the controller may report alongside a running test (a second opinion under way;
 * "you can wait for them").
 */
export function oneMoving(stages: Stage[]): Stage[] {
  let seen = false
  return stages.map((s) => {
    if (s.state !== 'active') return s
    if (!seen) { seen = true; return s }
    if (s.key === 'ready' || s.key === 'review') return s
    return { key: s.key, state: 'waiting', words: WAITING_WORDS[s.key] }
  })
}
