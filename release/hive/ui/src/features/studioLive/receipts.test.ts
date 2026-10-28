import { describe, expect, it } from 'vitest'
import { ApiError } from '../../api/client'
import { hostWords, readAdmission, readLedger, readStudioEvent, readStudioSteer, type Ledger, type LedgerStep } from './api'
import { costReadout } from './cost'
import { buildCards, claimStatus } from './receipts'
import { heldWords, isMonthlyTotalRequired, MONTHLY_TOTAL_REMEDY, MONTHLY_TOTAL_WORDS, studioRefusal } from './refusals'
import { headroom, moneyDrifted, monthlyLine } from './cost'
import { readConsent } from './api'
import { alsoQueuedWords, directionWords, opIdHoldWords, reloadMayForget, remoteStopConfirmed, remoteWords, stopProgressWords, roleToolsWords, stepWords } from './words'
import { parseFrameLive } from './wire'
import type { ReportEntry } from './outcomes'

const fsText = ((await import(/* @vite-ignore */ 'node:' + 'fs')) as { readFileSync(p: string, e: 'utf8'): string }).readFileSync.bind(null) as unknown as (p: string) => string
const readText = (p: string) => (fsText as unknown as (p: string, e: 'utf8') => string)(p, 'utf8')

/** J3 r4.3 O3: receipt cards from host records only, refusal words, cost order, the frame wire. INVENTED values. */

const H = (c: string) => c.repeat(64)
const ref = (rev: number, d = 'd') => ({ scene_id: 'sim-poster', revision: rev, digest: `sha256:${H(d)}` })
const step = (over: Partial<LedgerStep> = {}): LedgerStep => ({ n: 1, state: 'settled', proposal_n: 1, proposal_digest: `sha256:${H('1')}`, outcome: null, reason: null, piece_before: ref(1), piece_after: ref(2), receiver_generation: 7, direction_seqs: [], late: false, upload: { seq: 2, body_sha256: H('b'), scene_ref: ref(2), edit_generation: 3 }, summary: 'headline', spent_usd: 0.05, piece_read: null, op_ids: null, ...over })
const L = (over: Partial<Ledger> = {}): Ledger => ({
  session_id: 'ss_a', stream_id: 'as_aaaaaaaaaaaaaaaaaaaaaaaa', state: 'active', reason: null, ask_turn_id: 'op_a', goal_id: 'g_a', proposal_artifact_id: 'ar_p', maker_id: 'a_m', swarm_id: 's_x', program_id: 'omegadesign', scene_id: 'sim-poster', payer: null, model: null, steps: [], directions: [],
  budget: { cap: 2, spent: 0.3, held: 0.05, unknown: 0, step_cap: 0.25, step_spent: 0, step_seconds: 180, monthly: [{ scope: 'month', limit: 10, spent: 3.4, held: 0.05, unknown: 0, period: '2026-10' }] },
  piece_source: null,
  stop: { state: 'none', fenced_at: null, in_flight: 0, unknown_usd: 0, cancel_ack: null, maker_released: null, stop_failed: false, release_stale: false, message: null, finish_stopping: false }, piece: null, mount_epoch: null, piece_state: null, ...over,
})
const admission = { session_id: 'ss_a', stream_id: 'as_aaaaaaaaaaaaaaaaaaaaaaaa', goal_id: 'g_a', proposal_artifact_id: 'ar_p', state: 'active' as const, maker_id: 'a_m', payer: 'you', cap_usd: 2, step_cap_usd: 0.25, app_pin: null }
const facts = (over = {}) => ({ principal: 'user:p_a', admission, localStopped: false, reports: [] as ReportEntry[], ...over })
const kinds = (l: Ledger, f = facts()) => buildCards(l, f).map((c) => c.kind)

