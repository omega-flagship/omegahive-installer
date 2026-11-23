// Purpose: prove the Ask's spending stops through the store and the thread's rows: an expensive stop offers Go ahead,
// which sends the stopped turn's own words and context again with go_ahead; no stop offers a new thread or a raise; a
// thread shows its spend only. Invented data only.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.stubGlobal('window', { location: { hash: '#/', search: '', pathname: '/' }, matchMedia: () => ({ matches: false }), innerWidth: 1200, innerHeight: 800, addEventListener() {}, removeEventListener() {}, localStorage: { getItem: () => null, setItem() {}, removeItem() {} } })
// A server render reads a zustand store through its server snapshot (the initial state); read the live one instead.
vi.mock('zustand', async (orig) => {
  const z = await orig<typeof import('zustand')>()
  const build = (init: never) => {
    const api = z.createStore(init)
    ;(api as { getInitialState: unknown }).getInitialState = api.getState
    return Object.assign((sel?: never) => z.useStore(api, sel as never), api)
  }
  return { ...z, create: ((init?: never) => (init ? build(init) : build)) as never }
})

const { useHive } = await import('../../store/store')
const { threadRows, useAskStore } = await import('../../store/ask')
const { NoteRow, ThreadHead } = await import('./Thread')
const { GO_AHEAD, REFUSAL_WORDS, USAGE_AND_LIMITS, spendStop } = await import('./words')

it.each([
  ['hive_spend_paused', 'The hive owner'],
  ['mind_spend_paused', 'This mind’s owner'],
])('says who paused new paid calls for %s', (kind, owner) => {
  const result = spendStop({ kind, current_usd: null, estimate_usd: null, limit_usd: null })
  expect(result.text).toBe(`${owner} paused new paid calls. They can resume them in Usage.`)
  expect(result.offer).toEqual([USAGE_AND_LIMITS])
})
type AskBody = import('../../api/ask').AskBody
type AskEvent = import('../../api/ask').AskEvent
type HiveClient = import('../../api/client').HiveClient

const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0, spent_usd: 0.23 }
const EXPENSIVE = { kind: 'expensive', current_usd: 1.2, limit_usd: 1, estimate_usd: null }
let n = 0
let sent: AskBody[] = []
function bindWith(over: Partial<HiveClient> = {}) {
  sent = []
  const client = {
    mode: 'sim',
    ask: vi.fn(async (b: AskBody) => (sent.push(b), { operation_id: b.operation_id, turn_id: `t_${sent.length}`, thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't1', events: [], more: false })),
    ...over,
  } as unknown as HiveClient
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
}
const CONTEXT = { route: '#/swarm/s_lyra', experience: 'classic', swarm_id: 's_lyra' }
/** One turn asked through the real send, then closed by the host with `done`; asked: the conductor's "Go ahead?" came
 *  first and nobody answered it (a browser mind's turn stops unasked). */
async function stoppedTurn(outcome: string, extra: Record<string, unknown> = {}, asked = false) {
  await useAskStore.getState().send('build a tic-tac-toe app', CONTEXT, { where: 'on Lyra' })
  const op = useAskStore.getState().open!
  let seq = 0
  const deliver = (f: Record<string, unknown>) => useAskStore.getState().onEvent({ type: 'ask', operation_id: op, turn_id: 't1', seq: ++seq, at: '2026-11-19T10:00:00Z', ...f } as unknown as AskEvent)
  deliver({ phase: 'accepted', thread })
  if (asked) deliver({ phase: 'go_ahead', spent_usd: 1.2, limit_usd: 1 })
  deliver({ phase: 'done', spent_usd: 1.43, turn_spent_usd: 1.2, outcome, ...extra })
  return { op, notes: threadRows(useAskStore.getState()).filter((r) => r.op === op && r.kind === 'note') }
}

beforeEach(() => {
  useAskStore.getState().reset()
  bindWith()
})

