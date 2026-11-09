import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The Ask's own memory, wired through the Ask store (Jon 2026-10-07: kept by the browser; the hive stores nothing).
 * A hand-made client plays the host: live memory frames with their item, the stored stub read back after a reconnect,
 * a conductor-off hive refusing memory_notes, and a private app's page.
 */
const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: loc, matchMedia: () => ({ matches: false }) }))

const { ApiError } = await import('../api/client')
const { checkAskEvent } = await import('../api/ask')
const { useHive } = await import('./store')
const { threadRows, useAskStore } = await import('./ask')
const { askMemory, LOST_WORDS } = await import('../lib/askMemory')
const { SimAsk } = await import('../api/sim/ask')
type AskEvent = import('../api/ask').AskEvent
type AskBody = import('../api/ask').AskBody
type HiveClient = import('../api/client').HiveClient

let frames: Record<string, AskEvent[]> = {}
let sent: AskBody[] = []
const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
function fakeClient(over: Partial<HiveClient> = {}, conductor = true): HiveClient {
  return {
    mode: 'sim',
    ask: vi.fn(async (b: AskBody) => {
      sent.push(JSON.parse(JSON.stringify(b)))
      return { operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const, ...(conductor ? { conductor: { model: 'm' } } : {}) }
    }),
    askTurn: vi.fn(async (op: string, after = 0) => ({ operation_id: op, turn_id: 't1', events: (frames[op] ?? []).filter((e) => e.seq > after), more: false })),
    ...over,
  } as unknown as HiveClient
}
let n = 0
async function start(client: HiveClient, principal = 'user:p_ada') {
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, principal)
  await askMemory.whenReady()
}
function frame(op: string, seq: number, f: Record<string, unknown>, store = true): AskEvent {
  const e = { type: 'ask', operation_id: op, turn_id: `t-${op}`, principal: 'user:p_ada', seq, at: '2026-10-07T05:00:00Z', ...f } as unknown as AskEvent
  if (store) (frames[op] ??= []).push(f.phase === 'memory' ? ({ ...e, item: undefined, target_id: undefined } as AskEvent) : e)
  return e
}
const deliver = (e: AskEvent) => useAskStore.getState().onEvent(JSON.parse(JSON.stringify(e)))
const rows = () => threadRows(useAskStore.getState())
const CTX = { route: 'hive', experience: 'classic' }
async function ask(text: string, _client: HiveClient, context: import('../api/ask').AskContext = CTX) {
  void _client
  await useAskStore.getState().send(text, context, { where: 'on the hive' })
  const op = useAskStore.getState().open!
  deliver(frame(op, 1, { phase: 'accepted', thread }))
  return op
}
const mem = (statement: string, kind = 'preference', target: string | null = null) => ({ phase: 'memory', op: target ? 'revise' : 'remember', item: { statement, kind, truth: { frequency: 1, confidence: 0.8 } }, target_id: target, digest: 'abcd' })
const done = (op: string, seq: number) => deliver(frame(op, seq, { phase: 'done', outcome: 'complete' }))

beforeEach(() => {
  frames = {}
  sent = []
  loc.hash = '#/'
})
afterEach(async () => {
  askMemory.forgetAll()
  await askMemory.flushed()
  useAskStore.getState().reset()
})

