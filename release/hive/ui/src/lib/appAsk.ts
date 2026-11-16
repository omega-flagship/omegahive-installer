import {
  APP_ASK_ACK_MS, APP_ASK_BYTES, APP_ASK_LEASE_MS, APP_ASK_PENDING_BYTES, APP_ASK_RENEW_MS, APP_ASK_SUBSCRIPTIONS,
  askBytes, askInteger, askKeys, askObject, askSelector, readAppAskCard, readAppAskCursor, readAppAskLease,
  readAppAskPoll, readAppAskPresentation, readAppAskSubscription, sameAskCursor,
  type AppAskCard, type AppAskChunk, type AppAskCursor, type AppAskLease, type AppAskOp,
  type AppAskPresentation, type AppAskSubscription,
} from '../api/appAsk'
import { readFrameNotices, readFrameSpend } from '../api/notices'

const TYPES = ['presence', 'handoff', 'ask-send', 'ask-resume', 'ask-subscribe', 'ask-unsubscribe', 'ask-act-claim', 'ask-act-result', 'ask-ack', 'ask-notices', 'ask-spend'] as const
type Type = typeof TYPES[number]
type Request = { type: Type; id: string; channel: string } & Record<string, unknown>
export type AppAskParse = null | { ok: false; id: string | null; code: 'invalid' | 'too_large' } | { ok: true; request: Request }
const wireId = (v: unknown): v is string => typeof v === 'string' && /^[\w.:-]{1,80}$/.test(v)
const forbidden = /^(?:__proto__|constructor|prototype|principal|app_id|program|swarm_id|mind|generation_id|consent_id|consent_epoch|release_digest|token|key|key_id|session|session_ref|authority|confirm_token)$/i
function plain(v: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.length <= 256 && v.every((x) => plain(x, depth + 1))
  return askObject(v) && Object.keys(v).length <= 128 && Object.entries(v).every(([key, value]) => !forbidden.test(key) && plain(value, depth + 1))
}
/** Called only after the existing exact source-window/channel check. Unknown generic ops remain generic. */
export function parseAppAsk(data: unknown): AppAskParse {
  if (!askObject(data) || !TYPES.includes(data.type as Type)) return null
  const id = wireId(data.id) ? data.id : null
  if (askBytes(data) > APP_ASK_BYTES) return { ok: false, id, code: 'too_large' }
  const bad = (): AppAskParse => ({ ok: false, id, code: 'invalid' })
  if (!id || !wireId(data.channel)) return bad()
  const keys: Record<Type, string[]> = {
    presence: ['visible'], handoff: ['operation_id'], 'ask-send': ['text', 'context', 'op_id'],
    'ask-resume': ['operation_id', 'expected_epoch'], 'ask-subscribe': ['operation_id'],
    'ask-unsubscribe': ['subscription_id'], 'ask-act-claim': ['operation_id', 'act_id', 'expected_epoch'], 'ask-act-result': ['operation_id', 'act_id', 'result'], 'ask-ack': ['subscription_id', 'cursor'],
    'ask-notices': ['after'], 'ask-spend': ['days'],
  }
  if (!askKeys(data, ['type', 'id', 'channel', ...keys[data.type as Type]])) return bad()
  switch (data.type) {
    case 'presence': if (typeof data.visible !== 'boolean') return bad(); break
    case 'handoff': case 'ask-subscribe': if (!askSelector(data.operation_id)) return bad(); break
    case 'ask-resume': if (!askSelector(data.operation_id) || !askInteger(data.expected_epoch)) return bad(); break
    case 'ask-send':
      if (!askSelector(data.op_id) || typeof data.text !== 'string' || !data.text.trim() || data.text.length > 4000) return bad()
      if (data.context !== undefined && (!askObject(data.context) || !plain(data.context) || !askKeys(data.context, ['route', 'experience', 'view', 'selection', 'private']) || (data.context.private !== undefined && (data.context.private !== true || Object.keys(data.context).length !== 1)))) return bad()
      break
    case 'ask-unsubscribe': if (!askSelector(data.subscription_id)) return bad(); break
    case 'ask-act-claim': if (!askSelector(data.operation_id) || !askSelector(data.act_id) || !askInteger(data.expected_epoch)) return bad(); break
    case 'ask-act-result':
      if (!askSelector(data.operation_id) || !askSelector(data.act_id) || !askObject(data.result) || !plain(data.result) || !askKeys(data.result, ['ok', 'reason', 'view', 'route', 'experience']) || typeof data.result.ok !== 'boolean' || !askObject(data.result.view) || typeof data.result.route !== 'string' || typeof data.result.experience !== 'string') return bad()
      break
    case 'ask-ack': if (!askSelector(data.subscription_id) || !readAppAskCursor(data.cursor)) return bad(); break
    // G2/G4: the signed-in person's own notices and spend for this app's own context; the host decides whose and where
    case 'ask-notices': if (data.after !== undefined && !askInteger(data.after)) return bad(); break
    case 'ask-spend': if (data.days !== undefined && (!askInteger(data.days) || data.days < 1 || data.days > 31)) return bad(); break
  }
  return { ok: true, request: data as Request }
}

