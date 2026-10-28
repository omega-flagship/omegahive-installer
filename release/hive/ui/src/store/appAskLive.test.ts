import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Same in-memory store fixture shape as the existing Ask tests; no network or browser provider.
const loc = { hash: '#/', search: '', pathname: '/' }, moved: string[] = []
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined })
vi.mock('../lib/router', async (orig) => {
  const real = await orig<typeof import('../lib/router')>()
  return { ...real, navigate: (r: import('../lib/router').Route) => { loc.hash = real.href(r); moved.push(loc.hash) } }
})
const { useHive } = await import('./store')
const { setMover, threadRows, useAskStore } = await import('./ask')
const { claimAppAsk, offerAppAsk, recordAppAsk, useAppAskStore } = await import('./appAsk')
const { askMemory } = await import('../lib/askMemory')
type AskEvent = import('../api/ask').AskEvent
type AskAccepted = import('../api/ask').AskAccepted
type HiveClient = import('../api/client').HiveClient
type AppAskController = import('../lib/appAsk').AppAskController
type AppAskPort = import('../lib/appAsk').AppAskPort

const thread = { id: 'thread-1', mind: { id: 'mind-1', name: 'Garden' }, budget_usd: 0.25, spent_usd: 0 }
const event = (op: string, seq: number, fields: object, turn = 'turn-1') => ({ type: 'ask', app_ask: true, operation_id: op, turn_id: turn, seq, at: '2026-10-24T17:00:00Z', ...fields }) as AskEvent
const stub = (op: string, seq: number, fields: object) => ({ type: 'ask', app_ask: true, personal: true, operation_id: op, turn_id: 'turn-1', seq, at: '2026-10-24T17:00:00Z', ...fields })
const memory = (op: string, seq: number) => event(op, seq, { phase: 'memory', op: 'remember', digest: 'a'.repeat(64), item: { statement: 'An invented test preference.', kind: 'preference', truth: { frequency: 1, confidence: 0.9 } } })
const defer = <T,>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
let session = 0
function start(history: ReturnType<typeof stub>[] = [], over: Partial<HiveClient> = {}) {
  const client = { mode: 'sim', ask: vi.fn(), askTakeover: vi.fn(), askStop: vi.fn(),
    askTurn: vi.fn(async (op: string, after = 0) => ({ operation_id: op, turn_id: 'turn-1', app_ask: true, state: 'open', events: history.filter((e) => e.seq > after), more: false })),
    ...over,
  } as unknown as HiveClient
  useHive.setState({ client, session: `app-ask-${++session}`, inits: session })
  useAskStore.getState().bind(useHive.getState().session, 'user:test-person')
  return client
}
beforeEach(() => { moved.length = 0; loc.hash = '#/'; setMover(null); useAppAskStore.setState({ turns: [], provisional: [] }) })
afterEach(() => { vi.restoreAllMocks(); useAskStore.getState().reset(); useAppAskStore.setState({ turns: [], provisional: [] }); setMover(null) })

