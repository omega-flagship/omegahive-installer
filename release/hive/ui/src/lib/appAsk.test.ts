import { describe, expect, it } from 'vitest'
import { APP_ASK_EVENT_BYTES, APP_ASK_PENDING_BYTES, admitHostAskAct, askBytes, hostAskPresentationMatches, hostAskRecipient, readAppAskPoll, readAppAskRecipient, type AppAskChunk, type AppAskLease, type AppAskPresentation, type AppAskSubscription } from '../api/appAsk'
import { AppAskController, parseAppAsk, type AppAskClock, type AppAskOptions, type AppAskPort } from './appAsk'

const digest = `sha256:${'a'.repeat(64)}`, channel = '10000000-0000-4000-8000-000000000001'
const wire = <T extends object>(type: string, payload: T) => ({ type, id: 'request-1', channel, ...payload })
const presentation = (operation = 'p1:turn', generation = 'generation-1'): AppAskPresentation => ({ operation_id: operation, turn_id: 'turn-1', owner: 'frame', host_active: false, generation_id: generation, epoch: 1 })
const lease = (initial: string | null = null): AppAskLease => ({ generation_id: 'generation-1', consent_id: 'consent-1', consent_epoch: 1, release_digest: digest, lease_ms: 15000, renew_after_ms: 5000, resumable_operations: [], initial_operation_id: initial })
const subscription = (): AppAskSubscription => ({ subscription_id: 'sub-1', operation_id: 'p1:turn', cursor: { after_seq: 0, offset: 0 }, presentation: presentation() })
const chunk = (): AppAskChunk => ({ kind: 'chunk', subscription_id: 'sub-1', operation_id: 'p1:turn', seq: 1, offset: 0, total_bytes: 1, sha256: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb', data_base64: 'YQ==', next_cursor: { after_seq: 1, offset: 0 }, complete: true, terminal: false })
const defer = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
class Clock implements AppAskClock {
  time = 0; seq = 0; tasks = new Map<number, { at: number; fn(): void }>()
  now = () => this.time
  later = (fn: () => void, ms: number) => { const id = ++this.seq; this.tasks.set(id, { at: this.time + ms, fn }); return id }
  cancel = (id: unknown) => { this.tasks.delete(id as number) }
  async advance(ms: number) {
    const end = this.time + ms
    for (let i = 0; i < 10000; i++) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      this.time = next[1].at; this.tasks.delete(next[0]); next[1].fn()
      for (let n = 0; n < 8; n++) await Promise.resolve()
    }
    this.time = end
  }
}
function rig(overrides: Partial<AppAskPort> = {}) {
  const clock = new Clock(), calls: { kind: string; body?: unknown }[] = [], posted: object[] = [], offered: string[] = [], tracked: string[] = []
  let current = true, visible = true
  const port: AppAskPort = {
    programAskCard: async () => ({ app_id: 'garden', name: 'Garden', version: '1', release_digest: digest, consent_id: 'consent-1', consent_epoch: 1, consented: true, card_id: null, permission: 'may send to and show your Ask while open' }),
    programAskConsent: async () => { throw new Error('unexpected grant') }, programAskRevoke: async () => ({ revoked: true }),
    programAskFrame: async (_app, body) => { calls.push({ kind: 'frame', body }); return lease(body.initial_operation_id ?? null) },
    programAskPresence: async () => { calls.push({ kind: 'renew' }); return lease() },
    programAskClose: async () => { calls.push({ kind: 'close' }); return { fenced: true } },
    programAskOp: async (_app, _generation, body) => {
      calls.push({ kind: body.op, body })
      if (body.op === 'send') return { operation_id: 'p1:turn', turn_id: 'turn-1', new_turn: true, presentation: presentation() }
      if (body.op === 'subscribe') return subscription()
      if (body.op === 'poll') return { kind: 'idle', subscription_id: body.subscription_id, cursor: body.cursor, terminal: false }
      if (body.op === 'act-claim') return { act_id: body.act_id, claimed: true }
      if (body.op === 'act-result') return { act_id: body.act_id, recorded: true }
      if (body.op === 'yield') return { ...presentation(body.operation_id), owner: 'host', generation_id: null, epoch: 2 }
      return { unsubscribed: true }
    },
    askPresentation: async (op) => presentation(op),
    askClaim: async (op) => ({ ...presentation(op), owner: 'host', generation_id: null, host_active: true, epoch: 2 }),
    askHandover: async (op) => presentation(op), ...overrides,
  }
  const options: AppAskOptions = { app: 'garden', digest, channel, slot: 'host-slot', clock, port,
    current: () => current, visible: () => visible, confirm: async () => true, confirmHandoff: async () => true,
    hostOperation: () => 'host:chosen', state: () => undefined, post: (v) => posted.push(v),
    presentation: () => undefined, owns: () => true, offered: (op) => offered.push(op), track: (op) => tracked.push(op) }
  return { c: new AppAskController(options), options, port, clock, calls, posted, offered, tracked, identity: (v: boolean) => { current = v }, visibility: (v: boolean) => { visible = v } }
}

describe('P1 closed bridge and wire bounds', () => {
  it('uses UTF8 bytes at8192/8193 and leaves the generic bridge outside this parser', () => {
    const m = wire('ask-send', { op_id: 'once', text: 'é'.repeat(4000) })
    const remaining = 8192 - askBytes(m)
    const exact = { ...m, text: m.text + 'x'.repeat(Math.max(0, remaining)) }
    // MAX_TEXT4000 is also enforced. A long result tests the independent full-envelope byte edge.
    const r = wire('ask-act-result', { operation_id: 'op', act_id: 'act', result: { ok: true, route: '', experience: 'classic', view: { summary: '' } } })
    r.result.view.summary = 'x'.repeat(8192 - askBytes(r))
    expect(askBytes(r)).toBe(8192); expect(parseAppAsk(r)?.ok).toBe(true)
    r.result.view.summary += 'x'; expect(parseAppAsk(r)).toMatchObject({ ok: false, code: 'too_large' })
    expect(parseAppAsk(exact)?.ok).toBe(false)
    expect(parseAppAsk({ type: 'pick', id: 'x', channel })).toBeNull()
  })
  it('refuses authority injection, unknown fields, nested credentials and nonfinite data before a call', () => {
    for (const payload of [{ principal: 'user:other' }, { generation_id: 'new' }, { release_digest: digest }, { context: { view: { token: 'invented' } } }, { context: { route: 'x', view: { summary: Infinity } } }])
      expect(parseAppAsk(wire('ask-send', { op_id: 'once', text: 'hello', ...payload }))).toMatchObject({ ok: false, code: 'invalid' })
    expect(parseAppAsk(wire('ask-act-claim', { operation_id: 'op', act_id: 'act', expected_epoch: -1 }))).toMatchObject({ ok: false })
  })
  it('requires exact cursor progression, base64 chunk bounds and the same subscription/operation', () => {
    expect(APP_ASK_EVENT_BYTES * 2 + APP_ASK_PENDING_BYTES).toBe(131072) // logical payload contract, not JS heap containment
    expect(readAppAskPoll(chunk(), subscription())).toEqual(chunk())
    for (const change of [{ total_bytes: 61441 }, { offset: 1 }, { operation_id: 'other' }, { next_cursor: { after_seq: 0, offset: 0 } }, { data_base64: 'not base64' }])
      expect(readAppAskPoll({ ...chunk(), ...change }, subscription())).toBeNull()
  })
  it('distinguishes legacy host acts, explicit host/frame recipients and malformed recipients', () => {
    expect(hostAskRecipient(undefined)).toBe(true)
    expect(hostAskRecipient(undefined, true)).toBe(false)
    expect(hostAskRecipient({ kind: 'frame', generation_id: 'g', owner_epoch: 1 })).toBe(false)
    expect(hostAskRecipient({ kind: 'host', generation_id: null, owner_epoch: 1 }, true)).toBe(true)
    expect(readAppAskRecipient({ kind: 'host', generation_id: 'g', owner_epoch: 1 })).toBeNull()
  })
})
describe('P1 host lease and bounded delivery', () => {
  it('never creates a frame from an unbound frame handoff, even if it guesses the current host operation', async () => {
    const r = rig(); await r.c.open(); const before = r.calls.filter((x) => x.kind === 'frame').length
    expect(await r.c.receive(wire('handoff', { operation_id: 'host:chosen' }))).toMatchObject({ ok: false, code: 'handover_required' })
    expect(r.calls.filter((x) => x.kind === 'frame')).toHaveLength(before)
    r.c.dispose()
  })
  it('initial snapshot is derived only by the trusted host button and tracked before frame creation', async () => {
    const r = rig(); await r.c.initialHandoff()
    expect(r.tracked).toEqual(['host:chosen'])
    expect(r.calls.find((x) => x.kind === 'frame')?.body).toMatchObject({ initial_operation_id: 'host:chosen' })
    r.c.dispose()
  })
  it('does not enrich an unknown original question from a successful steer or replay', async () => {
    const text: (string | undefined)[] = []
    const r = rig({ programAskOp: async (_a, _g, body) => body.op === 'send'
      ? { operation_id: 'p1:turn', turn_id: 'turn-1', new_turn: false, presentation: presentation() } : {} })
    r.options.presentation = (_p, _c, words) => { text.push(words) }
    await r.c.open(); expect(await r.c.receive(wire('ask-send', { text: 'Later steer words', op_id: 'later' }))).toMatchObject({ ok: true, result: { new_turn: false } })
    expect(text).toEqual([undefined]); r.c.dispose()
  })
  it('passes question enrichment only for a proved new-turn admission', async () => {
    const text: (string | undefined)[] = [], r = rig()
    r.options.presentation = (_p, _c, words) => { text.push(words) }
    await r.c.open(); expect(await r.c.receive(wire('ask-send', { text: 'Original question', op_id: 'initial' }))).toMatchObject({ ok: true, result: { new_turn: true } })
    expect(text).toEqual(['Original question']); r.c.dispose()
  })
  it('raw handoff yields only its current bound turn without a host gesture or new frame, and stops that turn polling', async () => {
    const r = rig(); let confirms = 0, handbacks = 0
    r.options.confirmHandoff = async () => { confirms++; return true }
    r.port.askHandover = async () => { handbacks++; return presentation() }
    await r.c.open(); await r.c.receive(wire('ask-send', { text: 'hello', op_id: 'once' }))
    await r.c.receive(wire('ask-subscribe', { operation_id: 'p1:turn' })); await r.clock.advance(125)
    const frames = r.calls.filter((x) => x.kind === 'frame').length, polls = r.calls.filter((x) => x.kind === 'poll').length
    expect(await r.c.receive(wire('handoff', { operation_id: 'p1:turn' }))).toMatchObject({ ok: true, result: { operation_id: 'p1:turn', turn_id: 'turn-1', owner: 'host', generation_id: null, host_active: false, epoch: 2 } })
    expect(r.calls.filter((x) => x.kind === 'yield').map((x) => x.body)).toEqual([{ op: 'yield', operation_id: 'p1:turn' }])
    expect(confirms).toBe(0); expect(handbacks).toBe(0); expect(r.calls.filter((x) => x.kind === 'frame')).toHaveLength(frames)
    await r.clock.advance(1000); expect(r.calls.filter((x) => x.kind === 'poll')).toHaveLength(polls); expect(r.c.active()).toBe(true)
    r.c.dispose()
  })
  it('raw handoff refuses stale local ownership without sending yield', async () => {
    const r = rig(); await r.c.open(); await r.c.receive(wire('ask-send', { text: 'hello', op_id: 'once' }))
    r.options.owns = () => false
    expect(await r.c.receive(wire('handoff', { operation_id: 'p1:turn' }))).toMatchObject({ ok: false, code: 'handover_required' })
    expect(r.calls.filter((x) => x.kind === 'yield')).toHaveLength(0); r.c.dispose()
  })
  it('fresh trusted Show current learns consent membership and hands back without a new initial snapshot', async () => {
    const handbacks: object[] = []
    const r = rig({ programAskFrame: async (_app, body) => {
      handbacks.push({ frame: body }); return { ...lease(), resumable_operations: ['host:chosen'] }
    }, askPresentation: async (op) => ({ ...presentation(op), owner: 'host', generation_id: null, host_active: true, epoch: 5 }),
    askHandover: async (op, body) => { handbacks.push({ handback: body }); return { ...presentation(op), epoch: 6 } } })
    await r.c.showCurrent()
    expect(handbacks).toEqual([{ frame: { release_digest: digest, frame_slot_id: 'host-slot' } }, { handback: { generation_id: 'generation-1', expected_epoch: 5 } }])
    expect(r.tracked).toHaveLength(0); r.c.dispose()
  })
  it('fences a late frame-create response and never revives a closed generation', async () => {
    const d = defer<unknown>(), r = rig({ programAskFrame: () => d.promise })
    const opening = r.c.open(); await Promise.resolve(); await Promise.resolve(); r.c.fence()
    d.resolve(lease()); await expect(opening).rejects.toBeDefined(); expect(r.c.active()).toBe(false)
    expect(r.calls.filter((x) => x.kind === 'close')).toHaveLength(1)
  })
  it('keeps expiry running while renewal hangs, and late renewal cannot restore authority', async () => {
    const d = defer<unknown>(), r = rig({ programAskPresence: () => d.promise }); await r.c.open()
    await r.clock.advance(15000); expect(r.c.active()).toBe(false)
    d.resolve(lease()); await Promise.resolve(); await Promise.resolve(); expect(r.c.active()).toBe(false)
    expect(await r.c.receive(wire('ask-send', { op_id: 'same', text: 'hello' }))).toMatchObject({ ok: false })
  })
  it('drops an old renewal success after a new generation opens without closing the new generation', async () => {
    const d = defer<unknown>(); let generations = 0
    const r = rig({ programAskPresence: () => d.promise, programAskFrame: async () => ({ ...lease(), generation_id: `generation-${++generations}` }) })
    await r.c.open(); await r.clock.advance(15000); expect(r.c.active()).toBe(false)
    await r.c.open(); expect(generations).toBe(2); expect(r.c.active()).toBe(true)
    const closes = r.calls.filter((x) => x.kind === 'close').length
    d.resolve(lease()); for (let i = 0; i < 8; i++) await Promise.resolve()
    expect(r.c.active()).toBe(true); expect(r.calls.filter((x) => x.kind === 'close')).toHaveLength(closes)
    r.c.dispose()
  })
  it('fences a still-visible current generation synchronously on leave and cancels its later work', async () => {
    const r = rig(); await r.c.open(); expect(r.options.current()).toBe(true); expect(r.options.visible()).toBe(true)
    r.c.fence(); expect(r.c.active()).toBe(false)
    const calls = r.calls.length; await r.clock.advance(16000); expect(r.calls).toHaveLength(calls)
  })
  it('visibility and identity fences drop delayed replies and offer the same operation', async () => {
    const r = rig(); await r.c.open(); await r.c.receive(wire('ask-send', { text: 'hello', op_id: 'same' }))
    r.visibility(false); r.c.visibilityChanged(); expect(r.offered).toEqual(['p1:turn']); expect(r.c.active()).toBe(false)
    r.identity(false); expect(await r.c.receive(wire('presence', { visible: true }))).toMatchObject({ ok: false })
  })
  it('holds one pending chunk, counts the channel envelope, and suspends a frame that never acknowledges', async () => {
    const r = rig({ programAskOp: async (_a, _g, body) => body.op === 'subscribe' ? subscription() : body.op === 'poll' ? chunk() : { unsubscribed: true } })
    await r.c.open(); await r.c.receive(wire('ask-subscribe', { operation_id: 'p1:turn' }))
    await r.clock.advance(1000); expect(r.posted).toHaveLength(1); expect(r.posted[0]).toMatchObject({ channel, type: 'ask-event' }); expect(askBytes(r.posted[0])).toBeLessThanOrEqual(8192)
    await r.clock.advance(1250); expect(r.c.active()).toBe(false); expect(r.posted).toHaveLength(1)
  })
  it('accepts only the exact pending cursor acknowledgement and frees terminal server state', async () => {
    let unsubscribed = 0
    const r = rig({ programAskOp: async (_a, _g, body) => {
      if (body.op === 'subscribe') return subscription()
      if (body.op === 'poll') return { ...chunk(), terminal: true }
      if (body.op === 'unsubscribe') unsubscribed++
      return { unsubscribed: true }
    } })
    await r.c.open(); await r.c.receive(wire('ask-subscribe', { operation_id: 'p1:turn' })); await r.clock.advance(125)
    expect(await r.c.receive(wire('ask-ack', { subscription_id: 'sub-1', cursor: { after_seq: 2, offset: 0 } }))).toMatchObject({ ok: false })
    expect(await r.c.receive(wire('ask-ack', { subscription_id: 'sub-1', cursor: { after_seq: 1, offset: 0 } }))).toMatchObject({ ok: true })
    expect(unsubscribed).toBe(1); r.c.dispose()
  })
  it('duplicate subscribe cannot reset a pending acknowledgement deadline', async () => {
    const r = rig({ programAskOp: async (_a, _g, body) => body.op === 'subscribe' ? subscription() : body.op === 'poll' ? chunk() : { unsubscribed: true } })
    await r.c.open(); await r.c.receive(wire('ask-subscribe', { operation_id: 'p1:turn' })); await r.clock.advance(1000)
    await r.c.receive(wire('ask-subscribe', { operation_id: 'p1:turn' })); await r.clock.advance(1125)
    expect(r.c.active()).toBe(false); expect(r.posted).toHaveLength(1)
  })
  it('refuses a frame lease from a replaced consent instead of reviving the old request', async () => {
    const r = rig({ programAskFrame: async () => ({ ...lease(), consent_id: 'new-consent', consent_epoch: 2 }) })
    await expect(r.c.open()).rejects.toBeDefined(); expect(r.c.active()).toBe(false)
    expect(r.calls.filter((x) => x.kind === 'close')).toHaveLength(1)
  })
  it('bounds concurrent frame requests and never retries unknown sends under a fresh ID', async () => {
    const d = defer<unknown>(); let sends = 0
    const r = rig({ programAskOp: async (_a, _g, body) => { if (body.op === 'send') { sends++; return d.promise }; return {} } })
    await r.c.open()
    const pending = Array.from({ length: 8 }, (_, i) => r.c.receive(wire('ask-send', { op_id: `once-${i}`, text: 'hello' })))
    expect(await r.c.receive(wire('ask-send', { op_id: 'overflow', text: 'hello' }))).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(sends).toBe(8); r.c.fence()
    d.resolve({ operation_id: 'p1:turn', turn_id: 'turn-1', new_turn: true, presentation: presentation() })
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ ok: false })
    expect(sends).toBe(8)
  })
  it('keeps one globally in-flight poll across multiple subscriptions, with an independent expiry watchdog', async () => {
    const d = defer<unknown>(); let polls = 0
    const r = rig({ programAskOp: async (_a, _g, body) => {
      if (body.op === 'subscribe') return { ...subscription(), subscription_id: body.operation_id, operation_id: body.operation_id, presentation: presentation(body.operation_id) }
      if (body.op === 'poll') { polls++; return d.promise }
      return { unsubscribed: true }
    } })
    await r.c.open()
    for (const operation_id of ['p1:one', 'p1:two']) await r.c.receive(wire('ask-subscribe', { operation_id }))
    await r.clock.advance(1000); expect(polls).toBe(1)
    r.c.fence(); d.resolve({ kind: 'idle', subscription_id: 'p1:one', cursor: { after_seq: 0, offset: 0 }, terminal: false })
    await Promise.resolve(); expect(r.c.active()).toBe(false); expect(r.posted).toHaveLength(0)
  })
  it('refuses the17th subscription before dispatching another host request', async () => {
    let subscriptions = 0
    const r = rig({ programAskOp: async (_a, _g, body) => {
      if (body.op === 'subscribe') { subscriptions++; return { ...subscription(), subscription_id: body.operation_id, operation_id: body.operation_id, presentation: presentation(body.operation_id) } }
      return {}
    } })
    await r.c.open()
    for (let i = 0; i < 16; i++) expect(await r.c.receive(wire('ask-subscribe', { operation_id: `p1:${i}` }))).toMatchObject({ ok: true })
    expect(await r.c.receive(wire('ask-subscribe', { operation_id: 'p1:overflow' }))).toMatchObject({ ok: false, code: 'rate_limited' })
    expect(subscriptions).toBe(16); r.c.dispose()
  })
})
describe('P1 pre-execution host claim', () => {
  it('requires exact host turn, null generation and stamped epoch before and after a delayed claim', async () => {
    const recipient = { kind: 'host' as const, generation_id: null, owner_epoch: 7 }
    let p: AppAskPresentation = { ...presentation('op'), owner: 'host', generation_id: null, host_active: true, epoch: 7 }
    const current = () => hostAskPresentationMatches(p, 'op', 'turn-1', recipient)
    expect(current()).toBe(true)
    for (const change of [{ turn_id: 'different' }, { owner: 'frame' as const, generation_id: 'g' }, { epoch: 8 }]) expect(hostAskPresentationMatches({ ...p, ...change }, 'op', 'turn-1', recipient)).toBe(false)
    const d = defer<unknown>(); let claims = 0, effects = 0
    const result = admitHostAskAct({ recipient, tracked: true, operation: 'op', act: 'act', current, claim: async () => { claims++; return d.promise } })
    p = { ...p, epoch: 8 }; d.resolve({ act_id: 'act', claimed: true })
    if (await result) effects++
    expect(claims).toBe(1); expect(effects).toBe(0)
    expect(await admitHostAskAct({ recipient, tracked: true, operation: 'op', act: 'act', current, claim: async () => { claims++; return { act_id: 'act', claimed: true } } })).toBe(false)
    expect(claims).toBe(1)
  })
  it('never executes a frame recipient or a tracked unstamped legacy act', async () => {
    let claims = 0
    const base = { tracked: true, operation: 'op', act: 'act', current: () => true, claim: async () => { claims++; return { act_id: 'act', claimed: true } } }
    expect(await admitHostAskAct({ ...base, recipient: { kind: 'frame', generation_id: 'g', owner_epoch: 1 } })).toBe(false)
    expect(await admitHostAskAct({ ...base, recipient: undefined })).toBe(false); expect(claims).toBe(0)
  })
  it('has no retry or effect on lost/duplicate/mismatched claim, and rechecks current ownership after await', async () => {
    let calls = 0, current = true
    const base = { tracked: true, operation: 'op', act: 'act', recipient: { kind: 'host' as const, generation_id: null, owner_epoch: 1 }, current: () => current }
    expect(await admitHostAskAct({ ...base, claim: async () => { calls++; throw new Error('unknown') } })).toBe(false); expect(calls).toBe(1)
    expect(await admitHostAskAct({ ...base, claim: async () => ({ act_id: 'other', claimed: true }) })).toBe(false)
    expect(await admitHostAskAct({ ...base, claim: async () => { current = false; return { act_id: 'act', claimed: true } } })).toBe(false)
  })
  it('allows one explicit host claim and refuses a duplicate before a second effect', async () => {
    let claimed = false, effects = 0
    const input = { recipient: { kind: 'host' as const, generation_id: null, owner_epoch: 7 }, tracked: true, operation: 'op', act: 'act', current: () => true,
      claim: async (_op: string, _act: string, body: { owner_epoch: number }) => {
        expect(body.owner_epoch).toBe(7)
        if (claimed) throw new Error('already claimed')
        claimed = true; return { act_id: 'act', claimed: true }
      } }
    if (await admitHostAskAct(input)) effects++
    if (await admitHostAskAct(input)) effects++
    expect(effects).toBe(1)
  })
})