describe('memory frames: checked, kept the moment they arrive, said in the turn', () => {
  it('checkAskEvent reads the envelope: live (item) and stub (op, digest); anything else is dropped', () => {
    const base = { type: 'ask', operation_id: 'op-12345678', turn_id: 't1', seq: 2, at: 'x', phase: 'memory' }
    expect(checkAskEvent({ ...base, ...mem('x') })).not.toBeNull()
    expect(checkAskEvent({ ...base, op: 'remember', digest: 'abcd' })).not.toBeNull()
    expect(checkAskEvent({ ...base, op: '', digest: '' })).not.toBeNull()
    for (const bad of [{ op: 'learn', digest: 'a' }, { op: 'remember' }, { op: 'remember', digest: 'a', target_id: 'bad id!' }, { op: 'remember', digest: 'a', item: 'text' }, { op: 'remember', digest: 'a', turn_id: undefined }]) expect(checkAskEvent({ ...base, ...bad })).toBeNull()
  })
  it('a live frame is kept before the thread draws it, shows as a row, and is recalled into the next turn with its id', async () => {
    const client = fakeClient()
    await start(client)
    const op = await ask('call me Jon', client)
    expect(sent[0].memory_notes).toBeUndefined() // nothing known yet: no notes
    deliver(frame(op, 2, mem('Call them Jon', 'name')))
    expect(askMemory.getView().beliefs.map((b) => b.statement)).toEqual(['Call them Jon'])
    expect(rows().some((r) => r.kind === 'note' && r.text === 'Remembered in this browser: Call them Jon')).toBe(true)
    done(op, 3)
    await ask('what should you call me', client)
    const notes = sent[1].memory_notes as { id: string; text: string }[]
    expect(notes).toEqual([{ id: askMemory.getView().beliefs[0].id, text: 'name: Call them Jon' }])
    expect(askMemory.getView().beliefs[0].uses).toBe(1)
    expect(askMemory.getView().hive).toBe('learning')
  })
  it('a revise names the note it revises; the belief changes in place', async () => {
    const client = fakeClient()
    await start(client)
    let op = await ask('I prefer the cloud hive', client)
    deliver(frame(op, 2, mem('Uses the cloud hive', 'place')))
    done(op, 3)
    const id = askMemory.getView().beliefs[0].id
    op = await ask('no, I meant the Mac hive', client)
    deliver(frame(op, 2, mem('Uses the Mac hive', 'correction', id)))
    expect(askMemory.getView().beliefs).toMatchObject([{ id, kind: 'place', statement: 'Uses the Mac hive' }])
    expect(rows().some((r) => r.text === 'Updated in this browser: Uses the Mac hive')).toBe(true)
  })
  it('stand-in r2 P1: words forgotten mid-turn are not learned again from that turn\'s later frame; a new turn may teach them', async () => {
    const client = fakeClient()
    await start(client)
    const op = await ask('I prefer short answers', client)
    deliver(frame(op, 2, mem('Prefers short answers')))
    const id = askMemory.getView().beliefs[0].id
    expect(askMemory.forget(id)).toBe(true)
    deliver(frame(op, 3, mem('prefers short answers.')))
    expect(askMemory.getView().beliefs).toEqual([])
    expect(rows().some((r) => r.kind === 'note' && r.text === 'Not remembered: you asked the Ask to forget this.')).toBe(true)
    askMemory.forgetAll()
    deliver(frame(op, 4, mem('Works on the Mac hive', 'place')))
    expect(askMemory.getView().beliefs).toEqual([])
    done(op, 5)
    await askMemory.flushed()
    const next = await ask('I prefer short answers, really', client)
    deliver(frame(next, 2, mem('Prefers short answers')))
    expect(askMemory.getView().beliefs.map((b) => b.statement)).toEqual(['Prefers short answers'])
  })
  it('r3b: forget everything, reload, the turn rejoined: its delayed frame is timed by the host\'s accepted frame and not kept', async () => {
    const client = fakeClient()
    await start(client)
    await useAskStore.getState().send('I prefer short answers', CTX, { where: 'on the hive' })
    const op = useAskStore.getState().open!
    deliver(frame(op, 1, { phase: 'accepted', thread, at: new Date(Date.now() - 1000).toISOString() }))
    deliver(frame(op, 2, mem('Prefers short answers')))
    expect(askMemory.getView().beliefs).toHaveLength(1)
    askMemory.forgetAll()
    await askMemory.flushed()
    // the reload: the Ask and its memory start again; the turn is still open on the host, and is rejoined
    useAskStore.getState().reset()
    await start(client)
    await useAskStore.getState().rejoin(op)
    expect(useAskStore.getState().turns[op]?.memorySince).toBeUndefined()
    deliver(frame(op, 3, mem('Prefers short answers')))
    expect(askMemory.getView().beliefs).toEqual([])
    expect(rows().some((r) => r.kind === 'note' && r.text === 'Not remembered: you asked the Ask to forget this.')).toBe(true)
    await askMemory.flushed()
  })
  it('stand-in r3b P1: after a reload, a live memory frame that arrives before recovery has placed the accepted frame is held, then refused by the host time', async () => {
    // the reload's recovery read is held until the live frame has arrived (the race the stand-in reproduced)
    let gate: (() => void) | null = null
    let reads = 0
    const base = fakeClient()
    const client = {
      ...base,
      askTurn: vi.fn(async (op: string, after = 0) => {
        if (++reads === 2) await new Promise<void>((r) => (gate = r))
        return base.askTurn!(op, after)
      }),
    } as unknown as HiveClient
    await start(client)
    await useAskStore.getState().send('I prefer short answers', CTX, { where: 'on the hive' })
    const op = useAskStore.getState().open!
    deliver(frame(op, 1, { phase: 'accepted', thread, at: new Date(Date.now() - 1000).toISOString() }))
    deliver(frame(op, 2, mem('Prefers short answers')))
    expect(askMemory.getView().beliefs).toHaveLength(1)
    askMemory.forgetAll()
    await askMemory.flushed()
    useAskStore.getState().reset() // the reload
    await start(client)
    reads = 0
    const rejoined = useAskStore.getState().rejoin(op) // read 1: the turn view; read 2 (recovery): held
    for (let i = 0; i < 20 && !gate; i++) await new Promise((r) => setTimeout(r, 0))
    expect(gate).not.toBeNull()
    expect(useAskStore.getState().turns[op]?.events).toEqual([]) // the accepted frame is not placed yet
    deliver(frame(op, 3, mem('Prefers short answers'))) // live, before recovery
    expect(askMemory.getView().beliefs).toEqual([])
    gate!()
    await rejoined
    await askMemory.flushed()
    expect(askMemory.getView().beliefs).toEqual([])
    expect(JSON.stringify(askMemory.getView().trace)).not.toMatch(/short answers/i)
    expect(rows().some((r) => r.kind === 'note' && r.text === 'Not remembered: you asked the Ask to forget this.')).toBe(true)
  })
  it('stand-in r3b P1: a live memory frame whose turn start is not known is not kept (no generation fallback)', async () => {
    const client = fakeClient()
    await start(client)
    // a rejoined turn whose host frames carry no readable start
    await useAskStore.getState().send('hello', CTX, { where: 'on the hive' })
    const op = useAskStore.getState().open!
    deliver(frame(op, 1, { phase: 'accepted', thread, at: 'not a time' }))
    done(op, 2)
    useAskStore.getState().reset()
    await start(client)
    frames[op] = frames[op].filter((e) => e.phase !== 'done')
    await useAskStore.getState().rejoin(op)
    deliver(frame(op, 2, mem('Call them Jon', 'name')))
    expect(askMemory.getView().beliefs).toEqual([])
    expect(rows().some((r) => r.kind === 'note' && r.text === 'Not remembered: when this turn began is not known here.')).toBe(true)
  })
  it('after a reconnect, a stub this browser never had is one lost line, said in the turn; a kept one is not', async () => {
    const client = fakeClient()
    await start(client)
    const op = await ask('call me Jon and I prefer short answers', client)
    deliver(frame(op, 2, mem('Call them Jon', 'name')))
    frame(op, 3, mem('Prefers short answers'), true) // missed live: only its stub is on the host
    deliver(frame(op, 4, { phase: 'done', outcome: 'complete' }))
    await vi.waitFor(() => expect(rows().some((r) => r.text === LOST_WORDS)).toBe(true))
    expect(askMemory.getView().trace.filter((t) => t.kind === 'lost')).toHaveLength(1)
    expect(askMemory.getView().beliefs.map((b) => b.statement)).toEqual(['Call them Jon'])
  })
})