describe('P1 canonical live Ask adoption', () => {
  it('holds live words before admission reply and returns the same turn after a fence without a second Ask or legacy effects', async () => {
    const op = 'app:canonical', client = start([
      stub(op, 1, { phase: 'accepted', thread: { id: thread.id, mind: { id: thread.mind.id }, budget_usd: 0.25, spent_usd: 0 } }),
      stub(op, 2, { phase: 'answer' }), stub(op, 3, { phase: 'proposal' }),
    ])
    // Full authenticated live frames arrive before the app send HTTP response.
    useAskStore.getState().onEvent(event(op, 1, { phase: 'accepted', thread }))
    useAskStore.getState().onEvent(event(op, 2, { phase: 'answer', text: 'Words already held in this browser.' }))
    useAskStore.getState().onEvent(event(op, 3, { phase: 'proposal', proposal: { id: 'nav-1', kind: 'navigate', route: '#/usage', label: 'Usage', digest: 'nav-digest' } }))
    expect(useAskStore.getState().turns[op]).toMatchObject({ appAsk: true, appAskTurnId: 'turn-1', lastSeq: 3 })
    expect(useAskStore.getState().adoptAppTurn(op, 'turn-1', 'The request admitted by the app')).toBe(true)
    expect(useAskStore.getState().adoptAppTurn(op, 'turn-1', 'Later words cannot rename it')).toBe(true)
    const p = { operation_id: op, turn_id: 'turn-1', owner: 'frame' as const, generation_id: 'generation-1', host_active: false, epoch: 1 }
    const port = { askPresentation: async () => p, askClaim: async (_op: string, body: { expected_epoch: number }) => {
      expect(body).toEqual({ expected_epoch: 1 }); return { ...p, owner: 'host', generation_id: null, host_active: true, epoch: 2 }
    } } as unknown as AppAskPort
    const entry = { app: 'garden', appName: 'Garden', presentation: p, port, current: () => true, offeredLocally: false,
      controller: { active: () => true, hostClaimed: () => undefined } as unknown as AppAskController }
    expect(recordAppAsk(entry)).toBe(true); offerAppAsk(op, 'generation-1')
    const offered = useAppAskStore.getState().turns[0]
    expect(offered.offeredLocally).toBe(true)
    expect(await claimAppAsk(offered)).toMatchObject({ operation_id: op, turn_id: 'turn-1', owner: 'host', epoch: 2 })
    await useAskStore.getState().showAppTurn(op)
    expect(client.askTurn).not.toHaveBeenCalled(); expect(client.ask).not.toHaveBeenCalled(); expect(client.askTakeover).not.toHaveBeenCalled()
    expect(useAskStore.getState().open).toBe(op); expect(useAskStore.getState().log).toHaveLength(1)
    await useAskStore.getState().rebuild() // content-free stored copies cannot overwrite already-held live projections
    expect(threadRows(useAskStore.getState()).filter((r) => r.kind === 'answer').map((r) => r.text)).toEqual(['Words already held in this browser.'])
    expect(useAskStore.getState().turns[op].you).toBe('The request admitted by the app'); expect(moved).toHaveLength(0)
  })
  it('preserves an ahead live answer when content-free recovery fills its preceding gap', async () => {
    const op = 'app:gap'; start([stub(op, 2, { phase: 'thinking' }), stub(op, 3, { phase: 'answer' })])
    useAskStore.getState().onEvent(event(op, 1, { phase: 'accepted', thread }))
    useAskStore.getState().onEvent(event(op, 3, { phase: 'answer', text: 'The live answer survives the metadata read.' }))
    await vi.waitFor(() => expect(useAskStore.getState().turns[op].lastSeq).toBe(3))
    expect(useAskStore.getState().turns[op].events.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(threadRows(useAskStore.getState()).find((r) => r.kind === 'answer')?.text).toBe('The live answer survives the metadata read.')
  })
  it('does not adopt before an own binding or attach another turn to the same operation', () => {
    useAskStore.getState().reset()
    useAskStore.getState().onEvent(event('app:own', 1, { phase: 'accepted', thread }))
    expect(useAskStore.getState().turns['app:own']).toBeUndefined()
    start(); useAskStore.getState().onEvent(event('app:own', 1, { phase: 'accepted', thread }))
    useAskStore.getState().onEvent(event('app:own', 2, { phase: 'answer', text: 'Wrong turn' }, 'different-turn'))
    expect(useAskStore.getState().adoptAppTurn('app:own', 'different-turn', 'Other words')).toBe(false)
    expect(useAskStore.getState().turns['app:own'].lastSeq).toBe(1); expect(useAskStore.getState().log).toHaveLength(1)
  })
  it('bounds automatic app-turn adoption without evicting existing browser-held turns', () => {
    start()
    for (let i = 0; i < 33; i++) useAskStore.getState().onEvent(event(`app:${i}`, 1, { phase: 'accepted', thread }, `turn-${i}`))
    expect(Object.keys(useAskStore.getState().turns)).toHaveLength(32)
    expect(useAskStore.getState().turns['app:0']).toBeDefined(); expect(useAskStore.getState().turns['app:32']).toBeUndefined()
  })
  it('keeps live-before-response unknown app origin private after navigation and late text enrichment', () => {
    const receive = vi.spyOn(askMemory, 'receive').mockReturnValue({ kept: null, why: 'private' })
    const op = 'app:unknown-private'; start()
    useAskStore.getState().onEvent(event(op, 1, { phase: 'accepted', thread }))
    loc.hash = '#/usage' // a current public route cannot prove that this turn began outside a private page
    useAskStore.getState().onEvent(memory(op, 2))
    expect(useAskStore.getState().turns[op].privatePage).toBe(true)
    useAskStore.getState().adoptAppTurn(op, 'turn-1', 'Only the later admitted text is known')
    useAskStore.getState().onEvent(memory(op, 3))
    expect(receive).toHaveBeenCalledTimes(2)
    expect(receive.mock.calls.every(([, opts]) => opts.privatePage)).toBe(true)
    expect(useAskStore.getState().turns[op].privatePage).toBe(true)
  })
  it('keeps rejoined P1 origin private across recovery and a later public route', async () => {
    const receive = vi.spyOn(askMemory, 'receive').mockReturnValue({ kept: null, why: 'private' })
    const op = 'app:rejoined-private'; start()
    await useAskStore.getState().rejoin(op)
    loc.hash = '#/usage'; useAskStore.getState().onEvent(event(op, 1, { phase: 'accepted', thread })); useAskStore.getState().onEvent(memory(op, 2))
    await useAskStore.getState().recover(op); await useAskStore.getState().rebuild()
    expect(useAskStore.getState().turns[op].privatePage).toBe(true)
    expect(receive).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ privatePage: true }))
  })
  it('captures a trusted private host origin before its response and never clears it after navigation or adoption', async () => {
    const receive = vi.spyOn(askMemory, 'receive').mockReturnValue({ kept: null, why: 'private' }), d = defer<AskAccepted>()
    start([], { ask: async () => d.promise })
    const pending = useAskStore.getState().send('An invented host question', { private: true })
    const op = useAskStore.getState().open!
    expect(useAskStore.getState().turns[op].privatePage).toBe(true)
    loc.hash = '#/usage'; d.resolve({ operation_id: op, turn_id: 'turn-1', thread, state: 'accepted' }); await pending
    useAskStore.getState().adoptAppTurn(op, 'turn-1')
    useAskStore.getState().onEvent(event(op, 1, { phase: 'accepted', thread })); useAskStore.getState().onEvent(memory(op, 2))
    expect(useAskStore.getState().turns[op].privatePage).toBe(true)
    expect(receive).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ privatePage: true }))
  })
  it('retains explicit public provenance only from a trusted host send captured before await', async () => {
    const d = defer<AskAccepted>(); start([], { ask: async () => d.promise })
    const pending = useAskStore.getState().send('An invented public host question', { route: 'hive', experience: 'classic' })
    const op = useAskStore.getState().open!
    expect(useAskStore.getState().turns[op].privatePage).toBe(false)
    d.resolve({ operation_id: op, turn_id: 'turn-1', thread, state: 'accepted' }); await pending
    useAskStore.getState().adoptAppTurn(op, 'turn-1')
    expect(useAskStore.getState().turns[op].privatePage).toBe(false)
  })
})
