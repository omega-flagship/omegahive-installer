import { beforeEach, describe, expect, it } from 'vitest'
import { ApiError, type HiveClient } from '../../api/client'
import type { DecisionResult } from '../../lib/decisionGate'
import { INITIAL, screenOf } from './machine'
import { installPower, powerGate, usePower, type PowerHooks } from './store'

/**
 * f0b412fc FIX-FIRST (B1, B2): every answer is bound to the identity it was asked under, and an old POST answer never
 * replaces newer power state. All through the real store and gate, with deferred synthetic clients (no hive).
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

/**
 * A client whose getPower / setPower / me answers are queued by the test: each call takes the next queued answer, or
 * a fresh deferred the test settles later (`pending`). Every call is recorded; `getHive` stands for any gated method.
 */
function fake(opts: { me?: () => Promise<unknown>; power?: () => Promise<unknown>; set?: (b: { state: string }) => Promise<unknown> } = {}) {
  const calls: string[] = []
  const events = new Set<(e: unknown) => void>()
  const conn = new Set<(s: string) => void>()
  let authed = true
  const pendingPower: Deferred<unknown>[] = []
  const pendingSet: Deferred<unknown>[] = []
  const pendingMe: Deferred<unknown>[] = []
  const client = {
    mode: 'live',
    needsAuth: () => !authed,
    login: async () => {
      calls.push('login')
      authed = true
    },
    logout: () => {
      calls.push('logout')
      authed = false
    },
    me: () => {
      calls.push('me')
      if (opts.me) return opts.me()
      const d = deferred()
      pendingMe.push(d)
      return d.promise
    },
    getPower: () => {
      calls.push('getPower')
      if (opts.power) return opts.power()
      const d = deferred()
      pendingPower.push(d)
      return d.promise
    },
    setPower: (b: { state: string; operation_id: string }) => {
      calls.push(`setPower:${b.state}:${b.operation_id}`)
      if (opts.set) return opts.set(b)
      const d = deferred()
      pendingSet.push(d)
      return d.promise
    },
    getHive: async () => (calls.push('getHive'), { ok: true }),
    connect: () => calls.push('connect'),
    disconnect: () => undefined,
    subscribe: (f: (e: unknown) => void) => (events.add(f), () => events.delete(f)),
    onConnection: (f: (s: string) => void) => (conn.add(f), () => conn.delete(f)),
  }
  return {
    client: client as unknown as HiveClient,
    calls,
    pendingPower,
    pendingSet,
    pendingMe,
    emit: (e: unknown) => events.forEach((f) => f(e)),
    connection: (s: string) => conn.forEach((f) => f(s)),
    signOut: () => {
      authed = false
    },
  }
}

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

type Gated = HiveClient & { getHive: () => Promise<unknown> }
const p = () => usePower.getState()

/** Hooks that count what they were asked to do. */
function counting() {
  const seen = { woken: 0, wentOff: 0, notify: [] as string[] }
  const hooks: PowerHooks = { woken: () => void seen.woken++, wentOff: () => void seen.wentOff++, notify: (n) => void seen.notify.push(n.title) }
  return { seen, hooks }
}

beforeEach(() => usePower.setState({ ...INITIAL, dialog: null }))

