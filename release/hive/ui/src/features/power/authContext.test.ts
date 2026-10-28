import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError, Emitter, type HiveClient } from '../../api/client'
import { INITIAL } from './machine'
import { installPower, powerGate, usePower } from './store'
import type { DecisionResult } from '../../lib/decisionGate'

/**
 * Review db4b3f9/1e92645 identity follow-up, on Platform's person-session client (439efb9): the power generation is
 * bound to the client's synchronous credential observer (onAuthChange), so a re-login without a logout in between ends
 * the earlier identity at once. Synthetic deferred clients only (no hive).
 */

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}
function deferred<T = unknown>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

const ADMIN = { principal: 'user:admin', kind: 'sso', role: 'admin', expires_at: null, person: null }
const MEMBER = { principal: 'user:member', kind: 'sso', role: 'member', expires_at: null, person: null }

/** A client with the live credential side: a token, a new local handle per change, and its listeners. */
function fake(opts: { me?: () => Promise<unknown>; auth?: boolean } = {}) {
  const calls: string[] = []
  const pendingPower: Deferred<unknown>[] = []
  const pendingMe: Deferred<unknown>[] = []
  const pendingSet: Deferred<unknown>[] = []
  const authEvents = new Emitter<void>()
  let token: string | null = 'token-a'
  let handle: object = {}
  const client: Record<string, unknown> = {
    mode: 'live',
    needsAuth: () => !token,
    me: () => {
      calls.push('me')
      if (opts.me) return opts.me()
      const d = deferred()
      pendingMe.push(d)
      return d.promise
    },
    getPower: () => {
      calls.push('getPower')
      const d = deferred()
      pendingPower.push(d)
      return d.promise
    },
    setPower: (b: { state: string; operation_id: string }) => {
      calls.push(`setPower:${b.state}:${b.operation_id}`)
      const d = deferred()
      pendingSet.push(d)
      return d.promise
    },
    getHive: async () => (calls.push('getHive'), { ok: true }),
    connect: () => undefined,
    disconnect: () => undefined,
    subscribe: () => () => undefined,
    onConnection: () => () => undefined,
  }
  if (opts.auth !== false) {
    client.authContext = () => handle
    client.onAuthChange = (l: () => void) => authEvents.on(l)
  }
  return {
    client: client as unknown as HiveClient,
    calls,
    pendingPower,
    pendingMe,
    pendingSet,
    listeners: () => authEvents.size,
    change(next: string | null) {
      token = next
      handle = {}
      authEvents.emit()
    },
  }
}

const tick = async (n = 8) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}
type Gated = HiveClient & { getHive: () => Promise<unknown> }
const p = () => usePower.getState()

beforeEach(() => usePower.setState({ ...INITIAL, dialog: null }))

describe('power: the generation follows the credential observer', () => {
  it('same-client re-login without a logout: the old identity’s admin read and power answer never land', async () => {
    const meCalls: Deferred<unknown>[] = []
    const f = fake({ me: () => { const d = deferred(); meCalls.push(d); return d.promise } })
    const c = installPower(f.client, {}) as Gated
    const old = p().load()
    await tick()
    expect(meCalls).toHaveLength(1)
    // a call held before power was known, under the first identity
    const held = c.getHive()
    const genBefore = powerGate().generation
    // signed in again (no logout, no 'unauthorized' in between): the observer ends the earlier identity at once
    f.change('token-b')
    expect(powerGate().generation).toBeGreaterThan(genBefore)
    await expect(held).rejects.toMatchObject({ code: 'session_ended' })
    expect(p().admin).toBeNull()
    // the new identity reads afresh (the observer started it)
    await tick()
    expect(meCalls).toHaveLength(2)
    meCalls[1].resolve(MEMBER)
    await tick()
    f.pendingPower[0].resolve({ state: 'on', since: 'current', by: 'user:member' })
    await tick()
    expect(p()).toMatchObject({ admin: false, gate: 'on', by: 'user:member' })
    // the old identity's answers arrive last: they change nothing
    meCalls[0].resolve(ADMIN)
    await old
    await tick()
    expect(p().admin).toBe(false)
    expect(p().by).toBe('user:member')
    expect(f.calls).not.toContain('getHive')
  })

  it('cross-tab sign-out: the generation ends, nothing is read again, and no old answer lands', async () => {
    const f = fake({ me: async () => ADMIN })
    installPower(f.client, {})
    const old = p().load()
    await tick()
    expect(f.pendingPower).toHaveLength(1)
    f.change(null)
    expect(p().admin).toBeNull()
    f.pendingPower[0].resolve({ state: 'off', since: 'old', by: 'user:admin', minds_in_snapshot: 3 })
    await old
    await tick()
    expect(p()).toMatchObject({ ...INITIAL })
    expect(f.calls.filter((x) => x === 'getPower')).toHaveLength(1)
  })

  it('reinstalling unsubscribes the earlier client’s observer', async () => {
    const a = fake({ me: async () => ADMIN })
    installPower(a.client, {})
    expect(a.listeners()).toBe(1)
    const b = fake({ me: async () => MEMBER })
    installPower(b.client, {})
    expect(a.listeners()).toBe(0)
    const gen = powerGate().generation
    a.change('token-a2')
    expect(powerGate().generation).toBe(gen)
  })

  it('the observer and the authContext handle stay ungated (synchronous, no request) through the gated client', () => {
    const f = fake()
    const c = installPower(f.client, {})
    expect(typeof c.authContext?.()).toBe('object')
    const off = c.onAuthChange?.(() => undefined)
    expect(typeof off).toBe('function')
    off?.()
  })

  it('me() 409 auth_context_changed (the sign-in changed mid-read) is not a failure: the new identity reads its own', async () => {
    let n = 0
    const f: ReturnType<typeof fake> = fake({
      me: async () => {
        if (n++ > 0) return ADMIN
        // the live client's own sequence: the credential changes (listeners told), then the read answers 409
        f.change('token-b')
        throw new ApiError(409, 'auth_context_changed', 'Sign-in changed while reading identity')
      },
    })
    installPower(f.client, {})
    const old = p().load()
    await tick()
    await old
    await tick()
    f.pendingPower.at(-1)?.resolve({ state: 'on', since: 's', by: 'user:admin' })
    await tick()
    expect(n).toBe(2)
    expect(p()).toMatchObject({ admin: true, gate: 'on' })
    expect(f.pendingPower).toHaveLength(1)
  })

  it('a client without the observer (sim-like) keeps the earlier behaviour', async () => {
    const f = fake({ me: async () => ADMIN, auth: false })
    const c = installPower(f.client, {})
    expect(c.onAuthChange).toBeUndefined()
    const load = p().load()
    await tick()
    f.pendingPower[0].resolve({ state: 'on', since: 's', by: 'user:admin' })
    await load
    expect(p()).toMatchObject({ admin: true, gate: 'on' })
  })
})