describe('receipt cards (host records only)', () => {
  it('session started needs the linked admission whose ids are this ledger’s; a goal alone is not an admission', () => {
    expect(kinds(L())).toEqual(['session-started'])
    expect(kinds(L(), facts({ admission: { ...admission, proposal_artifact_id: 'ar_other' } }))).toEqual([])
    expect(readAdmission({ goal_id: 'g_a', state: 'active', cap_usd: 2, step_cap_usd: 0.25 })).toBeNull()
    expect(buildCards(L(), facts())[0].text).toBe('Studio session started · cap $2.00 · $6.55 of your month left')
  })
  it('a proposal revision alone is “proposal ready”, never drawn', () => {
    expect(kinds(L({ steps: [step({ outcome: null, state: 'finished' })] }))).toEqual(['session-started', 'proposal-ready'])
  })
  it('drawn needs the applied outcome with piece after-ref, receiver generation and the acknowledged upload', () => {
    expect(kinds(L({ steps: [step({ outcome: 'applied' })] }))).toContain('drawn')
    for (const missing of [{ upload: null }, { receiver_generation: null }, { piece_after: null }]) {
      const cards = buildCards(L({ steps: [step({ outcome: 'applied', ...missing })] }), facts())
      expect(cards.map((c) => c.kind)).not.toContain('drawn')
      expect(cards.at(-1)!.text).toBe('Step 1: not confirmed')
    }
  })
  it('a host record that disagrees with this canvas’s own report is not confirmed', () => {
    const local = { key: 'k', n: 1, body: null, tries: 1, state: { kind: 'reported', late: false }, report: { proposal: { artifact_id: 'ar_p', revision: 1, digest: `sha256:${H('1')}` }, outcome: 'applied', piece_before: ref(1), piece_after: ref(2, 'e'), receiver_generation: 7, receipt_digest: H('e'), observed_generation: 3 } } as ReportEntry
    expect(kinds(L({ steps: [step({ outcome: 'applied' })] }), facts({ reports: [local] }))).not.toContain('drawn')
  })
  it('refused shows its own words; late reports say so', () => {
    const c = buildCards(L({ steps: [step({ outcome: 'refused', reason: 'conflict', late: true, piece_after: ref(1) })] }), facts())
    expect(c.at(-1)!.text).toBe('Step 1 not applied: it would overwrite your edit')
    expect(c.at(-1)!.detail).toMatch(/after the step’s time ran out/)
  })
  it('Stop: local first, remote stopping until zero in flight; billing not settled is its own card and survives a month change', () => {
    const stopping = L({ state: 'stopping', stop: { state: 'stopping', fenced_at: 'x', in_flight: 1, unknown_usd: 0, cancel_ack: 'pending', maker_released: null, stop_failed: false, release_stale: false, message: null, finish_stopping: false } })
    const c1 = buildCards(stopping, facts({ localStopped: true }))
    expect(c1.find((c) => c.kind === 'stopped')!.text).toBe('Stopped here · remote: stopping…')
    const stopped = L({ state: 'stopped', stop: { state: 'stopped', fenced_at: 'x', in_flight: 0, unknown_usd: 0.07, cancel_ack: 'acknowledged', maker_released: null, stop_failed: false, release_stale: false, message: null, finish_stopping: false }, budget: { ...L().budget, unknown: 0.07, monthly: [{ scope: 'month', limit: 10, spent: 3.4, held: 0, unknown: 0.07, period: '2026-11' }] } })
    const c2 = buildCards(stopped, facts({ localStopped: true }))
    expect(c2.find((c) => c.kind === 'stopped')!.text).toBe('Stopped here · remote: stopped')
    expect(c2.find((c) => c.kind === 'stopped')!.detail).toBe('The maker acknowledged.')
    const bill = c2.find((c) => c.kind === 'billing')!
    expect(bill.text).toBe('$0.07 not settled yet')
    expect(bill.detail).toMatch(/now 2026-11/)
    expect(bill.detail).toMatch(/nothing was refunded/)
  })
  it('narration: a drawing claim without a drawn card for this person and session is not confirmed', () => {
    const cards = buildCards(L({ steps: [step({ outcome: 'applied' })] }), facts())
    expect(claimStatus('I’ve drawn the headline', cards, { principal: 'user:p_a', session_id: 'ss_a' })).toBe('confirmed')
    expect(claimStatus('I’ve drawn the headline', cards, { principal: 'user:p_b', session_id: 'ss_a' })).toBe('not-confirmed')
    expect(claimStatus('I’ve drawn the headline', buildCards(L({ steps: [step({ outcome: null, state: 'finished' })] }), facts()), { principal: 'user:p_a', session_id: 'ss_a' })).toBe('not-confirmed')
    expect(claimStatus('Studio has stopped', cards, { principal: 'user:p_a', session_id: 'ss_a' })).toBe('not-confirmed')
    expect(claimStatus('Here is an idea for colours', cards, { principal: 'user:p_a', session_id: 'ss_a' })).toBe('unclassified')
  })
})

describe('refusals', () => {
  const monthly = new ApiError(402, 'spend_limit', 'x', { envelope: { code: 'spend_limit', limit: { kind: 'own_key_limit', limit: null }, detail: { reason: 'monthly_total_required' } } })
  it('402 spend_limit + own_key_limit + monthly_total_required has its own words and the “Set your monthly limit” remedy', () => {
    expect(isMonthlyTotalRequired(monthly)).toBe(true)
    const r = studioRefusal(monthly)
    expect(r.words).toBe(MONTHLY_TOTAL_WORDS)
    expect(r.remedy).toEqual({ label: MONTHLY_TOTAL_REMEDY, go: 'me' })
    expect(r.code).toBe('monthly_total_required')
  })
  it('any other 402 is not the monthly-total refusal (no new top-level code is invented)', () => {
    expect(isMonthlyTotalRequired(new ApiError(402, 'spend_limit', 'x', { envelope: { limit: { kind: 'own_key_limit' } } }))).toBe(false)
    expect(isMonthlyTotalRequired(new ApiError(402, 'monthly_total_required', 'x'))).toBe(false)
  })
  it('429 keeps the words and says twenty are waiting', () => {
    const r = studioRefusal(new ApiError(429, 'rate_limited', 'x'))
    expect(r.keepWords).toBe(true)
    expect(r.words).toMatch(/Twenty directions/)
  })
})

describe('cost readout', () => {
  it('monthly headroom first, then the session against its cap, then the step backstops; unknown said as unknown', () => {
    const c = costReadout(L().budget)
    expect(c.monthly).toBe('$6.55 of your month left (limit $10.00)')   // 10 − 3.40 − 0.05 (held is inclusive)
    expect(c.session).toBe('This session: $0.30 of $2.00')
    expect(c.step).toBe('Each step: up to $0.25 and 180 s')
    expect(costReadout({ ...L().budget, spent: null, monthly: [] }).session).toBe('This session: unknown of $2.00')
  })
})

