import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOGOUT_WAIT_MS, LiveClient } from '../api/live'
import { useHive } from '../store/store'
import { confirmShowing } from '../ui/confirm'
import { askConfirmBound, bindEpoch, currentEpoch, guard, onIdentityChange, STALE } from './identityEpoch'

/**
 * Stand-in r1 P1 + P3: the identity epoch under the REAL LiveClient and the real store, for each way a sign-in ends or
 * changes in the browser: this tab's sign-out, another tab's sign-out or sign-in (the `storage` event on the token key),
 * and terminal session expiry on the events socket (close 4401 / 1008). For each: the epoch bumps and every clear hook
 * runs synchronously inside the change, the bound confirmation is answered "no" at once, and an earlier person's
 * promises that settle afterwards (or in the microtask gap after guard's check) never write.
 * INVENTED tokens; fetch, storage, window and WebSocket are stand-ins. No hive.
 */

const TOKEN_KEY = 'omegadots.hive.token'
const A = 'tok-a-invented'
const B = 'tok-b-invented'

class FakeSocket {
  static OPEN = 1
  static made: FakeSocket[] = []
  readyState = 0
  closed = false
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  constructor(readonly url: URL) {
    FakeSocket.made.push(this)
  }
  send() {}
  close() {
    this.closed = true
  }
  token() {
    return this.url.searchParams.get('token')
  }
}

let listeners: ((e: StorageEvent) => void)[] = []
let store: Map<string, string>
const clients: LiveClient[] = []
const offs: (() => void)[] = []

function defer<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)))
  return { promise, resolve, reject }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** What the browser does in THIS tab when ANOTHER tab writes: storage changes, then the event fires here. */
function otherTabSets(token: string | null) {
  if (token === null) store.delete(TOKEN_KEY)
  else store.set(TOKEN_KEY, token)
  for (const l of listeners) l({ key: TOKEN_KEY, newValue: token } as StorageEvent)
}

