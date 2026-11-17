// Purpose: verify the Ask store remembers a request that ended before its answer and lets it be continued: it joins the
// person's conversation with what it said and did and why it stopped, its closing row states the facts its Continue is
// composed from, and Continue sends its words as the next request, carrying that exchange, for a day from its turn's start
// (the hive's own window for what a turn may hand over), after which it is neither carried nor continued.
// the hive's own source, read as text by Vite: the page's types are the browser's, with no node:fs
import intentsSource from '../../../core/ask_intents.py?raw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: loc, matchMedia: () => ({ matches: false }) }))

const { useHive } = await import('./store')
const { askRetryContext, endedEarly, STOPPED_KEEP_MS, stoppedUntil, threadRows, useAskStore } = await import('./ask')
const { askMemory } = await import('../lib/askMemory')
const { memoryBackend } = await import('../lib/askMemory/backend')
const { currentEpoch } = await import('../lib/identityEpoch')
const { DONE_WORDS, refusedSay } = await import('../features/ask/words')
type AskBody = import('../api/ask').AskBody
type AskEvent = import('../api/ask').AskEvent
type HiveClient = import('../api/client').HiveClient
type MemoryBackend = import('../lib/askMemory/backend').MemoryBackend

/**
 * Haley, testers' group, 17 Nov: "At the very least, if it's going to stop, please have a 'continue task' button... Ask
 * currently doesn't remember what it was working on". Invented lives only: Ada (user:p_ada) and her own mind Taiga.
 */
const TAIGA = { mind_id: 'a_taiga01', name: 'Taiga' }
const thread = { id: 'ses_ask1', mind: { id: 'a_coord01', name: 'Orchestra' }, budget_usd: 0.25, spent_usd: 0 }

const dbs = new Map<string, MemoryBackend>()
;(askMemory as unknown as { deps: { backend: (n: string) => MemoryBackend } }).deps.backend = (n) => dbs.get(n) ?? (dbs.set(n, { ...memoryBackend(), durable: true }), dbs.get(n)!)

let sent: AskBody[] = []
let n = 0
const client = {
  mode: 'sim',
  ask: vi.fn(async (b: AskBody) => {
    sent.push(JSON.parse(JSON.stringify(b)))
    return { operation_id: b.operation_id, turn_id: `t${sent.length}`, thread, state: 'accepted' as const }
  }),
  askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't', events: [], more: false })),
  askStop: vi.fn(async () => ({})),
  askEndThread: vi.fn(async () => ({})),
} as unknown as HiveClient