describe('the frame wire and the ledger reader', () => {
  it('accepts exactly the outcome keys; refuses extra keys, bad refs and cross-scene before/after', () => {
    const ok = { type: 'studio-live-outcome', channel: 'c', session_id: 'ss_a', receiver_generation: 7, proposal: { artifact_id: 'ar_p', revision: 1, digest: `sha256:${H('1')}` }, outcome: 'applied', piece_before: ref(1), piece_after: ref(2), receipt_digest: H('e'), observed_generation: 3 }
    expect(parseFrameLive(ok)?.kind).toBe('outcome')
    expect(parseFrameLive({ ...ok, payer: 'me' })?.kind).toBe('invalid')
    expect(parseFrameLive({ ...ok, outcome: 'unreported' })?.kind).toBe('invalid')
    expect(parseFrameLive({ ...ok, piece_after: { ...ref(2), scene_id: 'other' } })?.kind).toBe('invalid')
    expect(parseFrameLive({ type: 'draft-save' })).toBeNull()
  })
  it('r1.5: the outcome may carry the receiver’s op_ids, forwarded unchanged and never normalised (the reporter judges the shape)', () => {
    const ok = { type: 'studio-live-outcome', channel: 'c', session_id: 'ss_a', receiver_generation: 7, proposal: { artifact_id: 'ar_p', revision: 1, digest: `sha256:${H('1')}` }, outcome: 'applied', piece_before: ref(1), piece_after: ref(2), receipt_digest: H('e'), observed_generation: 3 }
    const with2 = parseFrameLive({ ...ok, op_ids: ['b-1', 'a-1'] })
    expect(with2?.kind === 'outcome' && with2.report.op_ids).toEqual(['b-1', 'a-1'])
    const without = parseFrameLive(ok)
    expect(without?.kind === 'outcome' && 'op_ids' in without.report).toBe(false)
    for (const kept of [[], ['a', 'a'], ['-x'], [' a-1 ']]) {
      const r = parseFrameLive({ ...ok, op_ids: kept })
      expect(r?.kind === 'outcome' && r.report.op_ids).toEqual(kept)   // byte-for-byte: never trimmed, deduplicated or fixed
    }
    for (const bad of [[7], 'a-1', null, Array.from({ length: 65 }, (_, i) => `o${i}`), ['x'.repeat(201)]])
      expect(parseFrameLive({ ...ok, op_ids: bad })?.kind).toBe('invalid')
  })
  it('r1.5: the L6 held words are honest: not confirmed, nothing reported or replayed, never a drawing claim', () => {
    for (const why of ['op-ids-missing', 'op-ids-malformed', 'op-ids-differ', 'op-ids-refused'] as const) {
      const w = opIdHoldWords(why, 3)
      expect(w).toMatch(/^Step 3: result not confirmed\./)
      expect(w).toMatch(/won’t be skipped or replayed/)
      expect(w).not.toMatch(/\bdrawn\b|\bdone\b|\bdots?\b/i)
    }
    expect(opIdHoldWords('op-ids-missing', null)).toMatch(/^This step:/)
  })
  it('r1.5: the ledger reader keeps the step view’s declared op_ids (host R4), null when absent or malformed', () => {
    const raw = { ...L(), steps: [{ n: 1, state: 'finished', proposal_revision: 1, proposal_digest: `sha256:${H('1')}`, op_ids: ['x-1', 'y-1'] }] }
    expect(readLedger(raw, 'ss_a')!.steps[0].op_ids).toEqual(['x-1', 'y-1'])
    expect(readLedger({ ...raw, steps: [{ ...raw.steps[0], op_ids: null }] }, 'ss_a')!.steps[0].op_ids).toBeNull()
    expect(readLedger({ ...raw, steps: [{ ...raw.steps[0], op_ids: ['x-1', 'x-1'] }] }, 'ss_a')!.steps[0].op_ids).toBeNull()
  })
  it('the ledger reader names stream_id (null when the host has not admitted one) and refuses a foreign session', () => {
    const raw = { ...L(), steps: [] }
    expect(readLedger(raw, 'ss_a')?.stream_id).toBe('as_aaaaaaaaaaaaaaaaaaaaaaaa')
    expect(readLedger({ ...raw, stream_id: undefined }, 'ss_a')?.stream_id).toBeNull()
    expect(readLedger(raw, 'ss_other')).toBeNull()
  })
})

describe('held words (Code r1.2 binding)', () => {
  it('execution_retirement_failed says what happened and what helps; never a silent wait or a release claim', () => {
    const w = heldWords('execution_retirement_failed')
    expect(w).toBe('Studio couldn’t hand over cleanly from the last session. Nothing new will draw until that’s cleared. Ask Platform, or try again later.')
    expect(w).not.toMatch(/released/i)
    expect(heldWords('something_new')).toMatch(/holding this session/)
  })
})

describe('step words (Design routing review P2)', () => {
  const s = (o: object) => [{ n: 2, state: 'finished', proposal_n: null, outcome: null, ...o }]
  it('publication is “proposal ready”, drawn only on applied, other ends say what they are (never “done”)', () => {
    expect(stepWords(s({ proposal_n: 2 }))).toBe('step 2: proposal ready, waiting for the canvas')
    expect(stepWords(s({ proposal_n: 2, outcome: 'applied', state: 'settled' }))).toBe('step 2 drawn')
    expect(stepWords(s({ proposal_n: 2, outcome: 'accepted-no-source-change' }))).toBe('step 2: nothing changed in the piece')
    expect(stepWords(s({ proposal_n: 2, outcome: 'unreported', state: 'timed_out' }))).toBe('step 2: not confirmed')
    expect(stepWords(s({ state: 'timed_out' }))).toBe('step 2: drawing not confirmed')
    expect(stepWords(s({ state: 'finished' }))).toBe('step 2: drawing not confirmed')
    for (const o of [{ proposal_n: 2 }, { state: 'timed_out' }, { state: 'interrupted' }]) expect(stepWords(s(o))).not.toMatch(/\bdone\b|\bdrawn\b/)
  })
})

