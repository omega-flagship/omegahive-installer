import { afterEach, describe, expect, it, vi } from 'vitest'

// Propose's words ride to the Code swarm on an Ask turn the page closes at once (askBridge admittedTurn's carry), so
// the person's own mind never answers the same words beside the card; a steer of a turn already open is left alone,
// and the thread says where the words went in place of the stop words. A hand-made Ask client (invented data, no
// network), as vibeAdmission.test.ts plays it.
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
    ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })),
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

describe('admittedTurn with carry: the turn Propose rides on closes at once', () => {
  it('a new turn: stopped right after admission, so no answer of the person’s own mind follows; the Ask panel stays shut', async () => {
    const c = askClient()
    start(c)
    const op = await admittedTurn('Add a Reset button', CTX, undefined, false, carriedWords(TEAM))
    await settle()
    expect(c.askStop).toHaveBeenCalledTimes(1)
    expect(c.askStop).toHaveBeenCalledWith(op)
    expect(useAskStore.getState().turns[op].carried).toBe(`Sent to ${TEAM}. Its card on the Code page shows the change.`)
    expect(useAskStore.getState().threadOpen).toBe(false)
  })
  it('a steer of a turn already open: that turn is never stopped', async () => {
    const c = askClient()
    start(c)
    const open = await admittedTurn('what does app.js do?', CTX)
    expect(await admittedTurn('Add a Reset button', CTX, undefined, false, carriedWords(TEAM))).toBe(open)
    await settle()
    expect(c.askStop).not.toHaveBeenCalled()
    expect(useAskStore.getState().turns[open].carried).toBeUndefined()
  })
  it('without carry (a test request, the Ask itself): nothing is stopped', async () => {
    const c = askClient()
    start(c)
    await admittedTurn('run the tests', CTX)
    await settle()
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
