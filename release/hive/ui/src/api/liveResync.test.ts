// Purpose: tests when LiveClient asks for a re-read (onResync), against a stand-in socket that drops and reconnects.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveClient, parseStreamPosition } from './live'

/**
 * Flagship review #111 ("the UI doesn't re-read state after a WebSocket reconnect"): when what this client read may miss
 * something the live stream said, it says so once (onResync): the socket came back after a gap, a read predates the
 * socket's subscription (its Hive-Stream is older than the hello's stream), or an answer lands from before it. The
 * socket is a stand-in that drops and reconnects; fetch answers with the position the test sets. No hive.
 */

const TOKEN_KEY = 'omegadots.hive.token'
const A = 'a1b2c3d4e5f60718'   // one hive process's stream
const B = '0f1e2d3c4b5a6978'   // the next one, after a restart

class FakeSocket {
  static OPEN = 1
  static made: FakeSocket[] = []
  readyState = 0
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  constructor(readonly url: URL) {
    FakeSocket.made.push(this)
  }
  send() {}
  close() {}
  /** the hive accepts and greets: subscribed from `stream` on (absent: an older hive) */
  greet(stream?: { id: string; at: number }) {
    this.readyState = FakeSocket.OPEN
    this.onopen?.({})
    this.onmessage?.({ data: JSON.stringify({ type: 'hello', at: 'now', hive: {}, ...(stream ? { stream } : {}) }) })
  }
  drop(code = 1006) {
    this.readyState = 3
    this.onclose?.({ code })
  }
}

let position: string | null
let store: Map<string, string>
let storageListeners: ((e: StorageEvent) => void)[]
const clients: LiveClient[] = []

const at = (id: string, n: number) => { position = `${id} ${n}` }
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

function defer<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.made = []
  position = null
  storageListeners = []
  store = new Map([[TOKEN_KEY, 'tok-invented']])
  vi.stubGlobal('window', {
    location: { href: 'https://hive.invalid/', search: '' },
    addEventListener: (type: string, l: (e: StorageEvent) => void) => type === 'storage' && storageListeners.push(l),
    removeEventListener: () => undefined,
  })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('WebSocket', FakeSocket)
  // every answer carries the position the test last set (none: an older hive)
  vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json', ...(position ? { 'hive-stream': position } : {}) } })))
})
afterEach(() => {
  for (const c of clients.splice(0)) {
    c.disconnect()
    c.dispose()
  }
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/** A signed-in client with its events socket made (not yet greeted) and a count of the resyncs it asked for. */
async function connected(): Promise<{ c: LiveClient; asked: () => number }> {
  const c = new LiveClient('https://hive.invalid')
  clients.push(c)
  let n = 0
  c.onResync(() => n++)
  c.connect()
  await settle()   // the kind check (GET /api/auth/methods) answers, then the socket is made
  expect(FakeSocket.made.length).toBeGreaterThan(0)
  return { c, asked: () => n }
}
const socket = () => FakeSocket.made.at(-1)!

describe('a first hello', () => {
  it('asks nothing when every read is as new as the subscription', async () => {
    at(A, 5)
    const { c, asked } = await connected()
    await c.getHive()
    socket().greet({ id: A, at: 5 })
    await settle()
    expect(asked()).toBe(0)
  })

  it('asks once when a read predates the subscription (frames were published in between)', async () => {
    at(A, 5)
    const { c, asked } = await connected()
    await c.getHive()
    await c.listAgents()
    socket().greet({ id: A, at: 7 })
    await settle()
    expect(asked()).toBe(1)
  })

  it('asks once when a read came from another stream (the hive restarted in between)', async () => {
    at(A, 5)
    const { c, asked } = await connected()
    await c.getHive()
    socket().greet({ id: B, at: 0 })
    await settle()
    expect(asked()).toBe(1)
  })

  it('from an older hive (no positions) asks nothing: there is nothing to compare', async () => {
    const { c, asked } = await connected()
    await c.getHive()
    socket().greet()
    await settle()
    expect(asked()).toBe(0)
  })
})

describe('a socket that drops and reconnects', () => {
  it('asks once on the next hello, even with nothing read and nothing newer', async () => {
    at(A, 5)
    const { asked } = await connected()
    socket().greet({ id: A, at: 5 })
    await settle()
    expect(asked()).toBe(0)
    const first = socket()
    first.drop(1006)
    await vi.advanceTimersByTimeAsync(20_000)   // the reconnect backoff
    expect(socket()).not.toBe(first)
    socket().greet({ id: A, at: 5 })
    await settle()
    expect(asked()).toBe(1)
  })

  it('asks after the hive closed it for falling behind (1013), and again after every later gap', async () => {
    at(A, 5)
    const { asked } = await connected()
    socket().greet({ id: A, at: 5 })
    socket().drop(1013)
    await vi.advanceTimersByTimeAsync(20_000)
    socket().greet({ id: A, at: 1500 })
    await settle()
    expect(asked()).toBe(1)
    socket().drop(1012)
    await vi.advanceTimersByTimeAsync(20_000)
    socket().greet({ id: B, at: 3 })
    await settle()
    expect(asked()).toBe(2)
  })

  it('from an older hive (no positions) still asks after the gap', async () => {
    const { asked } = await connected()
    socket().greet()
    socket().drop()
    await vi.advanceTimersByTimeAsync(20_000)
    socket().greet()
    await settle()
    expect(asked()).toBe(1)
  })
})

describe('an answer that lands while subscribed', () => {
  it('asks once when it was read before the subscription; one more such answer asks nothing more', async () => {
    at(A, 4)
    const { c, asked } = await connected()
    const slow = [defer<Response>(), defer<Response>()]
    const fetchMock = vi.mocked(fetch)
    for (const d of slow) fetchMock.mockImplementationOnce(() => d.promise)
    const one = c.listAgents()
    const two = c.listSwarms()
    socket().greet({ id: A, at: 9 })
    await settle()
    expect(asked()).toBe(0)
    const old = () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json', 'hive-stream': `${A} 4` } })
    slow[0].resolve(old())
    await one
    await settle()
    expect(asked()).toBe(1)
    // sent before that resync was asked: the resync reads it again already
    slow[1].resolve(old())
    await two
    await settle()
    expect(asked()).toBe(1)
  })

  it('asks nothing when it is as new as the subscription or newer', async () => {
    at(A, 9)
    const { c, asked } = await connected()
    socket().greet({ id: A, at: 9 })
    await c.listAgents()
    at(A, 12)
    await c.listSwarms()
    await settle()
    expect(asked()).toBe(0)
  })
})

describe('a sign-in change', () => {
  it('starts over: the new sign-in first hello follows no gap of its own', async () => {
    at(A, 5)
    const { asked } = await connected()
    socket().greet({ id: A, at: 5 })
    const before = socket()
    store.set(TOKEN_KEY, 'tok-other-invented')
    for (const l of storageListeners) l({ key: TOKEN_KEY, newValue: 'tok-other-invented' } as StorageEvent)
    await settle()
    expect(socket()).not.toBe(before)
    socket().greet({ id: A, at: 5 })
    await settle()
    expect(asked()).toBe(0)
  })
})

describe('parseStreamPosition', () => {
  it('reads the header the hive sends and nothing else', () => {
    expect(parseStreamPosition(`${A} 42`)).toEqual({ id: A, at: 42 })
    for (const bad of [null, '', A, `${A} -1`, `${A} 1.5`, `nothex0123456789 3`, `${A}  3`, `${A} 3 x`]) expect(parseStreamPosition(bad)).toBeNull()
  })
})