describe('Code’s consent golden vectors (host 75b3c381 functions, generated offline, synthetic)', () => {
  // read as text and parsed by JSON.parse (the lone-surrogate vector is not loadable as a JSON module)
  const v = JSON.parse(readText(new URL('./fixtures/consentVectors.json', import.meta.url).pathname)) as { vectors: { id: string; disposition: string; payload: Record<string, unknown> }[] }
  it.each(v.vectors.map((x) => [x.id, x] as const))('%s', (_id, x) => {
    const p = readConsent(x.payload)
    if (x.disposition === 'requires_ui_refusal') expect(p).toBeNull()
    else expect(p).not.toBeNull()
  })
  it('missing, unknown or partial disclosures are refused (never auto-accepted)', () => {
    const base = v.vectors[0].payload
    const variant = (f: (p: Record<string, unknown>) => void) => { const p = JSON.parse(JSON.stringify(base)); f(p); return readConsent(p) }
    expect(variant((p) => { delete p.disclosures })).toBeNull()
    expect(variant((p) => { p.disclosures = ['unqualified'] })).toBeNull()
    expect(variant((p) => { p.disclosures = ['maker_reads_unsaved_piece_while_live'] })).toBeNull()
  })
  it('inclusive held: unknown is not subtracted twice; an unknown held total is unknown and never dropped', () => {
    const row = { scope: 'm', limit: 10, spent: 2, held: 1, unknown: 0.5, period: 'p' }
    expect(headroom(row)).toBe(7)
    expect(headroom({ ...row, unknown: null })).toBe(7)
    expect(headroom({ ...row, held: null })).toBeNull()
    expect(monthlyLine([row, { ...row, held: null, scope: 'other' }]).headroom).toBeNull()
    const b = { cap: 2, spent: 1.25, held: 0.6, unknown: 0.6, step_cap: 0.25, step_spent: 0, step_seconds: 180, monthly: [row] }
    expect(costReadout(b).nearCap).toBe(true)
    expect(costReadout({ ...b, unknown: null }).unknown).toBe('Not settled yet: unknown')
  })
})

describe('r1.1 money honesty (Kimi K1, K2) and role/tools (K5)', () => {
  const b = { cap: 2, spent: 0.4, held: 0.04, unknown: 0, step_cap: 0.25, step_spent: 0, step_seconds: 180, monthly: [] }
  it('K2: an absent held figure is unknown: never an optimistic “room left” and the held line says unknown', () => {
    const r = costReadout({ ...b, held: null })
    expect(r.nearCap).toBe(true)
    expect(r.held).toBe('Held for calls in progress: unknown')
  })
  it('K1: unknown may only go down by what settles into spent; otherwise the figures are “not settled”', () => {
    expect(moneyDrifted({ ...b, held: 0, unknown: 0.04 }, { ...b, spent: 0.44, held: 0, unknown: 0 })).toBe(false)   // it settled
    expect(moneyDrifted({ ...b, held: 0, unknown: 0.04 }, { ...b, held: 0, unknown: 0 })).toBe(true)                  // it vanished
    expect(costReadout(b, { drift: true }).session).toMatch(/not settled/)
  })
  it('K5: a non-null role and non-empty tools pass the reader and are named on the card', () => {
    const base = JSON.parse(readText(new URL('./fixtures/consentVectors.json', import.meta.url).pathname)).vectors.find((x: { id: string }) => x.id === 'effective-role-tools').payload
    const c = readConsent(base)!
    expect(c).not.toBeNull()
    expect(roleToolsWords(c)).toMatch(/^role: \S+ · tools: \S/)
    expect(roleToolsWords({ role_id: 'designer', tools: ['image-search', 'palette'] })).toBe('role: designer · tools: image-search, palette')
    expect(roleToolsWords({ role_id: null, tools: [] })).toBe('role: none · tools: none')
  })
})

