import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, type HiveClient } from '../../api/client'
import type { HiveEvent } from '../../api/types'
import { useHive } from '../../store/store'
import { OPEN_WHILE_OFF, readResult, readStatus, resultWords, tally } from './api'
import { canPress, INITIAL, powerReducer, screenOf, type PowerAction, type PowerView } from './machine'
import { installPower, powerGate, usePower } from './store'

const run = (actions: PowerAction[], from: PowerView = INITIAL) => actions.reduce(powerReducer, from)
const offStatus = { type: 'status', status: { state: 'off', since: '2026-10-05T23:50:00Z', by: 'user:operator', minds_in_snapshot: 4 } } as const

describe('the off-screen state machine', () => {
  it('stays unknown until power is read, then shows off', () => {
    expect(screenOf(INITIAL)).toBe('none')
    expect(screenOf(run([offStatus]))).toBe('off')
  })

  it('admin: press -> lighting; the report waits for BOTH the light-up and our own answer', () => {
    let v = run([{ type: 'admin', admin: true }, offStatus])
    expect(canPress(v)).toBe(true)
    v = run([{ type: 'press' }], v)
    expect(screenOf(v)).toBe('lighting')
    expect(canPress(v)).toBe(false)
    // the event lands first: still lighting (our answer is not in)
    v = run([{ type: 'event', state: 'on', since: 'x' }, { type: 'lit' }], v)
    expect(screenOf(v)).toBe('lighting')
    const result = readResult('on', { state: 'on', since: 'x', woken: ['a1', 'a2'], skipped: [{ id: 'a3', reason: 'deleted' }], failed: [{ id: 'a4', error: 'boom' }] })
    v = run([{ type: 'answered', result, current: true }], v)
    expect(screenOf(v)).toBe('report')
    expect(v.result).toEqual(result)
    v = run([{ type: 'dismiss' }], v)
    expect(screenOf(v)).toBe('none')
  })

  it('answer before the light-up has played: still lighting until lit', () => {
    let v = run([{ type: 'admin', admin: true }, offStatus, { type: 'press' }])
    v = run([{ type: 'answered', result: readResult('on', { woken: [], skipped: [], failed: [] }), current: true }], v)
    expect(screenOf(v)).toBe('lighting')
    expect(screenOf(run([{ type: 'lit' }], v))).toBe('report')
  })

  it('non-admin: no button, ever; someone else turning it on plays the light-up and leaves without a report', () => {
    let v = run([{ type: 'admin', admin: false }, offStatus])
    expect(screenOf(v)).toBe('off')
    expect(canPress(v)).toBe(false)
    expect(run([{ type: 'press' }], v)).toBe(v)
    v = run([{ type: 'event', state: 'on', since: 'y' }], v)
    expect(screenOf(v)).toBe('lighting')
    expect(screenOf(run([{ type: 'lit' }], v))).toBe('none')
  })

  it('an unknown role cannot press', () => {
    expect(canPress(run([offStatus]))).toBe(false)
  })

  it('a refused POST puts the light back out with the reason; the button returns', () => {
    let v = run([{ type: 'admin', admin: true }, offStatus, { type: 'press' }, { type: 'failed', on: false, note: 'The hive stayed off: forbidden' }])
    expect(screenOf(v)).toBe('off')
    expect(v.note).toMatch(/stayed off/)
    expect(canPress(v)).toBe(true)
    v = run([{ type: 'press' }], v)
    expect(v.note).toBeNull()
  })

  it('a lost answer with the hive on reports honestly that the details are unknown', () => {
    const v = run([{ type: 'admin', admin: true }, offStatus, { type: 'press' }, { type: 'lit' }, { type: 'failed', on: true, note: 'lost' }])
    expect(screenOf(v)).toBe('report')
    expect(v.result).toBeNull()
    expect(v.note).toBe('lost')
  })

  it('turned off again mid-report: back to dark', () => {
    const v = run([{ type: 'admin', admin: true }, offStatus, { type: 'event', state: 'on', since: 'a' }, { type: 'event', state: 'off', since: 'b' }])
    expect(screenOf(v)).toBe('off')
  })

  it('an unreadable power route (an older host) never strands the page', () => {
    expect(run([{ type: 'unreadable' }]).gate).toBe('on')
    expect(run([offStatus, { type: 'unreadable' }]).gate).toBe('off')
  })
})

