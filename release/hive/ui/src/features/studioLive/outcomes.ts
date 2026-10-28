/**
 * J3 r4.3 O3: step outcomes, reported to the host only as the frame observed them (contract :47, :75–:77, :87, :94–:112;
 * build follow-up case #2).
 *
 * - The frame reports AFTER its synchronous canvas CAS and readback; this never invents or upgrades an outcome.
 * - Each report is bound to the ACKNOWLEDGED piece upload that contains the observed state (upload seq + body sha256 +
 *   scene_ref + edit_generation, from PieceCustody). Missing or stale custody HOLDS the report (and so the host's step and
 *   n+1); a fresh capture is asked for. A previous upload, a last-saved piece, a timestamp or an HTTP 200 never stands in.
 * - The proposal must be this session's artifact and the exact revision the host bound to step n (ledger). Unknown
 *   mapping holds and re-reads the ledger; a mismatch fences (never a guessed step, never a skipped revision).
 * - The body for step n is built ONCE. Every retry (lost answer, timeout, reconnect) sends the identical body, so the
 *   host's per-(sid, n) idempotency answers the original record. A late outcome after the step's paid window closed
 *   still reports against n (never n+1), and the card says it came late.
 */
import { ApiError } from '../../api/client'
import { readOpIds, sameOpIds, type FrameOutcomeKind, type Ledger, type OutcomeBody, type ProposalRef, type SceneRef } from './api'
import type { Ack } from './custody'

/** What the frame says happened to one exact proposal revision (wire.ts checks the message's shape). */
export interface FrameReport {
  proposal: ProposalRef
  outcome: FrameOutcomeKind
  reason?: string
  piece_before: SceneRef
  piece_after: SceneRef
  receiver_generation: number
  receipt_digest: string
  /** the native edit generation the receiver observed with piece_after (envelope r1) */
  observed_generation: number
  /** host R4 L6: the op ids the receiver validated, from its own receipt (wire.ts); absent when the receiver gave none */
  op_ids?: string[]
}

export type ReportState =
  | { kind: 'held'; why: 'custody' | 'step-unknown' | 'closed' }
  /** host R4 L6: never sent automatically again. `missing`: the receipt names no op ids for a validated outcome;
   *  `malformed`: the host's shape would refuse them (e.g. a leading punctuation id); `differ`: they differ from the step's declared set (checked here, before sending); `refused`: the host answered
   *  409 op_ids_mismatch (the body is kept byte-identical for any re-report). No skip, no replay. */
  | { kind: 'held'; why: 'op-ids-missing' | 'op-ids-malformed' | 'op-ids-differ' | 'op-ids-refused' }
  | { kind: 'fenced'; why: string }
  | { kind: 'sending' }
  | { kind: 'unconfirmed' }
  | { kind: 'reported'; late: boolean }

export interface ReportEntry {
  key: string
  report: FrameReport
  n: number | null
  body: OutcomeBody | null
  state: ReportState
  tries: number
}

export interface ReporterDeps {
  /** this session's bound proposal artifact */
  proposalArtifact: string
  /** the fresh acknowledged upload that is exactly the observed snapshot (custody.ts), or null → HOLD */
  custodyFor(observed: SceneRef, generation: number): Ack | null
  ledger(): Ledger | null
  refreshLedger(): Promise<void>
  post(n: number, body: OutcomeBody): Promise<unknown>
  /** ask the frame for a fresh capture (custody missing) */
  requestCapture(): void
  later(ms: number, fn: () => void): () => void
  changed?(): void
}

const keyOf = (p: ProposalRef) => `${p.artifact_id}@${p.revision}`
/** host R4 OP_ID_OUTCOMES: the receiver validated these, so it must name the op ids it read */
const VALIDATED: readonly FrameOutcomeKind[] = ['applied', 'refused', 'accepted-no-source-change']
const isOpIdHold = (s: ReportState) => s.kind === 'held' && s.why.startsWith('op-ids')
const RETRY_MS = [1000, 2000, 4000, 8000, 15000]