describe('r1.2: uncertain steps, held words, stop confirmation, unknown money', () => {
  it('stand-in P2-3: an interrupted / timed-out step with no confirmed result reads “drawing not confirmed”, never “nothing drawn”', () => {
    for (const st of ['interrupted', 'timed_out']) {
      const c = buildCards(L({ steps: [step({ state: st as never, proposal_n: null, proposal_digest: null, outcome: null, reason: 'delivery_uncertain', spent_usd: 0.03 })] }), facts())
      const card = c.find((x) => x.id.endsWith(':e1'))!
      expect(card.text).toBe('Step 1: drawing not confirmed · $0.03 spent')
      expect(card.detail).toMatch(/not be replayed automatically/)
    }
  })
  it('Kimi K1: delivery_uncertain and maker_unresponsive have their own words and say what the person can do', () => {
    expect(heldWords('delivery_uncertain')).toMatch(/not confirmed and nothing is sent again\. You can Stop, or wait for the hive to clear it\./)
    expect(heldWords('maker_unresponsive')).toMatch(/maker isn’t responding \(this isn’t the canvas being slow\)/)
    expect(heldWords('maker_unresponsive')).not.toMatch(/retry/i)
  })
  it('Kimi K2: “remote: stopped” only when state and stop record both say so and nothing is in flight', () => {
    expect(remoteWords('stopping', { state: 'stopped', in_flight: 0 })).toBe('remote: stopping…')
    expect(remoteWords('stopped', { state: 'stopping', in_flight: 0 })).toBe('remote: stop not confirmed')
    expect(remoteWords('ended', { state: 'ended', in_flight: 0 })).toBe('remote: stopped')
    expect(remoteWords('ended', { state: 'ended', in_flight: 1 })).toBe('remote: stop not confirmed')
    const stopping = L({ state: 'stopping', stop: { state: 'stopped', fenced_at: 'x', in_flight: 0, unknown_usd: 0, cancel_ack: null, maker_released: null, stop_failed: false, release_stale: false, message: null, finish_stopping: false } })
    expect(buildCards(stopping, facts({ localStopped: true })).find((c) => c.kind === 'stopped')!.text).toBe('Stopped here · remote: stopping…')
  })
  it('one readout for bar and panel: an admitted ledger’s missing figures are unknown, a real zero stays $0.00', () => {
    const b = { cap: null, spent: null, held: 0, unknown: 0, step_cap: null, step_spent: 0, step_seconds: null, monthly: [] }
    const r = costReadout(b)
    expect(r.compact).toBe('unknown of unknown')
    expect(r.session).toBe('This session: unknown of unknown')
    expect(r.step).toBe('Each step: up to unknown and unknown')
    expect(r.nearCap).toBe(true)
    expect(costReadout({ ...b, cap: 2, spent: 0 }).compact).toBe('$0.00 of $2.00')
  })
})

describe('host R3 ledger (2975768e shapes)', () => {
  const H2 = (c: string) => c.repeat(64)
  const r3 = (over: Record<string, unknown> = {}) => ({
    session_id: 'ss_r3', kind: 'studio.session', stream_id: 'as_bbbbbbbbbbbbbbbbbbbbbbbb', state: 'active', state_reason: null, ask_turn_id: 'op_r3', goal_id: 'g_r3',
    proposal_artifact_id: 'ar_r3', maker_id: 'a_r3', swarm_id: 's_r3', program_id: 'omegadesign', step_window_s: 180,
    piece: { scene_id: 'sim-poster', source_ref: null },
    steps: [{ n: 1, state: 'finished', proposal_revision: 1, proposal_digest: `sha256:${H2('1')}`, outcome: 'applied', outcome_reason: null, receiver_generation: 7, mount_epoch: 2,
      piece_read: null, piece_upload: { seq: 3, body_sha256: `sha256:${H2('9')}`, scene_ref: { scene_id: 'sim-poster', revision: 4, digest: `sha256:${H2('d')}` }, edit_generation: 5 },
      direction_seqs: [], spend: { scope: 'studiostep:ss_r3:1', spent: 0.04, held: 0 } }],
    directions: [], piece_custody: { latest: { seq: 3, body_sha256: `sha256:${H2('9')}`, scene_ref: { scene_id: 'sim-poster', revision: 4, digest: `sha256:${H2('d')}` }, edit_generation: 5, acknowledged_at: 't', refresh: false }, piece_state: 'current', mount: { mount_epoch: 2, receiver_generation: 7, lease_expires_at: 't' } },
    budget: { scope: 'studio:ss_r3', cap: 2, spent: 0.04, held: 0, unknown: 0, step_cap: 0.25, step_spent: null, monthly: [] },
    stop: { state: null, stop_verified: false, stop_failed: false, release_stale: false, maker_released: false, message: null, finish_stopping: false, fenced_at: null },
    ...over,
  })
  it('reads proposal_revision, outcome_reason, piece_custody, the session piece, step_window_s and the stop view', () => {
    const l = readLedger(r3(), 'ss_r3')!
    expect(l.steps[0].proposal_n).toBe(1)
    expect(l.steps[0].piece_after?.revision).toBe(4)            // the acknowledged upload is the observed after-state
    expect(l.steps[0].spent_usd).toBe(0.04)
    expect(l.scene_id).toBe('sim-poster')
    expect(l.piece?.seq).toBe(3)
    expect(l.piece?.body_sha256).toBe(`sha256:${H2('9')}`)
    expect(l.mount_epoch).toBe(2)
    expect(l.piece_state).toBe('current')
    expect(l.budget.step_seconds).toBe(180)
    const cards = buildCards(l, { principal: 'user:p', admission: null, localStopped: false, reports: [] })
    expect(cards.find((c) => c.kind === 'drawn')?.text).toBe('Step 1 drawn')
  })
  it('host R3 stop: “stopped” only with state and stop record stopped and the maker released (R3 has no in_flight)', () => {
    const stopped = readLedger(r3({ state: 'stopped', stop: { state: 'stopped', stop_verified: true, stop_failed: false, release_stale: false, maker_released: true, message: null, finish_stopping: false } }), 'ss_r3')!
    expect(remoteWords(stopped.state, stopped.stop)).toBe('remote: stopped')
    const notReleased = readLedger(r3({ state: 'stopped', stop: { state: 'stopped', maker_released: false } }), 'ss_r3')!
    expect(remoteWords(notReleased.state, notReleased.stop)).toBe('remote: stop not confirmed')
    const stopping = readLedger(r3({ state: 'stopping', stop: { state: 'stopping', stop_failed: true, message: 'Studio’s mind couldn’t be stopped.' } }), 'ss_r3')!
    expect(remoteWords(stopping.state, stopping.stop)).toBe('remote: stopping…')
    expect(stopping.stop.message).toBe('Studio’s mind couldn’t be stopped.')
  })
  it('r1.4 field sweep: R3 has no `late`; an on-time outcome on a step that closed later is not late, one after the deadline is', () => {
    const at = (outcome_at: string, state = 'timed_out') => readLedger(r3({ steps: [{ ...r3().steps[0], state, deadline: '2026-10-18T10:04:00Z', outcome_at }] }), 'ss_r3')!.steps[0]
    expect(at('2026-10-18T10:03:59Z').late).toBe(false)              // recorded in time; the step timed out afterwards
    expect(at('2026-10-18T10:03:59Z', 'stopped').late).toBe(false)
    expect(at('2026-10-18T10:04:01Z').late).toBe(true)
    expect(readLedger(r3(), 'ss_r3')!.steps[0].late).toBe(false)     // no timestamps: not claimed late
  })
  it('r1.4: the full host R3 stopped-ledger fixture parses; stop has no in_flight; the stop card confirms from maker_released', () => {
    const raw = JSON.parse(readText(new URL('./fixtures/r3StoppedLedger.json', import.meta.url).pathname)).ledger
    const l = readLedger(raw, 'ss_a')!
    expect(l.stop.in_flight).toBeNull()
    expect(l.stop.unknown_usd).toBeNull()
    expect(l.budget.unknown).toBe(0)
    expect(reloadMayForget(l)).toBe(true)
    expect(l.steps.map((s) => s.late)).toEqual([false, false])
    const cards = buildCards(l, { principal: 'user:p', admission: null, localStopped: false, reports: [] })
    expect(cards.find((c) => c.kind === 'stopped')?.text).toBe('Stopped here · remote: stopped')
    expect(cards.map((c) => c.kind)).not.toContain('billing')
  })
  it('an R3 `unknown` outcome reads “drawing not confirmed”, never drawn', () => {
    const steps = [{ ...r3().steps[0], outcome: 'unknown' }]
    const cards = buildCards(readLedger(r3({ steps }), 'ss_r3')!, { principal: 'user:p', admission: null, localStopped: false, reports: [] })
    expect(cards.map((c) => c.kind)).not.toContain('drawn')
    expect(cards.at(-1)!.text).toBe('Step 1: drawing not confirmed')
  })
})

