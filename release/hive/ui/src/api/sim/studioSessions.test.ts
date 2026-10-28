import { describe, expect, it } from 'vitest'
import { SimStudioHost } from './studioSessions'
import { headroom } from '../../features/studioLive/cost'

/** SIM ONLY (J3 r4.3 O3): the invented session host conserves money across a Stop with a call in flight. */
function host(hold: boolean) {
  const timers: (() => void)[] = []
  const h = new SimStudioHost({ emit: () => undefined, later: (_ms, fn) => { timers.push(fn) }, now: () => '2026-10-18T00:00:00Z', principal: () => 'user:p_inv', flags: { monthlyMissing: false, rollover: false, speed: 1, hold } })
  const run = (n = 1) => { for (let i = 0; i < n; i++) { const t = timers.splice(0); t.forEach((f) => f()) } }
  return { h, run }
}
type L = { budget: { spent: number; held: number; unknown: number }; stop: { state: string; in_flight: number; unknown_usd: number }; steps: { n: number; state: string }[] }

describe('SimStudioHost Stop with a held in-flight call', () => {
  it('moves exactly the held amount to unknown: spent + held + unknown is conserved', () => {
    const { h, run } = host(true)
    const p = h.setupProposal('omegadesign', 's_forge') as { operation_id: string; request: Record<string, unknown>; consent_digest: string }
    const it1 = h.recordIntent(p.operation_id, { kind: 'studio.session', request: { ...p.request, consent_digest: p.consent_digest } }) as { intent_id: string }
    const a = h.submitIntent(it1.intent_id) as { session_id: string }
    // step 1 waits for the first acknowledged upload from the current mount (host plan S4.4)
    const sid = a.session_id
    const m = h.mountSession(sid, { expected_epoch: null, receiver_generation: 1, stream_id: (h.ledger(sid) as { stream_id: string }).stream_id, mount_id: 'm1_invented', attempt_id: 'att_invented_1' }) as { mount_token: string; mount_epoch: number }
    h.piece(sid, { seq: 1, body: '{"invented":1}', scene_ref: { scene_id: 'sim-poster', revision: 1, digest: `sha256:${'0'.repeat(64)}` }, edit_generation: 1, mount_token: m.mount_token, mount_epoch: m.mount_epoch, receiver_generation: 1 })
    run(1)            // step 1 admitted: its paid call is in flight (held)
    const before = h.ledger(a.session_id) as unknown as L
    expect(before.steps.length).toBeGreaterThan(0)
    const total0 = before.budget.spent + before.budget.held + before.budget.unknown
    h.control(a.session_id, { control_id: 'stop_inv', action: 'stop' })
    run(3)
    const after = h.ledger(a.session_id) as unknown as L
    const total1 = after.budget.spent + after.budget.held + after.budget.unknown
    expect(after.stop.state).toBe('stopped')
    expect(after.budget.held).toBe(0)
    expect(Math.round(total1 * 100)).toBe(Math.round(total0 * 100))
    expect(after.budget.unknown).toBe(before.budget.held)
    expect(after.budget.unknown).toBeGreaterThan(0)
  })
  it('monthly headroom is unchanged across Stop: the unsettled amount stays in the monthly held total', () => {
    const { h, run } = host(true)
    const p = h.setupProposal('omegadesign', 's_forge') as { operation_id: string; request: Record<string, unknown>; consent_digest: string }
    const it1 = h.recordIntent(p.operation_id, { kind: 'studio.session', request: { ...p.request, consent_digest: p.consent_digest } }) as { intent_id: string }
    const a = h.submitIntent(it1.intent_id) as { session_id: string }
    const sid = a.session_id
    const m = h.mountSession(sid, { expected_epoch: null, receiver_generation: 1, stream_id: (h.ledger(sid) as { stream_id: string }).stream_id, mount_id: 'm1_invented', attempt_id: 'att_invented_1' }) as { mount_token: string; mount_epoch: number }
    h.piece(sid, { seq: 1, body: '{"invented":1}', scene_ref: { scene_id: 'sim-poster', revision: 1, digest: `sha256:${'0'.repeat(64)}` }, edit_generation: 1, mount_token: m.mount_token, mount_epoch: m.mount_epoch, receiver_generation: 1 })
    run(1)
    type Row = { scope: string; limit: number; spent: number; held: number; unknown: number; period: string }
    const month = () => (h.ledger(a.session_id) as unknown as { budget: { monthly: Row[] } }).budget.monthly[0]
    const before = month()
    expect(before.held).toBeGreaterThan(0)
    h.control(a.session_id, { control_id: 'stop_inv2', action: 'stop' })
    run(3)
    const after = month()
    expect(after.unknown).toBeGreaterThan(0)
    expect(headroom(after)).toBe(headroom(before))
  })
  it('Kimi K4: op_ids are never reused across steps (the sim asserts it; read back from the published bodies)', () => {
    const { h, run } = host(false)
    const p = h.setupProposal('omegadesign', 's_forge') as { operation_id: string; request: Record<string, unknown>; consent_digest: string }
    const it1 = h.recordIntent(p.operation_id, { kind: 'studio.session', request: { ...p.request, consent_digest: p.consent_digest } }) as { intent_id: string }
    const sid = (h.submitIntent(it1.intent_id) as { session_id: string }).session_id
    const m = h.mountSession(sid, { expected_epoch: null, receiver_generation: 1, stream_id: (h.ledger(sid) as { stream_id: string }).stream_id, mount_id: 'm1_invented', attempt_id: 'att_invented_1' }) as { mount_token: string; mount_epoch: number }
    const mf = { mount_token: m.mount_token, mount_epoch: m.mount_epoch, receiver_generation: 1 }
    const ref = { scene_id: 'sim-poster', revision: 1, digest: `sha256:${'0'.repeat(64)}` }
    h.piece(sid, { seq: 1, body: '{"invented":1}', scene_ref: ref, edit_generation: 1, ...mf })
    const ids: string[] = []
    for (let n = 1; n <= 3; n++) {
      run(2)   // admit, then the maker publishes
      const l = h.ledger(sid) as unknown as { proposal_artifact_id: string; steps: { n: number; proposal_revision: number; proposal_digest: string }[] }
      const st = l.steps.find((x) => x.n === n)!
      const body = (h.readProposal({ artifact_id: l.proposal_artifact_id, revision: st.proposal_revision, digest: st.proposal_digest }) as { result: { body: string } }).result.body
      const mine = (JSON.parse(body) as { items: { op_id: string }[] }).items.map((i) => i.op_id)
      ids.push(...mine)
      h.outcome(sid, n, { proposal: { artifact_id: l.proposal_artifact_id, revision: st.proposal_revision, digest: st.proposal_digest }, outcome: 'applied', piece_before: ref, piece_after: ref, receipt_digest: 'e'.repeat(64), piece_upload: { seq: 1, body_sha256: (h.ledger(sid) as { piece_custody: { latest: { body_sha256: string } } }).piece_custody.latest.body_sha256, scene_ref: ref, edit_generation: 1 }, op_ids: mine, ...mf })
    }
    expect(ids.length).toBeGreaterThan(3)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('r1.5: the sim host enforces host R4 L6 (studio_gateway op_ids_check / op_ids_outcome)', () => {
  /** one session with step 1 published by the sim maker (its op ids declared), mounted, with an acknowledged piece */
  function published() {
    const { h, run } = host(false)
    const p = h.setupProposal('omegadesign', 's_forge') as { operation_id: string; request: Record<string, unknown>; consent_digest: string }
    const it1 = h.recordIntent(p.operation_id, { kind: 'studio.session', request: { ...p.request, consent_digest: p.consent_digest } }) as { intent_id: string }
    const sid = (h.submitIntent(it1.intent_id) as { session_id: string }).session_id
    const m = h.mountSession(sid, { expected_epoch: null, receiver_generation: 1, stream_id: (h.ledger(sid) as { stream_id: string }).stream_id, mount_id: 'm1_invented', attempt_id: 'att_invented_1' }) as { mount_token: string; mount_epoch: number }
    const mf = { mount_token: m.mount_token, mount_epoch: m.mount_epoch, receiver_generation: 1 }
    const ref = { scene_id: 'sim-poster', revision: 1, digest: `sha256:${'0'.repeat(64)}` }
    h.piece(sid, { seq: 1, body: '{"invented":1}', scene_ref: ref, edit_generation: 1, ...mf })
    run(2)
    const l = h.ledger(sid) as unknown as { proposal_artifact_id: string; piece_custody: { latest: { body_sha256: string } }; steps: { n: number; proposal_revision: number; proposal_digest: string; op_ids: string[] | null }[] }
    const st = l.steps[0]
    const body = (extra: Record<string, unknown>) => ({ proposal: { artifact_id: l.proposal_artifact_id, revision: st.proposal_revision, digest: st.proposal_digest }, outcome: 'applied', piece_before: ref, piece_after: ref, receipt_digest: 'e'.repeat(64), piece_upload: { seq: 1, body_sha256: l.piece_custody.latest.body_sha256, scene_ref: ref, edit_generation: 1 }, ...mf, ...extra })
    return { h, sid, declared: st.op_ids!, body }
  }
  const code = (f: () => unknown) => { try { f(); return 'ok' } catch (e) { return `${(e as { status: number }).status} ${(e as { code: string }).code}` } }
  it('the step view exposes the declared op ids', () => {
    const { declared } = published()
    expect(declared.length).toBeGreaterThan(0)
  })
  it('a validated outcome without op_ids is 400 bad_request; `invalid` without them is accepted', () => {
    const a = published()
    for (const outcome of ['applied', 'refused', 'accepted-no-source-change']) expect(code(() => a.h.outcome(a.sid, 1, a.body({ outcome })))).toBe('400 bad_request')
    const b = published()
    expect(code(() => b.h.outcome(b.sid, 1, b.body({ outcome: 'invalid' })))).toBe('ok')
  })
  it('a different set is 409 op_ids_mismatch (nothing recorded); the same set in another order is accepted', () => {
    const a = published()
    expect(code(() => a.h.outcome(a.sid, 1, a.body({ op_ids: [...a.declared, 'extra-1'] })))).toBe('409 op_ids_mismatch')
    expect((a.h.ledger(a.sid) as unknown as { steps: { outcome: string | null }[] }).steps[0].outcome).toBeNull()
    expect(code(() => a.h.outcome(a.sid, 1, a.body({ op_ids: [...a.declared].reverse() })))).toBe('ok')
  })
  it('a malformed list (duplicates) is 400 bad_request', () => {
    const a = published()
    expect(code(() => a.h.outcome(a.sid, 1, a.body({ op_ids: [a.declared[0], a.declared[0]] })))).toBe('400 bad_request')
  })
  it('a reused op id is refused at declaration: 409 op_id_reused, nothing recorded', () => {
    const a = published()
    expect(code(() => a.h.declareOpIds(a.sid, 1, [a.declared[0]]))).toBe('409 op_id_reused')
    expect((a.h.ledger(a.sid) as unknown as { steps: { op_ids: string[] }[] }).steps[0].op_ids).toEqual(a.declared)
  })
})

describe('r1.6: the sim host plays host R5 (controls, stop view, directions, steer, admission)', () => {
  type Flags = { hold?: boolean; stopFail?: number; consentDrift?: boolean; fenced?: boolean }
  function session(flags: Flags = {}) {
    const timers: (() => void)[] = []
    const h = new SimStudioHost({ emit: () => undefined, later: (_ms, fn) => { timers.push(fn) }, now: () => '2026-10-19T00:00:00Z', principal: () => 'user:p_inv', flags: { monthlyMissing: false, rollover: false, speed: 1, ...flags } })
    const run = (n = 1) => { for (let i = 0; i < n; i++) { const t = timers.splice(0); t.forEach((f) => f()) } }
    const p = h.setupProposal('omegadesign', 's_forge') as { operation_id: string; request: Record<string, unknown>; consent_digest: string }
    const start = () => {
      const it1 = h.recordIntent(`${p.operation_id}_${Math.random().toString(36).slice(2, 8)}`, { kind: 'studio.session', request: { ...p.request, consent_digest: p.consent_digest } }) as { intent_id: string }
      return (h.submitIntent(it1.intent_id) as { session_id: string }).session_id
    }
    const sid = start()
    return { h, run, sid, op: (h.ledger(sid) as { ask_turn_id: string }).ask_turn_id, start }
  }
  const code = (f: () => unknown) => { try { f(); return 'ok' } catch (e) { return `${(e as { status: number }).status} ${(e as { code: string }).code}` } }
  const ctl = (h: SimStudioHost, sid: string, action: string, id = `c_${action}_${Math.random().toString(36).slice(2, 8)}`) => h.control(sid, { control_id: id, action })
  type V = { state: string; state_reason: string | null; stop: Record<string, unknown>; directions: { state: string }[] }
  const view = (h: SimStudioHost, sid: string) => h.ledger(sid) as unknown as V
  it('pause from active (reason paused_by_person), idempotent; from a stopped session 409 not_active', () => {
    const { h, sid } = session()
    expect((ctl(h, sid, 'pause') as { state: string }).state).toBe('paused')
    expect(view(h, sid).state_reason).toBe('paused_by_person')
    expect(code(() => ctl(h, sid, 'pause'))).toBe('ok')
    ctl(h, sid, 'stop')
    expect(code(() => ctl(h, sid, 'pause'))).toBe('409 not_active')
  })
  it('resume: only from paused; held → not_paused, stopping → studio_stopping, window → window_ended, consent → consent_mismatch (left paused)', () => {
    const a = session()
    a.h.simulate(a.sid, 'held')
    expect(code(() => ctl(a.h, a.sid, 'resume'))).toBe('409 not_paused')
    const b = session({ stopFail: 1 })
    ctl(b.h, b.sid, 'stop')
    expect(code(() => ctl(b.h, b.sid, 'resume'))).toBe('409 studio_stopping')
    const c = session()
    ctl(c.h, c.sid, 'pause'); c.h.simulate(c.sid, 'window-ended')
    expect(code(() => ctl(c.h, c.sid, 'resume'))).toBe('409 window_ended')
    const d = session()
    ctl(d.h, d.sid, 'pause'); d.h.simulate(d.sid, 'consent-drift')
    expect(code(() => ctl(d.h, d.sid, 'resume'))).toBe('409 consent_mismatch')
    expect(view(d.h, d.sid).state).toBe('paused')
    const e = session()
    ctl(e.h, e.sid, 'pause')
    expect((ctl(e.h, e.sid, 'resume') as { state: string }).state).toBe('active')
  })
  it('a control id is idempotent: the same body answers the recorded result; another body 409 operation_conflict', () => {
    const { h, sid } = session()
    const first = ctl(h, sid, 'pause', 'c_same_00001')
    expect(ctl(h, sid, 'pause', 'c_same_00001')).toEqual(first)
    expect(code(() => ctl(h, sid, 'resume', 'c_same_00001'))).toBe('409 operation_conflict')
  })
  it('Stop: the R5 stop view (fenced_at, in_flight, unknown_usd, cancel_ack) and queued directions become cancelled', () => {
    const { h, sid, op } = session()
    h.steer(op, { steer_id: 'st_inv_00001', text: 'warmer', at_seq: 0, via: 'typed' })
    const r = ctl(h, sid, 'stop') as { stop: Record<string, unknown> }
    expect(r.stop.fenced_at).toBe('2026-10-19T00:00:00Z')
    expect([r.stop.in_flight, r.stop.unknown_usd, r.stop.cancel_ack]).toEqual([0, 0, 'pending'])
    expect(view(h, sid).directions.map((d) => d.state)).toEqual(['cancelled'])
  })
  it('a steer on a stopping or stopped session is 409 studio_session_closed and writes nothing; paused/held queue and say so', () => {
    const a = session()
    ctl(a.h, a.sid, 'pause')
    const ans = a.h.steer(a.op, { steer_id: 'st_inv_00002', text: 'bigger', at_seq: 0, via: 'typed' }) as { studio: Record<string, unknown> }
    expect(ans.studio).toEqual({ session_id: a.sid, seq: 1, state: 'queued', session_state: 'paused' })
    expect(a.h.steer(a.op, { steer_id: 'st_inv_00002', text: 'bigger', at_seq: 0, via: 'typed' })).toEqual(ans)   // replayed byte for byte
    ctl(a.h, a.sid, 'stop')
    expect(code(() => a.h.steer(a.op, { steer_id: 'st_inv_00003', text: 'more', at_seq: 0, via: 'typed' }))).toBe('409 studio_session_closed')
    expect(view(a.h, a.sid).directions.length).toBe(1)
  })
  it('a parked Stop offers one finish_stopping; with ?studiostopfail=2 it parks again and the host words name the administrator', () => {
    const one = session({ stopFail: 1 })
    ctl(one.h, one.sid, 'stop')
    expect(view(one.h, one.sid).stop.finish_stopping).toBe(true)
    ctl(one.h, one.sid, 'finish_stopping')
    expect(view(one.h, one.sid).state).toBe('stopped')
    const two = session({ stopFail: 2 })
    ctl(two.h, two.sid, 'stop')
    ctl(two.h, two.sid, 'finish_stopping')
    const v = view(two.h, two.sid)
    expect(v.state).toBe('stopping')
    expect(String(v.stop.message)).toMatch(/An administrator must stop the process\./)
  })
  it('admission (R5 E2a): a second live session for the person is refused; a fenced maker run is 409 execution_fenced', () => {
    const a = session()
    expect(code(() => a.start())).toBe('409 person_session_live')
    ctl(a.h, a.sid, 'stop')
    expect(code(() => a.start())).toBe('ok')
    expect(code(() => session({ fenced: true }))).toBe('409 execution_fenced')
  })
})

describe('r1.7: the sim host plays R6.2 and OI-13', () => {
  type Flags = { keyNone?: boolean; makerKind?: string }
  function host2(flags: Flags = {}) {
    const timers: (() => void)[] = []
    const h = new SimStudioHost({ emit: () => undefined, later: (_ms, fn) => { timers.push(fn) }, now: () => '2026-10-19T00:00:00Z', principal: () => 'user:p_inv', flags: { monthlyMissing: false, rollover: false, speed: 1, ...flags } })
    const run = (n = 1) => { for (let i = 0; i < n; i++) { const t = timers.splice(0); t.forEach((f) => f()) } }
    const p = h.setupProposal('omegadesign', 's_forge') as { operation_id: string; request: Record<string, unknown>; consent_digest: string }
    const it1 = h.recordIntent(p.operation_id, { kind: 'studio.session', request: { ...p.request, consent_digest: p.consent_digest } }) as { intent_id: string }
    return { h, run, submit: () => h.submitIntent(it1.intent_id) as { session_id: string } }
  }
  const code = (f: () => unknown) => { try { f(); return 'ok' } catch (e) { return `${(e as { status: number }).status} ${(e as { code: string }).code}` } }
  it('?studiokey=none: 402 own_key_needed at SETUP (host R7, scope studio_maker) before anything is shown or created', () => {
    const timers: (() => void)[] = []
    const h = new SimStudioHost({ emit: () => undefined, later: (_ms, fn) => { timers.push(fn) }, now: () => '2026-10-19T00:00:00Z', principal: () => 'user:p_inv', flags: { monthlyMissing: false, rollover: false, speed: 1, keyNone: true } })
    let env: Record<string, unknown> = {}
    expect(code(() => { try { return h.setupProposal('omegadesign', 's_forge') } catch (e) { env = (e as { envelope: Record<string, unknown> }).envelope; throw e } })).toBe('402 own_key_needed')
    expect(env.scope).toBe('studio_maker')
    h.addOwnKey()
    expect(code(() => h.setupProposal('omegadesign', 's_forge'))).toBe('ok')
  })
  it('?studiomaker=iter: 409 maker_kind_unsupported, nothing created; an omega maker is admitted', () => {
    expect(code(() => host2({ makerKind: 'iter' }).submit())).toBe('409 maker_kind_unsupported')
    expect(code(() => host2({ makerKind: 'omega' }).submit())).toBe('ok')
  })
  it('a second publish by the same execution answers the existing proposal: no new revision', () => {
    const a = host2()
    const sid = a.submit().session_id
    const m = a.h.mountSession(sid, { expected_epoch: null, receiver_generation: 1, stream_id: (a.h.ledger(sid) as { stream_id: string }).stream_id, mount_id: 'm1_invented', attempt_id: 'att_invented_1' }) as { mount_token: string; mount_epoch: number }
    a.h.piece(sid, { seq: 1, body: '{"invented":1}', scene_ref: { scene_id: 'sim-poster', revision: 1, digest: `sha256:${'0'.repeat(64)}` }, edit_generation: 1, mount_token: m.mount_token, mount_epoch: m.mount_epoch, receiver_generation: 1 })
    a.run(2)
    const before = a.h.ledger(sid) as unknown as { steps: { proposal_revision: number; proposal_digest: string; op_ids: string[] }[] }
    const again = a.h.republish(sid, 1) as { revision: number; digest: string; op_ids: string[]; already_published: boolean }
    expect(again).toEqual({ revision: before.steps[0].proposal_revision, digest: before.steps[0].proposal_digest, op_ids: before.steps[0].op_ids, already_published: true })
    const after = a.h.ledger(sid) as unknown as { steps: { proposal_revision: number }[] }
    expect(after.steps.map((x) => x.proposal_revision)).toEqual(before.steps.map((x) => x.proposal_revision))
  })
})

describe('r1.8: the sim host resolves the key, model and payer at admission (key_drift before consent)', () => {
  function world(keyNone = false) {
    const h = new SimStudioHost({ emit: () => undefined, later: () => undefined, now: () => '2026-10-19T00:00:00Z', principal: () => 'user:p_inv', flags: { monthlyMissing: false, rollover: false, speed: 1, keyNone } })
    const card = () => h.setupProposal('omegadesign', 's_forge') as { operation_id: string; request: Record<string, unknown>; consent_digest: string }
    const submit = (p: ReturnType<typeof card>) => {
      const it1 = h.recordIntent(`${p.operation_id}_x`, { kind: 'studio.session', request: { ...p.request, consent_digest: p.consent_digest } }) as { intent_id: string }
      return h.submitIntent(it1.intent_id)
    }
    return { h, card, submit }
  }
  const code = (f: () => unknown) => { try { f(); return 'ok' } catch (e) { return `${(e as { status: number }).status} ${(e as { code: string }).code}` } }
  it('a card shown on one key is key_drift once the resolved key changes (before consent); a fresh card is admitted', () => {
    const a = world()
    const old = a.card()
    a.h.changeWorld({ key: 'k_sim_new', label: 'Your newer key (invented)' })
    expect(code(() => a.submit(old))).toBe('409 key_drift')
    expect(code(() => a.submit(a.card()))).toBe('ok')
  })
  it('R7 shape: the setup answer names the maker and its request carries the host digest (recorded unchanged)', () => {
    const p = world().card() as unknown as { maker: Record<string, unknown>; request: Record<string, unknown>; consent_digest: string; key_label: string; maker_name: string }
    expect(p.maker).toMatchObject({ kind: 'omega', own_key: true })
    expect(p.request.consent_digest).toBe(p.consent_digest)
    expect([p.maker_name, p.key_label]).toEqual(['Bellows', 'Studio key (invented)'])
  })
  it('a model change is model_drift and a payer change payer_mismatch for the card shown before; fresh cards pass', () => {
    const a = world()
    const old = a.card()
    a.h.changeWorld({ model: 'invented-model-9' })
    expect(code(() => a.submit(old))).toBe('409 model_drift')
    const b = world()
    const old2 = b.card()
    b.h.changeWorld({ payer: 'hive_key' })
    expect(code(() => b.submit(old2))).toBe('409 payer_mismatch')
    expect(code(() => b.submit(b.card()))).toBe('ok')
  })
})