export interface AppAskPort {
  programAskCard(app: string): Promise<unknown>
  programAskConsent(app: string, body: { card_id: string }): Promise<unknown>
  programAskRevoke(app: string): Promise<unknown>
  programAskFrame(app: string, body: { release_digest: string; frame_slot_id: string; initial_operation_id?: string }): Promise<unknown>
  programAskPresence(app: string, generation: string): Promise<unknown>
  programAskClose(app: string, generation: string): Promise<unknown>
  programAskOp(app: string, generation: string, body: AppAskOp): Promise<unknown>
  askPresentation(operation: string): Promise<unknown>
  askClaim(operation: string, body: { expected_epoch: number }): Promise<unknown>
  askHandover(operation: string, body: { generation_id: string; expected_epoch: number }): Promise<unknown>
}
export interface AppAskClock { now(): number; later(fn: () => void, ms: number): unknown; cancel(id: unknown): void }
export interface AppAskState { active: boolean; reason: string | null; resumable: string[] }
interface Sub { value: AppAskSubscription; pending: { chunk: AppAskChunk; bytes: number; expires: number } | null; event: { seq: number; total: number; sha: string } | null; busy: boolean }
export interface AppAskOptions {
  app: string; digest: string; slot: string; channel: string; port: AppAskPort; clock: AppAskClock
  current(): boolean; visible(): boolean
  confirm(card: AppAskCard): Promise<boolean>
  confirmHandoff(operation: string): Promise<boolean>
  hostOperation(): string | null
  state(value: AppAskState): void
  post(value: object): void
  presentation(value: AppAskPresentation, controller: AppAskController, text?: string): boolean | void
  owns(value: AppAskPresentation): boolean
  offered(operation: string, generation: string): void
  track(operation: string): void
}
const CODES = new Set(['not_available', 'consent_required', 'card_changed', 'generation_fenced', 'lease_lapsed', 'handover_required', 'operation_conflict', 'act_result_recorded', 'act_expired', 'too_large', 'invalid', 'rate_limited', 'slow_consumer', 'event_too_large', 'event_unavailable'])
const codeOf = (e: unknown) => e && typeof e === 'object' && 'code' in e && typeof e.code === 'string' && CODES.has(e.code) ? e.code : 'not_available'
const refused = (code = 'not_available'): never => { throw Object.assign(new Error('Ask is unavailable here.'), { code }) }

