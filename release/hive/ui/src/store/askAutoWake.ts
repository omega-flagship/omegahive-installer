/** Host delivery boundary for the Ask: native reads and lifecycle effects stay in the store layer. */
import { readMyMind, type MyMind, type AskContext } from '../api/ask'
import { ApiError, type HiveClient } from '../api/client'
import type { Agent, Swarm } from '../api/types'

/** One UI wake-before-send attempt. No grant minting, scheduling or core logic. */
export type WakeGate = 'authority' | 'spending' | 'approval' | 'quiet-hours'
export interface WakeInspection {
  state: 'awake' | 'asleep' | 'starting' | 'unavailable'
  canWake: boolean
  /** Only current native facts may supply a gate; never a text guess. */
  gate?: WakeGate
}
export type WakePhase = 'inspecting' | 'waking' | 'sending'
export type WakeAttemptResult<T> =
  | { kind: 'sent'; value: T }
  | { kind: 'gated'; gate: WakeGate }
  | { kind: 'wake-failed'; reason: 'refused' | 'unconfirmed'; requestSent: false }
  | { kind: 'send-error'; error: unknown }
  | { kind: 'stale' }

export interface WakeAttemptPorts<T> {
  /** Same identity, Ask thread, requested answerer and pending request. */
  current(): boolean
  /** Fresh native state/access read; caller owns authentication. */
  inspect(): Promise<WakeInspection>
  /** Existing wake API. Called at most once by this attempt. */
  wake(current: () => boolean): Promise<unknown>
  /** Existing Ask send. Called at most once, after confirmed awake. */
  send(): Promise<T>
  phase(phase: WakePhase): void
}
class WakeBlocked extends Error {
  constructor(readonly gate: WakeGate) { super(gate) }
}
class Stopped extends Error {
  constructor(readonly causeKind: 'stale' | 'timeout') { super(causeKind) }
}

/** Duplicate run calls share the same promise and never repeat effects.
 * Cancelling an attempt prevents delivery; it does not claim to undo a wake
 * already received by the host. A send error remains distinct from not-sent.
 */
export class WakeBeforeSend<T> {
  private pending: Promise<WakeAttemptResult<T>> | null = null
  private stop = new AbortController()
  private stopped: 'stale' | 'timeout' = 'stale'
  constructor(private readonly ports: WakeAttemptPorts<T>, private readonly timeoutMs = 30000, private readonly pollMs = 250) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000
      || !Number.isFinite(pollMs) || pollMs < 10 || pollMs > timeoutMs) throw new Error('invalid wake bounds')
  }
  cancel(): void { this.stopped = 'stale'; this.stop.abort() }
  run(): Promise<WakeAttemptResult<T>> {
    return this.pending ??= this.perform()
  }
  private assertCurrent(): void {
    if (!this.ports.current()) throw new Stopped('stale')
    if (this.stop.signal.aborted) throw new Stopped(this.stopped)
  }
  private async scoped<V>(start: () => Promise<V>): Promise<V> {
    this.assertCurrent()
    let abort: (() => void) | undefined
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new Stopped(this.stopped))
        this.stop.signal.addEventListener('abort', abort, { once: true })
      })
      const work = Promise.resolve().then(() => { this.assertCurrent(); return start() })
      const value = await Promise.race([work, aborted])
      this.assertCurrent()
      return value
    } finally { if (abort) this.stop.signal.removeEventListener('abort', abort) }
  }
  private pause(): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Stopped(this.stopped)) }
      const timer = setTimeout(() => { this.stop.signal.removeEventListener('abort', abort); resolve() }, this.pollMs)
      this.stop.signal.addEventListener('abort', abort, { once: true })
    })
  }
  private async perform(): Promise<WakeAttemptResult<T>> {
    const deadline = setTimeout(() => { this.stopped = 'timeout'; this.stop.abort() }, this.timeoutMs)
    let sending = false
    try {
      this.assertCurrent()
      this.ports.phase('inspecting')
      let view = await this.scoped(() => this.ports.inspect())
      if (view.state !== 'awake' && view.gate) return { kind: 'gated', gate: view.gate }
      if (view.state === 'unavailable') return { kind: 'wake-failed', reason: 'refused', requestSent: false }
      if (view.state === 'asleep') {
        if (!view.canWake) return { kind: 'gated', gate: 'authority' }
        this.assertCurrent()
        this.ports.phase('waking')
        this.assertCurrent()
        await this.scoped(() => this.ports.wake(() => {
          try { this.assertCurrent(); return true } catch { return false }
        }))
        view = await this.scoped(() => this.ports.inspect())
      } else if (view.state === 'starting') {
        // Someone has already asked for this start. Do not issue another wake.
        this.ports.phase('waking')
      }
      while (view.state !== 'awake') {
        if (view.gate) return { kind: 'gated', gate: view.gate }
        if (view.state === 'unavailable' || view.state === 'asleep') return { kind: 'wake-failed', reason: 'unconfirmed', requestSent: false }
        await this.scoped(() => this.pause())
        view = await this.scoped(() => this.ports.inspect())
      }
      this.assertCurrent()
      // The wake deadline never labels an already dispatched Ask as not sent.
      clearTimeout(deadline)
      this.ports.phase('sending')
      this.assertCurrent()
      sending = true
      const value = await this.ports.send()
      return { kind: 'sent', value }
    } catch (error) {
      if (sending) return { kind: 'send-error', error }
      if (error instanceof WakeBlocked) return { kind: 'gated', gate: error.gate }
      if (error instanceof Stopped) return error.causeKind === 'stale'
        ? { kind: 'stale' } : { kind: 'wake-failed', reason: 'unconfirmed', requestSent: false }
      return this.ports.current() ? { kind: 'wake-failed', reason: 'refused', requestSent: false } : { kind: 'stale' }
    } finally { clearTimeout(deadline) }
  }
}