describe('B1: answers belong to the identity they were asked under', () => {
  it('same client, sign-out then sign-in: the earlier admin read never lands in the member session', async () => {
    const f = fake()
    let role: unknown = ADMIN
    const g = fake({ me: async () => role })
    // one client throughout: the deferred getPower of the first identity is held by f's queue
    Object.assign(g.client, { getPower: f.client.getPower })
    const c = installPower(g.client, {}) as Gated
    const old = p().load()
    await tick()
    expect(f.pendingPower).toHaveLength(1)
    expect(p().admin).toBe(true)
    // a call held before power was known, under the first identity
    const held = c.getHive()
    // sign-out (the client reports unauthorized), then sign in as a member
    g.signOut()
    g.connection('unauthorized')
    await expect(held).rejects.toMatchObject({ code: 'session_ended' })
    expect(p().admin).toBeNull()
    role = MEMBER
    await c.login('pw')
    const now = p().load()
    await tick()
    expect(f.pendingPower).toHaveLength(2)
    f.pendingPower[1].resolve({ state: 'on', since: 'current', by: 'user:member' })
    await now
    expect(p().admin).toBe(false)
    // the first identity's answer arrives last: it changes nothing
    f.pendingPower[0].resolve({ state: 'off', since: 'old', by: 'user:admin', minds_in_snapshot: 23 })
    await old
    await tick()
    expect(p()).toMatchObject({ gate: 'on', by: 'user:member', snapshot: null, admin: false })
    // the held call never ran, before or after the new sign-in
    expect(g.calls).not.toContain('getHive')
    // and only the two reads were made (the stale answer asked for nothing more)
    expect(f.calls.filter((x) => x === 'getPower')).toHaveLength(2)
  })

  it('a delayed role read (me) from before sign-out never restores admin', async () => {
    const f = fake({ power: async () => ({ state: 'on', since: 's', by: 'user:member' }) })
    const c = installPower(f.client, {}) as Gated
    const old = p().load()
    await tick()
    expect(f.pendingMe).toHaveLength(1)
    // signed out through the page's own client (logout), then in again
    c.logout()
    expect(p().admin).toBeNull()
    await c.login('pw')
    const now = p().load()
    await tick()
    f.pendingMe[1].resolve(MEMBER)
    await now
    expect(p().admin).toBe(false)
    f.pendingMe[0].resolve(ADMIN)
    await old
    await tick()
    expect(p().admin).toBe(false)
    expect(p().gate).toBe('on')
    // the stale me asked for no power read of its own
    expect(f.calls.filter((x) => x === 'getPower')).toHaveLength(1)
  })

  it('client replacement: held calls settle unrun, the old client is refused, its events and reads write nothing', async () => {
    const a = fake({ me: async () => ADMIN })
    const ca = installPower(a.client, {}) as Gated
    const old = p().load()
    await tick()
    const held = ca.getHive()
    const b = fake({ me: async () => MEMBER, power: async () => ({ state: 'on', since: 'b', by: 'user:member' }) })
    const cb = installPower(b.client, {}) as Gated
    await expect(held).rejects.toMatchObject({ code: 'client_replaced' })
    await expect(ca.getHive()).rejects.toMatchObject({ code: 'client_replaced' })
    await p().load()
    await expect(cb.getHive()).resolves.toEqual({ ok: true })
    // the replaced client: a late read, a late event, a late unauthorized
    a.pendingPower[0].resolve({ state: 'off', since: 'a', by: 'user:admin', minds_in_snapshot: 9 })
    await old
    a.emit({ type: 'hive.power', state: 'off', since: 'a2' })
    a.connection('unauthorized')
    await tick()
    expect(p()).toMatchObject({ gate: 'on', by: 'user:member', admin: false, snapshot: null })
    expect(a.calls).not.toContain('getHive')
    expect(a.calls.filter((x) => x === 'getPower')).toHaveLength(1)
  })

  it('press: an answer after sign-out neither dispatches, nor takes the new operation, nor hydrates, nor recovers', async () => {
    const f = fake({ me: async () => ADMIN })
    const k = counting()
    const c = installPower(f.client, k.hooks) as Gated
    const first = p().load()
    await tick()
    f.pendingPower[0].resolve({ state: 'off', since: 's0', by: 'user:admin' })
    await first
    const press = p().press()
    await tick()
    expect(f.pendingSet).toHaveLength(1)
    c.logout()
    await c.login('pw')
    const again = p().load()
    await tick()
    f.pendingPower[1].resolve({ state: 'off', since: 's0', by: 'user:admin' })
    await again
    const before = { ...p() }
    // the first identity's answer: woke minds, the hive is on
    f.pendingSet[0].resolve({ state: 'on', since: 's1', woken: ['a'], skipped: [], failed: [] })
    await press
    await tick()
    expect(p()).toMatchObject({ gate: before.gate, wake: 'idle', result: null, pending: false })
    expect(k.seen.woken).toBe(0)
    expect(f.calls.filter((x) => x === 'getPower')).toHaveLength(2)
    // the new identity's own press uses a NEW operation id (custody was not carried across)
    void p().press()
    await tick()
    const ids = f.calls.filter((x) => x.startsWith('setPower:on:'))
    expect(ids).toHaveLength(2)
    expect(ids[0]).not.toBe(ids[1])
  })

  it('press: a lost answer after replacement sends no recovery read on either client', async () => {
    const a = fake({ me: async () => ADMIN, power: async () => ({ state: 'off', since: 's', by: 'user:admin' }) })
    installPower(a.client, {})
    await p().load()
    const press = p().press()
    await tick()
    const b = fake({ me: async () => MEMBER, power: async () => ({ state: 'off', since: 's', by: 'user:admin' }) })
    installPower(b.client, {})
    await p().load()
    a.pendingSet[0].reject(new ApiError(0, 'network', 'lost'))
    await press
    await tick()
    expect(a.calls.filter((x) => x === 'getPower')).toHaveLength(1)
    expect(b.calls.filter((x) => x === 'getPower')).toHaveLength(1)
    expect(p()).toMatchObject({ gate: 'off', note: null, wake: 'idle', admin: false })
  })

  it('turnOff: a late answer after replacement writes nothing and calls no hook; its recheck sends nothing', async () => {
    const a = fake({ me: async () => ADMIN, power: async () => ({ state: 'on', since: 's', by: 'user:admin' }) })
    const ka = counting()
    installPower(a.client, ka.hooks)
    await p().load()
    const off = p().turnOff()
    await tick()
    const lostOff = p().turnOff()
    await tick()
    const kb = counting()
    const b = fake({ me: async () => ADMIN, power: async () => ({ state: 'on', since: 's', by: 'user:admin' }) })
    installPower(b.client, kb.hooks)
    await p().load()
    a.pendingSet[0].resolve({ state: 'off', since: 's2', stopped: 3, failed: [] })
    const answer = await off
    expect(answer).toMatchObject({ unsettled: expect.stringMatching(/signed out/) })
    expect(p()).toMatchObject({ gate: 'on', result: null })
    expect(ka.seen).toEqual({ woken: 0, wentOff: 0, notify: [] })
    expect(kb.seen).toEqual({ woken: 0, wentOff: 0, notify: [] })
    // a lost answer under the earlier identity: no recheck is offered, and none can read
    a.pendingSet[1].reject(new ApiError(0, 'network', 'lost'))
    const r = (await lostOff) as Exclude<DecisionResult, string | true>
    expect('recheck' in r && r.recheck).toBeFalsy()
    expect(a.calls.filter((x) => x === 'getPower')).toHaveLength(1)
  })

  it('turnOff: a recheck started under one identity sends nothing after sign-out', async () => {
    const f = fake({ me: async () => ADMIN, set: async () => Promise.reject(new ApiError(0, 'network', 'lost')) })
    const c = installPower(f.client, {}) as Gated
    const first = p().load()
    await tick()
    f.pendingPower[0].resolve({ state: 'on', since: 's', by: 'user:admin' })
    await first
    const r = (await p().turnOff()) as { unsettled: string; recheck?: () => Promise<DecisionResult> }
    expect(r.recheck).toBeTypeOf('function')
    c.logout()
    const again = await r.recheck!()
    expect(again).toMatchObject({ unsettled: expect.stringMatching(/signed out/) })
    expect(f.calls.filter((x) => x === 'getPower')).toHaveLength(1)
  })

  it('wakeAll: a late answer after sign-out notifies no one and reads nothing', async () => {
    const f = fake({ me: async () => ADMIN, power: async () => ({ state: 'on', since: 's', by: 'user:admin' }) })
    const k = counting()
    const c = installPower(f.client, k.hooks) as Gated
    await p().load()
    const wake = p().wakeAll()
    await tick()
    c.logout()
    f.pendingSet[0].resolve({ state: 'on', since: 's2', woken: ['a'], skipped: [], failed: [] })
    expect(await wake).toMatchObject({ unsettled: expect.any(String) })
    await tick()
    expect(k.seen.notify).toEqual([])
    expect(f.calls.filter((x) => x === 'getPower')).toHaveLength(1)
  })
})

