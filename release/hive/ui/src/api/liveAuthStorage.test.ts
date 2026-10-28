import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { LiveClient } from './live'

// Kimi K1 + Surface confirmation notes (a)-(d): another tab's sign-in or sign-out reaches this tab's LiveClient
// through the window 'storage' event. INVENTED tokens; fetch, storage, window and WebSocket are stand-ins.

const TOKEN_KEY = 'omegadots.hive.token'
const OLD = 'tok-old-invented'
const NEW = 'tok-new-invented'

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
let writes: string[] = []
let seenAuth: (string | null)[] = []

function storageEvent(key: string | null, newValue: string | null) {
  for (const l of listeners) l({ key, newValue } as StorageEvent)
}
/** What the browser does in THIS tab when ANOTHER tab writes: storage changes, then the event fires here. */
function otherTabSets(token: string | null) {
  if (token === null) store.delete(TOKEN_KEY)
  else store.set(TOKEN_KEY, token)
  storageEvent(TOKEN_KEY, token)
}

beforeEach(() => {
  listeners = []
  writes = []
  seenAuth = []
  store = new Map([[TOKEN_KEY, OLD]])
  FakeSocket.made = []
  vi.stubGlobal('window', {
    location: { href: 'https://hive.invalid/', search: '' },
    addEventListener: (type: string, l: (e: StorageEvent) => void) => type === 'storage' && listeners.push(l),
    removeEventListener: (type: string, l: (e: StorageEvent) => void) => { if (type === 'storage') listeners = listeners.filter((x) => x !== l) },
  })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { writes.push(`set ${k}`); store.set(k, v) },
    removeItem: (k: string) => { writes.push(`remove ${k}`); store.delete(k) },
  })
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    seenAuth.push((init.headers as Record<string, string>).Authorization ?? null)
    return new Response(JSON.stringify({ name: 'invented' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function client() {
  const c = new LiveClient('https://hive.invalid')
  // these tests predate localowner-ui r1.1's kind check: an ordinary hive (token in the address)
  ;(c as unknown as { localOwner: boolean | null }).localOwner = false
  const emits = { n: 0 }
  c.onAuthChange(() => emits.n++)
  const states: string[] = []
  c.onConnection((s) => states.push(s))
  return { c, emits, states }
}

describe('cross-tab sign-out: (a) a cleared token routes exactly like a current-bearer 401', () => {
  it('another tab logs out: null token, new identity, one emit, unauthorized', async () => {
    const { c, emits, states } = client()
    const before = c.authContext()
    otherTabSets(null)
    expect(c.authContext()).not.toBe(before)
    expect(emits.n).toBe(1)
    expect(states.at(-1)).toBe('unauthorized')
    await c.getHive()
    expect(seenAuth.at(-1)).toBeNull() // no bearer is sent any more
  })
  it('another tab clears storage (key null): same handling', () => {
    const { c, emits, states } = client()
    const before = c.authContext()
    store.clear()
    storageEvent(null, null)
    expect(c.authContext()).not.toBe(before)
    expect(emits.n).toBe(1)
    expect(states.at(-1)).toBe('unauthorized')
  })
  it('matches what a current-bearer 401 does to this tab', async () => {
    const viaStorage = client()
    otherTabSets(null)
    store.set(TOKEN_KEY, OLD)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'log in first' } }), { status: 401 })))
    const via401 = client()
    await via401.c.getHive().catch(() => undefined)
    for (const x of [viaStorage, via401]) {
      expect(x.emits.n).toBe(1)
      expect(x.states.at(-1)).toBe('unauthorized')
    }
  })
})

