import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the page's location, played in node: navigate() moves the hash, as the router does
const loc = { hash: '#/', search: '', pathname: '/' }
const store = new Map<string, string>()
const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), localStorage: storage })
vi.stubGlobal('localStorage', storage)
vi.mock('../lib/router', async (orig) => {
  const real = await orig<typeof import('../lib/router')>()
  return { ...real, navigate: (r: import('../lib/router').Route) => void (loc.hash = real.href(r)) }
})

const { useHive } = await import('./store')
const askModule = await import('./ask')
const { askOrigin, threadRows, useAskStore } = askModule
const { ApiError } = await import('../api/client')
const { AskRefusal } = await import('../api/ask')
type AskEvent = import('../api/ask').AskEvent
type AskBody = import('../api/ask').AskBody
type AskTurnState = import('../api/ask').AskTurnState
type HiveClient = import('../api/client').HiveClient

/**
 * Review B1 on next29 06ce9e7 (PLATFORM_NEXT29_06CE9E7_REVIEW_VERDICT_20261006): a credential-only replacement on the
 * SAME client (Platform person-session authContext/onAuthChange, no store re-init) is an identity change for the Ask.
 * The thread, held words, scheduled checks, reads in flight and the last request belong to the sign-in they were made
 * under: on the change they are dropped at once, nothing of the earlier sign-in is sent, shown or re-sent, and the new
 * sign-in is bound only from its own me() read. A synthetic client stands in for the live one (a credential handle
 * replaced on every change, listeners notified); invented people and words only, no network, no model.
 */
const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
const ctx = { route: 'hive', experience: 'classic' }
function frame(op: string, seq: number, f: Record<string, unknown>): AskEvent {
  return { type: 'ask', operation_id: op, turn_id: `t_${op}`, principal: 'user:ann', seq, at: '2026-10-06T10:00:00Z', ...f } as unknown as AskEvent
}
const view = (op: string, events: AskEvent[] = []): AskTurnState => ({ operation_id: op, turn_id: `t_${op}`, thread, state: 'accepted', events, more: false })
const lost = () => new ApiError(0, 'network', 'Failed to fetch')
function defer<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((r, j) => ((resolve = r), (reject = j)))
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

/** A synthetic client with the live client's credential side: one handle per sign-in, listeners told of each change. */
function authHost() {
  let handle: object = {}
  let who = 'user:ann'
  const listeners = new Set<() => void>()
  /** everything that left the page, with the sign-in it left under */
  const sent: { what: 'ask' | 'steer' | 'read' | 'confirm' | 'settings'; who: string; text?: string; op?: string }[] = []
  const on = {
    ask: async (b: AskBody): Promise<AskTurnState> => view(b.operation_id),
    askTurn: async (op: string, _after?: number): Promise<AskTurnState> => {
      void _after
      throw new AskRefusal(404, 'not_available', `no such turn ${op}`)
    },
    askSteer: async (op: string, b: { steer_id: string; text: string }): Promise<{ steer_id: string; operation_id: string }> => ({ steer_id: b.steer_id, operation_id: op }),
    askSettings: async () => ({ swarm_id: 'sw_ann_private', thread_budget_usd: 0.25 }),
    askConfirm: async () => ({ ok: true }),
    me: async () => ({ principal: who, kind: 'sso', role: 'member', expires_at: null, person: null }),
  }
  const client = {
    mode: 'live',
    authContext: () => handle,
    onAuthChange: (f: () => void) => {
      listeners.add(f)
      return () => void listeners.delete(f)
    },
    me: vi.fn(() => on.me()),
    ask: vi.fn((b: AskBody) => (sent.push({ what: 'ask', who, text: b.text, op: b.operation_id }), on.ask(structuredClone(b)))),
    askTurn: vi.fn((op: string, after?: number) => (sent.push({ what: 'read', who, op }), on.askTurn(op, after))),
    askSteer: vi.fn((op: string, b: { steer_id: string; text: string }) => (sent.push({ what: 'steer', who, text: b.text, op }), on.askSteer(op, b))),
    askSettings: vi.fn(() => (sent.push({ what: 'settings', who }), on.askSettings())),
    askConfirm: vi.fn(() => (sent.push({ what: 'confirm', who }), on.askConfirm())),
  } as unknown as HiveClient
  return {
    client,
    on,
    sent,
    /** a credential replacement on this same client; `notify: false` is the interval before the observer runs */
    signIn(next: string, notify = true) {
      who = next
      handle = {}
      if (notify) for (const f of [...listeners]) f()
    },
    /** everything sent while `principal` was signed in */
    by: (principal: string) => sent.filter((s) => s.who === principal),
  }
}

