/**
 * The Code controller's own view of one request: the MeTTa coding controller (host hive/core/code_controller_engine.py,
 * view() and _status(); route GET /api/requests/{request_id}/controller, host commit e5885f3b, not yet deployed).
 * 404 means the person can't see the request or it has no controller run: an older host, or a request the engine does
 * not drive. The client method `requestController` is optional on HiveClient (live.ts carries it).
 *
 * Shape (host view(), commit 826b23a0): { request_id, engine: "metta-coding-controller/<ver>", reducer_sha256, profile,
 * phase, status, candidate, next_action, review, last_error, max_repairs, updated_at, test, second_opinion, actions[],
 * journal[], effects[] }. `actions`: [{ name: apply | changes | discard, label, method, path, body, available, why_not }]
 * (unknown names ignored; a malformed action is treated as absent, never as a whole-state failure). `second_opinion`:
 * the latest review effect { state, reviewer_id, decision, notes } (malformed → null).
 *
 * R3.12 (host view() docstring): `unreviewed` (true when the waiting proposal had no second opinion and the person's
 * review setting let it go on; derived by the host from next_action `(tell confirm-unreviewed-to-apply …)`),
 * `review_policy` (review-required | review-waivable; a string today, a small { policy } object tolerated), status
 * `applied_unrecorded` (the Apply landed after an unknown outcome; the hive is still recording it), review values
 * unavailable | requested | review-pass | review-fail | changes_requested.
 *
 * Strict about types (a field of the wrong type → null: nothing is claimed from a shape it does not know), tolerant of
 * absent optional fields and of fields the host adds later (ignored). A status or phase this UI does not know is kept
 * (`known: false`) and the work stream falls back to its derived stages. Never shown raw: the stages word everything.
 */
import { ApiError } from '../../../../api/client'

export const CONTROLLER_STATUSES = ['writing', 'testing', 'repairing', 'reviewing', 'review_unavailable', 'tested_review_not_configured', 'ready_for_you', 'waiting_for_your_apply', 'needs_you', 'applied', 'applied_unrecorded', 'stopped', 'checking', 'engine_error'] as const
export type ControllerStatus = (typeof CONTROLLER_STATUSES)[number]
export interface ControllerTest {
  /** the effect's state: journaled (dispatched, running), done, refused, unknown, … */
  state: string
  status: string | null
  tested: boolean | null
  command_outcome: string | null
  exit_code: number | null
  /** the retained output previews (each at most 2000 characters from the host) */
  stdout: string | null
  stderr: string | null
}
/** One of the person's decisions as the engine offers it now. */
export interface ControllerAction {
  available: boolean
  /** the engine's own reason it is not offered now (plain words from the host), or null */
  why_not: string | null
  label: string | null
}
export type ActionName = 'apply' | 'changes' | 'discard'
export interface SecondOpinion {
  /** the review effect's state: journaled, done, … */
  state: string
  /** pass | fail | null */
  decision: string | null
  notes: string | null
}
export interface ControllerState {
  request_id: string
  engine: string
  phase: string
  status: string
  /** the status is one this UI words (otherwise the stages fall back to what the canvas derives) */
  known: boolean
  /** the candidate (proposal) the controller is carrying, as the host names it */
  candidate: string | null
  next_action: string | null
  /** no second opinion on the waiting proposal, and the person's review setting lets them apply anyway */
  unreviewed: boolean
  /** review-required | review-waivable (as the host words it), or null */
  review_policy: string | null
  /** null | unavailable | requested | changes_requested | not_configured | review-pass | review-fail | … */
  review: string | null
  /** the reviewer's notes, from the latest review observation in the journal */
  review_notes: string | null
  last_error: string | null
  max_repairs: number | null
  /** failed test runs so far (each starts a repair) */
  repairs: number
  test: ControllerTest | null
  /** the engine's second opinion (the reviewer mind), when one was asked for */
  second_opinion: SecondOpinion | null
  /** the person's decisions the engine describes (absent: not described by this host) */
  actions: Partial<Record<ActionName, ControllerAction>>
  updated_at: string | null
}

type Obj = Record<string, unknown>
const obj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
const ID = /^[A-Za-z0-9_.:-]{1,160}$/
const BAD = Symbol('bad')
/** optional string: absent/null → null; a string within `max` → itself; anything else → BAD */
const str = (v: unknown, max = 400): string | null | typeof BAD => (v === undefined || v === null ? null : typeof v === 'string' && v.length <= max ? v : BAD)
const int = (v: unknown): number | null | typeof BAD => (v === undefined || v === null ? null : typeof v === 'number' && Number.isSafeInteger(v) ? v : BAD)
const bool = (v: unknown): boolean | null | typeof BAD => (v === undefined || v === null ? null : typeof v === 'boolean' ? v : BAD)

function parseTest(v: unknown): ControllerTest | null | typeof BAD {
  if (v === undefined || v === null) return null
  if (!obj(v) || typeof v.state !== 'string' || !v.state || v.state.length > 64) return BAD
  const status = str(v.status, 64), tested = bool(v.tested), outcome = str(v.command_outcome, 64), exit = int(v.exit_code)
  if (status === BAD || tested === BAD || outcome === BAD || exit === BAD) return BAD
  let stdout: string | null = null
  let stderr: string | null = null
  if (v.logs !== undefined && v.logs !== null) {
    if (!obj(v.logs)) return BAD
    for (const name of ['stdout', 'stderr'] as const) {
      const l = v.logs[name]
      if (l === undefined || l === null) continue
      if (!obj(l)) return BAD
      const t = str(l.text, 4000)
      if (t === BAD) return BAD
      if (name === 'stdout') stdout = t
      else stderr = t
    }
  }
  return { state: v.state, status, tested, command_outcome: outcome, exit_code: exit, stdout, stderr }
}