export class OutcomeReporter {
  readonly entries = new Map<string, ReportEntry>()
  private writesOpen = true
  constructor(private deps: ReporterDeps) {}

  /** A frame report. A duplicate of one already known (same proposal) keeps the original; never a second body. */
  add(report: FrameReport): ReportEntry {
    const key = keyOf(report.proposal)
    const known = this.entries.get(key)
    if (known) {
      // the same proposal with a different digest or outcome is a conflict: fenced, the original kept
      const ids = (r: FrameReport) => JSON.stringify(r.op_ids ?? null)
      if (known.report.proposal.digest !== report.proposal.digest || known.report.outcome !== report.outcome || known.report.receipt_digest !== report.receipt_digest || ids(known.report) !== ids(report))
        known.state = { kind: 'fenced', why: 'The canvas reported this step twice with different results; the first report is kept.' }
      this.deps.changed?.()
      return known
    }
    const entry: ReportEntry = { key, report, n: null, body: null, state: { kind: 'held', why: 'step-unknown' }, tries: 0 }
    if (report.proposal.artifact_id !== this.deps.proposalArtifact) entry.state = { kind: 'fenced', why: 'That proposal is not this session’s. Nothing was reported.' }
    this.entries.set(key, entry)
    void this.advance(entry)
    return entry
  }

  /** Try every held report again (a new acknowledged upload, a fresh ledger, a reconnect). */
  retryHeld(): void {
    // an L6 hold is never replayed automatically (its report cannot change; the host would answer the same)
    for (const e of this.entries.values()) if ((e.state.kind === 'held' && !isOpIdHold(e.state)) || e.state.kind === 'unconfirmed') void this.advance(e)
  }

  /** No more writes (identity change, unmount). Entries stay for display; nothing is sent from here on. */
  closeWrites(): void {
    this.writesOpen = false
    for (const e of this.entries.values()) if (e.state.kind !== 'reported' && e.state.kind !== 'fenced') e.state = { kind: 'held', why: 'closed' }
    this.deps.changed?.()
  }

  private stepFor(p: ProposalRef): { n: number; late: boolean; readSeq: number | null; declared: string[] | null } | null | 'mismatch' {
    const l = this.deps.ledger()
    if (!l) return null
    const s = l.steps.find((x) => x.proposal_n === p.revision)
    if (!s) return null
    if (s.proposal_digest && s.proposal_digest.replace(/^sha256:/, '') !== p.digest.replace(/^sha256:/, '')) return 'mismatch'
    return { n: s.n, late: s.state === 'timed_out' || s.state === 'stopped' || s.state === 'interrupted', readSeq: s.piece_read?.seq ?? null, declared: s.op_ids }
  }