let n = 0
/** a store session for the client, bound to `principal` (as AskHost does after me()) */
function start(h: ReturnType<typeof authHost>, principal = 'user:ann') {
  useHive.setState({ client: h.client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, principal)
}
/** the same store session, bound again for whoever is signed in now (no store re-init: credential-only change) */
const rebind = (principal: string) => useAskStore.getState().bind(useHive.getState().session, principal)
const rows = () => JSON.stringify(threadRows(useAskStore.getState()))
const turnCount = () => Object.keys(useAskStore.getState().turns).length

beforeEach(() => {
  loc.hash = '#/'
})
afterEach(() => {
  vi.useRealTimers()
  useAskStore.getState().reset()
})

describe('Ask: a credential-only change on the same client is an identity change (Review B1, next29 06ce9e7)', () => {
  it('the change clears the thread synchronously: no turns, no held words, unbound, epoch moved', async () => {
    const h = authHost()
    start(h)
    await useAskStore.getState().send('ANN PRIVATE QUESTION', ctx)
    expect(turnCount()).toBe(1)
    const epoch = useAskStore.getState().epoch
    h.signIn('user:bea')
    // no await: the reset is part of the change itself
    expect(useAskStore.getState().bound).toBeNull()
    expect(turnCount()).toBe(0)
    expect(useAskStore.getState().epoch).toBeGreaterThan(epoch)
    expect(rows()).not.toContain('ANN PRIVATE')
  })

  it('a pending send answered after the change writes nothing, and a lost answer is not checked under the new sign-in', async () => {
    const h = authHost()
    start(h)
    const answer = defer<AskTurnState>()
    h.on.ask = () => answer.promise
    const sending = useAskStore.getState().send('ANN PRIVATE QUESTION', ctx)
    await flush()
    h.signIn('user:bea')
    answer.resolve(view(h.sent[0].op!))
    await sending
    await flush()
    expect(useAskStore.getState().thread).toBeNull()
    expect(rows()).not.toContain('ANN PRIVATE')

    const h2 = authHost()
    start(h2)
    const gone = defer<AskTurnState>()
    h2.on.ask = () => gone.promise
    const sending2 = useAskStore.getState().send('ANN SECOND', ctx)
    await flush()
    h2.signIn('user:bea')
    gone.reject(lost())
    await sending2
    await flush()
    // no check of Ann's request under Bea: no read, no same-id re-send
    expect(h2.by('user:bea')).toEqual([])
  })

  it('a held-word release whose admission answer arrives after the change sends nothing', async () => {
    const h = authHost()
    start(h)
    const read = defer<AskTurnState>()
    h.on.ask = () => Promise.reject(lost())
    h.on.askTurn = () => read.promise
    const sending = useAskStore.getState().send('original', ctx)
    await flush()
    const op = h.sent[0].op!
    expect(useAskStore.getState().turns[op].state).toBe('checking')
    await useAskStore.getState().steer('ANN PRIVATE HELD', ctx)
    h.signIn('user:bea')
    read.resolve(view(op, [frame(op, 1, { phase: 'accepted', thread })]))
    await sending
    await flush()
    expect(h.sent.filter((s) => s.what === 'steer')).toEqual([])
    expect(h.sent.filter((s) => s.what === 'ask')).toHaveLength(1)
    expect(h.by('user:bea')).toEqual([])
    expect(rows()).not.toContain('ANN PRIVATE HELD')
  })

  it('a scheduled check does not run after the change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = authHost()
    start(h)
    h.on.ask = () => Promise.reject(lost())
    await useAskStore.getState().send('ANN PRIVATE QUESTION', ctx)
    await flush()
    const op = h.sent[0].op!
    expect(useAskStore.getState().turns[op].unsure?.state).toBe('waiting')
    const before = h.sent.length
    h.signIn('user:bea')
    await vi.advanceTimersByTimeAsync(120_000)
    await flush()
    expect(h.sent.length).toBe(before)
    expect(h.by('user:bea')).toEqual([])
  })

  it('a recovery read answered after the change applies nothing and schedules nothing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = authHost()
    start(h)
    await useAskStore.getState().send('q', ctx)
    const op = h.sent[0].op!
    const read = defer<AskTurnState>()
    h.on.askTurn = () => read.promise
    // a gap: frame 2 before frame 1 starts a recovery read
    useAskStore.getState().onEvent(frame(op, 2, { phase: 'answer', text: 'ANN PRIVATE ANSWER' }))
    await flush()
    expect(h.sent.filter((s) => s.what === 'read')).toHaveLength(1)
    h.signIn('user:bea')
    read.resolve(view(op, [frame(op, 1, { phase: 'accepted', thread }), frame(op, 2, { phase: 'answer', text: 'ANN PRIVATE ANSWER' })]))
    await flush()
    await vi.advanceTimersByTimeAsync(120_000)
    await flush()
    expect(rows()).not.toContain('ANN PRIVATE ANSWER')
    expect(h.by('user:bea')).toEqual([])
  })

  it('a steer answered after the change (the turn became a new request) shows nothing of it', async () => {
    const h = authHost()
    start(h)
    await useAskStore.getState().send('q', ctx)
    const op = h.sent[0].op!
    useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
    const answer = defer<{ steer_id: string; operation_id: string }>()
    h.on.askSteer = () => answer.promise
    const steering = useAskStore.getState().steer('ANN PRIVATE STEER', ctx)
    await flush()
    h.signIn('user:bea')
    answer.resolve({ steer_id: 'st_x', operation_id: 'ask:became:new' })
    await steering
    await flush()
    expect(turnCount()).toBe(0)
    expect(rows()).not.toContain('ANN PRIVATE STEER')
  })

  it('before the observer runs (the interval): nothing is sent, written or acted on under the earlier binding', async () => {
    const h = authHost()
    start(h)
    await useAskStore.getState().send('ANN EARLIER QUESTION', ctx)
    const op = h.sent[0].op!
    useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
    const origin = askOrigin()
    expect(origin.ok()).toBe(true)
    const answer = defer<AskTurnState>()
    h.on.ask = () => answer.promise
    // the credential is replaced; the listeners have not run yet
    h.signIn('user:bea', false)
    expect(origin.ok()).toBe(false)
    expect(useAskStore.getState().addLocal('ANN', 'ANN PRIVATE LOCAL', { origin })).toBe('')
    await useAskStore.getState().steer('ANN PRIVATE STEER', ctx)
    await useAskStore.getState().send('ANN PRIVATE NEW', ctx)
    expect(h.by('user:bea')).toEqual([])
    // the earlier binding's thread is gone; words typed now are shown only as not sent
    expect(rows()).not.toContain('ANN EARLIER QUESTION')
    expect(rows()).not.toContain('ANN PRIVATE LOCAL')
    expect(useAskStore.getState().bound).toBeNull()
  })

  it('late settings and confirm answers from the earlier sign-in do not land', async () => {
    const h = authHost()
    start(h)
    const settings = defer<{ swarm_id: string; thread_budget_usd: number }>()
    h.on.askSettings = () => settings.promise
    const loading = useAskStore.getState().loadSettings()
    useAskStore.setState({ confirm: { op: 'ask:x', proposal: { id: 'p1', digest: 'd1' } as never, seq: 1 } })
    const confirmed = defer<{ ok: boolean }>()
    h.on.askConfirm = () => confirmed.promise
    const confirming = useAskStore.getState().confirmAct()
    await flush()
    h.signIn('user:bea')
    settings.resolve({ swarm_id: 'sw_ann_private', thread_budget_usd: 0.25 })
    confirmed.resolve({ ok: true })
    await loading
    expect(useAskStore.getState().settings).toBeNull()
    expect(await confirming).not.toBe(true)
  })

  it('A → B → A on the same client: none of the first A sign-in’s turns, held words, checks or last request revive', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const h = authHost()
    start(h)
    h.on.ask = () => Promise.reject(lost())
    await useAskStore.getState().send('ANN FIRST QUESTION', ctx)
    await flush()
    const op = h.sent[0].op!
    await useAskStore.getState().steer('ANN FIRST HELD', ctx)
    expect(useAskStore.getState().turns[op].held).toHaveLength(1)
    const before = h.sent.length
    h.signIn('user:bea')
    h.signIn('user:ann')
    // the host reads me() again and binds Ann: the same store session and principal as before, a different sign-in
    rebind('user:ann')
    expect(useAskStore.getState().bound?.principal).toBe('user:ann')
    expect(turnCount()).toBe(0)
    expect(rows()).not.toContain('ANN FIRST')
    // the old check's timer, the last request and the held words never run under the returned Ann
    h.on.askTurn = async (o) => view(o, [frame(o, 1, { phase: 'accepted', thread })])
    h.on.ask = async (b) => view(b.operation_id)
    await vi.advanceTimersByTimeAsync(120_000)
    await useAskStore.getState().retryLast()
    await useAskStore.getState().checkAgain(op)
    await flush()
    expect(h.sent.length).toBe(before)
    expect(h.sent.some((s) => s.text === 'ANN FIRST HELD')).toBe(false)
    expect(turnCount()).toBe(0)
  })

  it('after the change, recovery works for the new sign-in (same id re-sent once, admitted, frames apply)', async () => {
    const h = authHost()
    start(h)
    h.signIn('user:bea')
    rebind('user:bea')
    let posts = 0
    const admitted = new Set<string>()
    h.on.ask = async (b) => {
      posts++
      if (posts === 1) throw lost()
      admitted.add(b.operation_id)
      return view(b.operation_id)
    }
    h.on.askTurn = async (op) => {
      if (!admitted.has(op)) throw new AskRefusal(404, 'not_available', 'no such turn')
      return view(op, [frame(op, 1, { phase: 'accepted', thread }), frame(op, 2, { phase: 'answer', text: 'Answer for Bea' })])
    }
    await useAskStore.getState().send('BEA QUESTION', ctx)
    const op = h.sent[0].op!
    await vi.waitFor(() => expect(useAskStore.getState().turns[op]?.state).not.toBe('checking'))
    useAskStore.getState().onEvent(frame(op, 1, { phase: 'accepted', thread }))
    useAskStore.getState().onEvent(frame(op, 2, { phase: 'answer', text: 'Answer for Bea' }))
    await flush()
    expect(h.sent.filter((s) => s.what === 'ask').map((s) => s.op)).toEqual([op, op])
    expect(h.sent.every((s) => s.who === 'user:bea')).toBe(true)
    expect(rows()).toContain('Answer for Bea')
  })
})