describe('memory_notes: only where the hive takes them, never from a private page', () => {
  it('notes go once with the request; a refusal is never re-sent without them (the host takes notes whatever its switches)', async () => {
    const ask0 = vi.fn(async (b: AskBody) => {
      sent.push(JSON.parse(JSON.stringify(b)))
      throw new ApiError(400, 'invalid', 'invalid')
    })
    const client = fakeClient({ ask: ask0 as never })
    await start(client)
    askMemory.receive({ turn_id: 'tx', seq: 1, op: 'remember', digest: 'd', item: { statement: 'Prefers short answers', kind: 'preference', truth: { frequency: 1, confidence: 0.8 } } }, { privatePage: false, since: askMemory.turnMark() })
    await useAskStore.getState().send('hello', CTX)
    expect(sent.map((b) => !!b.memory_notes)).toEqual([true])
    expect(useAskStore.getState().turns[sent[0].operation_id].state).toBe('refused')
  })
  it('a private app page sends no notes and keeps nothing it is told', async () => {
    const client = fakeClient()
    await start(client)
    askMemory.receive({ turn_id: 'tx', seq: 1, op: 'remember', digest: 'd', item: { statement: 'Prefers short answers', kind: 'preference', truth: { frequency: 1, confidence: 0.8 } } }, { privatePage: false, since: askMemory.turnMark() })
    loc.hash = '#/programs/atlas'
    const op = await ask('call me Jon', client, { private: true })
    expect(sent[0].memory_notes).toBeUndefined()
    deliver(frame(op, 2, mem('Call them Jon', 'name')))
    expect(askMemory.getView().beliefs.map((b) => b.statement)).toEqual(['Prefers short answers'])
    expect(rows().some((r) => r.text === 'Not remembered: this page is private.')).toBe(true)
  })
  it('another person signing in switches the memory; an unknown person has none', async () => {
    const client = fakeClient()
    await start(client)
    askMemory.receive({ turn_id: 'tx', seq: 1, op: 'remember', digest: 'd', item: { statement: 'Prefers short answers', kind: 'preference', truth: { frequency: 1, confidence: 0.8 } } }, { privatePage: false, since: askMemory.turnMark() })
    await askMemory.flushed()
    await start(client, 'user:p_rowan')
    expect(askMemory.getView().owner?.principal).toBe('user:p_rowan')
    expect(askMemory.getView().beliefs).toEqual([])
    await start(client, 'unknown')
    expect(askMemory.getView().owner).toBeNull()
    await start(client)
    expect(askMemory.getView().beliefs.map((b) => b.statement)).toEqual(['Prefers short answers'])
  })
})