describe('r1.6: host R5 stop view, directions, steer answer and codes (94c42da2)', () => {
  /** the R5 ledger key set (studio_sessions.ledger + R5 stop_view + directions_view), INVENTED values */
  const r5 = (state: string, stop: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
    session_id: 'ss_r5', kind: 'studio.session', stream_id: 'as_cccccccccccccccccccccccc', state, state_reason: null, ask_turn_id: 'op_r5', goal_id: 'g_r5', proposal_artifact_id: 'ar_r5', maker_id: 'a_r5', swarm_id: 's_r5', program_id: 'omegadesign', step_window_s: 180,
    piece: { scene_id: 'sim-poster', source_ref: null }, steps: [], directions: [], piece_custody: { latest: null, piece_state: 'missing', mount: { mount_epoch: null, receiver_generation: null, lease_expires_at: null } },
    budget: { scope: 'studio:ss_r5', cap: 2, spent: 0.1, held: 0, unknown: Number(stop.unknown_usd ?? 0), step_cap: 0.25, step_spent: null, monthly: [] },
    stop: { state: state === 'stopping' || state === 'stopped' ? state : null, fenced_at: '2026-10-19T10:00:00Z', in_flight: 0, unknown_usd: 0, cancel_ack: 'pending', stop_verified: false, stop_failed: false, release_stale: false, release_phase: null, maker_released: false, stopping_deadline: null, settle_deadline: null, message: null, finish_stopping: false, ...stop },
    ...over,
  })
  const L5 = (state: string, stop: Record<string, unknown>, over: Record<string, unknown> = {}) => readLedger(r5(state, stop, over), 'ss_r5')!
  it('reads in_flight, unknown_usd, cancel_ack, fenced_at and finish_stopping from the R5 stop view', () => {
    const l = L5('stopping', { in_flight: 1, unknown_usd: 0.25, cancel_ack: 'acknowledged', finish_stopping: true })
    expect([l.stop.in_flight, l.stop.unknown_usd, l.stop.cancel_ack, l.stop.fenced_at, l.stop.finish_stopping]).toEqual([1, 0.25, 'acknowledged', '2026-10-19T10:00:00Z', true])
  })
  it('stop confirmation: stopped + stop record stopped + in_flight 0 + maker not unreleased; anything else is not confirmed', () => {
    expect(remoteWords('stopped', L5('stopped', { maker_released: true }).stop)).toBe('remote: stopped')
    expect(remoteStopConfirmed('stopped', L5('stopped', { in_flight: 1, maker_released: true }).stop)).toBe(false)
    expect(remoteStopConfirmed('stopped', L5('stopped', { in_flight: 0, maker_released: false }).stop)).toBe(false)
    expect(remoteWords('stopping', L5('stopping', { in_flight: 1 }).stop)).toBe('remote: stopping…')
  })
  it('stop progress says how many sent calls are still finishing (from in_flight), never "stopped"', () => {
    const one = L5('stopping', { in_flight: 1 })
    expect(stopProgressWords(one.state, one.stop)).toMatch(/^Stopping: one call was already sent and is finishing/)
    const two = L5('stopping', { in_flight: 2 })
    expect(stopProgressWords(two.state, two.stop)).toMatch(/2 calls were already sent/)
    expect(stopProgressWords('stopped', L5('stopped', { maker_released: true }).stop)).toBeNull()
  })
  it('held money: R5 stopped with unknown billing (Sb) is confirmed stopped but the reload keeps the session; budget.unknown stays authoritative', () => {
    const owed = L5('stopped', { maker_released: true, unknown_usd: 0.3 })
    expect(remoteStopConfirmed(owed.state, owed.stop)).toBe(true)
    expect(reloadMayForget(owed)).toBe(false)
    const cards = buildCards(owed, { principal: 'user:p', admission: null, localStopped: true, reports: [] })
    expect(cards.find((c) => c.kind === 'billing')?.text).toBe('$0.30 not settled yet')
    expect(reloadMayForget(L5('stopped', { maker_released: true }))).toBe(true)
    // the two R5 figures are the same query; if they ever disagree, budget.unknown (authoritative) decides, and a
    // positive stop figure still keeps the session (never forget money)
    expect(reloadMayForget({ ...L5('stopped', { maker_released: true }), budget: { ...L5('stopped', {}).budget, unknown: null } })).toBe(false)
    expect(reloadMayForget(L5('stopping', { in_flight: 1, maker_released: true }))).toBe(false)
  })
  it('the cancel ack is shown on the stop card, never gating', () => {
    const cards = (ack: string) => buildCards(L5('stopped', { maker_released: true, cancel_ack: ack }), { principal: 'user:p', admission: null, localStopped: true, reports: [] })
    expect(cards('pending').find((c) => c.kind === 'stopped')?.detail).toBe('The maker hasn’t acknowledged yet.')
    expect(cards('acknowledged').find((c) => c.kind === 'stopped')?.detail).toBe('The maker acknowledged.')
    expect(cards('pending').find((c) => c.kind === 'stopped')?.text).toBe('Stopped here · remote: stopped')
  })
  it('directions: queued | delivered | read | cancelled, each in honest words (paused / held say they wait)', () => {
    const l = L5('active', {}, { directions: ['queued', 'delivered', 'read', 'cancelled'].map((state, i) => ({ seq: i + 1, steer_id: `st_${i}`, state, step: null })) })
    expect(l.directions.map((d) => d.state)).toEqual(['queued', 'delivered', 'read', 'cancelled'])
    expect(directionWords('cancelled', 'stopped')).toBe('not sent: the session stopped before the maker read it')
    expect(directionWords('queued', 'paused')).toMatch(/paused, so it reaches the maker after you resume/)
    expect(directionWords('queued', 'held')).toMatch(/held, so it waits/)
    expect(directionWords('read', 'active')).toBe('read by the maker')
  })
  it('the steer answer’s studio object: session_id, seq, state queued, session_state', () => {
    const a = readStudioSteer({ steer_id: 'st_1', operation_id: 'op', turn_id: 'at', new_turn: false, seq: 4, via: 'typed', studio: { session_id: 'ss_r5', seq: 3, state: 'queued', session_state: 'paused' } }, 'ss_r5')
    expect(a).toEqual({ steer_id: 'st_1', session_id: 'ss_r5', seq: 3, state: 'queued', session_state: 'paused' })
    expect(readStudioSteer({ steer_id: 'st_1', new_turn: true, studio: { session_id: 'ss_r5', seq: 3, state: 'queued' } }, 'ss_r5')).toBeNull()
    expect(readStudioSteer({ steer_id: 'st_1', new_turn: false, studio: { session_id: 'ss_other', seq: 3, state: 'queued' } }, 'ss_r5')).toBeNull()
  })
  it('every R5 code has plain words and a way on (no dead end)', () => {
    const want: Record<string, string | undefined> = { studio_session_closed: undefined, not_active: 'none', not_paused: 'wait', studio_stopping: 'none', window_ended: 'stop-then-new', consent_mismatch: 'confirm-new-card', execution_fenced: 'wait', person_session_live: 'stop-then-new' }
    for (const [code, next] of Object.entries(want)) {
      const r = studioRefusal(new ApiError(409, code, 'host words'))
      expect(r.code).toBe(code)
      expect(r.next).toBe(next)
      expect(r.words).not.toMatch(/hive refused that/)                  // not the generic fallback
      expect(r.words).not.toMatch(/\bdots?\b/i)
    }
    expect(studioRefusal(new ApiError(409, 'studio_session_closed', 'x')).words).toMatch(/kept here/)
    const owned = studioRefusal(new ApiError(409, 'maker_busy', 'x', { envelope: { code: 'maker_busy', message: 'x', reason: 'studio_owned' } }))
    expect([owned.code, owned.next]).toEqual(['studio_owned', 'stop-then-new'])
    expect(heldWords('paused_by_person')).toMatch(/^You paused this session/)
  })
})

