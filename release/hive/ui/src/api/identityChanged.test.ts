import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, IDENTITY_CHANGED, isIdentityChanged } from './client'
import { LiveClient } from './live'

/**
 * professional-release r1.1 (stand-in P1, the class fix): a request records the sign-in it was sent under. When the
 * client's sign-in changes before the answer is delivered, the answer (success or failure) is never delivered: it is
 * ApiError 409 `identity_changed`, so a multi-step flow stops at its next await. INVENTED tokens; fetch, storage and
 * window are stand-ins (as liveAuthStorage.test.ts).
 */
const TOKEN_KEY = 'omegadots.hive.token'
let listeners: ((e: StorageEvent) => void)[] = []
let store: Map<string, string>
let release: ((r: Response) => void)[] = []
let sent: { url: string; auth: string | null; method: string; init: RequestInit }[] = []

const otherTabSets = (token: string | null) => {
  if (token === null) store.delete(TOKEN_KEY)
  else store.set(TOKEN_KEY, token)
  for (const l of listeners) l({ key: TOKEN_KEY, newValue: token } as StorageEvent)
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const outcome = (p: Promise<unknown>) => p.then((v) => ({ ok: v }), (e: unknown) => ({ err: e }))
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }

beforeEach(() => {
  listeners = []
  release = []
  sent = []
  store = new Map([[TOKEN_KEY, 'tok-a-invented']])
  vi.stubGlobal('window', {
    location: { href: 'https://hive.invalid/', search: '' },
    addEventListener: (type: string, l: (e: StorageEvent) => void) => type === 'storage' && listeners.push(l),
    removeEventListener: () => undefined,
  })
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  })
  vi.stubGlobal('fetch', vi.fn((url: string, init: RequestInit) => {
    sent.push({ url, auth: (init.headers as Record<string, string>).Authorization ?? null, method: init.method ?? 'GET', init })
    return new Promise<Response>((res) => release.push(res))
  }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('an answer that arrives after a sign-in change is never delivered', () => {
  it('a successful mutation answered after A→B rejects with identity_changed, not success', async () => {
    const c = new LiveClient('https://hive.invalid')
    const pending = outcome(c.createSwarm({ name: 'Invented', description: '', hue: 1 } as never))
    otherTabSets('tok-b-invented')
    release[0](json({ id: 's_invented', name: 'Invented' }))
    const r = await pending
    expect('err' in r && isIdentityChanged(r.err)).toBe(true)
    expect((r as { err: ApiError }).err).toMatchObject({ status: 409, code: IDENTITY_CHANGED })
  })
  it('a failure answered after the change is identity_changed too (it belongs to the earlier sign-in)', async () => {
    const c = new LiveClient('https://hive.invalid')
    const pending = outcome(c.agentAction('a_invented', 'start'))
    otherTabSets('tok-b-invented')
    release[0](json({ error: { code: 'boom', message: 'invented' } }, 500))
    const r = await pending
    expect('err' in r && isIdentityChanged(r.err)).toBe(true)
  })
  it('A→B→A: a request sent under the first A is still not delivered (a new sign-in is a new identity)', async () => {
    const c = new LiveClient('https://hive.invalid')
    const pending = outcome(c.createGoal('s_invented', { title: 'Invented', priority: 0.5 }))
    otherTabSets('tok-b-invented')
    otherTabSets('tok-a-invented')
    release[0](json({ id: 'g_invented' }))
    const r = await pending
    expect('err' in r && isIdentityChanged(r.err)).toBe(true)
  })
  it('the same multi-step flow, after the change, stops at the first answer: no later step is sent', async () => {
    const c = new LiveClient('https://hive.invalid')
    const flow = (async () => {
      const s = await c.createSwarm({ name: 'Invented', description: '', hue: 1 } as never)
      await c.createAgent({ name: 'Later', swarm_id: s.id } as never)
    })()
    const r = outcome(flow)
    otherTabSets('tok-b-invented')
    release[0](json({ id: 's_invented' }))
    expect('err' in (await r) && isIdentityChanged((await r as { err: unknown }).err)).toBe(true)
    expect(sent.map((x) => x.url)).toEqual(['https://hive.invalid/api/swarms']) // createAgent was never sent
  })
  it("a change while the answer's body is still being read: identity_changed, not success", async () => {
    const c = new LiveClient('https://hive.invalid')
    const pending = outcome(c.createSwarm({ name: 'Invented', description: '', hue: 1 } as never))
    let body!: (v: unknown) => void
    release[0]({ ok: true, status: 200, json: () => new Promise((r) => { body = r }) } as unknown as Response)
    await new Promise((r) => setTimeout(r, 0))
    otherTabSets('tok-b-invented')
    body({ id: 's_invented' })
    const r = await pending
    expect('err' in r && isIdentityChanged(r.err)).toBe(true)
  })
  it('control: with no change the answer is delivered, and a current-bearer 401 still ends the session (not identity_changed)', async () => {
    const c = new LiveClient('https://hive.invalid')
    const states: string[] = []
    c.onConnection((s) => states.push(s))
    const ok = c.createSwarm({ name: 'Invented', description: '', hue: 1 } as never)
    release[0](json({ id: 's_invented' }))
    expect(await ok).toMatchObject({ id: 's_invented' })
    const denied = outcome(c.getHive())
    release[1](json({ error: { code: 'unauthorized', message: 'invented' } }, 401))
    const r = await denied
    expect('err' in r && r.err instanceof ApiError && r.err.status === 401).toBe(true)
    expect(states.at(-1)).toBe('unauthorized')
  })
  it('the Ask, binary and raw paths check it too (askRequest, importMind, uploadAsset)', async () => {
    const c = new LiveClient('https://hive.invalid')
    const ask = outcome(c.askSteer('op_invented', { steer_id: 'st_invented', text: 'x' } as never))
    const imp = outcome(c.importMind(new Blob(['x'])))
    const up = outcome(c.uploadAsset(new Blob(['x']), {} as never))
    otherTabSets('tok-b-invented')
    release[0](json({ steer_id: 'st_invented', operation_id: 'op_invented' }))
    release[1](json({ id: 'a_invented' }))
    release[2](json({ sha256: 'invented' }))
    for (const r of [await ask, await imp, await up]) expect('err' in r && isIdentityChanged(r.err)).toBe(true)
  })
  it("an Ask refusal answered after the change is identity_changed too (never the earlier sign-in's refusal)", async () => {
    const c = new LiveClient('https://hive.invalid')
    const ask = outcome(c.askSteer('op_invented', { steer_id: 'st_invented', text: 'x' } as never))
    otherTabSets('tok-b-invented')
    release[0](json({ error: { code: 'ask_busy', message: 'invented' } }, 409))
    const r = await ask
    expect('err' in r && isIdentityChanged(r.err)).toBe(true)
  })
  it('importMind: a change while its answer is still being read is identity_changed', async () => {
    const c = new LiveClient('https://hive.invalid')
    const imp = outcome(c.importMind(new Blob(['x'])))
    let body!: (v: unknown) => void
    release[0]({ ok: true, status: 200, json: () => new Promise((r) => { body = r }) } as unknown as Response)
    await new Promise((r) => setTimeout(r, 0))
    otherTabSets('tok-b-invented')
    body({ id: 'a_invented' })
    const r = await imp
    expect('err' in r && isIdentityChanged(r.err)).toBe(true)
  })
  it('me() keeps its own contract: auth_context_changed', async () => {
    const c = new LiveClient('https://hive.invalid')
    const me = outcome(c.me())
    otherTabSets('tok-b-invented')
    release[0](json({ principal: 'user:invented' }))
    expect(await me).toMatchObject({ err: { status: 409, code: 'auth_context_changed' } })
  })
})

/** A failing answer whose body is still being read: the test resolves the body after the sign-in change. */
function slowError(status: number, body: unknown) {
  let give!: () => void
  const res = { ok: false, status, statusText: 'invented', json: () => new Promise((r) => { give = () => r(body) }) } as unknown as Response
  return { res, give: () => give() }
}

describe('r1.2 (stand-in r1.1 P2): an error read across a sign-in change is identity_changed, on every path', () => {
  const paths: [string, (c: LiveClient) => Promise<unknown>][] = [
    ['request (createSwarm)', (c) => c.createSwarm({ name: 'Invented', description: '', hue: 1 } as never)],
    ['askRequest (askSteer)', (c) => c.askSteer('op_invented', { steer_id: 'st_invented', text: 'x' } as never)],
    ['binary (importMind)', (c) => c.importMind(new Blob(['x']))],
    ['draftCall (putAppDraft)', (c) => c.putAppDraft('app_invented', 'k', { swarm_id: 's', expected_revision: 0, body: {} } as never)],
    ['raw (uploadAsset)', (c) => c.uploadAsset(new Blob(['x']), {} as never)],
  ]
  for (const [name, send] of paths) {
    it(`${name}: a 409 whose body is read after A→B is identity_changed, never the earlier sign-in's error`, async () => {
      const c = new LiveClient('https://hive.invalid')
      const pending = outcome(send(c))
      const slow = slowError(409, { error: { code: 'invented_conflict', message: 'the earlier sign-in error' } })
      release[0](slow.res)
      await new Promise((r) => setTimeout(r, 0))
      otherTabSets('tok-b-invented')
      slow.give()
      const r = await pending
      expect('err' in r && isIdentityChanged(r.err), name).toBe(true)
    })
  }
  it('a slow 401 body for the CURRENT sign-in still ends the session (not identity_changed)', async () => {
    const c = new LiveClient('https://hive.invalid')
    const states: string[] = []
    c.onConnection((x) => states.push(x))
    const pending = outcome(c.getHive())
    const slow = slowError(401, { error: { code: 'unauthorized', message: 'invented' } })
    release[0](slow.res)
    await new Promise((r) => setTimeout(r, 0))
    slow.give()
    const r = await pending
    expect('err' in r && r.err instanceof ApiError && r.err.status === 401 && !isIdentityChanged(r.err)).toBe(true)
    expect(states.at(-1)).toBe('unauthorized')
  })
  it('a slow 401 body read after A→B neither ends the NEW session nor reports 401: identity_changed', async () => {
    const c = new LiveClient('https://hive.invalid')
    const states: string[] = []
    c.onConnection((x) => states.push(x))
    const pending = outcome(c.getHive())
    const slow = slowError(401, { error: { code: 'unauthorized', message: 'invented' } })
    release[0](slow.res)
    await new Promise((r) => setTimeout(r, 0))
    otherTabSets('tok-b-invented')
    slow.give()
    const r = await pending
    expect('err' in r && isIdentityChanged(r.err)).toBe(true)
    expect(states).not.toContain('unauthorized')
    expect(store.get(TOKEN_KEY)).toBe('tok-b-invented')
  })
})

describe('r1.2 (Kimi r1.1 #1): the identity is the principal, however it changed', () => {
  it('a cookie-only switch (same bearer, another principal from me()) is a new identity: new handle, listeners told, the read re-made', async () => {
    store.delete(TOKEN_KEY) // a cookie (hive_signin) session: no bearer here at all
    const c = new LiveClient('https://hive.invalid')
    let told = 0
    c.onAuthChange(() => told++)
    const first = c.me(); release[0](json({ principal: 'user:invented-a' }))
    expect(await first).toMatchObject({ principal: 'user:invented-a' })
    const before = c.authContext()
    // another tab signs in as someone else with the cookie: nothing changes in this tab's storage
    const second = outcome(c.me()); release[1](json({ principal: 'user:invented-b' }))
    expect(await second).toMatchObject({ err: { status: 409, code: 'auth_context_changed' } }) // readMe reads again
    expect(c.authContext()).not.toBe(before)
    expect(told).toBe(1)
    const third = c.me(); release[2](json({ principal: 'user:invented-b' }))
    expect(await third).toMatchObject({ principal: 'user:invented-b' })
    expect(told).toBe(1) // the same principal again: no change
  })
  it('a request sent before that cookie-only switch is answered identity_changed', async () => {
    store.delete(TOKEN_KEY)
    const c = new LiveClient('https://hive.invalid')
    const first = c.me(); release[0](json({ principal: 'user:invented-a' })); await first
    const write = outcome(c.createGoal('s_invented', { title: 'Invented', priority: 0.5 }))
    const who = outcome(c.me()); release[2](json({ principal: 'user:invented-b' })); await who
    release[1](json({ id: 'g_invented' }))
    const r = await write
    expect('err' in r && isIdentityChanged(r.err)).toBe(true)
  })
})

/** The older socket tests predate the kind check: they run against an ordinary hive. */
const ordinary = (c: LiveClient) => { (c as unknown as { localOwner: boolean | null }).localOwner = false }
class FakeSocket {
  static made: FakeSocket[] = []
  static OPEN = 1
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number }) => void) | null = null
  constructor(readonly url: URL) { FakeSocket.made.push(this) }
  send() {}
  close() {}
}
describe('r1.2 (Kimi r1.1 #2): a socket frame from the earlier sign-in is dropped at the client', () => {
  it('frames reaching the old socket after A→B (before its close) reach no listener; the new socket\'s frames do', () => {
    FakeSocket.made = []
    vi.stubGlobal('WebSocket', FakeSocket)
    const c = new LiveClient('https://hive.invalid')
    ordinary(c)
    const seen: string[] = []
    c.subscribe((e) => seen.push((e as { type: string; text?: string }).text ?? (e as { type: string }).type))
    c.connect()
    const old = FakeSocket.made[0]
    const oldHandler = old.onmessage! // what a frame already queued for the old socket still calls
    oldHandler({ data: JSON.stringify({ type: 'message', text: 'under A' }) })
    otherTabSets('tok-b-invented')
    oldHandler({ data: JSON.stringify({ type: 'message', text: 'stale, from A' }) })
    FakeSocket.made.at(-1)!.onmessage!({ data: JSON.stringify({ type: 'message', text: 'under B' }) })
    expect(seen).toEqual(['under A', 'under B'])
  })
})