async function signIn() {
  useHive.setState({ client, session: `session-cont-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
  await askMemory.whenReady()
}
// the hive's clock as its frames carry it: the turn began a moment ago
const startedAt = () => new Date(Date.now() - 1000).toISOString()
const frame = (op: string, turn: string, seq: number, f: Record<string, unknown>) =>
  ({ type: 'ask', operation_id: op, turn_id: turn, principal: 'user:p_ada', seq, at: startedAt(), ...f }) as unknown as AskEvent
const deliver = (e: AskEvent) => useAskStore.getState().onEvent(e)
const ctx = { route: 'hive', experience: 'classic' } as never

/** A request the hive takes, says a little and hands one thing over, then ends with `end`; returns its operation id. */
async function endedWith(words: string, end: Record<string, unknown>): Promise<string> {
  await useAskStore.getState().send(words, ctx, { where: 'on the hive' })
  const op = useAskStore.getState().open!
  const turn = `t${sent.length}`
  deliver(frame(op, turn, 1, { phase: 'accepted', thread, speaks_as: TAIGA }))
  deliver(frame(op, turn, 2, { phase: 'answer', text: 'Starting on the board. ', delta: true }))
  deliver(frame(op, turn, 3, { phase: 'dispatched', intent_id: 'in_1', intent_kind: 'create.plan', to: { kind: 'service', ref: 'create', name: 'Create' }, label: 'Tic-tac-toe' }))
  deliver(frame(op, turn, 4, end))
  return op
}
const stopRow = (op: string) => threadRows(useAskStore.getState()).find((r) => r.op === op && r.ending)

beforeEach(async () => {
  sent = []
  dbs.clear()
  loc.hash = '#/'
  await signIn()
})
afterEach(() => {
  useAskStore.getState().reset()
  vi.useRealTimers()
})

describe('a request that ended before its answer joins the conversation', () => {
  it('a stopped request is kept with what it said and handed over and why it stopped, and the next request carries it', async () => {
    const op = await endedWith('build me a tic-tac-toe game', { phase: 'done', outcome: 'cancelled', spent_usd: 0, turn_spent_usd: 0 })
    expect(endedEarly(useAskStore.getState().turns[op])).toBe(true)
    await vi.waitFor(() => expect(askMemory.getView().talks).toHaveLength(1))
    const kept = askMemory.getView().talks[0]
    expect(kept).toMatchObject({ mind_id: TAIGA.mind_id, mind_name: 'Taiga', words: 'build me a tic-tac-toe game' })
    expect(kept.answer.split('\n')).toEqual(['Starting on the board.', 'Handed to Create: Tic-tac-toe.', DONE_WORDS.cancelled])
    await useAskStore.getState().send('continue', ctx, { where: 'on the hive' })
    expect(sent[sent.length - 1]).not.toHaveProperty('continues')
    const carried = sent[sent.length - 1].conversation
    expect(carried?.map((e) => [e.said, e.by])).toEqual([['build me a tic-tac-toe game', TAIGA.mind_id]])
    expect(carried?.[0].answer).toBe(`Starting on the board. Handed to Create: Tic-tac-toe. ${DONE_WORDS.cancelled}`)
  })

  it('a refusal after the hive took it (a coordinator turn stopped, the hive lost) is kept with the refusal\'s words', async () => {
    const op = await endedWith('plan my week', { phase: 'refused', reason: 'not_available', spent_usd: 0, turn_spent_usd: 0 })
    expect(endedEarly(useAskStore.getState().turns[op])).toBe(true)
    await vi.waitFor(() => expect(askMemory.getView().talks).toHaveLength(1))
    expect(askMemory.getView().talks[0].answer.split('\n').at(-1)).toBe(refusedSay('not_available'))
  })

  it('an answered request, a spending stop and a request refused before the hive took it are not ended early', async () => {
    const done = await endedWith('build me a clock', { phase: 'done', outcome: 'complete', spent_usd: 0, turn_spent_usd: 0 })
    expect(endedEarly(useAskStore.getState().turns[done])).toBe(false)
    const spend = await endedWith('build me a map', { phase: 'done', outcome: 'spend_cap', spent_usd: 0.25, turn_spent_usd: 0.25 })
    expect(endedEarly(useAskStore.getState().turns[spend])).toBe(false)
    expect(stopRow(spend)?.ending).toMatchObject({ early: false, latest: true })
    const refusedLimit = await endedWith('build me a game', { phase: 'refused', reason: 'spend_limit', spent_usd: 0, turn_spent_usd: 0 })
    expect(endedEarly(useAskStore.getState().turns[refusedLimit])).toBe(false)
    // nothing ended early, so nothing joined the conversation that an answer did not bring
    expect(askMemory.getView().talks.map((t) => t.words)).toEqual([])
  })

  it('a private app\'s request is never kept, however it ended', async () => {
    await useAskStore.getState().send('read my journal', { route: 'program', experience: 'classic', private: true } as never, { where: 'in Atlas' })
    const op = useAskStore.getState().open!
    deliver(frame(op, 'tp', 1, { phase: 'accepted', thread, speaks_as: TAIGA }))
    deliver(frame(op, 'tp', 2, { phase: 'done', outcome: 'cancelled', spent_usd: 0, turn_spent_usd: 0 }))
    await new Promise((r) => setTimeout(r, 0))
    expect(askMemory.getView().talks).toEqual([])
  })
})

describe('the facts Continue is composed from, and Continue itself', () => {
  it('the closing row says it ended early, and latest only while it is the thread\'s latest request', async () => {
    const op = await endedWith('build me a tic-tac-toe game', { phase: 'done', outcome: 'time_cap', spent_usd: 0, turn_spent_usd: 0 })
    expect(stopRow(op)).toMatchObject({ kind: 'note', text: DONE_WORDS.time_cap, ending: { early: true, latest: true } })
    const later = await endedWith('and a chess board', { phase: 'done', outcome: 'complete', spent_usd: 0, turn_spent_usd: 0 })
    expect(stopRow(op)?.ending).toMatchObject({ early: true, latest: false })
    // an answered request draws no closing note, so nothing is composed under it
    expect(stopRow(later)).toBeUndefined()
  })

  it('Continue sends its words as the next request, asked as the stopped one was, carrying it; never for an older one', async () => {
    const op = await endedWith('build me a tic-tac-toe game', { phase: 'done', outcome: 'cancelled', spent_usd: 0, turn_spent_usd: 0 })
    await vi.waitFor(() => expect(askMemory.getView().talks).toHaveLength(1))
    const asked = sent.length
    const epoch = currentEpoch()
    await useAskStore.getState().continueStopped(op, epoch, askRetryContext(op, epoch), 'Continue')
    expect(sent).toHaveLength(asked + 1)
    const body = sent[sent.length - 1]
    expect(body.text).toBe('Continue')
    expect(body.continues).toBe('t1')
    expect(sent[asked - 1]).not.toHaveProperty('continues')
    expect(body.context).toEqual(sent[asked - 1].context)
    expect(body.conversation?.map((e) => e.said)).toEqual(['build me a tic-tac-toe game'])
    // the continued request is still open, so a second press sends nothing; a stale context sends nothing either
    await useAskStore.getState().continueStopped(op, epoch, askRetryContext(op, epoch), 'Continue')
    await useAskStore.getState().continueStopped(op, epoch, '{"route":"elsewhere"}', 'Continue')
    expect(sent).toHaveLength(asked + 1)
    const continued = useAskStore.getState().open!
    deliver(frame(continued, 't2', 1, { phase: 'accepted', thread, speaks_as: TAIGA }))
    deliver(frame(continued, 't2', 2, { phase: 'done', outcome: 'cancelled', spent_usd: 0, turn_spent_usd: 0 }))
    await useAskStore.getState().continueStopped(continued, epoch, askRetryContext(continued, epoch), 'Continue again')
    expect(sent[sent.length - 1].continues).toBe('t2')
  })
})

describe('what is kept of a stopped request lasts its turn\'s day (Jon on #394: "time limit on what\'s kept")', () => {
  it('the day is the hive\'s own: ask_intents TURN_MAX_AGE, after which the hive acts on none of the turn\'s hand-overs', () => {
    const hours = Number(/^TURN_MAX_AGE = datetime\.timedelta\(hours=(\d+)\)$/m.exec(intentsSource)?.[1])
    expect(hours * 3_600_000).toBe(STOPPED_KEEP_MS)
  })

  it('kept and offered until its turn is a day old, then neither carried nor continued, and gone from this browser', async () => {
    const op = await endedWith('build me a tic-tac-toe game', { phase: 'done', outcome: 'cancelled', spent_usd: 0, turn_spent_usd: 0 })
    const t = useAskStore.getState().turns[op]
    const until = Date.parse(t.events.find((e) => e.phase === 'accepted')!.at) + STOPPED_KEEP_MS
    expect(stoppedUntil(t)).toBe(until)
    expect(stopRow(op)?.ending).toEqual({ early: true, latest: true, until })
    await vi.waitFor(() => expect(askMemory.getView().talks).toHaveLength(1))
    expect(askMemory.getView().talks[0].until).toBe(until)
    // a day on: the next request carries nothing of it, and Continue sends nothing
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(until)
    expect(askMemory.conversation()).toEqual([])
    const asked = sent.length
    const epoch = currentEpoch()
    await useAskStore.getState().continueStopped(op, epoch, askRetryContext(op, epoch), 'Continue')
    expect(sent).toHaveLength(asked)
    // the next read of this browser's memory lets it go, and nobody forgot it, so no forget is counted
    await useAskStore.getState().send('something else', ctx, { where: 'on the hive' })
    await askMemory.flushed()
    const again = await (dbs.values().next().value as MemoryBackend).load()
    expect(again.talks).toEqual([])
    expect(again.tombs).toEqual([])
  })
})