  /** entries with an advance in progress: a retry while one runs is a no-op (never two advances, never two bodies) */
  private advancing = new Set<string>()
  private async advance(e: ReportEntry): Promise<void> {
    if (this.advancing.has(e.key)) return
    this.advancing.add(e.key)
    try {
      await this.advanceOnce(e)
    } finally {
      this.advancing.delete(e.key)
    }
  }
  private async advanceOnce(e: ReportEntry): Promise<void> {
    if (!this.writesOpen || e.state.kind === 'fenced' || e.state.kind === 'reported' || e.state.kind === 'sending' || isOpIdHold(e.state)) return
    if (e.n === null) {
      let step = this.stepFor(e.report.proposal)
      if (step === null) {
        await this.deps.refreshLedger()
        step = this.stepFor(e.report.proposal)
      }
      if (step === 'mismatch') {
        e.state = { kind: 'fenced', why: 'The hive bound a different proposal to this step. Nothing was reported; the session waits.' }
        this.deps.changed?.()
        return
      }
      if (!step) {
        e.state = { kind: 'held', why: 'step-unknown' }
        this.deps.changed?.()
        return
      }
      e.n = step.n
    }
    if (!e.body) {
      // host R4 L6, before custody (no capture is asked for a report that cannot be sent): the receiver's own op ids
      const ids = e.report.op_ids
      if (!ids && VALIDATED.includes(e.report.outcome)) {
        e.state = { kind: 'held', why: 'op-ids-missing' }
        this.deps.changed?.()
        return
      }
      // the host's L6 shape (1-16 distinct, leading alphanumeric): a list it would refuse is held, never repaired or sent
      if (ids && !readOpIds(ids)) {
        e.state = { kind: 'held', why: 'op-ids-malformed' }
        this.deps.changed?.()
        return
      }
      // cross-check with the step's declared set (where the host exposes it): a difference holds, nothing is sent
      const declared = this.stepFor(e.report.proposal)
      if (ids && typeof declared === 'object' && declared?.declared && !sameOpIds(ids, declared.declared)) {
        e.state = { kind: 'held', why: 'op-ids-differ' }
        this.deps.changed?.()
        return
      }
      // custody: the acknowledged upload that contains what the receiver observed; never a stale or unacknowledged one
      const ack = this.deps.custodyFor(e.report.piece_after, e.report.observed_generation)
      if (!ack) {
        e.state = { kind: 'held', why: 'custody' }
        this.deps.requestCapture()
        this.deps.changed?.()
        return
      }
      // Kimi K4: the observed piece cannot predate what the maker read for this step (a late duplicate from an old mount
      // or a reused revision): fenced, never bound
      const bound = this.stepFor(e.report.proposal)
      if (typeof bound === 'object' && bound && bound.readSeq !== null && ack.seq < bound.readSeq) {
        e.state = { kind: 'fenced', why: 'That canvas report is older than the piece the maker read for this step; it is not used.' }
        this.deps.changed?.()
        return
      }
      const r = e.report
      e.body = {
        proposal: r.proposal,
        outcome: r.outcome,
        ...(r.reason ? { reason: r.reason } : {}),
        piece_before: r.piece_before,
        piece_after: r.piece_after,
        receiver_generation: r.receiver_generation,
        receipt_digest: r.receipt_digest,
        piece_upload: { seq: ack.seq, body_sha256: ack.body_sha256, scene_ref: ack.scene_ref, edit_generation: ack.edit_generation },
        ...(r.op_ids ? { op_ids: [...r.op_ids] } : {}),   // the receiver's list, as it gave it (never the ledger's)
      }
    }
    e.state = { kind: 'sending' }
    e.tries++
    this.deps.changed?.()
    try {
      await this.deps.post(e.n, e.body)
      const late = this.stepFor(e.report.proposal)
      e.state = { kind: 'reported', late: typeof late === 'object' && !!late?.late }
    } catch (err) {
      if (!this.writesOpen) { e.state = { kind: 'held', why: 'closed' }; this.deps.changed?.(); return }
      if (err instanceof ApiError && err.status === 409 && err.code === 'op_ids_mismatch') {
        e.state = { kind: 'held', why: 'op-ids-refused' }   // not confirmed: no skip, no replay; e.body kept as sent
      } else if (err instanceof ApiError && err.status === 409 && (err.code === 'wrong_proposal' || err.code === 'operation_conflict' || err.code === 'stale_receiver')) {
        e.state = { kind: 'fenced', why: err.code === 'stale_receiver' ? 'A newer canvas already reported for this session; this older one is not used.' : 'The hive holds a different report for this step. The first one stands; the session waits.' }
      } else {
        // lost or refused for now: the SAME body goes again later; unknown is never turned into success or refusal
        e.state = { kind: 'unconfirmed' }
        const wait = RETRY_MS[Math.min(e.tries - 1, RETRY_MS.length - 1)]
        this.deps.later(wait, () => void this.advance(e))
      }
    }
    this.deps.changed?.()
  }
}