describe('followups-r8 (stand-in r1.2 P2): a cookie-only principal change reopens the events socket', () => {
  it('frames from the new principal resume on a new socket; the old socket stays mute', async () => {
    FakeSocket.made = []
    vi.stubGlobal('WebSocket', FakeSocket)
    const c = new LiveClient('https://hive.invalid')
    ordinary(c)
    const seen: string[] = []
    c.subscribe((e) => seen.push((e as { type: string; text?: string }).text ?? (e as { type: string }).type))
    c.connect()
    expect(FakeSocket.made).toHaveLength(1)
    const old = FakeSocket.made[0]
    const oldHandler = old.onmessage!
    const first = c.me(); release[0](json({ principal: 'user:invented-a' })); await first
    oldHandler({ data: JSON.stringify({ type: 'message', text: 'under A' }) })
    // the same bearer, another principal (a cookie-only hive_signin switch in another tab): no storage event here
    const second = outcome(c.me()); release[1](json({ principal: 'user:invented-b' }))
    expect(await second).toMatchObject({ err: { status: 409, code: 'auth_context_changed' } })
    expect(FakeSocket.made).toHaveLength(2) // reopened, not left muted until some later reconnect
    expect(FakeSocket.made[1].url.searchParams.get('token')).toBe('tok-a-invented')
    oldHandler({ data: JSON.stringify({ type: 'message', text: 'stale, from A' }) })
    FakeSocket.made[1].onmessage!({ data: JSON.stringify({ type: 'message', text: 'under B' }) })
    expect(seen).toEqual(['under A', 'under B'])
    // hydration's connect() afterwards keeps the new socket (no third one)
    c.connect()
    expect(FakeSocket.made).toHaveLength(2)
  })
  it('the same principal again opens nothing new', async () => {
    FakeSocket.made = []
    vi.stubGlobal('WebSocket', FakeSocket)
    const c = new LiveClient('https://hive.invalid')
    ordinary(c)
    c.connect()
    const a = c.me(); release[0](json({ principal: 'user:invented-a' })); await a
    const b = c.me(); release[1](json({ principal: 'user:invented-a' })); await b
    expect(FakeSocket.made).toHaveLength(1)
  })
})