describe('honest results (host pin 293fe18)', () => {
  it('off: stopped is a count, failed minds are named as still running', () => {
    const r = readResult('off', { state: 'off', since: 's', stopped: 5, failed: [{ id: 'a_vega', error: 'timeout' }] })
    const w = resultWords(r, (id) => (id === 'a_vega' ? 'Vega' : undefined))
    expect(w.headline).toBe('Stopped 5 minds.')
    expect(w.detail).toEqual(['1 mind could not be stopped and is still running: Vega (timeout).'])
    expect(w.ok).toBe(false)
  })

  it('on: woken, each skip reason in plain words, failures with their error', () => {
    const r = readResult('on', {
      state: 'on',
      since: 's',
      woken: ['a1', 'a2'],
      skipped: [
        { id: 'a3', reason: 'deleted' },
        { id: 'a4', reason: 'swarm archived' },
        { id: 'a5', reason: 'moved' },
        { id: 'a6', reason: 'awake' },
        { id: 'a7', reason: 'error' },
      ],
      failed: [{ id: 'a8', error: 'start failed' }],
    })
    const w = resultWords(r)
    expect(w.headline).toBe('Woke 2 minds.')
    expect(w.detail[0]).toBe('Skipped 5 minds: a3 (deleted), a4 (its swarm is archived), a5 (moved), a6 (not stopped (already awake)), a7 (not stopped (error)).')
    expect(w.detail[1]).toBe('1 mind did not wake: a8 (start failed).')
    expect(w.ok).toBe(false)
  })

  it('on with nothing pending: a calm "Nothing to wake"', () => {
    const w = resultWords(readResult('on', { state: 'on', since: null, woken: [], skipped: [], failed: [] }))
    expect(w).toMatchObject({ headline: 'Nothing to wake.', nothing: true, ok: true })
  })

  it('reads counts, ids and records; anything else is an empty tally, never a guess', () => {
    expect(tally(3)).toEqual({ count: 3, minds: [] })
    expect(tally(['a'])).toEqual({ count: 1, minds: [{ id: 'a' }] })
    expect(tally('nope')).toEqual({ count: 0, minds: [] })
    expect(readStatus({ state: 'maybe' })).toBeNull()
    expect(readStatus({ state: 'on', since: null, by: null })).toEqual({ state: 'on', since: null, by: null })
  })
})

/** A client that records every method called on it. Network methods resolve with `answers[name]`. */
function recordingClient(opts: { authed: boolean; power: () => unknown; me?: unknown }) {
  const calls: string[] = []
  const listeners = new Set<(e: HiveEvent) => void>()
  const conn = new Set<(s: string) => void>()
  let authed = opts.authed
  const base: Record<string, unknown> = {
    mode: 'live',
    needsAuth: () => (calls.push('needsAuth'), !authed),
    login: async () => {
      calls.push('login')
      authed = true
    },
    trySso: async () => (calls.push('trySso'), false),
    me: async () => (calls.push('me'), opts.me ?? { principal: 'user:operator', kind: 'password', role: 'admin', expires_at: null, person: null }),
    getPower: async () => (calls.push('getPower'), opts.power()),
    setPower: async (b: { state: string }) => (calls.push(`setPower:${b.state}`), b.state === 'on' ? { state: 'on', since: 'n', woken: ['a1'], skipped: [], failed: [] } : { state: 'off', since: 'n', stopped: 1, failed: [] }),
    connect: () => calls.push('connect'),
    disconnect: () => calls.push('disconnect'),
    subscribe: (fn: (e: HiveEvent) => void) => (listeners.add(fn), () => listeners.delete(fn)),
    onConnection: (fn: (s: string) => void) => (conn.add(fn), () => conn.delete(fn)),
  }
  const client = new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p as string]
      if (typeof p !== 'string' || p === 'then') return undefined
      // the person-session observer is optional and synchronous: this client has none (it is not a network method)
      if (p === 'authContext' || p === 'onAuthChange') return undefined
      // every other method: a read or write the gate must keep from the wire
      return async () => {
        calls.push(p)
        return []
      }
    },
  }) as unknown as HiveClient
  return { client, calls, emit: (e: unknown) => listeners.forEach((f) => f(e as HiveEvent)), open: (s: string) => conn.forEach((f) => f(s)) }
}