beforeEach(() => {
  listeners = []
  store = new Map([[TOKEN_KEY, A]])
  FakeSocket.made = []
  vi.stubGlobal('window', {
    location: { href: 'https://hive.invalid/', search: '' },
    addEventListener: (type: string, l: (e: StorageEvent) => void) => type === 'storage' && listeners.push(l),
    removeEventListener: (type: string, l: (e: StorageEvent) => void) => {
      if (type === 'storage') listeners = listeners.filter((x) => x !== l)
    },
  })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/api/auth/login')) return json({ token: B })
      if (String(url).endsWith('/api/auth/logout')) return json({})
      return json([]) // every read: an empty hive (invented)
    }),
  )
})
afterEach(() => {
  for (const off of offs.splice(0)) off()
  for (const c of clients.splice(0)) {
    c.disconnect()
    c.dispose()
  }
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A tab signed in as A on a real LiveClient, hydrated by the real store, with its events socket open. */
async function signedInLive(): Promise<{ c: LiveClient; ws: FakeSocket }> {
  const c = new LiveClient('https://hive.invalid')
  clients.push(c)
  await useHive.getState().init(c)
  for (let i = 0; i < 20; i++) await Promise.resolve()
  const ws = FakeSocket.made.at(-1)!
  expect(ws.token()).toBe(A)
  ws.readyState = FakeSocket.OPEN
  ws.onopen?.({})
  expect(useHive.getState().connection).toBe('open')
  return { c, ws }
}

interface Seen {
  epochBumped: boolean
  cleared: boolean
  confirmGone: boolean
  bindingStale: boolean
}

/**
 * The whole lifecycle around one identity-ending `change`: A's state on screen (a clear hook), A's open confirmation,
 * A's late answers. The change is made in the microtask between guard's check of A's first answer and the consumer
 * writing it (stand-in r1 P2 ordering); A's second answer and A's late failure settle after the change.
 */
async function lifecycle(change: (h: { c: LiveClient; ws: FakeSocket }) => void) {
  const h = await signedInLive()
  const before = currentEpoch()
  let shown: string | null = 'A’s invented words'
  offs.push(onIdentityChange(() => (shown = null)))
  const binding = bindEpoch()
  const answer = askConfirmBound('Forget A’s invented notes?', 'Forget', { danger: true })
  expect(confirmShowing()).toBe('Forget A’s invented notes?')

  const first = defer<string>()
  const second = defer<string>()
  const failing = defer<string>()
  const writes: string[] = []
  const consume = async (p: Promise<string>) => {
    const v = await guard(p, binding)
    if (v !== STALE) binding.commit(() => writes.push(v))
    return v
  }
  const c1 = consume(first.promise)
  const c2 = consume(second.promise)
  const c3 = consume(failing.promise)

  let seen: Seen | null = null
  first.resolve('A’s invented first answer')
  queueMicrotask(() => {
    change(h)
    // read synchronously, in the same run as the change, before any later microtask or render
    seen = { epochBumped: currentEpoch() > before, cleared: shown === null, confirmGone: confirmShowing() === null, bindingStale: !binding.current() }
  })
  const firstResult = await c1
  second.resolve('A’s invented second answer')
  failing.reject(new Error('A’s invented failure'))
  expect(seen).toEqual({ epochBumped: true, cleared: true, confirmGone: true, bindingStale: true })
  expect(firstResult).toBe('A’s invented first answer') // guard's own check ran before the change ...
  expect(await c2).toBe(STALE)
  expect(await c3).toBe(STALE)
  expect(writes).toEqual([]) // ... and still nothing of A's was written
  expect(await answer).toBe(false)
  return h
}

describe('identity epoch under the real LiveClient: every way a sign-in ends', () => {
  it('this tab signs out (logout): the identity ends once the hive has ended the session, and nothing of A lands after', async () => {
    const h = await signedInLive()
    const before = currentEpoch()
    let shown: string | null = 'A’s invented words'
    offs.push(onIdentityChange(() => (shown = null)))
    const binding = bindEpoch()
    const answer = askConfirmBound('Forget A’s invented notes?', 'Forget', { danger: true })
    const server = defer<Response>()
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => (calls.push({ url, init }), server.promise)))
    const late = defer<string>()
    const writes: string[] = []
    const consume = (async () => {
      const v = await guard(late.promise, binding)
      if (v !== STALE) binding.commit(() => writes.push(v))
      return v
    })()
    const out = h.c.logout() as Promise<void>
    // still waiting for the hive: this tab has not yet treated the person as gone
    expect(currentEpoch()).toBe(before)
    expect(shown).not.toBeNull()
    expect(calls.map((x) => x.url.endsWith('/api/auth/logout'))).toEqual([true])
    server.resolve(new Response(null, { status: 204 }))
    await out
    expect({ epochBumped: currentEpoch() > before, cleared: shown === null, confirmGone: confirmShowing() === null, bindingStale: !binding.current() }).toEqual({ epochBumped: true, cleared: true, confirmGone: true, bindingStale: true })
    late.resolve('A’s invented late answer')
    expect(await consume).toBe(STALE)
    expect(writes).toEqual([])
    expect(await answer).toBe(false)
    expect(h.c.needsAuth()).toBe(true)
    expect(useHive.getState().connection).toBe('unauthorized')
  })

  it('sign-out always tells the hive, even with no bearer (a cookie-only session ends too)', async () => {
    const h = await signedInLive()
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => (calls.push({ url, init }), new Response(null, { status: 204 }))))
    await h.c.logout()
    calls.length = 0
    await h.c.logout() // no token now: still POSTs, with the cookie and no Authorization
    expect(calls).toHaveLength(1)
    expect(calls[0].url.endsWith('/api/auth/logout')).toBe(true)
    expect(calls[0].init?.credentials).toBe('same-origin')
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBeUndefined()
  })

  it('a hive that never answers still signs this tab out after LOGOUT_WAIT_MS', async () => {
    const h = await signedInLive()
    const before = currentEpoch()
    vi.useFakeTimers()
    try {
      vi.stubGlobal('fetch', vi.fn((_u: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))))
      const out = h.c.logout() as Promise<void>
      await vi.advanceTimersByTimeAsync(LOGOUT_WAIT_MS - 1)
      expect(currentEpoch()).toBe(before)
      await vi.advanceTimersByTimeAsync(1)
      await out
      expect(currentEpoch()).toBeGreaterThan(before)
      expect(h.c.needsAuth()).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('another tab signs out (storage event, token removed)', async () => {
    const { c } = await lifecycle(() => otherTabSets(null))
    expect(c.needsAuth()).toBe(true)
  })

  it('another tab signs in as someone else (storage event, token replaced)', async () => {
    const { c } = await lifecycle(() => otherTabSets(B))
    expect(c.needsAuth()).toBe(false)
    expect(FakeSocket.made.at(-1)!.token()).toBe(B)
  })

  it('the events socket reports the session expired (close 4401)', async () => {
    const { c } = await lifecycle(({ ws }) => ws.onclose?.({ code: 4401 }))
    expect(c.needsAuth()).toBe(true)
    expect(store.has(TOKEN_KEY)).toBe(false)
    expect(useHive.getState().connection).toBe('unauthorized')
  })

  it('the events socket closes on policy (close 1008)', async () => {
    const { c } = await lifecycle(({ ws }) => ws.onclose?.({ code: 1008 }))
    expect(c.needsAuth()).toBe(true)
    expect(useHive.getState().connection).toBe('unauthorized')
  })
})

describe('events-socket expiry: only the bearer it was opened under', () => {
  it('a socket from before a re-login on this tab expiring never signs the new person out', async () => {
    const { c, ws } = await signedInLive()
    await c.login('invented')
    expect(store.get(TOKEN_KEY)).toBe(B)
    const e = currentEpoch()
    let fired = 0
    offs.push(onIdentityChange(() => fired++))
    ws.onclose?.({ code: 4401 })
    expect(store.get(TOKEN_KEY)).toBe(B)
    expect(c.needsAuth()).toBe(false)
    expect(currentEpoch()).toBe(e)
    expect(fired).toBe(0)
    expect(useHive.getState().connection).not.toBe('unauthorized')
  })

  it('an ordinary drop (1006) is not an identity change: no bump, no clear, reconnecting', async () => {
    const { c, ws } = await signedInLive()
    const e = currentEpoch()
    let fired = 0
    offs.push(onIdentityChange(() => fired++))
    ws.onclose?.({ code: 1006 })
    expect(currentEpoch()).toBe(e)
    expect(fired).toBe(0)
    expect(c.needsAuth()).toBe(false)
    expect(useHive.getState().connection).toBe('reconnecting')
  })
})