const ACTION_NAMES: readonly string[] = ['apply', 'changes', 'discard']
/** Each known, well-formed action; anything else is left out (never fails the whole state). */
function parseActions(v: unknown): Partial<Record<ActionName, ControllerAction>> {
  const out: Partial<Record<ActionName, ControllerAction>> = {}
  if (!Array.isArray(v)) return out
  for (const a of v.slice(0, 20)) {
    if (!obj(a) || typeof a.name !== 'string' || !ACTION_NAMES.includes(a.name) || typeof a.available !== 'boolean') continue
    const why = str(a.why_not, 400), label = str(a.label, 80)
    if (why === BAD || label === BAD || out[a.name as ActionName]) continue
    out[a.name as ActionName] = { available: a.available, why_not: why ? why.trim() || null : null, label }
  }
  return out
}
function parseSecondOpinion(v: unknown): SecondOpinion | null {
  if (!obj(v) || typeof v.state !== 'string' || !v.state || v.state.length > 64) return null
  const decision = str(v.decision, 32), notes = str(v.notes, 4000)
  if (decision === BAD || notes === BAD) return null
  return { state: v.state, decision: decision ? decision.toLowerCase() : null, notes: notes ? notes.slice(0, 600).trim() || null : null }
}

/** review_policy: a short string, or a small object naming it ({ policy } / { name }); anything else → null (never fatal) */
function reviewPolicy(v: unknown): string | null {
  const s = obj(v) ? (typeof v.policy === 'string' ? v.policy : typeof v.name === 'string' ? v.name : null) : v
  return typeof s === 'string' && s.length > 0 && s.length <= 64 ? s : null
}

/** Strict, tolerant parse of the controller read (see the header); anything it can't trust → null. */
export function parseControllerState(raw: unknown): ControllerState | null {
  if (!obj(raw)) return null
  if (typeof raw.request_id !== 'string' || !ID.test(raw.request_id)) return null
  if (typeof raw.engine !== 'string' || !raw.engine.startsWith('metta-coding-controller/') || raw.engine.length > 120) return null
  if (typeof raw.phase !== 'string' || !raw.phase || raw.phase.length > 64) return null
  if (typeof raw.status !== 'string' || !raw.status || raw.status.length > 64) return null
  const candidate = str(raw.candidate, 200), next = str(raw.next_action, 2000), review = str(raw.review, 64), err = str(raw.last_error, 2000)
  const updated = str(raw.updated_at, 64), max = int(raw.max_repairs)
  if (candidate === BAD || next === BAD || review === BAD || err === BAD || updated === BAD || max === BAD) return null
  if (updated !== null && Number.isNaN(Date.parse(updated))) return null
  if (raw.reducer_sha256 !== undefined && raw.reducer_sha256 !== null && typeof raw.reducer_sha256 !== 'string') return null
  if (raw.profile !== undefined && raw.profile !== null && typeof raw.profile !== 'string') return null
  const test = parseTest(raw.test)
  if (test === BAD) return null
  const unreviewed = bool(raw.unreviewed)
  if (unreviewed === BAD) return null
  const policy = reviewPolicy(raw.review_policy)
  let repairs = 0
  let notes: string | null = null
  if (raw.journal !== undefined && raw.journal !== null) {
    if (!Array.isArray(raw.journal) || raw.journal.length > 2000) return null
    for (const j of raw.journal) {
      if (!obj(j) || typeof j.kind !== 'string') return null
      if (/^tests?-fail/.test(j.kind)) repairs++
      if ((j.kind === 'review-pass' || j.kind === 'review-fail') && obj(j.evidence) && typeof j.evidence.notes === 'string') notes = j.evidence.notes.slice(0, 600) || null
    }
  }
  if (raw.effects !== undefined && raw.effects !== null && (!Array.isArray(raw.effects) || !raw.effects.every((e) => obj(e) && typeof e.kind === 'string'))) return null
  return {
    request_id: raw.request_id,
    engine: raw.engine,
    phase: raw.phase,
    status: raw.status,
    known: (CONTROLLER_STATUSES as readonly string[]).includes(raw.status),
    candidate,
    next_action: next,
    unreviewed: unreviewed === true || (!!next && next.startsWith('(tell confirm-unreviewed-to-apply')),
    review_policy: policy,
    review,
    review_notes: notes,
    last_error: err,
    max_repairs: max,
    repairs,
    test,
    second_opinion: parseSecondOpinion(raw.second_opinion),
    actions: parseActions(raw.actions),
    updated_at: updated,
  }
}

/**
 * One controller read for exactly this request:
 * - `engine`: the engine drives it (its state);
 * - `none`: no controller run (404), or the client has no controller read: an older host, the canvas's own paths apply;
 * - `unknown`: unreadable for now (a failure, or a shape it can't trust): nothing is claimed either way.
 */
export type ControllerRead = { kind: 'engine'; state: ControllerState } | { kind: 'none' } | { kind: 'unknown' }
export interface ControllerClient {
  requestController?: (requestId: string) => Promise<unknown>
}
export function carriesController(client: unknown): boolean {
  return !!client && typeof (client as ControllerClient).requestController === 'function'
}
export async function readController(client: unknown, requestId: string): Promise<ControllerRead> {
  if (!carriesController(client)) return { kind: 'none' }
  try {
    const s = parseControllerState(await (client as Required<ControllerClient>).requestController(requestId))
    return s && s.request_id === requestId ? { kind: 'engine', state: s } : { kind: 'unknown' }
  } catch (e) {
    return e instanceof ApiError && e.status === 404 ? { kind: 'none' } : { kind: 'unknown' }
  }
}