describe('the simulator plays the host memory contract', () => {
  it('accepts memory_notes as the host does, stores only stubs, and revises a note it was sent', () => {
    const emitted: AskEvent[] = []
    const later: (() => void)[] = []
    const sim = new SimAsk({
      emit: (e) => emitted.push(e),
      later: (_ms, fn) => later.push(fn),
      agents: () => [{ id: 'a_vega01', name: 'Vega', status: 'awake', swarm_id: 's_lyra' } as never],
      swarms: () => [{ id: 's_lyra', name: 'Lyra', coordinator_id: 'a_vega01' } as never],
      goals: () => [],
      principal: () => 'user:operator',
    })
    const body = (text: string, notes?: AskBody['memory_notes']): AskBody => ({ operation_id: `op-${text.length}-abcdefgh`, text, context: { route: 'hive', experience: 'classic' }, via: 'typed', ...(notes ? { memory_notes: notes } : {}) })
    expect(() => sim.ask(body('x', Array.from({ length: 21 }, () => 'n')))).toThrow()
    expect(() => sim.ask(body('x', [{ id: 'bad id', text: 'x' }]))).toThrow()
    const r = sim.ask(body('no, I meant the Mac hive', [{ id: 'b_1', text: 'place: Uses the cloud hive' }]))
    expect(r.conductor).toBeTruthy()
    while (later.length) later.shift()!()
    const m = emitted.filter((e) => e.phase === 'memory') as Extract<AskEvent, { phase: 'memory' }>[]
    expect(m).toHaveLength(1)
    expect(m[0]).toMatchObject({ op: 'revise', target_id: 'b_1', item: { kind: 'correction' } })
    const stored = sim.turn(r.operation_id).events.filter((e) => e.phase === 'memory') as Extract<AskEvent, { phase: 'memory' }>[]
    expect(stored[0].item).toBeUndefined()
    expect(stored[0].digest).toBe(m[0].digest)
  })
})