describe('next28 4e745a7 Review B1: same-client credential replacement', () => {
  // Review's portable probe (coordination/receipts-local/omegareview-next28-4e745a7/identity-probe.txt), verbatim but for
  // types: the authContext stamp is cast, and this file's fake() stands for identity.test.ts's.
  it('Review: same-client credential replacement invalidates the old admin read without unauthorized', async () => {
    const f = fake()
    let stamp = 1
    const listeners = new Set<() => void>()
    Object.assign(f.client, { authContext: () => stamp as unknown as object, onAuthChange: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) } })
    installPower(f.client, {})
    const old = p().load()
    await tick()
    expect(f.pendingMe).toHaveLength(1)
    stamp++
    listeners.forEach(fn => fn())
    f.pendingMe[0].resolve(ADMIN)
    await tick()
    for (const d of f.pendingPower) d.resolve({ state: 'off', since: 'old', by: 'user:admin', minds_in_snapshot: 23 })
    await old
    expect(p().admin).not.toBe(true)
    expect(p().by).not.toBe('user:admin')
  })

  /** Load power fully under the current identity (me answered by `who`, power answered by `status`). */
  async function settle(f: ReturnType<typeof fake>, who: unknown, status: unknown) {
    const load = p().load()
    await tick()
    f.pendingMe.at(-1)?.resolve(who)
    await tick()
    f.pendingPower.at(-1)?.resolve(status)
    await load
    await tick()
  }

  it('A→B→A on the same client: nothing of A’s earlier state or operations revives', async () => {
    const f = fake()
    installPower(f.client, {})
    await settle(f, ADMIN, { state: 'on', since: 'a1', by: 'user:admin', minds_in_snapshot: 0 })
    expect(p()).toMatchObject({ admin: true, gate: 'on' })
    // A starts turning the hive off; its answer is still out
    const offA = p().turnOff()
    await tick()
    const opA = f.calls.find((x) => x.startsWith('setPower:off:'))
    expect(opA).toBeTruthy()
    // B signs in on the same client, then A again (no logout, no unauthorized)
    f.change('token-b')
    expect(p().admin).toBeNull()
    f.change('token-a')
    expect(p().admin).toBeNull()
    // A's earlier POST answer lands now: it belongs to the first A, not this one
    f.pendingSet[0].resolve({ state: 'off', since: 'a-old', stopped: 4, failed: [] })
    const r: DecisionResult = await offA
    expect(r).toMatchObject({ unsettled: expect.stringContaining('signed out') })
    await tick()
    expect(p().gate).not.toBe('off')
    expect(p().by).not.toBe('user:admin')
    // the second A reads afresh; its own turn-off is a NEW operation (the first A's id is not reused)
    await settle(f, ADMIN, { state: 'on', since: 'a2', by: 'user:admin', minds_in_snapshot: 0 })
    expect(p()).toMatchObject({ admin: true, gate: 'on', since: 'a2' })
    void p().turnOff()
    await tick()
    const ops = f.calls.filter((x) => x.startsWith('setPower:off:'))
    expect(ops).toHaveLength(2)
    expect(ops[1]).not.toBe(opA)
  })

  it('a stale POST across an auth change: its answer neither sets state nor reaches hooks', async () => {
    const notes: string[] = []
    const f = fake()
    installPower(f.client, { notify: (n) => void notes.push(n.title) })
    await settle(f, ADMIN, { state: 'on', since: 's1', by: 'user:admin', minds_in_snapshot: 0 })
    const wake = p().wakeAll()
    await tick()
    expect(f.pendingSet).toHaveLength(1)
    f.change('token-b')
    f.pendingSet[0].resolve({ state: 'on', since: 'old', woken: ['m1'], skipped: [], failed: [] })
    expect(await wake).toMatchObject({ unsettled: expect.any(String) })
    await tick()
    expect(notes).toEqual([])
    expect(p().admin).toBeNull()
  })

  it('a stale read across an auth change: the old identity’s status is never adopted', async () => {
    const f = fake()
    installPower(f.client, {})
    const old = p().load()
    await tick()
    f.pendingMe[0].resolve(MEMBER)
    await tick()
    expect(f.pendingPower).toHaveLength(1)
    f.change('token-b')
    f.pendingPower[0].resolve({ state: 'off', since: 'old', by: 'user:old', minds_in_snapshot: 9 })
    await old
    await tick()
    expect(p().gate).not.toBe('off')
    expect(p().by).not.toBe('user:old')
    expect(p().snapshot).toBeNull()
  })
})