const network = (calls: string[]) => calls.filter((c) => !['needsAuth', 'connect', 'disconnect'].includes(c))

describe('the gate: nothing but power, sign-in and the socket while off', () => {
  beforeEach(() => usePower.setState({ ...INITIAL, dialog: null }))

  it('while off, no other call reaches the client, and each is refused at once as hive_off', async () => {
    const r = recordingClient({ authed: true, power: () => ({ state: 'off', since: 's', by: 'user:operator', minds_in_snapshot: 3 }) })
    const c = installPower(r.client, {})
    await usePower.getState().load()
    expect(screenOf(usePower.getState())).toBe('off')
    for (const m of ['getHive', 'listAgents', 'listSwarms', 'getModels', 'usage', 'listGoals', 'uiPrefs', 'askThreads', 'health'] as const) {
      const fn = (c as unknown as Record<string, () => Promise<unknown>>)[m]
      await expect(fn()).rejects.toMatchObject({ status: 503, code: 'hive_off' })
    }
    // polling: twenty more ticks of a poller, still nothing on the wire
    for (let i = 0; i < 20; i++) await (c as unknown as { usage: () => Promise<unknown> }).usage().catch(() => undefined)
    expect(network(r.calls)).toEqual(['me', 'getPower'])
    expect(r.calls).toContain('connect') // the events socket stays open while off
    expect(powerGate().refused.length).toBeGreaterThanOrEqual(29)
  })

  it('every method open while off is power, sign-in, or makes no request', () => {
    expect([...OPEN_WHILE_OFF].sort()).toEqual(['authContext', 'authMethods', 'connect', 'disconnect', 'flowStudioUrl', 'getPower', 'login', 'logout', 'me', 'mode', 'needsAuth', 'onAuthChange', 'onConnection', 'setPower', 'subscribe', 'trySso'])
  })

  it('a call made before power is known waits for the read, then goes through when on', async () => {
    const r = recordingClient({ authed: true, power: () => ({ state: 'on', since: null, by: null, minds_in_snapshot: 0 }) })
    const c = installPower(r.client, {}) as unknown as { getHive: () => Promise<unknown> }
    await expect(c.getHive()).resolves.toEqual([])
    expect(network(r.calls)).toEqual(['me', 'getPower', 'getHive'])
  })

  it('sign-in reaches the off screen: the hive store boots, signs in, and only sign-in and power touch the hive', async () => {
    const r = recordingClient({ authed: false, power: () => ({ state: 'off', since: 's', by: 'user:operator' }), me: { principal: 'user:p_rowan', kind: 'sso', role: 'member', expires_at: null, person: null } })
    const c = installPower(r.client, {})
    await useHive.getState().init(c)
    // signed out: nothing read yet, power unknown, no off screen (the Login shows)
    expect(network(r.calls)).toEqual(['trySso'])
    expect(screenOf(usePower.getState())).toBe('none')
    await c.login('pw')
    await useHive.getState().hydrate()
    expect(screenOf(usePower.getState())).toBe('off')
    expect(usePower.getState().admin).toBe(false) // a member: "The hive is resting", no button
    expect(canPress(usePower.getState())).toBe(false)
    expect(network(r.calls)).toEqual(['trySso', 'login', 'me', 'getPower'])
    expect(useHive.getState().ready).toBe(false)
  })

  it('hive.power on: everything opens again and the page reads it all afresh', async () => {
    let state = 'off'
    const r = recordingClient({ authed: true, power: () => ({ state, since: 's', by: 'user:operator' }) })
    let woken = 0
    const c = installPower(r.client, { woken: () => woken++ }) as unknown as { getHive: () => Promise<unknown> }
    await usePower.getState().load()
    await expect(c.getHive()).rejects.toBeInstanceOf(ApiError)
    state = 'on'
    r.emit({ type: 'hive.power', state: 'on', since: 't' })
    expect(woken).toBe(1)
    await expect(c.getHive()).resolves.toEqual([])
  })

  it('a GET that started before an event never overrides the event', async () => {
    let release: (v: unknown) => void = () => undefined
    const r = recordingClient({ authed: true, power: () => new Promise((res) => (release = res)) })
    installPower(r.client, {})
    const loading = usePower.getState().load()
    await Promise.resolve()
    await Promise.resolve()
    r.emit({ type: 'hive.power', state: 'off', since: 'e' })
    release({ state: 'on', since: null, by: null })
    await loading
    expect(usePower.getState().gate).toBe('off')
  })

  it('live host cf8bd9c: a lost answer, then a replay that redid the cut-short run with DIFFERENT counts, then a GET refetch shown', async () => {
    let power: Record<string, unknown> = { state: 'off', since: 's', by: 'user:operator', minds_in_snapshot: 5 }
    const ids: string[] = []
    let calls = 0
    const r = recordingClient({ authed: true, power: () => power })
    ;(r.client as unknown as Record<string, unknown>).setPower = async (b: { state: string; operation_id: string }) => {
      r.calls.push(`setPower:${b.state}`)
      ids.push(b.operation_id)
      calls++
      // the first run was cut short: no answer reaches us, and the hive is still off
      if (calls === 1) throw new ApiError(0, 'network', 'lost')
      // the replay redoes the run: its counts differ from what the first run would have said; the hive is now on
      power = { state: 'on', since: 'n2', by: 'user:operator', minds_in_snapshot: 0 }
      return { state: 'on', since: 'n2', woken: ['a1', 'a2', 'a3'], skipped: [{ id: 'a4', reason: 'awake' }], failed: [{ id: 'a5', error: 'start failed' }] }
    }
    installPower(r.client, {})
    await usePower.getState().load()
    await usePower.getState().press()
    // lost: the GET says still off, so the light goes back out, calmly, and the button returns
    expect(screenOf(usePower.getState())).toBe('off')
    expect(usePower.getState().note).toMatch(/could not confirm/)
    expect(canPress(usePower.getState())).toBe(true)
    await usePower.getState().press()
    // the same operation id both times (the host is idempotent on it, and redoes a cut-short run)
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(ids[1])
    usePower.getState().dispatch({ type: 'lit' })
    // the replay's answer is the result shown
    const w = resultWords(usePower.getState().result!)
    expect(w.headline).toBe('Woke 3 minds.')
    expect(w.detail).toEqual(['Skipped 1 mind: a4 (not stopped (already awake)).', '1 mind did not wake: a5 (start failed).'])
    // and GET /api/hive/power is read again after the answer: the true state is what the page shows
    await vi.waitFor(() => expect(usePower.getState().snapshot).toBe(0))
    const after = r.calls.slice(r.calls.lastIndexOf('setPower:on'))
    expect(after).toContain('getPower')
    expect(usePower.getState().gate).toBe('on')
    expect(usePower.getState().since).toBe('n2')
  })

  it('the power button: POST on with an operation id, the report waits for the light-up', async () => {
    let state = 'off'
    const r = recordingClient({ authed: true, power: () => ({ state, since: 's', by: 'user:operator', minds_in_snapshot: state === 'off' ? 1 : 0 }) })
    const set = (r.client as unknown as { setPower: (b: { state: string }) => Promise<unknown> }).setPower
    ;(r.client as unknown as Record<string, unknown>).setPower = async (b: { state: string }) => {
      state = b.state
      return set(b)
    }
    installPower(r.client, {})
    await usePower.getState().load()
    await usePower.getState().press()
    expect(r.calls).toContain('setPower:on')
    expect(screenOf(usePower.getState())).toBe('lighting')
    usePower.getState().dispatch({ type: 'lit' })
    expect(screenOf(usePower.getState())).toBe('report')
    expect(resultWords(usePower.getState().result!).headline).toBe('Woke 1 mind.')
  })
})
