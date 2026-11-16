import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import type { Ledger, LedgerStep, OutcomeBody } from './api'
import type { Ack } from './custody'
import { OutcomeReporter, type FrameReport } from './outcomes'

/** J3 r4.3 O3: outcomes bound to acknowledged custody (contract :75–:77; follow-up case #2). INVENTED values. */

const H = (c: string) => c.repeat(64)
const ref = (rev: number) => ({ scene_id: 'sim-poster', revision: rev, digest: `sha256:${H('d')}` })
const report = (over: Partial<FrameReport> = {}): FrameReport => ({
  proposal: { artifact_id: 'ar_p', revision: 3, digest: `sha256:${H('3')}` }, outcome: 'refused', reason: 'conflict',
  piece_before: ref(5), piece_after: ref(5), receiver_generation: 7, receipt_digest: H('r'), observed_generation: 9, op_ids: ['op-a', 'op-b'], ...over,
})
const step = (over: Partial<LedgerStep> = {}): LedgerStep => ({ n: 4, state: 'finished', proposal_n: 3, proposal_digest: `sha256:${H('3')}`, outcome: null, reason: null, piece_before: null, piece_after: null, receiver_generation: null, direction_seqs: [], late: false, upload: null, piece_read: null, summary: null, spent_usd: null, op_ids: null, ...over })
const ledger = (steps: LedgerStep[]): Ledger => ({ session_id: 'ss_x', stream_id: 'as_x', state: 'active', reason: null, ask_turn_id: 'op', goal_id: 'g', proposal_artifact_id: 'ar_p', maker_id: 'a_m', swarm_id: 's', program_id: 'omegadesign', scene_id: 'sim-poster', payer: null, model: null, steps, directions: [], budget: { cap: 2, spent: 0, held: 0, unknown: 0, step_cap: 0.25, step_spent: 0, step_seconds: 180, monthly: [] }, stop: { state: 'none', fenced_at: null, in_flight: 0, unknown_usd: 0, cancel_ack: null, maker_released: null, stop_failed: false, release_stale: false, message: null, finish_stopping: false }, piece: null, mount_epoch: null, piece_state: null, piece_source: null })
const ack = (seq: number, gen: number, rev = 5): Ack => ({ seq, body_sha256: H(String(seq)), scene_ref: ref(rev), edit_generation: gen, mount: 7, at: 0 })
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function harness(l: Ledger, acks: Ack[] = []) {
  const posts: { n: number; body: OutcomeBody }[] = []
  const timers: (() => void)[] = []
  let captures = 0
  let fail: ApiError | null = null
  const r = new OutcomeReporter({
    proposalArtifact: 'ar_p',
    // exact snapshot only (custody.ts decides freshness; covered there)
    custodyFor: (obs, gen) => [...acks].reverse().find((a) => a.scene_ref.scene_id === obs.scene_id && a.scene_ref.revision === obs.revision && a.scene_ref.digest === obs.digest && a.edit_generation === gen) ?? null,
    ledger: () => l,
    refreshLedger: async () => undefined,
    post: async (n, body) => { if (fail) { const e = fail; fail = null; throw e } posts.push({ n, body: JSON.parse(JSON.stringify(body)) }) },
    requestCapture: () => { captures++ },
    later: (_ms, fn) => { timers.push(fn); return () => undefined },
  })
  return { r, posts, timers, acks, captures: () => captures, failNext: (e: ApiError) => { fail = e } }
}

describe('r1.5: host R4 L6 op ids (contract r4.3:120)', () => {
  it('a validated outcome whose receipt names no op ids is HELD and never sent (no capture asked, no auto replay)', async () => {
    for (const outcome of ['applied', 'refused', 'accepted-no-source-change'] as const) {
      const h = harness(ledger([step()]), [ack(1, 9)])
      const e = h.r.add(report({ outcome, op_ids: undefined }))
      await flush()
      expect(e.state).toEqual({ kind: 'held', why: 'op-ids-missing' })
      h.r.retryHeld()
      await flush()
      expect(h.posts).toEqual([])
      expect(h.captures()).toBe(0)
    }
  })
  it('ids the host’s L6 shape would refuse are HELD (not confirmed), never repaired or sent', async () => {
    for (const ids of [['-lead'], ['.x'], ['a', 'a'], [], Array.from({ length: 17 }, (_, i) => `o${i}`), ['x'.repeat(81)], ['has space']]) {
      const h = harness(ledger([step()]), [ack(1, 9)])
      const e = h.r.add(report({ op_ids: ids }))
      await flush()
      expect(e.state).toEqual({ kind: 'held', why: 'op-ids-malformed' })
      h.r.retryHeld()
      await flush()
      expect(h.posts).toEqual([])
    }
  })
  it('`invalid` without op ids is reported (the host requires them only for validated outcomes); with them, they are sent', async () => {
    const h = harness(ledger([step()]), [ack(1, 9)])
    h.r.add(report({ outcome: 'invalid', op_ids: undefined }))
    await flush()
    expect(h.posts.length).toBe(1)
    expect('op_ids' in h.posts[0].body).toBe(false)
  })
  it('the body carries the RECEIVER’s op ids, never the ledger’s declared list', async () => {
    const h = harness(ledger([step({ op_ids: ['op-b', 'op-a'] })]), [ack(1, 9)])
    h.r.add(report({ op_ids: ['op-a', 'op-b'] }))
    await flush()
    expect(h.posts[0].body.op_ids).toEqual(['op-a', 'op-b'])   // the receiver's order, not the ledger's
  })
  it('set equality ignores order: a reordered list is not a difference', async () => {
    const h = harness(ledger([step({ op_ids: ['op-b', 'op-a'] })]), [ack(1, 9)])
    const e = h.r.add(report({ op_ids: ['op-a', 'op-b'] }))
    await flush()
    expect(e.state.kind).toBe('reported')
  })
  it('a difference from the step’s declared set HOLDS before sending (missing, extra or other ids)', async () => {
    for (const declared of [['op-a'], ['op-a', 'op-b', 'op-c'], ['op-a', 'op-x']]) {
      const h = harness(ledger([step({ op_ids: declared })]), [ack(1, 9)])
      const e = h.r.add(report({ op_ids: ['op-a', 'op-b'] }))
      await flush()
      expect(e.state).toEqual({ kind: 'held', why: 'op-ids-differ' })
      expect(h.posts).toEqual([])
    }
  })
  it('409 op_ids_mismatch is held as not confirmed: no skip, no replay, the body kept identical', async () => {
    const h = harness(ledger([step()]), [ack(1, 9)])
    h.failNext(new ApiError(409, 'op_ids_mismatch', 'not the declared ones'))
    const e = h.r.add(report())
    await flush()
    expect(e.state).toEqual({ kind: 'held', why: 'op-ids-refused' })
    const sent = JSON.stringify(e.body)
    h.r.retryHeld()
    for (const t of h.timers) t()
    await flush()
    expect(h.posts).toEqual([])                        // never sent again automatically
    expect(JSON.stringify(e.body)).toBe(sent)          // any re-report would be byte-identical
    expect(e.n).toBe(4)                                // still step 4: never n+1
  })
  it('a second frame report for the same proposal with different op ids is a conflict (the first is kept)', async () => {
    const h = harness(ledger([step()]), [ack(1, 9)])
    const first = h.r.add(report())
    await flush()
    h.r.add(report({ op_ids: ['op-z'] }))
    expect(first.state.kind).toBe('fenced')
    expect(h.posts.length).toBe(1)
  })
})