class SendingSocket extends FakeSocket {
  sentFrames: string[] = []
  closedWith: number | null = null
  override send(d?: unknown) { this.sentFrames.push(String(d)) }
  override close(code?: number) { this.closedWith = code ?? null }
}
const methods = (localOwner: boolean) => json({ password: false, public: false, sso: { enabled: false, provider: '', login_url: null }, local_owner: localOwner })
const methodsAsks = () => sent.filter((x) => x.url.endsWith('/api/auth/methods'))
describe('localowner-ui r1.1 (J1b): the bearer never enters an address, and a local hive signs in with the first frame', () => {
  const states = (c: LiveClient) => {
    const seen: string[] = []
    c.onConnection((s) => seen.push(s))
    return seen
  }
  it('kind unknown at connect: NO socket opens until /api/auth/methods answers (no bearer in any URL meanwhile)', async () => {
    FakeSocket.made = []
    vi.stubGlobal('WebSocket', SendingSocket)
    const c = new LiveClient('https://hive.invalid')
    c.connect()
    expect(FakeSocket.made).toHaveLength(0)
    expect(methodsAsks()).toHaveLength(1)
    expect(methodsAsks()[0].auth).toBeNull()          // the kind check carries no credential
    release[0](methods(true)); await flush()
    expect(FakeSocket.made).toHaveLength(1)
    expect(FakeSocket.made[0].url.searchParams.get('token')).toBeNull()
  })
  it('local_owner: the first frame is the auth frame (≤4 KiB in UTF-8 bytes); "open" only on hello', async () => {
    FakeSocket.made = []
    vi.stubGlobal('WebSocket', SendingSocket)
    const c = new LiveClient('https://hive.invalid')
    const seen = states(c)
    c.connect(); release[0](methods(true)); await flush()
    const ws = FakeSocket.made[0] as SendingSocket
    ws.onopen!()
    expect(ws.sentFrames[0]).toBe(JSON.stringify({ type: 'auth', token: 'tok-a-invented' }))
    expect(new TextEncoder().encode(ws.sentFrames[0]).length).toBeLessThanOrEqual(4096)
    expect(seen).not.toContain('open')
    ws.onmessage!({ data: JSON.stringify({ type: 'hello', at: 'x', hive: {} }) })
    expect(seen).toContain('open')
  })
  it('an ordinary hive (local_owner false): token in the address, open on TCP open, as before', async () => {
    FakeSocket.made = []
    vi.stubGlobal('WebSocket', SendingSocket)
    const c = new LiveClient('https://hive.invalid')
    const seen = states(c)
    c.connect(); release[0](methods(false)); await flush()
    const ws = FakeSocket.made[0] as SendingSocket
    expect(ws.url.searchParams.get('token')).toBe('tok-a-invented')
    ws.onopen!()
    expect(ws.sentFrames).toEqual([])
    expect(seen).toContain('open')
  })
  it('the kind check fails: no socket, then ONE retry after the backoff, and a socket only once the kind is known', async () => {
    vi.useFakeTimers()
    try {
      FakeSocket.made = []
      vi.stubGlobal('WebSocket', SendingSocket)
      const c = new LiveClient('https://hive.invalid')
      c.connect()
      release[0](new Response('down', { status: 503 })); await vi.advanceTimersByTimeAsync(0)
      expect(FakeSocket.made).toHaveLength(0)
      expect(methodsAsks()).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(20_000)
      expect(methodsAsks()).toHaveLength(2)
      release[1](methods(true)); await vi.advanceTimersByTimeAsync(0)
      expect(FakeSocket.made).toHaveLength(1)
      expect(FakeSocket.made[0].url.searchParams.get('token')).toBeNull()
    } finally { vi.useRealTimers() }
  })
})

