// Purpose: verify the Ask store carries the person's conversation to whichever mind answers: an answered turn joins
// it with the mind whose voice answered, the next turn sends it, New thread starts it again, a private page adds nothing,
// and a reload shows it from this browser's memory.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const loc = { hash: '#/', search: '', pathname: '/' }
vi.stubGlobal('window', Object.assign(new EventTarget(), { location: loc, matchMedia: () => ({ matches: false }) }))

const { useHive } = await import('./store')
const { EARLIER_WORDS, threadRows, useAskStore } = await import('./ask')
const { askMemory } = await import('../lib/askMemory')
const { memoryBackend } = await import('../lib/askMemory/backend')
type AskBody = import('../api/ask').AskBody
type AskEvent = import('../api/ask').AskEvent
type HiveClient = import('../api/client').HiveClient
type MemoryBackend = import('../lib/askMemory/backend').MemoryBackend

/**
 * Jon, 16 Nov: one identity mind, "context and continuity are consistently persistent regardless of which model you
 * interact", "without needing additional LLM calls to pass through convo". Invented lives only: Ada (user:p_ada), her
 * own mind Taiga, and Worker, a mind of a swarm she uses.
 */
const TAIGA = { mind_id: 'a_taiga01', name: 'Taiga' }
const WORKER = { mind_id: 'a_worker01', name: 'Worker' }
const thread = { id: 'ses_ask1', mind: { id: 'a_coord01', name: 'Orchestra' }, budget_usd: 0.25, spent_usd: 0 }

// the page's memory on durable storage (IndexedDB's stand-in), one database per person and hive, kept across a reload
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
  useHive.setState({ client, session: `session-conv-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
  await askMemory.whenReady()
}
const frame = (op: string, turn: string, seq: number, f: Record<string, unknown>) =>
  ({ type: 'ask', operation_id: op, turn_id: turn, principal: 'user:p_ada', seq, at: '2026-11-16T05:00:00Z', ...f }) as unknown as AskEvent
const deliver = (e: AskEvent) => useAskStore.getState().onEvent(e)

/** One turn, answered in `voice`'s name: what was sent, once the answer is kept in this browser. */
async function answered(words: string, answer: string, voice: { mind_id: string; name: string }, context: Record<string, unknown> = { route: 'hive', experience: 'classic' }): Promise<AskBody> {
  const kept = askMemory.getView().talks.length
  await useAskStore.getState().send(words, context as never, { where: 'on the hive' })
  const op = useAskStore.getState().open!
  const turn = `t${sent.length}`
  deliver(frame(op, turn, 1, { phase: 'accepted', thread, speaks_as: voice }))
  deliver(frame(op, turn, 2, { phase: 'answer', text: answer }))
  deliver(frame(op, turn, 3, { phase: 'done', outcome: 'complete', spent_usd: 0, turn_spent_usd: 0 }))
  if (!('private' in context)) await vi.waitFor(() => expect(askMemory.getView().talks.length).toBe(kept + 1))
  return sent[sent.length - 1]
}

beforeEach(async () => {
  sent = []
  dbs.clear()
  loc.hash = '#/'
  await signIn()
})
afterEach(() => {
  useAskStore.getState().reset()
})

describe('the conversation goes with every turn, whichever mind answers', () => {
  it('a turn Worker answered is kept with Worker and the next turn carries it; the first carried nothing', async () => {
    const first = await answered('what do you build?', 'The garden planner.', WORKER)
    expect(first.conversation).toBeUndefined()
    expect(askMemory.getView().talks).toMatchObject([{ mind_id: WORKER.mind_id, mind_name: 'Worker', words: 'what do you build?' }])
    const second = await answered('my code word is HEMLOCK-SEVEN', 'Noted.', TAIGA)
    expect(second.conversation).toEqual([{ said: 'what do you build?', answer: 'The garden planner.', by: WORKER.mind_id, at: expect.any(Number) }])
    await useAskStore.getState().send('and what was my code word?', { route: 'hive', experience: 'classic' } as never, { where: 'on the hive' })
    expect(sent[sent.length - 1].conversation?.map((e) => [e.said, e.by])).toEqual([
      ['what do you build?', WORKER.mind_id],
      ['my code word is HEMLOCK-SEVEN', TAIGA.mind_id],
    ])
  })

  it('New thread starts a new conversation: the next turn carries nothing from before', async () => {
    await answered('my code word is HEMLOCK-SEVEN', 'Noted.', TAIGA)
    await useAskStore.getState().newThread()
    const next = await answered('hello again', 'Hi.', TAIGA)
    expect(next.conversation).toBeUndefined()
  })

  it('a private app\'s page keeps nothing and sends nothing', async () => {
    await answered('my code word is HEMLOCK-SEVEN', 'Noted.', TAIGA)
    const priv = await answered('how did I sleep?', 'Seven hours.', TAIGA, { private: true })
    expect(priv.conversation).toBeUndefined()
    await vi.waitFor(() => expect(useAskStore.getState().open).toBeNull())
    expect(askMemory.getView().talks.map((t) => t.words)).toEqual(['my code word is HEMLOCK-SEVEN'])
  })
})

describe('a reload keeps the conversation', () => {
  it('after a reload the thread shows the conversation so far from this browser, and the next turn carries it', async () => {
    await answered('what do you build?', 'The garden planner.', WORKER)
    // the page reloads: the Ask's rows are gone with it; the person's memory is still in this browser
    useAskStore.getState().reset()
    expect(threadRows(useAskStore.getState())).toEqual([])
    await signIn()
    await vi.waitFor(() => expect(threadRows(useAskStore.getState()).length).toBeGreaterThan(0))
    expect(threadRows(useAskStore.getState()).map((r) => [r.kind, r.text, r.who])).toEqual([
      ['note', EARLIER_WORDS, undefined],
      ['you', 'what do you build?', undefined],
      ['answer', 'The garden planner.', 'Worker'],
    ])
    const next = await answered('and the second one?', 'The seed tracker.', WORKER)
    expect(next.conversation?.map((e) => e.said)).toEqual(['what do you build?'])
  })

  it('a thread that already has rows is never overwritten by a restore', async () => {
    await answered('what do you build?', 'The garden planner.', WORKER)
    useAskStore.getState().reset()
    useHive.setState({ client, session: `session-conv-${++n}`, inits: n })
    useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
    useAskStore.getState().note('A note the page wrote first.')
    await askMemory.whenReady()
    await Promise.resolve()
    expect(threadRows(useAskStore.getState()).map((r) => r.text)).toEqual(['A note the page wrote first.'])
  })
})
