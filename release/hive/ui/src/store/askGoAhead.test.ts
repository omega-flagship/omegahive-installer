// Purpose: prove the Ask's go-ahead question through the store: it stands while it is the open turn's latest frame of
// work, the person's answer goes once (POST /api/ask/{op}/go-ahead), each failure is said, and the frame is read
// strictly. Invented data only.
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }) }))

const { checkAskEvent } = await import('../api/ask')
const { ApiError } = await import('../api/client')
const { useHive } = await import('./store')
const { threadRows, useAskStore } = await import('./ask')
type AskEvent = import('../api/ask').AskEvent
type HiveClient = import('../api/client').HiveClient

const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0, spent_usd: 0 }
let frames: Record<string, AskEvent[]> = {}
let answers: [string, boolean][] = []
function fakeClient(over: Partial<HiveClient> = {}): HiveClient {
  return {
    mode: 'sim',
    ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string, after = 0) => ({ operation_id: op, turn_id: 't1', events: (frames[op] ?? []).filter((e) => e.seq > after), more: false })),
    askGoAhead: vi.fn(async (op: string, go: boolean) => (answers.push([op, go]), { ok: true as const, go })),
    ...over,
  } as unknown as HiveClient
}
let n = 0
async function start(client: HiveClient) {
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
  await useAskStore.getState().send('build a tic-tac-toe app', { route: '#/', experience: 'classic' })
  return useAskStore.getState().open!
}
function frame(op: string, seq: number, f: Record<string, unknown>) {
  const e = { type: 'ask', operation_id: op, turn_id: 't1', seq, at: '2026-11-19T10:00:00Z', ...f } as unknown as AskEvent
  ;(frames[op] ??= []).push(e)
  useAskStore.getState().onEvent(e)
}
/** A turn that reached the person's threshold: accepted, one step, then the question. */
async function waiting(over: Partial<HiveClient> = {}) {
  const op = await start(fakeClient(over))
  frame(op, 1, { phase: 'accepted', thread })
  frame(op, 2, { phase: 'thinking', step: 'building it' })
  frame(op, 3, { phase: 'go_ahead', spent_usd: 1.2, limit_usd: 1 })
  return op
}
const question = (op: string) => threadRows(useAskStore.getState()).filter((r) => r.op === op && r.kind === 'go-ahead')

beforeEach(() => {
  frames = {}
  answers = []
  useAskStore.getState().reset()
})

describe('the go_ahead frame', () => {
  it('is read strictly: its figures when they are money, null otherwise, and the frame is never dropped', () => {
    const base = { type: 'ask', operation_id: 'ask:x1', turn_id: 't1', seq: 3, at: '' }
    expect(checkAskEvent({ ...base, phase: 'go_ahead', spent_usd: 1.2, limit_usd: 1 })).toMatchObject({ phase: 'go_ahead', spent_usd: 1.2, limit_usd: 1 })
    for (const odd of [undefined, null, -1, Number.NaN, Number.POSITIVE_INFINITY, '1.20', {}])
      expect(checkAskEvent({ ...base, phase: 'go_ahead', spent_usd: odd, limit_usd: odd }), String(odd)).toMatchObject({ phase: 'go_ahead', spent_usd: null, limit_usd: null })
  })
})

describe('the question stands while the turn waits', () => {
  it('shows under the turn with its spend and threshold, and opens the thread so it is seen', async () => {
    const op = await start(fakeClient())
    useAskStore.getState().setThreadOpen(false)
    frame(op, 1, { phase: 'accepted', thread })
    frame(op, 2, { phase: 'go_ahead', spent_usd: 1.2, limit_usd: 1 })
    expect(question(op)).toEqual([{ id: `${op}#2`, op, seq: 2, kind: 'go-ahead', text: '', goAhead: { spentUsd: 1.2, limitUsd: 1 } }])
    expect(useAskStore.getState().threadOpen).toBe(true)
  })
  it('a steer or a memory note keeps it standing; a later thinking, act, answer or done frame moves it on', async () => {
    for (const later of [{ phase: 'thinking', step: 'carrying on' }, { phase: 'act', act: { act_id: 'a1', kind: 'scroll', to: 'top' } }, { phase: 'answer', text: 'Built.' }, { phase: 'done', outcome: 'complete' }]) {
      useAskStore.getState().reset()
      const op = await waiting()
      frame(op, 4, { phase: 'steer', steer_id: 'st_aaaa1', text: 'make it blue' })
      expect(question(op), later.phase).toHaveLength(1)
      frame(op, 5, later)
      expect(question(op), later.phase).toEqual([])
    }
  })
  it('a closed turn never asks, and a turn stopped by the person shows the stop instead', async () => {
    const op = await waiting()
    frame(op, 4, { phase: 'refused', reason: 'stopped' })
    expect(question(op)).toEqual([])
    expect(threadRows(useAskStore.getState()).filter((r) => r.op === op).map((r) => r.kind)).toEqual(['you', 'step', 'refused'])
  })
})