describe('B2: an old POST answer never replaces newer power state', () => {
  async function offAdmin(extra: Parameters<typeof fake>[0] = {}) {
    let reads = 0
    const f = fake({ me: async () => ADMIN, power: () => (++reads === 1 ? Promise.resolve({ state: 'off', since: '2026-10-06T08:00:00Z', by: 'user:admin' }) : new Promise(() => undefined)), ...extra })
    const k = counting()
    const c = installPower(f.client, k.hooks) as Gated
    await p().load()
    return { f, c, k }
  }

  it('a delayed on answer after a newer off event: the gate stays off and every ordinary method stays refused', async () => {
    const { f, c } = await offAdmin()
    const press = p().press()
    f.emit({ type: 'hive.power', state: 'on', since: 'own-on' })
    f.emit({ type: 'hive.power', state: 'off', since: 'newer-off' })
    f.pendingSet[0].resolve({ state: 'on', since: 'own-on', woken: ['a'], skipped: [], failed: [] })
    await press
    expect(p().gate).toBe('off')
    expect(p().since).toBe('newer-off')
    await expect(c.getHive()).rejects.toMatchObject({ status: 503, code: 'hive_off' })
    expect(f.calls).not.toContain('getHive')
  })

  it('the report completes after a newer event: it is shown, and the state is not changed', async () => {
    const { f, k } = await offAdmin()
    const press = p().press()
    // someone turned it off again before our answer (our own on event never reached us)
    f.emit({ type: 'hive.power', state: 'off', since: '2026-10-06T08:05:00Z' })
    f.pendingSet[0].resolve({ state: 'on', since: '2026-10-06T08:01:00Z', woken: ['a', 'b'], skipped: [], failed: [] })
    await press
    expect(screenOf(p())).toBe('report')
    expect(p().result).toMatchObject({ kind: 'on', woken: { count: 2 } })
    expect(p().note).toMatch(/turned off again/)
    expect(p().gate).toBe('off')
    expect(p().since).toBe('2026-10-06T08:05:00Z')
    expect(k.seen.woken).toBe(0)
    p().dispatch({ type: 'dismiss' })
    expect(screenOf(p())).toBe('off')
  })

  it('a current answer is applied: no newer event, the gate opens and the page hydrates once', async () => {
    const { f, c, k } = await offAdmin()
    const press = p().press()
    f.pendingSet[0].resolve({ state: 'on', since: '2026-10-06T08:01:00Z', woken: ['a'], skipped: [], failed: [] })
    await press
    expect(p().gate).toBe('on')
    expect(k.seen.woken).toBe(1)
    // its own event, later, changes nothing
    f.emit({ type: 'hive.power', state: 'on', since: '2026-10-06T08:01:00Z' })
    expect(k.seen.woken).toBe(1)
    await expect(c.getHive()).resolves.toEqual({ ok: true })
  })

  it('a delayed off answer after a newer on: the gate stays on, nothing goes dark, the report is still given', async () => {
    let reads = 0
    const f = fake({ me: async () => ADMIN, power: () => (++reads === 1 ? Promise.resolve({ state: 'on', since: '2026-10-06T07:00:00Z', by: 'user:admin' }) : new Promise(() => undefined)) })
    const k = counting()
    const c = installPower(f.client, k.hooks) as Gated
    await p().load()
    const off = p().turnOff()
    f.emit({ type: 'hive.power', state: 'off', since: '2026-10-06T08:00:00Z' })
    f.emit({ type: 'hive.power', state: 'on', since: '2026-10-06T08:02:00Z' })
    const darkBefore = k.seen.wentOff
    f.pendingSet[0].resolve({ state: 'off', since: '2026-10-06T08:00:00Z', stopped: 4, failed: [] })
    expect(await off).toBe(true)
    expect(p().gate).toBe('on')
    expect(p().since).toBe('2026-10-06T08:02:00Z')
    expect(k.seen.wentOff).toBe(darkBefore)
    expect(k.seen.notify).toEqual(['Stopped 4 minds.'])
    await expect(c.getHive()).resolves.toEqual({ ok: true })
  })

  it("another admin's reversal arriving before our off answer, and a read older than it, both leave the newer on", async () => {
    let reads = 0
    const later = deferred<unknown>()
    const f = fake({
      me: async () => ADMIN,
      power: () => (++reads === 1 ? Promise.resolve({ state: 'on', since: '2026-10-06T07:00:00Z', by: 'user:admin' }) : reads === 2 ? later.promise : Promise.resolve({ state: 'on', since: '2026-10-06T08:02:00Z', by: 'user:other' })),
    })
    installPower(f.client, {})
    await p().load()
    const off = p().turnOff()
    // a read begins (the wake dialog), then the other admin's on arrives before our own off event or answer
    const reading = p().load()
    f.emit({ type: 'hive.power', state: 'on', since: '2026-10-06T08:02:00Z' })
    f.pendingSet[0].resolve({ state: 'off', since: '2026-10-06T08:00:00Z', stopped: 2, failed: [] })
    await off
    expect(p().gate).toBe('on')
    // the read that began before the reversal says off (older): kept out, read again
    later.resolve({ state: 'off', since: '2026-10-06T08:00:00Z', by: 'user:admin' })
    await reading
    await tick(12)
    expect(p()).toMatchObject({ gate: 'on', since: '2026-10-06T08:02:00Z', by: 'user:other' })
    expect(reads).toBe(3)
  })

  it('lost-answer recovery: a recovery read older than a newer event confirms nothing; a valid one reports the hive on', async () => {
    const recovery = deferred<unknown>()
    let reads = 0
    const f = fake({
      me: async () => ADMIN,
      power: () => (++reads === 1 ? Promise.resolve({ state: 'off', since: '2026-10-06T08:00:00Z', by: 'user:admin' }) : reads === 2 ? recovery.promise : new Promise(() => undefined)),
      set: () => Promise.reject(new ApiError(0, 'network', 'lost')),
    })
    installPower(f.client, {})
    await p().load()
    const press = p().press()
    await tick()
    // while the recovery read is out, the hive is turned off again (newer)
    f.emit({ type: 'hive.power', state: 'off', since: '2026-10-06T08:09:00Z' })
    recovery.resolve({ state: 'on', since: '2026-10-06T08:01:00Z', by: 'user:admin' })
    await press
    expect(p()).toMatchObject({ gate: 'off', wake: 'idle', since: '2026-10-06T08:09:00Z' })
    expect(p().note).toMatch(/could not confirm/)

    // a valid recovery read: the hive is on, the answer's details are honestly lost
    const g = fake({
      me: async () => ADMIN,
      power: (() => {
        let n = 0
        return () => Promise.resolve(++n === 1 ? { state: 'off', since: '2026-10-06T09:00:00Z', by: 'user:admin' } : { state: 'on', since: '2026-10-06T09:01:00Z', by: 'user:admin' })
      })(),
      set: () => Promise.reject(new ApiError(0, 'network', 'lost')),
    })
    installPower(g.client, {})
    await p().load()
    await p().press()
    p().dispatch({ type: 'lit' })
    expect(p()).toMatchObject({ gate: 'on', since: '2026-10-06T09:01:00Z', result: null })
    expect(screenOf(p())).toBe('report')
    expect(p().note).toMatch(/lost on the way back/)
  })

  it('turnOff never sets off from its answer alone when a newer on was seen (no unconditional off event)', async () => {
    let reads = 0
    const f = fake({ me: async () => ADMIN, power: () => (++reads === 1 ? Promise.resolve({ state: 'on', since: 'a', by: 'user:admin' }) : new Promise(() => undefined)) })
    installPower(f.client, {})
    await p().load()
    const off = p().turnOff()
    // untimed sinces: arrival order decides; the other admin's on came after our request began
    f.emit({ type: 'hive.power', state: 'on', since: 'other-on' })
    f.pendingSet[0].resolve({ state: 'off', since: 'own-off', stopped: 1, failed: [] })
    await off
    expect(p().gate).toBe('on')
    expect(powerGate().state).toBe('on')
  })
})
