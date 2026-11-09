/**
 * SIM: the MeTTa coding controller's person view of a Code request (host: hive/core/code_controller_engine.py view(),
 * routes GET /api/requests/{rq}/controller and POST …/controller/apply | changes | discard), for screenshots of the
 * engine-driven path. Off unless ?simengine=1 (then every sim Code request is engine-driven); without it the read is a
 * 404 and the canvas uses its own paths, exactly as on a host without the controller.
 *
 * The invented request moves on a clock from its first read (reducer R3.12): writing with `(rest awaiting-helper)`
 * (1.5 s, waiting for a helper to take it) → writing (the helper thinks, to 4 s) → testing (3 s) → ready_for_you,
 * unreviewed: no second-opinion reviewer runs in the sim, and the invented person starts on review-waivable (so the
 * engine-driven Apply can be shown), so the engine tells `(tell confirm-unreviewed-to-apply c)` with review
 * `unavailable`. Under review-required (GET/PUT /api/me/code-controller; it applies to new requests only, as the host)
 * the run ends blocked instead: status needs_you, review `unavailable`, as the host when no reviewer can run. Apply is refused like the live
 * hive today (Code's pinned release has no production copy-effect policy): 503 copy_apply_off, and the action says
 * why; ?simapply=on lets it through (status applied). Invented data only.
 */
import { ApiError } from '../client'

type Status = 'writing' | 'testing' | 'repairing' | 'ready_for_you' | 'needs_you' | 'applied' | 'stopped'
interface Run { started: number; round: number; final: 'applied' | 'stopped' | null; changes: string | null; policy: ReviewPolicy }

/** the opening wait for a helper to take the attempt (next_action `(rest awaiting-helper)`) */
const AWAITING_HELPER_MS = 1500
const WRITING_MS = 4000
const TESTING_MS = 3000
const APPLY_OFF = 'Applying isn’t switched on for this project yet.'

const REVIEW_POLICIES = ['review-required', 'review-waivable'] as const
type ReviewPolicy = (typeof REVIEW_POLICIES)[number]

export class SimController {
  private runs = new Map<string, Run>()
  /** the invented person's review setting (host default review-required); a run keeps the one it started under */
  private policy: ReviewPolicy = 'review-waivable'
  constructor(private o: { on: () => boolean; applyOn: () => boolean; known: (requestId: string) => boolean; now?: () => number }) {}
  private now() { return this.o.now ? this.o.now() : Date.now() }

  private run(id: string): Run {
    if (!this.o.on() || !this.o.known(id)) throw new ApiError(404, 'not_found', `no request ${id}`)
    let r = this.runs.get(id)
    if (!r) { r = { started: this.now(), round: 1, final: null, changes: null, policy: this.policy }; this.runs.set(id, r) }
    return r
  }

  private status(r: Run): Status {
    if (r.final) return r.final
    const t = this.now() - r.started
    if (t < WRITING_MS) return 'writing'
    if (t < WRITING_MS + TESTING_MS) return 'testing'
    return r.policy === 'review-waivable' ? 'ready_for_you' : 'needs_you'
  }

  /** GET /api/me/code-controller */
  prefs(): Record<string, unknown> {
    if (!this.o.on()) throw new ApiError(404, 'not_found', 'no code controller on this hive')
    return { review_policy: this.policy, applies_to: 'new Code requests' }
  }
  /** PUT /api/me/code-controller {review_policy} */
  setPrefs(body: { review_policy?: unknown }): Record<string, unknown> {
    if (!this.o.on()) throw new ApiError(404, 'not_found', 'no code controller on this hive')
    const p = body?.review_policy
    if (!(REVIEW_POLICIES as readonly unknown[]).includes(p)) throw new ApiError(400, 'bad_request', `review_policy is one of ${REVIEW_POLICIES.join(', ')}`)
    this.policy = p as ReviewPolicy
    return { review_policy: this.policy, applies_to: 'new Code requests' }
  }

  view(id: string): Record<string, unknown> {
    const r = this.run(id)
    const status = this.status(r)
    const phase = status === 'writing' ? 'open' : status === 'testing' ? 'edited' : status === 'applied' ? 'delivered' : status === 'stopped' ? 'stopped' : status === 'needs_you' ? 'blocked' : 'green'
    const blocked = status === 'needs_you'
    const tested = status === 'ready_for_you' || status === 'applied' || blocked
    const ready = status === 'ready_for_you'
    const candidate = status === 'writing' ? null : `sg_sim_${r.round}`
    const awaiting = status === 'writing' && this.now() - r.started < AWAITING_HELPER_MS
    const at = new Date(r.started).toISOString()
    return {
      request_id: id, engine: 'metta-coding-controller/sim-1', reducer_sha256: null, profile: 'root-suggest', phase, status,
      review_policy: r.policy, candidate, unreviewed: ready,
      next_action: ready ? `(tell confirm-unreviewed-to-apply "${candidate}")` : awaiting ? '(rest awaiting-helper)' : status === 'writing' ? '(think make-the-smallest-change)' : null,
      review: ready || blocked ? 'unavailable' : null, last_error: null, max_repairs: 3,
      // no reviewer could run, so no review effect exists (the host's second_opinion is the latest review effect)
      second_opinion: null,
      test: status === 'writing' ? null : tested
        ? { state: 'done', status: 'CONTROLLER_TEST_OBSERVED', tested: true, command_outcome: 'succeeded', exit_code: 0, logs: { stdout: { text: '============ 1 passed in 0.02s ============', classification: 'test-output' } } }
        : { state: 'journaled' },
      journal: [{ seq: 1, id: `obs-${id}-1`, kind: 'understood', fields: [], verdict: 'accepted', at, evidence: null }],
      effects: [{ kind: 'think', seq: 1, state: status === 'writing' ? 'journaled' : 'done' }],
      actions: [
        { name: 'apply', label: 'Apply', method: 'POST', path: `/api/requests/${id}/controller/apply`, body: {}, available: ready && this.o.applyOn(), why_not: ready ? (this.o.applyOn() ? null : APPLY_OFF) : 'It isn’t ready yet.' },
        { name: 'changes', label: 'Ask for changes', method: 'POST', path: `/api/requests/${id}/controller/changes`, body: { text: '' }, available: ready, why_not: ready ? null : 'It isn’t ready yet.' },
        { name: 'discard', label: 'Discard', method: 'POST', path: `/api/requests/${id}/controller/discard`, body: {}, available: !r.final, why_not: r.final ? 'This request is finished.' : null },
      ],
      updated_at: new Date(this.now()).toISOString(),
    }
  }

  apply(id: string) {
    const r = this.run(id)
    if (this.status(r) !== 'ready_for_you') throw new ApiError(409, 'not_ready', 'the request is not ready to apply')
    if (!this.o.applyOn()) throw new ApiError(503, 'copy_apply_off', 'copy-apply is not switched on for this project')
    r.final = 'applied'
    return this.view(id)
  }
  changes(id: string, text: string) {
    const r = this.run(id)
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) throw new ApiError(400, 'bad_request', 'text is 1-4000 characters')
    if (this.status(r) !== 'ready_for_you') throw new ApiError(409, 'not_ready', 'the request is not ready for changes')
    Object.assign(r, { started: this.now(), round: r.round + 1, changes: text.trim() })
    return this.view(id)
  }
  discard(id: string) {
    const r = this.run(id)
    if (r.final) throw new ApiError(409, 'not_ready', 'the request is finished')
    r.final = 'stopped'
    return this.view(id)
  }
}