describe('r1.7: host R6.2, OI-13 own_key_needed and the r1.6 review follow-ups', () => {
  it('own_key_needed (402, OI-13): plain words, a direct way to Keys, words kept (never retried on its own)', () => {
    const r = studioRefusal(new ApiError(402, 'own_key_needed', 'x', { envelope: { code: 'own_key_needed', message: 'x', scope: 'use', pays: 'own-key' } }))
    expect(r.code).toBe('own_key_needed')
    expect(r.words).toMatch(/someone else’s key.*Add your own key in Keys/)
    expect(r.remedy).toEqual({ label: 'Add your own key', go: 'keys' })
    expect(r.keepWords).toBe(true)
  })
  it('maker_kind_unsupported (R6 OI-11): says an Omega maker is needed; nothing created', () => {
    const r = studioRefusal(new ApiError(409, 'maker_kind_unsupported', 'x'))
    expect(r.words).toMatch(/Choose an Omega mind as the maker/)
    expect(r.words).toMatch(/Nothing was created or spent/)
    expect(r.next).toBe('none')
  })
  it('resume refusals map to their real next step: only consent_mismatch offers a new card; drift is Stop then new; money waits', () => {
    for (const code of ['model_drift', 'key_drift', 'payer_mismatch', 'role_drift', 'maker_not_member', 'attachment_drift', 'execution_binding_unqualified']) {
      const r = studioRefusal(new ApiError(409, code, 'x'), 'resume')
      expect([code, r.next]).toEqual([code, 'stop-then-new'])
      expect(r.words).toMatch(/can’t resume\. It stays paused\. Stop it, then start a new session/)
    }
    for (const code of ['budget_exhausted', 'spend_limit']) {
      const r = studioRefusal(new ApiError(402, code, 'x'), 'resume')
      expect([code, r.next, r.remedy?.go]).toEqual([code, 'none', 'usage'])
      expect(r.words).toMatch(/Resume again/)
    }
    expect(studioRefusal(new ApiError(409, 'consent_mismatch', 'x'), 'resume').next).toBe('confirm-new-card')
    expect(studioRefusal(new ApiError(409, 'window_ended', 'x'), 'resume').next).toBe('stop-then-new')
    // outside a resume the admission words stay (setup's "confirm again with what is true now")
    expect(studioRefusal(new ApiError(409, 'model_drift', 'x')).words).toMatch(/Confirm again with what is true now/)
  })
  it('the stop-progress line shows only while BOTH the session and its stop record are stopping', () => {
    expect(stopProgressWords('stopping', { state: 'stopping', in_flight: 1, cancel_ack: null })).toMatch(/^Stopping/)
    expect(stopProgressWords('stopped', { state: 'stopping', in_flight: 0, cancel_ack: null })).toBeNull()
    expect(stopProgressWords('stopping', { state: 'stopped', in_flight: 0, cancel_ack: null })).toBeNull()
  })
  it('the host’s stop words keep their last sentence (the administrator line) even past the bound', () => {
    const long = `Studio's mind couldn't be stopped. (${'x'.repeat(1500)}) An administrator must stop the process.`
    const w = hostWords(long)!
    expect(w.endsWith('An administrator must stop the process.')).toBe(true)
    expect(w.length).toBeLessThan(1000)
    expect(hostWords('short words.')).toBe('short words.')
    // and the ledger reader uses it for the stop view's message
    const l = readLedger({ session_id: 'ss_a', stream_id: 'as_aaaaaaaaaaaaaaaaaaaaaaaa', state: 'stopping', ask_turn_id: 'op_a', goal_id: 'g_a', proposal_artifact_id: 'ar_p', maker_id: 'a_m', swarm_id: 's_x', program_id: 'omegadesign', budget: {}, directions: [], steps: [], stop: { state: 'stopping', message: long, stop_failed: true, finish_stopping: true } }, 'ss_a')!
    expect(l.stop.message?.endsWith('An administrator must stop the process.')).toBe(true)
  })
  it('after "also queue", the original’s fate follows its host state (cancelled never says "still active")', () => {
    expect(alsoQueuedWords('cancelled')).toMatch(/never read by the maker: Stop cancelled it/)
    expect(alsoQueuedWords('cancelled')).not.toMatch(/still active/)
    expect(alsoQueuedWords('read')).toMatch(/already read the original/)
    expect(alsoQueuedWords('queued')).toMatch(/still active/)
  })
  it('R6.2 maker-side `studio_already_started=possible` never changes what the person’s page reads', () => {
    const base = { session_id: 'ss_a', stream_id: 'as_aaaaaaaaaaaaaaaaaaaaaaaa', state: 'active', ask_turn_id: 'op_a', goal_id: 'g_a', proposal_artifact_id: 'ar_p', maker_id: 'a_m', swarm_id: 's_x', program_id: 'omegadesign', budget: {}, stop: { state: null }, directions: [],
      steps: [{ n: 1, state: 'finished', proposal_revision: 1, proposal_digest: `sha256:${H('1')}` }] }
    const extra = { ...base, studio_already_started: 'possible', steps: [{ ...base.steps[0], studio_already_started: 'possible', already_published: true }] }
    expect(readLedger(extra, 'ss_a')).toEqual(readLedger(base, 'ss_a'))
    const ev = { type: 'studio.step', session_id: 'ss_a', step: 1, phase: 'published', proposal_revision: 1 }
    expect(readStudioEvent({ ...ev, studio_already_started: 'possible' })).toEqual(readStudioEvent(ev))
  })
})
