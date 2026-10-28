import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// the page's location, played in node: navigate() moves the hash, as the router does
const loc = { hash: '#/', search: '', pathname: '/' }
const store = new Map<string, string>()
vi.stubGlobal('window', {
  location: loc,
  matchMedia: () => ({ matches: false }),
  // ui/confirm (via lib/identityEpoch) registers a keydown hook at load; a stand-in window needs the listener API
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
  localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
})
vi.mock('../lib/router', async (orig) => {
  const real = await orig<typeof import('../lib/router')>()
  return { ...real, navigate: (r: import('../lib/router').Route) => void (loc.hash = real.href(r)) }
})

const { useHive } = await import('./store')
const { RECOVER_BACKOFF_MS, RECOVER_TRIES, setMover, threadRows, useAskStore } = await import('./ask')
const { runIntent, performAct, WAIT_MS } = await import('../features/ask/run')
const { lookState, previewLook } = await import('../shell/uiVariant')
const { markUnsaved } = await import('../features/ask/dirty')
type AskEvent = import('../api/ask').AskEvent
type HiveClient = import('../api/client').HiveClient
type IntentAct = import('../lib/intent').IntentAct

/**
 * Review of 32d704a, B1 and B2 (SURFACE_ASK_32D704A_REVIEW_VERDICT_20261005): invented data only, no network.
 * B1: a fast-path act runs under the origin it started in (client, store session, init count, principal, Ask epoch);
 *     after every await nothing is dispatched, published or undone unless that origin still holds.
 * B2: a gap that recovery cannot fill stays a gap: nothing after it applies, lastSeq never passes it, the history says
 *     it is incomplete, reads are retried a bounded number of times, and a later fill applies in order.
 */
let frames: Record<string, AskEvent[]> = {}
const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
function fakeClient(over: Partial<HiveClient> = {}): HiveClient {
  return {
    mode: 'sim',
    ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string, after = 0) => ({ operation_id: op, turn_id: 't1', events: (frames[op] ?? []).filter((e) => e.seq > after), more: false })),
    askTakeover: vi.fn(async () => ({})),
    ...over,
  } as unknown as HiveClient
}

let n = 0
async function start(client: HiveClient, principal = 'user:p_ada') {
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, principal)
}
/** the same client, re-initialised (Surface R bumps inits): the thread resets and binds again */
function reinit(principal = 'user:p_ada') {
  useHive.setState({ inits: useHive.getState().inits + 1000 })
  useAskStore.getState().bind(useHive.getState().session, principal)
}
function frame(op: string, seq: number, f: Record<string, unknown>): AskEvent {
  const e = { type: 'ask', operation_id: op, turn_id: 't1', principal: 'user:p_ada', seq, at: '2026-10-05T21:00:00Z', ...f } as unknown as AskEvent
  ;(frames[op] ??= []).push(e)
  return e
}
const deliver = (e: AskEvent) => useAskStore.getState().onEvent(e)
const rows = () => threadRows(useAskStore.getState())
const text = () => JSON.stringify(rows())
async function ask(words: string, client: HiveClient) {
  await start(client)
  await useAskStore.getState().send(words, { route: 'hive', experience: 'classic' }, { where: 'on the hive' })
  const op = useAskStore.getState().open!
  deliver(frame(op, 1, { phase: 'accepted', thread }))
  return op
}
const nav = (op: string, seq: number, route: string) => frame(op, seq, { phase: 'proposal', proposal: { id: `p${seq}`, kind: 'navigate', route, digest: `d${seq}`, label: route.slice(2) } })
function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)))
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
const wake = { do: 'wake', mind: { id: 'a1', name: 'Synthetic' } } as unknown as IntentAct
const original = useHive.getState()

beforeEach(() => {
  frames = {}
  loc.hash = '#/'
  setMover(null)
})
afterEach(() => {
  vi.useRealTimers()
  markUnsaved('test', false)
  previewLook(null)
  useHive.setState({ agentAction: original.agentAction, createGoal: original.createGoal, sendMessage: original.sendMessage })
  useAskStore.getState().reset()
})

// ---------------------------------------------------------------- Review's two probes, ported as they were written