describe('the person answers once', () => {
  it('Go ahead sends go true once; a second press sends nothing; it says it is going ahead until the turn moves on', async () => {
    const op = await waiting()
    await Promise.all([useAskStore.getState().answerGoAhead(op, true), useAskStore.getState().answerGoAhead(op, true)])
    expect(answers).toEqual([[op, true]])
    expect(question(op)[0].goAhead?.state).toBe('went')
    await useAskStore.getState().answerGoAhead(op, false)
    expect(answers).toEqual([[op, true]])
    frame(op, 4, { phase: 'thinking', step: 'carrying on' })
    expect(question(op)).toEqual([])
  })
  it('Stop sends go false; the turn then ends as a Stop ends it', async () => {
    const op = await waiting()
    await useAskStore.getState().answerGoAhead(op, false)
    expect(answers).toEqual([[op, false]])
    expect(question(op)[0].goAhead?.state).toBe('stopping')
    frame(op, 4, { phase: 'refused', reason: 'stopped' })
    expect(question(op)).toEqual([])
    expect(useAskStore.getState().open).toBeNull()
  })
  it('while the answer is in flight the question waits; a failure says why and lets the person answer again', async () => {
    let fail = true
    let release: () => void = () => {}
    const op = await waiting({ askGoAhead: vi.fn(async (o: string, go: boolean) => {
      answers.push([o, go])
      await new Promise<void>((r) => (release = r))
      if (fail) throw new ApiError(0, 'network', 'offline')
      return { ok: true as const, go }
    }) } as Partial<HiveClient>)
    const pending = useAskStore.getState().answerGoAhead(op, true)
    expect(question(op)[0].goAhead?.state).toBe('sending')
    release()
    await pending
    expect(question(op)[0].goAhead).toEqual({ spentUsd: 1.2, limitUsd: 1, state: 'failed', error: 'Could not reach the hive. Check the connection and try again.' })
    fail = false
    const again = useAskStore.getState().answerGoAhead(op, true)
    release()
    await again
    expect(answers).toEqual([[op, true], [op, true]])
    expect(question(op)[0].goAhead?.state).toBe('went')
  })
  it('not waiting any more (answered elsewhere, closed, timed out) says so and reads the turn back; 404 too', async () => {
    const op = await waiting({ askGoAhead: vi.fn(async () => { throw new ApiError(409, 'not_waiting', 'not waiting') }) } as Partial<HiveClient>)
    const reads = (useHive.getState().client!.askTurn as ReturnType<typeof vi.fn>).mock.calls.length
    await useAskStore.getState().answerGoAhead(op, true)
    expect(question(op)[0].goAhead?.state).toBe('gone')
    await vi.waitFor(() => expect((useHive.getState().client!.askTurn as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(reads))
    useAskStore.getState().reset()
    const lost = await waiting({ askGoAhead: vi.fn(async () => { throw new ApiError(404, 'not_available', 'gone') }) } as Partial<HiveClient>)
    await useAskStore.getState().answerGoAhead(lost, false)
    expect(question(lost)[0].goAhead?.state).toBe('gone')
  })
  it('nothing is sent for a turn that is not waiting, nor by a client without the route', async () => {
    const op = await start(fakeClient())
    frame(op, 1, { phase: 'accepted', thread })
    await useAskStore.getState().answerGoAhead(op, true)
    await useAskStore.getState().answerGoAhead('ask:none', true)
    expect(answers).toEqual([])
    useAskStore.getState().reset()
    const bare = await waiting({ askGoAhead: undefined } as Partial<HiveClient>)
    await useAskStore.getState().answerGoAhead(bare, true)
    expect(question(bare)[0].goAhead?.state).toBeUndefined()
  })
  it('an answer that returns after the person changed is never written', async () => {
    let release: () => void = () => {}
    const op = await waiting({ askGoAhead: vi.fn(async (_o: string, go: boolean) => { await new Promise<void>((r) => (release = r)); return { ok: true as const, go } }) } as Partial<HiveClient>)
    const pending = useAskStore.getState().answerGoAhead(op, true)
    useAskStore.getState().bind(useHive.getState().session, 'user:p_bea')
    release()
    await pending
    expect(useAskStore.getState().turns[op]).toBeUndefined()
  })
})
