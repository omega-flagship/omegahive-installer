// Purpose: prove a refused row offers Try again only while its request is the latest one, the only request retryLast
// sends again, so an older row never shows a button that does nothing when pressed. Invented data only.
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
const { ThreadLog } = await import('./Thread')
type AskBody = import('../../api/ask').AskBody
type AskEvent = import('../../api/ask').AskEvent
type HiveClient = import('../../api/client').HiveClient

const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0, spent_usd: 0 }
const CONTEXT = { route: '#/swarm/s_lyra', experience: 'classic', swarm_id: 's_lyra' }
let n = 0
let sent: AskBody[] = []

beforeEach(() => {
  useAskStore.getState().reset()
  sent = []
  const client = {
    mode: 'sim',
    ask: vi.fn(async (b: AskBody) => (sent.push(b), { operation_id: b.operation_id, turn_id: `t_${sent.length}`, thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't1', events: [], more: false })),
  } as unknown as HiveClient
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
})

/** One request sent through the real send, then refused by the host because its coordinator is busy. */
async function refused(words: string) {
  await useAskStore.getState().send(words, CONTEXT)
  const op = useAskStore.getState().open!
  let seq = 0
  for (const f of [{ phase: 'accepted', thread }, { phase: 'refused', reason: 'coordinator_busy' }])
    useAskStore.getState().onEvent({ type: 'ask', operation_id: op, turn_id: `t_${sent.length}`, seq: ++seq, at: '2026-11-19T10:00:00Z', ...f } as unknown as AskEvent)
  return op
}

/** The Try again buttons the thread draws, one entry per refused row that has one. */
function tryAgainButtons(): number {
  const html = renderToStaticMarkup(createElement(ThreadLog, { rows: threadRows(useAskStore.getState()), variant: 'glass' }))
  return [...html.matchAll(/<button type="button"[^>]*>Try again<\/button>/g)].length
}

describe('Try again is offered on the latest request only', () => {
  it('the latest refused row offers it, and loses it once a newer request is sent', async () => {
    await refused('build a tic-tac-toe app')
    expect(tryAgainButtons()).toBe(1)
    await refused('and a scoreboard')
    // two refused rows, one button: the newer request's
    expect(threadRows(useAskStore.getState()).filter((r) => r.kind === 'refused')).toHaveLength(2)
    expect(tryAgainButtons()).toBe(1)
    expect(sent).toHaveLength(2)
  })
})