describe('Review probes (32d704a), ported', () => {
  it('Review: old fast-path answer never adds private text to a new principal', async () => {
    const d = deferred<boolean>()
    await start(fakeClient(), 'user:ann')
    useHive.setState({ agentAction: async () => d.promise })
    const job = runIntent(wake, { you: 'ANN PRIVATE WORDS' })
    await start(fakeClient(), 'user:bob')
    d.resolve(true)
    await job
    expect(text()).not.toContain('ANN PRIVATE WORDS')
  })

  it('Review: a failed recovery never skips a missing frame to apply navigation', async () => {
    const client = fakeClient({ askTurn: vi.fn(async () => { throw Error('recovery unavailable') }) as never })
    const op = await ask('hello', client)
    deliver(nav(op, 3, '#/usage'))
    await vi.waitFor(() => expect(useAskStore.getState().turns[op].recovering).toBe(false))
    expect(loc.hash).toBe('#/')
    expect(useAskStore.getState().turns[op].lastSeq).toBe(1)
  })
})

// ---------------------------------------------------------------- B1

describe('B1: a fast-path act publishes only into the thread it started in', () => {
  it('A→B→A: Ann, then Bob, then Ann again (a new thread): the late answer lands in none of them', async () => {
    const d = deferred<boolean>()
    await start(fakeClient(), 'user:ann')
    useHive.setState({ agentAction: async () => d.promise })
    const job = runIntent(wake, { you: 'ANN PRIVATE WORDS' })
    expect(text()).toContain('Asking the hive to wake Synthetic')
    await start(fakeClient(), 'user:bob')
    expect(rows()).toHaveLength(0)
    await start(fakeClient(), 'user:ann')
    d.resolve(true)
    await job
    expect(rows()).toHaveLength(0)
  })

  it('same client, re-initialised: the late answer from before the re-init never lands', async () => {
    const d = deferred<boolean>()
    await start(fakeClient())
    useHive.setState({ agentAction: async () => d.promise })
    const job = runIntent(wake, { you: 'before the re-init' })
    reinit()
    d.resolve(true)
    await job
    expect(rows()).toHaveLength(0)
  })

  it('a new thread (epoch bump) on the same person and client: the late answer never lands', async () => {
    const d = deferred<boolean>()
    await start(fakeClient())
    useHive.setState({ agentAction: async () => d.promise })
    const job = runIntent(wake, { you: 'old thread' })
    await useAskStore.getState().newThread()
    d.resolve(true)
    await job
    expect(rows()).toHaveLength(0)
  })

  it('delayed success: under way first (never "Waking" before the hive says so), then the hive’s yes', async () => {
    const d = deferred<boolean>()
    await start(fakeClient())
    useHive.setState({ agentAction: async () => d.promise })
    const job = runIntent(wake, { you: 'wake synthetic' })
    const local = () => rows().find((r) => r.kind === 'local')!
    expect(local().text).toBe('Asking the hive to wake Synthetic…')
    expect(local().state).toBe('sending')
    d.resolve(true)
    await job
    expect(local().text).toBe('Waking Synthetic.')
  })

  it('delayed refusal (the store’s false): "not confirmed", never "Nothing changed"; for sleep too', async () => {
    // the host lets this viewer put it to sleep (Platform r2.4 may_sleep), read fresh at the press (r1.3)
    await start(fakeClient({ getAgent: async () => ({ id: 'a1', name: 'Synthetic', status: 'awake', may_remind: false, may_sleep: true }) } as unknown as Partial<HiveClient>))
    useHive.setState({ agentAction: async () => false })
    await runIntent(wake, { you: 'wake synthetic' })
    await runIntent({ do: 'sleep', mind: { id: 'a1', name: 'Synthetic' } } as unknown as IntentAct, { you: 'sleep synthetic' })
    const locals = rows().filter((r) => r.kind === 'local')
    expect(locals.map((r) => r.text)).toEqual([
      'Not confirmed: the hive did not say yes to waking Synthetic. Look at Synthetic before trying again.',
      'Not confirmed: the hive did not say yes to putting Synthetic to sleep. Look at Synthetic before trying again.',
    ])
    expect(text()).not.toContain('Nothing changed')
  })

  it('a delayed error is an unknown outcome; after a switch it writes nothing', async () => {
    await start(fakeClient())
    useHive.setState({ agentAction: async () => { throw new Error('boom') } })
    await runIntent(wake, { you: 'wake synthetic' })
    expect(rows().find((r) => r.kind === 'local')!.text).toMatch(/^Not confirmed: the hive’s answer was lost/)
    const d = deferred<boolean>()
    useHive.setState({ agentAction: async () => d.promise })
    const job = runIntent(wake, { you: 'ANN AGAIN' })
    await start(fakeClient(), 'user:bob')
    d.reject(new Error('late boom'))
    await job
    expect(rows()).toHaveLength(0)
  })

  it('timeout: "nothing is confirmed"; a later answer settles the row; a later answer after a switch writes nothing', async () => {
    vi.useFakeTimers()
    await start(fakeClient())
    const d = deferred<boolean>()
    useHive.setState({ agentAction: async () => d.promise })
    const job = runIntent(wake, { you: 'wake synthetic' })
    await vi.advanceTimersByTimeAsync(WAIT_MS + 1)
    await job
    const local = () => rows().find((r) => r.kind === 'local')!
    expect(local().text).toBe('No answer from the hive about waking Synthetic yet. Nothing is confirmed.')
    d.resolve(true)
    await flush()
    expect(local().text).toBe('Waking Synthetic. (the hive answered late)')

    const d2 = deferred<boolean>()
    useHive.setState({ agentAction: async () => d2.promise })
    const job2 = runIntent(wake, { you: 'ANN TIMED OUT' })
    await vi.advanceTimersByTimeAsync(WAIT_MS + 1)
    await job2
    await start(fakeClient(), 'user:bob')
    d2.resolve(true)
    await flush()
    expect(rows()).toHaveLength(0)
  })

  it('goal: null is "not confirmed", never "Nothing changed"; a late goal after a switch writes nothing', async () => {
    await start(fakeClient())
    useHive.setState({ createGoal: async () => null })
    await runIntent({ do: 'goal', swarm: { id: 's1', name: 'North' }, title: 'Tidy' } as unknown as IntentAct, { you: 'goal tidy' })
    expect(rows().find((r) => r.kind === 'local')!.text).toBe('Not confirmed: the hive did not say the task for North was made. Look at its tasks before asking again.')
    const d = deferred<null>()
    useHive.setState({ createGoal: async () => d.promise })
    const job = runIntent({ do: 'goal', swarm: { id: 's1', name: 'North' }, title: 'ANN GOAL' } as unknown as IntentAct, { you: 'ANN GOAL' })
    await start(fakeClient(), 'user:bob')
    d.resolve(null)
    await job
    expect(rows()).toHaveLength(0)
  })

  it('send: "Sent" only once the hive took it; a refusal says Not sent; a switch meanwhile writes nothing', async () => {
    const d = deferred<unknown>()
    const client = fakeClient({ sendMessage: vi.fn(() => d.promise) as never })
    await start(client)
    const act = { do: 'send', mind: { id: 'a1', name: 'Synthetic' }, text: 'hello' } as unknown as IntentAct
    const job = runIntent(act, { you: 'tell synthetic hello' })
    const local = () => rows().find((r) => r.kind === 'local')!
    expect(local().text).toBe('Sending to Synthetic: “hello”')
    d.resolve({ id: 'm1', agent_id: 'a1', role: 'user', text: 'hello', created_at: '2026-10-05T21:00:00Z' })
    await job
    expect(local().text).toBe('Sent to Synthetic: “hello”')

    useAskStore.getState().reset()
    const refused = fakeClient({ sendMessage: vi.fn(async () => { throw new Error('nope') }) as never })
    await start(refused)
    await runIntent(act, { you: 'tell synthetic hello' })
    expect(local().text).toMatch(/^Not sent to Synthetic/)

    const d3 = deferred<unknown>()
    await start(fakeClient({ sendMessage: vi.fn(() => d3.promise) as never }), 'user:ann')
    const job3 = runIntent({ ...act, text: 'ANN PRIVATE' } as IntentAct, { you: 'ANN PRIVATE' })
    await start(fakeClient(), 'user:bob')
    d3.resolve({ id: 'm2', agent_id: 'a1', role: 'user', text: 'ANN PRIVATE', created_at: '2026-10-05T21:00:00Z' })
    await job3
    expect(text()).not.toContain('ANN PRIVATE')
  })

  it('look: a late save after a switch writes no row, and a late failure shows no preview on the new page', async () => {
    const save = deferred<never>()
    await start(fakeClient({ setUiPrefs: vi.fn(() => save.promise) as never }), 'user:ann')
    const job = runIntent({ do: 'look', patch: { layout: 'dock' }, label: 'Dock' } as unknown as IntentAct, { you: 'ANN LOOK' })
    await start(fakeClient(), 'user:bob')
    save.reject(new Error('cannot store'))
    await job
    expect(rows()).toHaveLength(0)
    expect(lookState().preview).toBeNull()
  })

  it('an old Undo never acts on the current client', async () => {
    const annSave = vi.fn(async (p: unknown) => ({ prefs: p }))
    await start(fakeClient({ setUiPrefs: annSave as never }), 'user:ann')
    await runIntent({ do: 'look', patch: { layout: 'dock' }, label: 'Dock' } as unknown as IntentAct, { you: 'dock' })
    const row = rows().find((r) => r.kind === 'local' && r.undo)!
    expect(row).toBeTruthy()
    const bobSave = vi.fn(async (p: unknown) => ({ prefs: p }))
    await start(fakeClient({ setUiPrefs: bobSave as never }), 'user:bob')
    await useAskStore.getState().runUndo(row.id)
    expect(bobSave).not.toHaveBeenCalled()
    expect(annSave).toHaveBeenCalledTimes(1)
    // the origin fence itself, without the reset that clears Undos: a row added under Ann's origin is refused under Bob
    await start(fakeClient(), 'user:ann')
    const origin = (await import('./ask')).askOrigin()
    await start(fakeClient(), 'user:bob')
    expect(useAskStore.getState().addLocal('ANN', 'x', { origin, undo: vi.fn() })).toBe('')
    expect(rows()).toHaveLength(0)
  })

  it('owner onAct (the experience’s own handler, through performAct): a switch during it runs nothing more and keeps nothing', async () => {
    const d = deferred<boolean>()
    await start(fakeClient(), 'user:ann')
    const fallback = vi.fn(async () => true)
    useHive.setState({ agentAction: fallback })
    const onAct = vi.fn(async () => (await d.promise, false)) // not handled: the shared runner would run it
    const job = performAct(wake, { you: 'ANN WORDS', experience: 'still', onAct })
    await start(fakeClient(), 'user:bob')
    d.resolve(false)
    expect(await job).toBe('stale')
    expect(fallback).not.toHaveBeenCalled()
    expect(rows()).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- B2

describe('B2: a gap recovery cannot fill stays a gap', () => {
  it('recovery unavailable: nothing after the gap applies, the history says so, reads are bounded with backoff', async () => {
    vi.useFakeTimers()
    const read = vi.fn(async () => { throw Error('recovery unavailable') })
    const op = await ask('hello', fakeClient({ askTurn: read as never }))
    deliver(nav(op, 3, '#/usage'))
    await flush()
    expect(read).toHaveBeenCalledTimes(1)
    expect(rows().find((r) => r.kind === 'gap')).toMatchObject({ state: 'waiting' })
    for (const ms of RECOVER_BACKOFF_MS) await vi.advanceTimersByTimeAsync(ms + 1)
    expect(read).toHaveBeenCalledTimes(RECOVER_TRIES)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(RECOVER_TRIES) // bounded: no more reads on its own
    const t = useAskStore.getState().turns[op]
    expect(t.gap?.state).toBe('gave-up')
    expect(t.lastSeq).toBe(1)
    expect(loc.hash).toBe('#/')
    expect(rows().find((r) => r.kind === 'gap')).toMatchObject({ state: 'failed', text: expect.stringMatching(/^Some steps could not be loaded/) })
    expect(rows().some((r) => r.kind === 'nav' || r.kind === 'go')).toBe(false)
  })

  it('a missing state-changing frame: seq 2 (a takeover-like revert) missing, the navigation at seq 3 is withheld', async () => {
    const op = await ask('hello', fakeClient({ askTurn: vi.fn(async (o: string) => ({ operation_id: o, turn_id: 't1', events: [], more: false })) as never }))
    // the host's read answers, but without seq 2: still a gap
    deliver(nav(op, 3, '#/usage'))
    await vi.waitFor(() => expect(useAskStore.getState().turns[op].recovering).toBe(false))
    expect(loc.hash).toBe('#/')
    expect(useAskStore.getState().turns[op].lastSeq).toBe(1)
    expect(useAskStore.getState().turns[op].moves).toBe(0)
  })

  it('multiple gaps and repeated reads: each gap holds what is after it; a read that fills one applies only up to the next', async () => {
    vi.useFakeTimers()
    const client = fakeClient()
    const op = await ask('hello', client)
    const f2 = frame(op, 2, { phase: 'thinking', step: 'reading' })
    frames[op] = frames[op].filter((e) => e !== f2) // the host does not have 2 yet
    deliver(nav(op, 3, '#/tasks'))
    deliver(nav(op, 5, '#/usage'))
    await flush()
    expect(useAskStore.getState().turns[op].lastSeq).toBe(1)
    // the next read has 2 but not 4: 2 and 3 apply, 5 stays held
    frames[op].push(f2)
    frames[op].sort((a, b) => a.seq - b.seq)
    await vi.advanceTimersByTimeAsync(RECOVER_BACKOFF_MS[0] + 1)
    expect(useAskStore.getState().turns[op].lastSeq).toBe(3)
    expect(loc.hash).toBe('#/tasks')
    expect(useAskStore.getState().turns[op].gap).toBeTruthy()
    // 4 arrives in the host's log: the next read applies 4 then 5, in order
    frame(op, 4, { phase: 'thinking', step: 'more' })
    frames[op].sort((a, b) => a.seq - b.seq)
    await vi.advanceTimersByTimeAsync(RECOVER_BACKOFF_MS[1] + 1)
    const t = useAskStore.getState().turns[op]
    expect(t.lastSeq).toBe(5)
    expect(t.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(t.gap).toBeUndefined()
    expect(loc.hash).toBe('#/usage')
    expect(rows().some((r) => r.kind === 'gap')).toBe(false)
  })

  it('recovery that later succeeds (the person’s Try again after the bounded reads) then applies, in order', async () => {
    vi.useFakeTimers()
    let up = false
    const client = fakeClient({
      askTurn: vi.fn(async (o: string, after = 0) => {
        if (!up) throw Error('recovery unavailable')
        return { operation_id: o, turn_id: 't1', events: (frames[o] ?? []).filter((e) => e.seq > after), more: false }
      }) as never,
    })
    const op = await ask('hello', client)
    frame(op, 2, { phase: 'thinking', step: 'reading' })
    deliver(nav(op, 3, '#/usage'))
    for (const ms of RECOVER_BACKOFF_MS) await vi.advanceTimersByTimeAsync(ms + 1)
    expect(useAskStore.getState().turns[op].gap?.state).toBe('gave-up')
    expect(loc.hash).toBe('#/')
    up = true
    await useAskStore.getState().retryRecover(op)
    const t = useAskStore.getState().turns[op]
    expect(t.events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(t.gap).toBeUndefined()
    expect(loc.hash).toBe('#/usage')
  })

  it('a final answer behind a gap that cannot be filled is shown, marked incomplete; nothing held is applied', async () => {
    vi.useFakeTimers()
    const op = await ask('hello', fakeClient({ askTurn: vi.fn(async () => { throw Error('down') }) as never }))
    deliver(nav(op, 3, '#/usage'))
    deliver(frame(op, 4, { phase: 'answer', text: 'Here is Usage.' }))
    deliver(frame(op, 5, { phase: 'done', spent_usd: 0.2, outcome: 'answered' }))
    for (const ms of RECOVER_BACKOFF_MS) await vi.advanceTimersByTimeAsync(ms + 1)
    const answer = rows().find((r) => r.kind === 'answer')!
    expect(answer).toMatchObject({ text: 'Here is Usage.', incomplete: true })
    expect(loc.hash).toBe('#/')
    const st = useAskStore.getState()
    expect(st.turns[op].lastSeq).toBe(1)
    expect(st.thread?.spent_usd).toBe(0) // the done frame's spend was not applied either
    expect(st.open).toBeNull() // the turn closes on this page so the person can ask again
  })

  it('a rebuild never takes a host log with holes as exact: the page keeps its own whole log', async () => {
    const client = fakeClient()
    const op = await ask('hello', client)
    deliver(frame(op, 2, { phase: 'thinking', step: 'reading' }))
    deliver(frame(op, 3, { phase: 'answer', text: 'Hi.' }))
    frames[op] = frames[op].filter((e) => e.seq !== 2)
    await useAskStore.getState().rebuild()
    expect(useAskStore.getState().turns[op].events.map((e) => e.seq)).toEqual([1, 2, 3])
  })
})