describe('Ask: the host binds the new sign-in only from its own me() read (bindAskIdentity)', () => {
  it('a me() answer for the earlier sign-in never binds; the next read binds the new one', async () => {
    const h = authHost()
    useHive.setState({ client: h.client, session: `session-${++n}`, inits: n })
    const me = defer<{ principal: string }>()
    h.on.me = (() => me.promise) as never
    const bindAskIdentity = askModule.bindAskIdentity
    bindAskIdentity(h.client, useHive.getState().session, useHive.getState().inits)
    h.signIn('user:bea')
    me.resolve({ principal: 'user:ann' })
    await flush()
    expect(useAskStore.getState().bound).toBeNull()
    h.on.me = (async () => ({ principal: 'user:bea' })) as never
    bindAskIdentity(h.client, useHive.getState().session, useHive.getState().inits)
    await flush()
    expect(useAskStore.getState().bound?.principal).toBe('user:bea')
  })

  it('me() auth_context_changed is a superseded read, never bound as "unknown"', async () => {
    const h = authHost()
    useHive.setState({ client: h.client, session: `session-${++n}`, inits: n })
    const seen: (string | null)[] = []
    const off = useAskStore.subscribe((s) => seen.push(s.bound?.principal ?? null))
    let calls = 0
    h.on.me = (async () => {
      calls++
      if (calls === 1) {
        h.signIn('user:bea')
        throw new ApiError(409, 'auth_context_changed', 'changed')
      }
      return { principal: 'user:bea' }
    }) as never
    askModule.bindAskIdentity(h.client, useHive.getState().session, useHive.getState().inits)
    await flush()
    askModule.bindAskIdentity(h.client, useHive.getState().session, useHive.getState().inits)
    await flush()
    off()
    expect(seen).not.toContain('unknown')
    expect(useAskStore.getState().bound?.principal).toBe('user:bea')
  })

  it('a cancelled read (the host re-ran for a newer sign-in or session) binds nothing', async () => {
    const h = authHost()
    useHive.setState({ client: h.client, session: `session-${++n}`, inits: n })
    const me = defer<{ principal: string }>()
    h.on.me = (() => me.promise) as never
    const cancel = askModule.bindAskIdentity(h.client, useHive.getState().session, useHive.getState().inits)
    cancel()
    me.resolve({ principal: 'user:ann' })
    await flush()
    expect(useAskStore.getState().bound).toBeNull()
  })
})