describe('conductor-live: the host says its switches; the memory state follows them, bound to the identity', () => {
  const settingsWith = (capabilities: unknown) => vi.fn(async () => ({ swarm_id: 'sw_x', thread_budget_usd: 0.25, capabilities }))
  it('memory on: never "unknown" before the first Ask once the switches are read', async () => {
    const client = fakeClient({ askSettings: settingsWith({ conductor: true, memory: true }) as never })
    await start(client)
    expect(askMemory.getView().hive).toBe('unknown')
    await useAskStore.getState().loadSettings()
    expect(askMemory.getView().capabilities).toEqual({ conductor: true, memory: true })
    expect(askMemory.getView().hive).toBe('conductor')
  })
  it('memory off (conductor on): off, and no notes are sent', async () => {
    const client = fakeClient({ askSettings: settingsWith({ conductor: true, memory: false }) as never })
    await start(client)
    askMemory.receive({ turn_id: 'tx', seq: 1, op: 'remember', digest: 'd', item: { statement: 'Prefers short answers', kind: 'preference', truth: { frequency: 1, confidence: 0.8 } } }, { privatePage: false, since: askMemory.turnMark() })
    await useAskStore.getState().loadSettings()
    expect(askMemory.getView().hive).toBe('off')
    await useAskStore.getState().send('hello', CTX)
    expect(sent[0].memory_notes).toBeUndefined()
    // a reply carrying the conductor does not turn a memory the host says is off back on
    expect(askMemory.getView().hive).toBe('off')
  })
  it('conductor off: memory reads off with the conductor off, whatever the host says of memory', async () => {
    const client = fakeClient({ askSettings: settingsWith({ conductor: false, memory: true }) as never }, false)
    await start(client)
    await useAskStore.getState().loadSettings()
    expect(askMemory.getView().capabilities).toEqual({ conductor: false, memory: false })
    expect(askMemory.getView().hive).toBe('off')
  })
  it('an older host that does not say: the state is left to the replies, as before', async () => {
    const client = fakeClient({ askSettings: settingsWith(undefined) as never })
    await start(client)
    await useAskStore.getState().loadSettings()
    expect(askMemory.getView().capabilities).toBeNull()
    expect(askMemory.getView().hive).toBe('unknown')
  })
  it('a read that an identity change overtook binds nothing; the new person reads their own', async () => {
    let release: (v: unknown) => void = () => undefined
    const slow = vi.fn(() => new Promise((r) => (release = r)))
    const client = fakeClient({ askSettings: slow as never })
    await start(client)
    const pending = useAskStore.getState().loadSettings()
    await start(client, 'user:p_bea')
    release({ swarm_id: 'sw_x', thread_budget_usd: 0.25, capabilities: { conductor: true, memory: false } })
    await pending
    expect(askMemory.getView().owner?.principal).toBe('user:p_bea')
    expect(askMemory.getView().capabilities).toBeNull()
    expect(useAskStore.getState().settings).toBeNull()
  })
  it('r2 P2: a late memory frame never turns memory the host says is off back on, and nothing is recalled', async () => {
    const client = fakeClient({ askSettings: settingsWith({ conductor: true, memory: false }) as never })
    await start(client)
    await useAskStore.getState().loadSettings()
    expect(askMemory.getView().hive).toBe('off')
    askMemory.receive({ turn_id: 'tx', seq: 1, op: 'remember', digest: 'd', item: { statement: 'Prefers short answers', kind: 'preference', truth: { frequency: 1, confidence: 0.8 } } }, { privatePage: false, since: askMemory.turnMark() })
    expect(askMemory.getView().hive).toBe('off')
    expect(askMemory.notesFor('short answers please').notes).toEqual([])
    await useAskStore.getState().send('short answers please', CTX)
    expect(sent[0].memory_notes).toBeUndefined()
  })
  it('r2 P2: one turn’s acceptance (a replay admitted before the conductor) never overwrites the host’s switches; it reads them again', async () => {
    const settings = settingsWith({ conductor: true, memory: true })
    const client = fakeClient({ askSettings: settings as never }, false)
    await start(client)
    await useAskStore.getState().loadSettings()
    expect(settings).toHaveBeenCalledTimes(1)
    await useAskStore.getState().send('hello', CTX)
    expect(askMemory.getView().capabilities).toEqual({ conductor: true, memory: true })
    expect(askMemory.getView().hive).toBe('conductor')
    await vi.waitFor(() => expect(settings).toHaveBeenCalledTimes(2))
  })
  it('switches read before this browser’s memory finished loading still decide the state', async () => {
    const client = fakeClient({ askSettings: settingsWith({ conductor: true, memory: false }) as never })
    useHive.setState({ client, session: `session-${++n}`, inits: n })
    useAskStore.getState().bind(useHive.getState().session, 'user:p_cy')
    await useAskStore.getState().loadSettings()
    await askMemory.whenReady()
    expect(askMemory.getView().hive).toBe('off')
  })
})

describe('conductor-live: the memory section’s words in each state (features/keys/AskMemorySection)', () => {
  it('off, conductor off, on with nothing learned, learning, and an older host', async () => {
    const { memoryStatus } = await import('../features/ask/words')
    const on = { conductor: true, memory: true }
    expect(memoryStatus(true, 'off', { conductor: true, memory: false }, 0)).toBe('Memory is off on this hive: nothing new is learned here.')
    expect(memoryStatus(true, 'off', { conductor: false, memory: false }, 0)).toMatch(/^Memory is off on this hive: its Ask runs without the part that learns/)
    expect(memoryStatus(true, 'off', { conductor: true, memory: false }, 2)).toMatch(/stays until you forget it\.$/)
    const nothing = memoryStatus(true, 'conductor', on, 0)
    expect(nothing).toMatch(/^Nothing learned yet\. Memory is on/)
    expect(nothing).not.toMatch(/off|unknown/i)
    expect(memoryStatus(true, 'learning', on, 1)).toMatch(/^Kept only in this browser/)
    expect(memoryStatus(true, 'unknown', null, 0)).toMatch(/If this hive’s memory is off, nothing will be\.$/)
    expect(memoryStatus(false, 'unknown', on, 0)).toMatch(/^Sign in/)
  })
})