describe('OutcomeReporter', () => {
  it('HOLDS with no acknowledged upload containing the observed hand edit; never reports against an unacknowledged one', async () => {
    const h = harness(ledger([step()]), [ack(1, 8)])   // the only ack predates the observed generation 9
    const e = h.r.add(report())
    await flush()
    expect(e.state).toEqual({ kind: 'held', why: 'custody' })
    expect(h.posts).toEqual([])
    expect(h.captures()).toBe(1)                       // a fresh capture was asked for
    h.acks.push(ack(2, 9))                             // the upload with that generation is acknowledged
    h.r.retryHeld()
    await flush()
    expect(h.posts.length).toBe(1)
    expect(h.posts[0].n).toBe(4)
    expect(h.posts[0].body.piece_upload).toEqual({ seq: 2, body_sha256: H('2'), scene_ref: ref(5), edit_generation: 9 })
  })
  it('the body is built once: a lost answer retries the identical body (host idempotency per (sid, n))', async () => {
    const h = harness(ledger([step()]), [ack(1, 9)])
    h.failNext(new ApiError(0, 'network', 'lost'))
    const e = h.r.add(report())
    await flush()
    expect(e.state.kind).toBe('unconfirmed')
    h.acks.push(ack(0, 9))                             // even if custody would now pick another upload…
    h.timers[0]()
    await flush()
    expect(h.posts.length).toBe(1)
    expect(h.posts[0].body.piece_upload.seq).toBe(1)         // …the retry is byte-identical to the first body
  })
  it('a late outcome after the step timed out still reports against n (never n+1) and is marked late', async () => {
    const h = harness(ledger([step({ state: 'timed_out' }), step({ n: 5, proposal_n: null, proposal_digest: null, state: 'admitted' })]), [ack(1, 9, 6)])
    const e = h.r.add(report({ outcome: 'applied', piece_after: ref(6) }))
    await flush()
    expect(h.posts.map((p) => p.n)).toEqual([4])
    expect(e.state).toEqual({ kind: 'reported', late: true })
  })
  it('a proposal from another artifact or a digest the host did not bind is fenced, with zero writes', async () => {
    const h = harness(ledger([step({ proposal_digest: `sha256:${H('9')}` })]), [ack(1, 9)])
    const foreign = h.r.add(report({ proposal: { artifact_id: 'ar_other', revision: 3, digest: `sha256:${H('3')}` } }))
    const wrong = h.r.add(report())
    await flush()
    expect(foreign.state.kind).toBe('fenced')
    expect(wrong.state.kind).toBe('fenced')
    expect(h.posts).toEqual([])
  })
  it('an unknown step mapping holds (no guessed step)', async () => {
    const h = harness(ledger([]), [ack(1, 9)])
    const e = h.r.add(report())
    await flush()
    expect(e.state).toEqual({ kind: 'held', why: 'step-unknown' })
    expect(h.posts).toEqual([])
  })
  it('after closeWrites nothing is sent, even on retry', async () => {
    const h = harness(ledger([step()]), [])
    h.r.add(report())
    await flush()
    h.r.closeWrites()
    h.acks.push(ack(1, 9))
    h.r.retryHeld()
    await flush()
    expect(h.posts).toEqual([])
  })
  it('Kimi K4: an observed piece older than what the maker read for the step is fenced, never bound', async () => {
    const h = harness(ledger([step({ piece_read: { seq: 5, body_sha256: H('9'), scene_ref: ref(5), edit_generation: 9 } })]), [ack(2, 9)])
    const e = h.r.add(report())
    await flush()
    expect(e.state.kind).toBe('fenced')
    expect(h.posts).toEqual([])
  })
})