/** No browser globals or identity credentials. The host supplies visibility/current checks and a bounded clock. */
export class AppAskController {
  private lease: AppAskLease | null = null
  private deadline = 0
  private renewAt = 0
  private serial = 0
  private disposed = false
  private opening: Promise<void> | null = null
  private renewing = false
  private timer: unknown = null
  private subs = new Map<string, Sub>()
  private turns = new Map<string, AppAskPresentation>()
  private pollIndex = 0
  private polling = false
  private tokens = 40
  private inflight = 0
  private tokenAt: number
  constructor(private readonly o: AppAskOptions) { this.tokenAt = o.clock.now() }
  active(): boolean { return !this.disposed && !!this.lease && this.o.current() && this.o.visible() && this.o.clock.now() < this.deadline }
  visibilityChanged(): void { if (this.lease && !this.o.visible()) this.fence('lease_lapsed') }
  private ticket(): { serial: number; generation: string } {
    if (!this.active()) { this.fence('lease_lapsed'); return refused('lease_lapsed') }
    return { serial: this.serial, generation: this.lease!.generation_id }
  }
  private holds(t: { serial: number; generation: string }): boolean { return t.serial === this.serial && t.generation === this.lease?.generation_id && this.active() }
  private remember(value: AppAskPresentation, text?: string): void {
    if (this.turns.size >= 32 && !this.turns.has(value.operation_id)) this.turns.delete(this.turns.keys().next().value!)
    this.turns.set(value.operation_id, value)
    if (this.o.presentation(value, this, text) === false) { this.fence(); return refused('generation_fenced') }
  }
  private update(reason: string | null = null): void { this.o.state({ active: this.active(), reason, resumable: this.lease?.resumable_operations.slice() ?? [] }) }
  /** Local authority is fenced synchronously BEFORE any best-effort close, listener removal or caller teardown. */
  fence(reason = 'generation_fenced'): void {
    const lease = this.lease, closeAsSamePerson = this.o.current()
    this.serial++; this.lease = null; this.deadline = 0; this.renewing = false
    if (this.timer !== null) this.o.clock.cancel(this.timer)
    this.timer = null; this.subs.clear(); this.polling = false
    for (const [op, p] of this.turns) if (lease && p.owner === 'frame' && p.generation_id === lease.generation_id) this.o.offered(op, lease.generation_id)
    this.update(reason)
    if (lease && closeAsSamePerson) void this.o.port.programAskClose(this.o.app, lease.generation_id).catch(() => undefined)
  }
  dispose(): void { this.fence(); this.disposed = true }
  async open(initial?: string): Promise<void> {
    if (this.active() && !initial) return
    if (this.opening) return this.opening
    if (this.disposed || !this.o.current() || !this.o.visible()) return refused()
    if (this.lease) this.fence('lease_lapsed')
    const serial = ++this.serial
    this.opening = this.create(serial, initial).finally(() => { this.opening = null })
    return this.opening
  }
  private async create(serial: number, initial?: string): Promise<void> {
    const valid = () => !this.disposed && serial === this.serial && this.o.current() && this.o.visible()
    let card = readAppAskCard(await this.o.port.programAskCard(this.o.app), this.o.app, this.o.digest)
    if (!valid() || !card) return refused()
    if (!card.consented) {
      if (!card.card_id || !await this.o.confirm(card)) return refused('consent_required')
      if (!valid()) return refused()
      card = readAppAskCard(await this.o.port.programAskConsent(this.o.app, { card_id: card.card_id }), this.o.app, this.o.digest)
      if (!valid() || !card?.consented) return refused('card_changed')
    }
    const began = this.o.clock.now()
    const lease = readAppAskLease(await this.o.port.programAskFrame(this.o.app, { release_digest: this.o.digest, frame_slot_id: this.o.slot, ...(initial ? { initial_operation_id: initial } : {}) }), this.o.digest)
    if (!valid() || !lease || lease.consent_id !== card.consent_id || lease.consent_epoch !== card.consent_epoch || lease.initial_operation_id !== (initial ?? null) || this.o.clock.now() >= began + APP_ASK_LEASE_MS) {
      if (lease && this.o.current()) void this.o.port.programAskClose(this.o.app, lease.generation_id).catch(() => undefined)
      return refused()
    }
    this.lease = lease; this.deadline = began + APP_ASK_LEASE_MS; this.renewAt = began + APP_ASK_RENEW_MS
    this.update(); this.schedule()
    if (initial) {
      const t = this.ticket(), p = readAppAskPresentation(await this.o.port.askPresentation(initial), initial)
      if (!this.holds(t)) return refused('generation_fenced')
      if (p?.owner !== 'frame' || p.generation_id !== lease.generation_id) { this.fence(); return refused() }
      this.remember(p)
    }
  }
  private schedule(): void { if (this.timer === null && !this.disposed) this.timer = this.o.clock.later(() => { this.timer = null; void this.tick() }, 125) }
  private async tick(): Promise<void> {
    if (!this.active()) return this.fence('lease_lapsed')
    const now = this.o.clock.now()
    if ([...this.subs.values()].some((s) => s.pending && s.pending.expires <= now)) return this.fence('slow_consumer')
    if (now >= this.renewAt && !this.renewing) {
      const t = this.ticket(), began = now; this.renewing = true
      // Continue the deadline watchdog while renewal is in flight; late replies never revive a lease.
      this.schedule()
      try {
        const next = readAppAskLease(await this.o.port.programAskPresence(this.o.app, t.generation), this.o.digest)
        if (!this.holds(t)) return
        if (!next || next.generation_id !== t.generation || next.consent_id !== this.lease?.consent_id || next.consent_epoch !== this.lease?.consent_epoch || this.o.clock.now() >= began + APP_ASK_LEASE_MS) return this.fence('lease_lapsed')
        // Preserve the once-handed selector only for this same generation. Renewal does not recopy a thread,
        // and a later fresh generation still starts with the server's null initial selector.
        this.lease = { ...next, initial_operation_id: this.lease!.initial_operation_id }
        this.deadline = began + APP_ASK_LEASE_MS; this.renewAt = began + APP_ASK_RENEW_MS
      } catch { if (this.holds(t)) this.fence('lease_lapsed') } finally { if (t.serial === this.serial) this.renewing = false }
      return
    }
    const blocked = this.polling || [...this.subs.values()].some((s) => s.pending)
    const ready = blocked ? [] : [...this.subs.values()].filter((s) => !s.busy)
    if (ready.length) {
      const s = ready[this.pollIndex++ % ready.length], t = this.ticket(); s.busy = true; this.polling = true
      // Keep the watchdog live across the one globally in-flight poll. One global ACK chunk then blocks all
      // polling until consumed; no concurrent slow responses can accumulate separate chunks.
      this.schedule()
      try {
        const out = readAppAskPoll(await this.o.port.programAskOp(this.o.app, t.generation, { op: 'poll', subscription_id: s.value.subscription_id, cursor: { ...s.value.cursor } }), s.value)
        if (!this.holds(t) || this.subs.get(s.value.subscription_id) !== s) return
        if (!out) return this.fence('invalid')
        if (out.kind === 'chunk') {
          const p = this.turns.get(s.value.operation_id)
          if (!p || p.owner !== 'frame' || p.generation_id !== t.generation || p.epoch !== s.value.presentation.epoch || !this.o.owns(p)) return this.fence()
          if (s.event && (s.event.seq !== out.seq || s.event.total !== out.total_bytes || s.event.sha !== out.sha256)) return this.fence('invalid')
          s.event ??= { seq: out.seq, total: out.total_bytes, sha: out.sha256 }
          const frame = { type: 'ask-event', channel: this.o.channel, subscription_id: s.value.subscription_id, chunk: out }, bytes = askBytes(frame)
          if (bytes > APP_ASK_BYTES || bytes + [...this.subs.values()].reduce((n, x) => n + (x.pending?.bytes ?? 0), 0) > APP_ASK_PENDING_BYTES) return this.fence('slow_consumer')
          s.pending = { chunk: out, bytes, expires: this.o.clock.now() + APP_ASK_ACK_MS }
          this.o.post(frame)
        } else if (out.terminal) {
          await this.op({ op: 'unsubscribe', subscription_id: s.value.subscription_id })
          this.subs.delete(s.value.subscription_id)
        }
      } catch (e) { if (this.holds(t)) this.fence(codeOf(e)) } finally { s.busy = false; if (t.serial === this.serial) this.polling = false }
    }
    this.schedule()
  }
  private async op(body: AppAskOp): Promise<unknown> {
    if (askBytes(body) > APP_ASK_BYTES) return refused('too_large')
    const t = this.ticket(), value = await this.o.port.programAskOp(this.o.app, t.generation, body)
    if (!this.holds(t)) return refused('generation_fenced')
    return value
  }
  private presentation(value: unknown, operation?: string, text?: string): AppAskPresentation {
    const p = readAppAskPresentation(value, operation)
    if (!p || (p.owner === 'frame' && p.generation_id !== this.lease?.generation_id)) return refused()
    this.remember(p, text); return p
  }
  private known(operation: string): boolean { return this.turns.has(operation) || this.lease?.resumable_operations.includes(operation) === true }
  hostClaimed(p: AppAskPresentation): void {
    if (p.owner !== 'host' || !this.o.current()) return
    this.remember(p)
    for (const [id, s] of this.subs) if (s.value.operation_id === p.operation_id) this.subs.delete(id)
  }
  async handback(operation: string): Promise<AppAskPresentation> {
    if (!this.o.current() || this.disposed || !this.known(operation) || !await this.o.confirmHandoff(operation) || !this.o.current() || this.disposed) return refused('handover_required')
    // A host modal may suspend the old visible lease. The person's explicit handback uses a fresh generation,
    // never an old heartbeat or an automatic resume of a host-active turn.
    await this.open()
    const t = this.ticket(), p = readAppAskPresentation(await this.o.port.askPresentation(operation), operation)
    if (!this.holds(t) || !p) return refused('handover_required')
    const out = await this.o.port.askHandover(operation, { generation_id: t.generation, expected_epoch: p.epoch })
    if (!this.holds(t)) return refused()
    return this.presentation(out, operation)
  }
  /** Called only from the trusted host button; the frame never supplies the initial operation selector. */
  async showCurrent(): Promise<void> {
    const operation = this.o.hostOperation()
    if (!operation || !this.o.current() || this.disposed) return refused('handover_required')
    // A reloaded controller must learn this consent's resumable membership before classifying the current turn.
    // Opening without an initial selector grants no authority over an arbitrary host operation.
    await this.open()
    if (!this.o.current() || this.disposed || this.o.hostOperation() !== operation) return refused('handover_required')
    if (operation && this.known(operation)) { await this.handback(operation); return }
    await this.initialHandoff()
  }
  async initialHandoff(): Promise<void> {
    const operation = this.o.hostOperation()
    if (!operation || !this.o.current() || !await this.o.confirmHandoff(operation) || !this.o.current() || this.o.hostOperation() !== operation) return refused('handover_required')
    this.o.track(operation)
    this.fence(); await this.open(operation)
  }
  async revoke(): Promise<void> { this.fence(); if (this.o.current()) await this.o.port.programAskRevoke(this.o.app) }
  async receive(data: unknown): Promise<object | null> {
    const parsed = parseAppAsk(data)
    if (!parsed) return null
    if (!parsed.ok) return parsed.id ? { type: 'app-reply', id: parsed.id, ok: false, error: 'Ask request could not be read.', code: parsed.code } : null
    const m = parsed.request
    const arrivedSerial = this.serial
    const localControl = m.type === 'ask-ack' || m.type === 'presence' && m.visible === false
    if (this.inflight >= 8 && !localControl) return { type: 'app-reply', id: m.id, ok: false, error: 'Ask is busy here. Try again after this request settles.', code: 'rate_limited' }
    this.inflight++
    try {
      const now = this.o.clock.now(); this.tokens = Math.min(40, this.tokens + Math.max(0, now - this.tokenAt) * .02); this.tokenAt = now
      if (this.tokens < 1) return refused('rate_limited')
      this.tokens--
      if (!this.o.current() || this.disposed) return refused()
      let result: unknown
      switch (m.type) {
        case 'presence':
          if (!m.visible) { this.fence(); result = { active: false }; break }
          await this.open(); this.ticket()
          result = { active: true, resumable_operations: this.lease!.resumable_operations, initial_operation_id: this.lease!.initial_operation_id }; break
        case 'handoff': {
          const op = m.operation_id as string
          const p = this.turns.get(op), t = this.ticket()
          if (!p || p.owner !== 'frame' || p.generation_id !== t.generation || !this.o.owns(p)) return refused('handover_required')
          // A frame can yield only its own already-bound turn. It cannot select the host's initial turn,
          // prove a person gesture, create a generation or transfer ownership back into itself.
          for (const [id, s] of this.subs) if (s.value.operation_id === op) this.subs.delete(id)
          const next = readAppAskPresentation(await this.op({ op: 'yield', operation_id: op }), op)
          if (!next || next.turn_id !== p.turn_id || next.owner !== 'host' || next.generation_id !== null || next.host_active || next.epoch <= p.epoch) return refused('generation_fenced')
          this.remember(next); result = next
          break
        }
        case 'ask-send': {
          const r = await this.op({ op: 'send', text: m.text as string, op_id: m.op_id as string, ...(m.context ? { context: m.context as Record<string, unknown> } : {}) })
          if (!askObject(r) || !askKeys(r, ['operation_id', 'turn_id', 'new_turn', 'presentation']) || !askSelector(r.operation_id) || !askSelector(r.turn_id) || typeof r.new_turn !== 'boolean') return refused()
          const p = readAppAskPresentation(r.presentation, r.operation_id)
          if (!p || p.turn_id !== r.turn_id) return refused('generation_fenced')
          // A steer/replay is not proof of the original question; retain its placeholder if those words are lost.
          result = { operation_id: r.operation_id, turn_id: r.turn_id, new_turn: r.new_turn, presentation: this.presentation(p, r.operation_id, r.new_turn ? m.text as string : undefined) }; break
        }
        case 'ask-resume': result = this.presentation(await this.op({ op: 'resume', operation_id: m.operation_id as string, expected_epoch: m.expected_epoch as number }), m.operation_id as string); break
        case 'ask-subscribe': {
          if (this.subs.size >= APP_ASK_SUBSCRIPTIONS) return refused('rate_limited')
          const t = this.ticket(), s = readAppAskSubscription(await this.op({ op: 'subscribe', operation_id: m.operation_id as string }), m.operation_id as string, t.generation)
          if (!s) return refused()
          this.remember(s.presentation)
          const existing = this.subs.get(s.subscription_id)
          if (existing && existing.value.operation_id !== s.operation_id) { this.fence('invalid'); return refused() }
          // Idempotent subscribe cannot discard an unacknowledged chunk or reset its watchdog.
          if (!existing) this.subs.set(s.subscription_id, { value: s, pending: null, event: null, busy: false })
          result = existing?.value ?? s; break
        }
        case 'ask-unsubscribe': {
          this.subs.delete(m.subscription_id as string)
          const r = await this.op({ op: 'unsubscribe', subscription_id: m.subscription_id as string })
          if (!askObject(r) || !askKeys(r, ['unsubscribed']) || r.unsubscribed !== true) return refused()
          result = { unsubscribed: true }; break
        }
        case 'ask-act-result': {
          const p = this.turns.get(m.operation_id as string)
          if (!p || p.owner !== 'frame' || p.generation_id !== this.ticket().generation || !this.o.owns(p)) return refused('act_expired')
          const r = await this.op({ op: 'act-result', operation_id: m.operation_id as string, act_id: m.act_id as string, result: m.result as Record<string, unknown> })
          if (!this.o.owns(p)) return refused('act_expired')
          if (!askObject(r) || !askKeys(r, ['act_id', 'recorded']) || r.act_id !== m.act_id || r.recorded !== true) return refused()
          result = { act_id: r.act_id, recorded: true }; break
        }
        case 'ask-act-claim': {
          const p = this.turns.get(m.operation_id as string)
          if (!p || p.owner !== 'frame' || p.generation_id !== this.ticket().generation || p.epoch !== m.expected_epoch || !this.o.owns(p)) return refused('act_expired')
          const r = await this.op({ op: 'act-claim', operation_id: m.operation_id as string, act_id: m.act_id as string, expected_epoch: m.expected_epoch as number })
          if (!this.o.owns(p)) return refused('act_expired')
          if (!askObject(r) || !askKeys(r, ['act_id', 'claimed']) || r.act_id !== m.act_id || r.claimed !== true) return refused('act_expired')
          result = { act_id: r.act_id, claimed: true }; break
        }
        case 'ask-notices': {
          const r = readFrameNotices(await this.op({ op: 'notices', ...(m.after !== undefined ? { after: m.after as number } : {}) }))
          if (!r) return refused()
          result = r; break
        }
        case 'ask-spend': {
          const r = readFrameSpend(await this.op({ op: 'spend', ...(m.days !== undefined ? { days: m.days as number } : {}) }))
          if (!r) return refused()
          result = r; break
        }
        case 'ask-ack': {
          this.ticket()
          const s = this.subs.get(m.subscription_id as string), cursor = m.cursor as AppAskCursor
          if (!s?.pending || s.pending.expires <= now || !sameAskCursor(cursor, s.pending.chunk.next_cursor)) return refused('invalid')
          const terminal = s.pending.chunk.terminal && s.pending.chunk.complete
          const complete = s.pending.chunk.complete
          s.value.cursor = { ...cursor }; s.pending = null
          if (complete) s.event = null
          if (terminal) {
            s.busy = true
            await this.op({ op: 'unsubscribe', subscription_id: s.value.subscription_id })
            this.subs.delete(s.value.subscription_id)
          }
          result = { acknowledged: true }; break
        }
      }
      if (!this.o.current() || this.disposed || (m.type !== 'presence' || m.visible) && !this.active()) return refused('generation_fenced')
      if (askBytes(result) > APP_ASK_BYTES - 256) return refused('too_large')
      return { type: 'app-reply', id: m.id, ok: true, result }
    } catch (e) {
      const code = codeOf(e)
      if (this.serial === arrivedSerial && ['not_available', 'generation_fenced', 'lease_lapsed', 'consent_required', 'card_changed', 'slow_consumer', 'event_too_large', 'event_unavailable'].includes(code)) this.fence(code)
      return { type: 'app-reply', id: m.id, ok: false, error: 'Ask is unavailable here. Return to Ask or check again.', code }
    }
    finally { this.inflight-- }
  }
}
