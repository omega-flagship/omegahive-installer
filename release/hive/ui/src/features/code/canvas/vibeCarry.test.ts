import { afterEach, describe, expect, it, vi } from 'vitest'

// Propose's words ride to the Code swarm on an Ask turn that says carry (askBridge admittedTurn's carry), which the
// host closes at admission with nothing answering it, so neither the person's own mind nor the conductor answers or
// builds the same words beside the card (a tester's v0.39 Linux gate got a second app from them); they never steer a
// turn already open, whose answerer a steer reaches, and the thread says where the words went in place of the stop
// words. A hand-made Ask client (invented data, no network) that answers a carried turn closed, as the host does (hive
// API.md, POST /api/ask).
const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', { location: loc, matchMedia: () => ({ matches: false }), addEventListener: () => undefined, removeEventListener: () => undefined, innerWidth: 1440, innerHeight: 900 })

const { useHive } = await import('../../../store/store')
const { turnRows, useAskStore } = await import('../../../store/ask')
const { admittedTurn } = await import('./askBridge')
const { carriedWords } = await import('./vibeRoute')
type HiveClient = import('../../../api/client').HiveClient
type TurnMeta = import('../../../store/ask').TurnMeta

const TEAM = 'Create · Code'
// a hand-made Ask client, as vibeAdmission.test.ts plays it
const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0 }
const CTX = { route: 'code', experience: 'classic' } as const
function askClient(): HiveClient {
  return {
    mode: 'sim',
    ask: vi.fn(async (b: { operation_id: string; carry?: true }) => (b.carry
      ? { operation_id: b.operation_id, turn_id: 't1', thread, state: 'refused' as const, reason: 'stopped' }
      : { operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't1', thread, state: 'thinking', events: [], more: false })),
    askSteer: vi.fn(async (op: string, b: { steer_id: string }) => ({ steer_id: b.steer_id, operation_id: op })),
    askStop: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't1', thread, state: 'refused', reason: 'stopped' })),
  } as unknown as HiveClient
}
let n = 0
function start(client: HiveClient) {
  useHive.setState({ client, session: `carry-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session!, 'user:p_ada')
}
afterEach(() => useAskStore.getState().reset())
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve() }

describe('admittedTurn with carry: the turn Propose rides on says so, and the host closes it', () => {
  it('a new turn: its admission says carry, so nothing answers it and the page sends no stop; the Ask panel stays shut', async () => {
    const c = askClient()
    start(c)
    const op = await admittedTurn('Add a Reset button', CTX, undefined, false, carriedWords(TEAM))
    await settle()
    const body = (c.ask as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(body).toMatchObject({ operation_id: op, text: 'Add a Reset button', carry: true })
    expect(body).not.toHaveProperty('memory_notes')
    expect(body).not.toHaveProperty('answer_in')
    expect(c.askStop).not.toHaveBeenCalled()
    expect(useAskStore.getState().turns[op].carried).toBe(`Sent to ${TEAM}. Its card on the Code page shows the change.`)
    expect(useAskStore.getState().threadOpen).toBe(false)
  })
  it('a turn already open: the change never steers it; it is refused in the Ask’s words, and that turn goes on', async () => {
    const c = askClient()
    start(c)
    const open = await admittedTurn('what does app.js do?', CTX)
    await expect(admittedTurn('Add a Reset button', CTX, undefined, false, carriedWords(TEAM))).rejects.toMatchObject({ code: 'unsupported' })
    await settle()
    expect(c.askSteer).not.toHaveBeenCalled()
    expect(c.ask).toHaveBeenCalledTimes(1)
    expect(c.askStop).not.toHaveBeenCalled()
    expect(useAskStore.getState().turns[open].carried).toBeUndefined()
  })
  it('without carry (a test request, the Ask itself): the turn is the Ask’s own, and nothing is stopped', async () => {
    const c = askClient()
    start(c)
    await admittedTurn('run the tests', CTX)
    await settle()
    expect((c.ask as ReturnType<typeof vi.fn>).mock.calls[0][0]).not.toHaveProperty('carry')
    expect(c.askStop).not.toHaveBeenCalled()
  })
})

describe('the thread says where carried words went, never that they were stopped', () => {
  const turn = (over: Partial<TurnMeta>) => ({ op: 'op-carry', you: 'Add a Reset button', events: [], outcomes: {}, steers: [], notes: [], ...over }) as unknown as TurnMeta
  const said = (t: TurnMeta) => turnRows(t, 'Vega').filter((r) => r.kind !== 'you').map((r) => [r.kind, r.text, r.reason])
  const note = carriedWords(TEAM)
  it('the host’s stop of a conductor turn (done, cancelled) and of an ordinary turn (refused, stopped)', () => {
    expect(said(turn({ carried: note, events: [{ seq: 1, phase: 'done', outcome: 'cancelled' }] as never }))).toEqual([['note', note, undefined]])
    expect(said(turn({ carried: note, events: [{ seq: 1, phase: 'refused', reason: 'stopped' }] as never }))).toEqual([['note', note, undefined]])
  })
  it('a stop answered before any frame', () => {
    expect(said(turn({ carried: note, refusedEarly: 'stopped' }))).toEqual([['note', note, undefined]])
  })
  it('a turn admitted for the person’s own mind never says that mind answers it (a fresh hive showed both lines)', () => {
    const actingAs = { mind_id: 'a_vega01', name: 'Vega' }
    expect(said(turn({ carried: note, actingAs, events: [{ seq: 1, phase: 'refused', reason: 'stopped' }] as never }))).toEqual([['note', note, undefined]])
    expect(said(turn({ actingAs }))).toEqual([['note', 'Answering for you: your mind Vega.', undefined]])
  })
  it('a turn the person stopped themselves still says it stopped', () => {
    expect(said(turn({ events: [{ seq: 1, phase: 'done', outcome: 'cancelled' }] as never }))).toEqual([['note', 'This request was stopped.', undefined]])
    expect(said(turn({ events: [{ seq: 1, phase: 'refused', reason: 'stopped' }] as never }))).toEqual([['refused', '', 'stopped']])
  })
})