describe('scanner r1 (Kimi live-pins r1): the kind check is bounded, and restarts on a visibility/online event or connect()', () => {
  type L = () => void
  let on: Record<string, L[]>
  let docOn: Record<string, L[]>
  let doc: { visibilityState: string }
  const fire = (m: Record<string, L[]>, type: string) => { for (const l of [...(m[type] ?? [])]) l() }
  beforeEach(() => {
    on = {}
    docOn = {}
    const add = (m: Record<string, L[]>) => (type: string, l: L) => { (m[type] ??= []).push(l) }
    const remove = (m: Record<string, L[]>) => (type: string, l: L) => { m[type] = (m[type] ?? []).filter((x) => x !== l) }
    vi.stubGlobal('window', { location: { href: 'https://hive.invalid/', search: '' }, addEventListener: add(on), removeEventListener: remove(on) })
    doc = { visibilityState: 'visible' }
    vi.stubGlobal('document', Object.assign(doc, { addEventListener: add(docOn), removeEventListener: remove(docOn) }))
  })
  const GIVE_UP = 8
  /** connect, then fail every methods ask; returns once the client has given up (asks stop, nothing scheduled) */
  const failUntilParked = async (c: LiveClient) => {
    const seen: string[] = []
    c.onConnection((s) => seen.push(s))
    c.connect()
    for (let i = 0; i < GIVE_UP; i++) {
      expect(methodsAsks(), `ask ${i + 1}`).toHaveLength(i + 1)
      release[i](new Response('down', { status: 503 })); await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(20_000)
    }
    return seen
  }
  it(`stops after ${GIVE_UP} failures in a row: no more asks, no timer, no socket, and not "reconnecting" forever`, async () => {
    vi.useFakeTimers()
    try {
      FakeSocket.made = []
      vi.stubGlobal('WebSocket', SendingSocket)
      const c = new LiveClient('https://hive.invalid')
      const seen = await failUntilParked(c)
      expect(methodsAsks()).toHaveLength(GIVE_UP)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(methodsAsks()).toHaveLength(GIVE_UP)
      expect(vi.getTimerCount()).toBe(0)
      expect(FakeSocket.made).toHaveLength(0)
      expect(seen.at(-1)).toBe('idle')
    } finally { vi.useRealTimers() }
  })
  it('scanner r1.1 (stand-in P1): a connect() during the backoff neither resets the count nor leaves its timer alive past giving up', async () => {
    vi.useFakeTimers()
    try {
      FakeSocket.made = []
      vi.stubGlobal('WebSocket', SendingSocket)
      const c = new LiveClient('https://hive.invalid')
      const seen: string[] = []
      c.onConnection((s) => seen.push(s))
      c.connect()
      for (let i = 0; i < GIVE_UP - 2; i++) {
        release[i](new Response('down', { status: 503 })); await vi.advanceTimersByTimeAsync(0)
        await vi.advanceTimersByTimeAsync(20_000)
      }
      expect(methodsAsks()).toHaveLength(GIVE_UP - 1)
      // failure 7: its retry timer is pending ...
      release[GIVE_UP - 2](new Response('down', { status: 503 })); await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(1)
      // ... a connect() during the backoff asks at once (the count is NOT reset) ...
      c.connect(); await vi.advanceTimersByTimeAsync(0)
      expect(methodsAsks()).toHaveLength(GIVE_UP)
      // ... and failure 8 gives up: the earlier timer goes with it
      release[GIVE_UP - 1](new Response('down', { status: 503 })); await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
      expect(seen.at(-1)).toBe('idle')
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(methodsAsks()).toHaveLength(GIVE_UP)
      expect(seen.at(-1)).toBe('idle')
      expect(FakeSocket.made).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })
  const signInElsewhere = (token: string) => {
    store.set(TOKEN_KEY, token)
    for (const l of [...(on.storage ?? [])]) (l as unknown as (e: StorageEvent) => void)({ key: TOKEN_KEY, newValue: token } as StorageEvent)
  }
  for (const end of ['disconnect', 'dispose'] as const) {
    it(`scanner r1.1: ${end}() while given up leaves no timer, no listener and no socket; no event starts it again`, async () => {
      vi.useFakeTimers()
      try {
        FakeSocket.made = []
        vi.stubGlobal('WebSocket', SendingSocket)
        const c = new LiveClient('https://hive.invalid')
        await failUntilParked(c)
        expect(on.online ?? []).toHaveLength(1)
        expect(docOn.visibilitychange ?? []).toHaveLength(1)
        c[end]()
        expect(on.online ?? []).toHaveLength(0)
        expect(docOn.visibilitychange ?? []).toHaveLength(0)
        if (end === 'dispose') expect(on.storage ?? []).toHaveLength(0)
        fire(on, 'online'); fire(docOn, 'visibilitychange'); await vi.advanceTimersByTimeAsync(60 * 60_000)
        expect(methodsAsks()).toHaveLength(GIVE_UP)
        expect(vi.getTimerCount()).toBe(0)
        expect(FakeSocket.made).toHaveLength(0)
      } finally { vi.useRealTimers() }
    })
  }
  it('scanner r1.1: a sign-in change while given up starts the kind check again (no credential), then the socket under the new bearer', async () => {
    vi.useFakeTimers()
    try {
      FakeSocket.made = []
      vi.stubGlobal('WebSocket', SendingSocket)
      const c = new LiveClient('https://hive.invalid')
      await failUntilParked(c)
      signInElsewhere('tok-b-invented'); await vi.advanceTimersByTimeAsync(0)
      expect(methodsAsks()).toHaveLength(GIVE_UP + 1)
      expect(methodsAsks()[GIVE_UP].auth).toBeNull()
      expect(on.online ?? []).toHaveLength(0)
      expect(docOn.visibilitychange ?? []).toHaveLength(0)
      release[GIVE_UP](methods(true)); await vi.advanceTimersByTimeAsync(0)
      expect(FakeSocket.made).toHaveLength(1)
      const ws = FakeSocket.made[0] as SendingSocket
      expect(ws.url.searchParams.get('token')).toBeNull()
      ws.onopen!()
      expect(ws.sentFrames[0]).toBe(JSON.stringify({ type: 'auth', token: 'tok-b-invented' }))
    } finally { vi.useRealTimers() }
  })
  for (const trigger of ['visible', 'online', 'connect'] as const) {
    it(`once given up, ${trigger === 'visible' ? 'coming back into view' : trigger === 'online' ? 'going back online' : 'the next connect()'} starts it again (bounded again)`, async () => {
      vi.useFakeTimers()
      try {
        FakeSocket.made = []
        vi.stubGlobal('WebSocket', SendingSocket)
        const c = new LiveClient('https://hive.invalid')
        await failUntilParked(c)
        expect(methodsAsks()).toHaveLength(GIVE_UP)
        // a hidden page changing visibility is no reason to ask
        doc.visibilityState = 'hidden'; fire(docOn, 'visibilitychange'); await vi.advanceTimersByTimeAsync(0)
        expect(methodsAsks()).toHaveLength(GIVE_UP)
        // Kimi r1 #3: only `visible` is coming back into view (not any state other than hidden)
        doc.visibilityState = 'prerender'; fire(docOn, 'visibilitychange'); await vi.advanceTimersByTimeAsync(0)
        expect(methodsAsks()).toHaveLength(GIVE_UP)
        doc.visibilityState = 'visible'
        if (trigger === 'visible') fire(docOn, 'visibilitychange')
        else if (trigger === 'online') fire(on, 'online')
        else c.connect()
        await vi.advanceTimersByTimeAsync(0)
        expect(methodsAsks()).toHaveLength(GIVE_UP + 1)
        // the restart removed its listeners: another event asks nothing more while this ask is out
        fire(on, 'online'); fire(docOn, 'visibilitychange'); await vi.advanceTimersByTimeAsync(0)
        expect(methodsAsks()).toHaveLength(GIVE_UP + 1)
        // and it is bounded afresh: GIVE_UP more failures, then quiet again
        for (let i = GIVE_UP; i < 2 * GIVE_UP; i++) {
          release[i](new Response('down', { status: 503 })); await vi.advanceTimersByTimeAsync(0)
          await vi.advanceTimersByTimeAsync(20_000)
        }
        await vi.advanceTimersByTimeAsync(60 * 60_000)
        expect(methodsAsks()).toHaveLength(2 * GIVE_UP)
        // restarted once more, the kind is known: a socket opens, the bearer in no address
        fire(on, 'online'); await vi.advanceTimersByTimeAsync(0)
        expect(methodsAsks()).toHaveLength(2 * GIVE_UP + 1)
        release[2 * GIVE_UP](methods(true)); await vi.advanceTimersByTimeAsync(0)
        expect(FakeSocket.made).toHaveLength(1)
        expect(FakeSocket.made[0].url.searchParams.get('token')).toBeNull()
        expect(on.online ?? []).toHaveLength(0)
        expect(docOn.visibilitychange ?? []).toHaveLength(0)
      } finally { vi.useRealTimers() }
    })
  }
  it('the pre-kind path sends GET /api/auth/methods and nothing else, without a credential, through every retry (else connect is a write)', async () => {
    vi.useFakeTimers()
    try {
      FakeSocket.made = []
      vi.stubGlobal('WebSocket', SendingSocket)
      const c = new LiveClient('https://hive.invalid')
      await failUntilParked(c)
      c.connect(); await vi.advanceTimersByTimeAsync(0)
      expect(sent.length).toBe(GIVE_UP + 1)
      expect(sent.map((x) => `${x.method} ${new URL(x.url).pathname} ${x.auth ?? 'no-credential'}`)).toEqual(Array(GIVE_UP + 1).fill('GET /api/auth/methods no-credential'))
      // scanner r1.1 (Kimi r1, sharpest): the bearer is ABSENT everywhere on the kind check, searched for by its value:
      // not in the address (path, query, fragment), not in any header (Authorization or another), not in a body; and the
      // client never asks for cross-origin cookies here. (Same-origin cookies are the browser's default and are left as
      // they are: a hive behind an access proxy may need them to answer at all.)
      const needle = 'tok-a-invented'
      for (const x of sent) {
        expect(x.url, x.url).not.toContain(needle)
        expect(new URL(x.url).search).toBe('')
        expect(JSON.stringify(x.init.headers ?? {}), 'headers').not.toContain(needle)
        expect(Object.keys((x.init.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase())).not.toContain('authorization')
        expect(x.init.body ?? null).toBeNull()
        expect(x.init.credentials).not.toBe('include')
      }
      expect(FakeSocket.made).toHaveLength(0)
    } finally { vi.useRealTimers() }
  })
  it('scanner r1.1 (Kimi P1-2): parked is one state; no way into open() asks while parked, only a restart trigger does', async () => {
    vi.useFakeTimers()
    try {
      FakeSocket.made = []
      vi.stubGlobal('WebSocket', SendingSocket)
      const c = new LiveClient('https://hive.invalid')
      await failUntilParked(c)
      // a socket close's retry, a late retry, any internal path: all go through open(), which is parked. (While the kind
      // is unknown no socket exists, so the close handler's retry is driven here through the same open() it calls.)
      ;(c as unknown as { open(): void }).open()
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(methodsAsks()).toHaveLength(GIVE_UP)
      expect(FakeSocket.made).toHaveLength(0)
      // a storage event that changes nothing (same token) is no restart: still parked, listeners kept
      for (const l of [...(on.storage ?? [])]) (l as unknown as (e: StorageEvent) => void)({ key: TOKEN_KEY, newValue: 'tok-a-invented' } as StorageEvent)
      await vi.advanceTimersByTimeAsync(0)
      expect(methodsAsks()).toHaveLength(GIVE_UP)
      expect(on.online ?? []).toHaveLength(1)
      // a sign-out elsewhere ends it: unauthorized, nothing asked, no listeners left
      const seen: string[] = []
      c.onConnection((s) => seen.push(s))
      store.delete(TOKEN_KEY)
      for (const l of [...(on.storage ?? [])]) (l as unknown as (e: StorageEvent) => void)({ key: TOKEN_KEY, newValue: null } as StorageEvent)
      await vi.advanceTimersByTimeAsync(60 * 60_000)
      expect(methodsAsks()).toHaveLength(GIVE_UP)
      expect(seen.at(-1)).toBe('unauthorized')
      expect(on.online ?? []).toHaveLength(0)
      expect(docOn.visibilitychange ?? []).toHaveLength(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
  it('scanner r1.1 (Kimi P1-2): given up, then disconnect(), then a sign-in elsewhere: fully reset (not parked, no listeners), nothing asked until connect(), which works', async () => {
    vi.useFakeTimers()
    try {
      FakeSocket.made = []
      vi.stubGlobal('WebSocket', SendingSocket)
      const c = new LiveClient('https://hive.invalid')
      await failUntilParked(c)
      c.disconnect()
      signInElsewhere('tok-b-invented'); await vi.advanceTimersByTimeAsync(0)
      expect((c as unknown as { kindParked: boolean }).kindParked).toBe(false)
      expect(on.online ?? []).toHaveLength(0)
      expect(docOn.visibilitychange ?? []).toHaveLength(0)
      expect(methodsAsks()).toHaveLength(GIVE_UP)
      c.connect(); await vi.advanceTimersByTimeAsync(0)
      expect(methodsAsks()).toHaveLength(GIVE_UP + 1)
      release[GIVE_UP](methods(false)); await vi.advanceTimersByTimeAsync(0)
      expect(FakeSocket.made).toHaveLength(1)
      expect(FakeSocket.made[0].url.searchParams.get('token')).toBe('tok-b-invented')
    } finally { vi.useRealTimers() }
  })
})