/** Existing host reads only. In particular, visibility is not ownership. */
export type NativeWakeClient = Pick<HiveClient, 'me' | 'askSettings' | 'myMind' | 'getAgent' | 'getSwarm' | 'agentAction'>
export interface NativeWakeOptions<T> {
  client: NativeWakeClient
  principal: string
  context: AskContext
  current(): boolean
  send(): Promise<T>
  phase(phase: WakePhase): void
  target?(mind: Pick<Agent, 'id' | 'name'>): void
  fallback?(mind: MyMind): void
  expectedOwn?: string
}

/** Resolve the same coordinator as core/ask.py _route; never wake an addressed
 * member when that member's swarm is actually answered by its coordinator.
 * Without a coordinator, an explicitly addressed member may answer itself;
 * swarm ownership alone never authorizes waking that fallback member.
 * The context (especially exactly {private:true}) is never rewritten here.
 * No-target cases go to Ask for its canonical refusal, without a wake effect.
 */
export function nativeWakePorts<T>(o: NativeWakeOptions<T>): WakeAttemptPorts<T> {
  let pinned: string | null | undefined
  let target: Agent | null = null
  let routeChanged = false
  let allowed = false
  const current = () => !routeChanged && o.current()
  const check = () => { if (!current()) throw new Stopped('stale') }
  async function fresh<V>(read: () => Promise<V>): Promise<V> {
    check()
    const value = await read()
    check()
    return value
  }
  async function resolve(): Promise<{ mind: Agent; swarm: Swarm; memberFallback: boolean } | null> {
    const ctx = o.context
    const addressedId = 'private' in ctx ? undefined : ctx.mind ?? ctx.selection?.find((r) => r.kind === 'mind')?.ref
    const addressed = addressedId ? await fresh(() => o.client.getAgent(addressedId)) : null
    let swarmId = addressed ? addressed.swarm_id : 'private' in ctx ? undefined : ctx.swarm_id
    if (!swarmId && !addressed) {
      // The host's saved default wins over its personal-mind fallback.
      const settings = o.client.askSettings ? await fresh(() => o.client.askSettings!()) : null
      swarmId = settings?.swarm_id
      if (!swarmId && o.client.myMind) {
        const own = readMyMind(await fresh(() => o.client.myMind!()))
        swarmId = own?.swarm_id
        if (!swarmId && own) {
          const mind = await fresh(() => o.client.getAgent(own.id))
          swarmId = mind.swarm_id
        }
      }
    }
    if (!swarmId) return null
    const swarm = await fresh(() => o.client.getSwarm(swarmId!))
    const id = swarm.coordinator_id ?? (addressed?.swarm_id === swarm.id ? addressed.id : null)
    if (!id) return null
    const mind = await fresh(() => o.client.getAgent(id))
    if (mind.swarm_id !== swarm.id || mind.kind === 'module') return null
    return { mind, swarm, memberFallback: !swarm.coordinator_id }
  }
  async function inspect(): Promise<WakeInspection> {
    // An own-mind selection never belongs to a private page's exact context.
    // Assert inside the attempt so an invalid future caller fails before reads
    // or effects, while the request remains known not-sent with its words kept.
    if (o.expectedOwn && 'private' in o.context) throw new Error('expectedOwn never applies to a private Ask')
    // A legacy client without native reads still submits to Ask for the host’s
    // canonical route/refusal; it gains no client-side wake capability.
    if (!o.client.me || !o.client.getAgent || !o.client.getSwarm) return { state: 'awake', canWake: false }
    const me = await fresh(() => o.client.me!())
    if (me.principal !== o.principal) { routeChanged = true; throw new Stopped('stale') }
    if (o.expectedOwn) {
      const own = o.client.myMind ? readMyMind(await fresh(() => o.client.myMind!())) : null
      if (own?.id !== o.expectedOwn) { routeChanged = true; throw new Stopped('stale') }
    }
    const resolved = await resolve()
    const id = resolved?.mind.id ?? null
    if (o.expectedOwn && id !== o.expectedOwn) { routeChanged = true; throw new Stopped('stale') }
    if (pinned !== undefined && pinned !== id) { routeChanged = true; throw new Stopped('stale') }
    pinned = id
    target = resolved?.mind ?? null
    // Ask, not this adapter, owns missing-route and access refusals.
    if (!resolved) return { state: 'awake', canWake: false }
    o.target?.(resolved.mind)
    const { mind, swarm } = resolved
    const own = mind.personal_of === o.principal || mind.is_mine === true
    // This is the explicitly requested auto-wake scope, narrower than visibility.
    // The host's existing sleep flag additionally confirms current lifecycle access.
    allowed = mind.may_sleep === true && (own || me.role === 'admin' || (!resolved.memberFallback && swarm.owner === o.principal))
      && (!mind.personal_of || own)
    // A stopped mind wakes exactly like an asleep one (the host's wake/start lifecycle runs from either; Jon 11-01:
    // asking is the intent, no wake click wall). Most resting minds are 'stopped', so treating it as unavailable left
    // the Ask unable to send at all (Jon 11-04: "Couldn't wake Design creative-director").
    const state = mind.status === 'awake' || mind.status === 'starting' ? mind.status
      : mind.status === 'asleep' || mind.status === 'stopped' ? 'asleep' : 'unavailable'
    if (state === 'asleep' && !allowed && o.client.myMind && !('private' in o.context)) {
      const own = readMyMind(await fresh(() => o.client.myMind!()))
      if (own?.swarm_id) o.fallback?.(own)
    }
    return { state, canWake: allowed }
  }
  return {
    current, inspect,
    async wake(attemptCurrent) {
      // Re-read both identity and route immediately before the existing effect.
      const state = await inspect()
      check()
      if (state.state === 'awake' || state.state === 'starting') return
      if (!attemptCurrent()) throw new Stopped('stale')
      if (!allowed) throw new WakeBlocked('authority')
      if (!target || state.state !== 'asleep') throw new Error('wake no longer permitted')
      try { await fresh(() => o.client.agentAction(target!.id, 'wake')) }
      catch (error) {
        // Only a typed native response; never infer spending from text or a stale budget.
        if (error instanceof ApiError && error.code === 'budget_exhausted') throw new WakeBlocked('spending')
        throw error
      }
    },
    send: o.send,
    phase: o.phase,
  }
}