describe("Correction 2 (Surface re-confirmation): a cleared token follows this tab's own logout()", () => {
  it('the open socket is silenced and closed, no old-socket frame reaches subscribers, no reconnect is scheduled', () => {
    vi.useFakeTimers()
    try {
      const { c, states } = client()
      const events: unknown[] = []
      c.subscribe((e) => events.push(e))
      c.connect()
      const old = FakeSocket.made[0]
      old.readyState = FakeSocket.OPEN
      old.onopen?.({})
      expect(states.at(-1)).toBe('open')
      old.onmessage?.({ data: JSON.stringify({ type: 'agent.updated', id: 'a_before' }) })
      expect(events).toHaveLength(1)
      otherTabSets(null)
      expect(old.closed).toBe(true)
      expect(old.onmessage).toBeNull()
      expect(old.onclose).toBeNull()
      expect(old.onopen).toBeNull()
      expect(states.at(-1)).toBe('unauthorized')
      // a frame arriving after the clear: the browser calls whatever onmessage now holds, which is nothing
      old.onmessage?.({ data: JSON.stringify({ type: 'agent.updated', id: 'a_after' }) })
      expect(events).toHaveLength(1)
      // the close arrives later: nothing is attached to it, the state stays unauthorized and nothing reconnects
      old.onclose?.({ code: 1006 })
      vi.advanceTimersByTime(60_000)
      expect(vi.getTimerCount()).toBe(0) // no reconnect, no ping
      expect(FakeSocket.made).toHaveLength(1)
      expect(states.at(-1)).toBe('unauthorized')
    } finally {
      vi.useRealTimers()
    }
  })
  it('a pending reconnect is cancelled too', () => {
    vi.useFakeTimers()
    try {
      const { c } = client()
      c.connect()
      FakeSocket.made[0].onclose?.({ code: 1006 }) // the socket dropped: a reconnect is scheduled
      expect(vi.getTimerCount()).toBe(1)
      otherTabSets(null)
      expect(vi.getTimerCount()).toBe(0)
      vi.advanceTimersByTime(60_000)
      expect(FakeSocket.made).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
  it('same end state as this tab calling logout() itself', async () => {
    const viaStorage = client()
    viaStorage.c.connect()
    otherTabSets(null)
    store.set(TOKEN_KEY, OLD)
    const viaLogout = client()
    viaLogout.c.connect()
    await viaLogout.c.logout() // sign-out waits for the hive to end the session (b203496 pairing)
    for (const x of [viaStorage, viaLogout]) {
      expect(x.emits.n).toBe(1)
      expect(x.states.at(-1)).toBe('unauthorized')
    }
    expect(FakeSocket.made.map((s) => s.closed)).toEqual([true, true])
  })
})

describe('dispose()', () => {
  it('removes the storage listener: a retired client neither emits nor reopens on a storage event', () => {
    const { c, emits } = client()
    c.connect()
    const before = c.authContext()
    c.dispose()
    otherTabSets(NEW)
    otherTabSets(null)
    expect(emits.n).toBe(0)
    expect(c.authContext()).toBe(before)
    expect(FakeSocket.made).toHaveLength(1)
    expect(FakeSocket.made[0].closed).toBe(false)
  })
  it('only its own listener: another live client still hears the event', () => {
    const a = client()
    const b = client()
    a.c.dispose()
    otherTabSets(null)
    expect(a.emits.n).toBe(0)
    expect(b.emits.n).toBe(1)
  })
})

describe('cross-tab sign-in: (b) a changed token reopens the events socket under the new bearer', () => {
  it('new identity, one emit, the old socket is closed and silenced, a new one opens with the new token', async () => {
    const { c, emits } = client()
    const events: unknown[] = []
    c.subscribe((e) => events.push(e))
    c.connect()
    expect(FakeSocket.made.map((s) => s.token())).toEqual([OLD])
    const old = FakeSocket.made[0]
    const before = c.authContext()
    otherTabSets(NEW)
    expect(c.authContext()).not.toBe(before)
    expect(emits.n).toBe(1)
    expect(old.closed).toBe(true)
    expect(old.onmessage).toBeNull()
    expect(old.onclose).toBeNull()
    expect(FakeSocket.made.map((s) => s.token())).toEqual([OLD, NEW])
    // a frame from the new socket arrives; nothing from the old bearer can
    FakeSocket.made[1].onmessage?.({ data: JSON.stringify({ type: 'agent.updated', id: 'a_invented' }) })
    expect(events).toHaveLength(1)
    await c.getHive()
    expect(seenAuth.at(-1)).toBe(`Bearer ${NEW}`)
  })
  it('a socket that was not wanted is not opened', () => {
    const { c } = client()
    otherTabSets(NEW)
    expect(FakeSocket.made).toHaveLength(0)
    expect(c.authContext()).toBeTruthy()
  })
  it('signed out here, then signed in in another tab: the wanted socket opens under the new token', () => {
    store.delete(TOKEN_KEY)
    const { c } = client()
    c.connect()
    expect(FakeSocket.made).toHaveLength(0)
    otherTabSets(NEW)
    expect(FakeSocket.made.map((s) => s.token())).toEqual([NEW])
  })
  it('an in-flight me() that started before the other tab changed the token is refused, not delivered', async () => {
    let release!: () => void
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((res) => {
      release = () => res(new Response(JSON.stringify({ principal: 'user:operator', auth_session_ref: 'as1_' + 'a'.repeat(64) }), { status: 200 }))
    })))
    const { c } = client()
    const pending = c.me()
    otherTabSets(NEW)
    release()
    const err = await pending.then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toMatchObject({ status: 409, code: 'auth_context_changed' })
  })
})

describe('(c) the listener never writes storage, (d) same-value and unrelated events change nothing', () => {
  it('no storage writes for sign-out, sign-in or clear events', () => {
    const { c } = client()
    c.connect()
    otherTabSets(NEW)
    otherTabSets(null)
    store.clear()
    storageEvent(null, null)
    otherTabSets(OLD)
    expect(writes).toEqual([]) // only the other tab (otherTabSets) touched storage
  })
  it('a same-value event mints no identity, emits nothing and keeps the socket', () => {
    const { c, emits, states } = client()
    c.connect()
    const before = c.authContext()
    const statesBefore = states.length
    storageEvent(TOKEN_KEY, OLD)
    storageEvent(null, null) // e.g. clear() of other keys raced by a re-set: storage still holds OLD
    expect(c.authContext()).toBe(before)
    expect(emits.n).toBe(0)
    expect(FakeSocket.made).toHaveLength(1)
    expect(FakeSocket.made[0].closed).toBe(false)
    expect(states.length).toBe(statesBefore)
  })
  it('other keys are ignored', () => {
    const { c, emits } = client()
    const before = c.authContext()
    storageEvent('omegadots.something.else', 'x')
    expect(c.authContext()).toBe(before)
    expect(emits.n).toBe(0)
  })
  it('a second same-value event after a change does nothing more', () => {
    const { emits } = client()
    otherTabSets(NEW)
    storageEvent(TOKEN_KEY, NEW)
    expect(emits.n).toBe(1)
  })
})