describe('an expensive stop offers Go ahead', () => {
  it('says what it had spent and offers Go ahead, drawn as a real button', async () => {
    const { notes: [stop] } = await stoppedTurn('spend_cap', { limit: EXPENSIVE }, true)
    expect(stop.text).toBe('Stopped here: this one looks expensive (about $1.20 so far), and no go-ahead came in time.')
    expect(stop.offer).toEqual([GO_AHEAD])
    const html = renderToStaticMarkup(createElement(NoteRow, { r: stop }))
    expect([...html.matchAll(/<button type="button"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])).toEqual(['Go ahead'])
  })
  it('a browser mind’s turn, stopped at the threshold without a question, names no question', async () => {
    const { notes: [stop] } = await stoppedTurn('spend_cap', { limit: EXPENSIVE })
    expect(stop.text).toBe('Stopped here: this one looks expensive (about $1.20 so far).')
    expect(stop.offer).toEqual([GO_AHEAD])
  })
  it('Go ahead sends the stopped turn’s own words and context again, with go_ahead, as a new request', async () => {
    const { op } = await stoppedTurn('spend_cap', { limit: EXPENSIVE }, true)
    expect(sent).toHaveLength(1)
    expect(sent[0].go_ahead).toBeUndefined()
    expect(await useAskStore.getState().goAheadAgain(op)).toBe('sent')
    expect(sent).toHaveLength(2)
    expect(sent[1]).toMatchObject({ text: 'build a tic-tac-toe app', context: sent[0].context, via: 'typed', go_ahead: true })
    expect(sent[1].operation_id).not.toBe(sent[0].operation_id)
    expect(useAskStore.getState().open).toBe(sent[1].operation_id)
    // the go-ahead was for those words only: the next request asks again when it looks expensive
    const again = sent[1].operation_id
    for (const [seq, f] of [{ phase: 'accepted', thread }, { phase: 'done', outcome: 'complete', turn_spent_usd: 1.9 }].entries())
      useAskStore.getState().onEvent({ type: 'ask', operation_id: again, turn_id: 't2', seq: seq + 1, at: '2026-11-19T10:01:00Z', ...f })
    expect(useAskStore.getState().open).toBeNull()
    await useAskStore.getState().send('and a scoreboard', CONTEXT)
    expect(sent[2].go_ahead).toBeUndefined()
  })
  it('while another request is running, Go ahead sends nothing (never a steer of that request)', async () => {
    const { op } = await stoppedTurn('spend_cap', { limit: EXPENSIVE }, true)
    await useAskStore.getState().send('something else', CONTEXT)
    expect(sent).toHaveLength(2)
    expect(await useAskStore.getState().goAheadAgain(op)).toBe('busy')
    expect(sent).toHaveLength(2)
  })
  it('a turn that did not stop as expensive, or whose words this page did not keep, cannot go ahead', async () => {
    const { op } = await stoppedTurn('spend_cap', { limit: { kind: 'mind_total', current_usd: 3.89, limit_usd: 3.92 } })
    expect(await useAskStore.getState().goAheadAgain(op)).toBe('gone')
    expect(await useAskStore.getState().goAheadAgain('ask:nothing')).toBe('gone')
    // a turn read back by its id (rejoined after a reload): its stop is said, with no Go ahead to press
    bindWith({ askTurn: vi.fn(async (o: string) => ({ operation_id: o, turn_id: 't9', state: 'done', thread, events: [
      { type: 'ask', operation_id: o, turn_id: 't9', seq: 1, at: '2026-11-19T10:00:00Z', phase: 'accepted', thread },
      { type: 'ask', operation_id: o, turn_id: 't9', seq: 2, at: '2026-11-19T10:05:00Z', phase: 'done', outcome: 'spend_cap', limit: EXPENSIVE },
    ], more: false })) } as Partial<HiveClient>)
    await useAskStore.getState().rejoin('ask:earlier01')
    const [stop] = threadRows(useAskStore.getState()).filter((r) => r.op === 'ask:earlier01' && r.kind === 'note')
    expect(stop.text).toMatch(/looks expensive \(about \$1\.20 so far\)/)
    expect(stop.offer).toBeUndefined()
    expect(await useAskStore.getState().goAheadAgain('ask:earlier01')).toBe('gone')
    expect(sent).toHaveLength(0)
  })
})

describe('no stop offers a new thread or a raise', () => {
  it('a limit stop names its limit with Usage & limits; other stops carry no offer', async () => {
    const { notes: [mind] } = await stoppedTurn('spend_cap', { limit: { kind: 'member_allowance', current_usd: 4.98, limit_usd: 5 } })
    expect(mind.text).toBe('Stopped here: you have reached your spending allowance ($4.98 of $5.00). An admin can raise it.')
    expect(mind.offer).toEqual([USAGE_AND_LIMITS])
    for (const outcome of ['act_cap', 'call_cap', 'time_cap', 'cancelled', 'error']) {
      useAskStore.getState().reset()
      bindWith()
      const { notes: [row] } = await stoppedTurn(outcome)
      expect(row.offer, outcome).toBeUndefined()
    }
  })
  it('the spend_limit refusal offers Usage & limits only', () => {
    expect(REFUSAL_WORDS.spend_limit.offer).toEqual([USAGE_AND_LIMITS])
  })
})

describe('a thread shows its spend only', () => {
  it('the thread head says what the thread has spent, with no limit beside it', async () => {
    await stoppedTurn('complete')
    const html = renderToStaticMarkup(createElement(ThreadHead, { variant: 'glass' }))
    expect(html).toMatch(/<span class="ask-spend" title="Spent in this thread">\$1\.43<span class="sr-only"> spent in this thread<\/span><\/span>/)
    expect(html).not.toContain(' / $')
  })
})