export const ASK_NOT_SENT = Symbol('Ask not dispatched')
export interface WakeView {
  phase: 'inspecting' | 'waking' | 'sending' | 'failed' | 'gated' | 'stopped'
  name: string
  since: number
  failures: number
  gate?: WakeGate
  changed?: boolean
  own?: MyMind
  privateRequest?: boolean
  mindId?: string
}
interface DeliveryOptions<T> extends NativeWakeOptions<T> {
  /** Re-enter the same request, body and operation after a known not-sent result. */
  retry(): Promise<void>
  reopen(): void
  routeOwn(context: AskContext): void
}
interface Delivery {
  view: WakeView
  attempt?: WakeBeforeSend<unknown>
  current(): boolean
  retry(): Promise<void>
  pending: boolean
  clearDraft?: () => void
  expectedOwn?: string
  useOwn(): void
}
const deliveries = new Map<string, Delivery>()
const wakeListeners = new Set<() => void>()
const publishWake = () => { for (const listener of wakeListeners) listener() }

/** Request-scoped UI custody; no store imports and no retry after dispatch. */
export const askAutoWake = {
  subscribe(listener: () => void) { wakeListeners.add(listener); return () => { wakeListeners.delete(listener) } },
  view(op: string): WakeView | null { return deliveries.get(op)?.view ?? null },
  restoreDraft(op: string, restore: () => (() => void) | null): void {
    const d = deliveries.get(op)
    // Check custody before the restoration itself, not only before retaining its cleanup.
    if (!d || !d.current() || (d.view.phase !== 'failed' && d.view.phase !== 'gated')) return
    const cleanup = restore()
    if (cleanup && deliveries.get(op) === d && d.current()) d.clearDraft = cleanup
  },
  pending(op: string): boolean { return deliveries.get(op)?.pending === true },
  canRetry(op: string): boolean {
    const d = deliveries.get(op)
    return !!d && !d.pending && d.current() && (d.view.phase === 'failed' || d.view.phase === 'gated')
  },
  async useOwn(op: string): Promise<void> {
    const d = deliveries.get(op)
    if (!d || !this.canRetry(op) || d.view.gate !== 'authority' || !d.view.own) return
    d.useOwn()
    await this.retry(op)
  },
  async retry(op: string): Promise<void> {
    const d = deliveries.get(op)
    if (!d || !this.canRetry(op)) return
    d.pending = true
    d.view = { ...d.view, phase: 'inspecting', since: Date.now() }
    publishWake()
    await d.retry()
  },
  cancel(op: string): boolean {
    const d = deliveries.get(op)
    if (!d?.pending) return false
    d.view = { ...d.view, phase: 'stopped' }
    d.attempt?.cancel()
    publishWake()
    return true
  },
  clear(): void {
    for (const d of deliveries.values()) d.attempt?.cancel()
    deliveries.clear()
    publishWake()
  },
  async deliver<T>(op: string, o: DeliveryOptions<T>): Promise<T | typeof ASK_NOT_SENT> {
    // Legacy clients retain their synchronous dispatch boundary. They cannot
    // auto-wake; Ask remains responsible for their canonical route/refusal.
    if (!o.client.me || !o.client.getAgent || !o.client.getSwarm) return o.send()
    const previous = deliveries.get(op)
    const d: Delivery = {
      view: { phase: 'inspecting', name: previous?.view.name ?? 'your mind', since: Date.now(), failures: previous?.view.failures ?? 0, privateRequest: 'private' in o.context },
      current: o.current,
      clearDraft: previous?.clearDraft,
      expectedOwn: previous?.expectedOwn ?? o.expectedOwn,
      useOwn: () => {
        const own = d.view.own
        if (!own?.swarm_id || 'private' in o.context) return
        const { mind: _mind, swarm_id: _swarm, selection, ...rest } = o.context
        void _mind; void _swarm
        const others = selection?.filter((r) => r.kind !== 'mind')
        d.expectedOwn = own.id
        o.routeOwn({ ...rest, mind: own.id, swarm_id: own.swarm_id, ...(others?.length ? { selection: others } : {}) })
      },
      retry: async () => { if (o.current()) { o.reopen(); await o.retry() } },
      pending: true,
    }
    const update = (patch: Partial<WakeView>) => {
      if (deliveries.get(op) !== d || !o.current()) return
      d.view = { ...d.view, ...patch }
      publishWake()
    }
    d.attempt = new WakeBeforeSend(nativeWakePorts({ ...o, expectedOwn: d.expectedOwn,
      fallback: (own) => update({ own }),
      target: (mind) => { update({ name: mind.name.slice(0, 60), mindId: mind.id }); o.target?.(mind) },
      phase: (phase) => {
        if (phase === 'sending') { d.pending = false; d.clearDraft?.(); d.clearDraft = undefined; update({ phase }) }
        else if (phase === 'waking') update({ phase, since: Date.now() })
        o.phase(phase)
      },
    }))
    deliveries.set(op, d)
    publishWake()
    const result = await d.attempt.run()
    d.pending = false
    if (result.kind === 'sent' || result.kind === 'send-error') {
      // Dispatch is irreversible. Even a cleared/superseded view must preserve
      // the transport outcome; the store's identity snapshot owns its projection.
      if (deliveries.get(op) === d) { deliveries.delete(op); publishWake() }
      if (result.kind === 'send-error') throw result.error
      return result.value as T
    }
    if (deliveries.get(op) !== d) return ASK_NOT_SENT
    if (d.view.phase !== 'stopped') update(result.kind === 'gated'
      ? { phase: 'gated', gate: result.gate }
      : { phase: 'failed', failures: d.view.failures + 1, changed: result.kind === 'stale' })
    return ASK_NOT_SENT
  },
}
