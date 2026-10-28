import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

/**
 * Spend-stop r1: the Ask's spending stop ("Stopped here: this request reached its spending limit") is never a dead end.
 * It offers New thread and the raise for new threads (an open thread's limit is fixed when it starts; the host has no
 * route to raise it), and the page never sends a limit above $5 (the owner, 2026-10-05). Invented data only.
 */
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
const { NoteRow } = await import('./Thread')
const { DONE_OFFERS, RAISE_FOR_NEW, raiseSteps, REFUSAL_WORDS, THREAD_LIMIT_MAX_USD } = await import('./words')
type AskEvent = import('../../api/ask').AskEvent
type HiveClient = import('../../api/client').HiveClient

const thread = { id: 'ses_ask1', mind: { id: 'a_vega01', name: 'Vega' }, budget_usd: 0.25, spent_usd: 0.23 }
let n = 0
let seq = 0
const setAskSettings = vi.fn(async (b: { thread_budget_usd?: number }) => ({ swarm_id: 's_x', thread_budget_usd: b.thread_budget_usd ?? 0.25, max_thread_budget_usd: 5 }))
function bindWith(over: Partial<HiveClient> = {}) {
  const client = {
    mode: 'sim',
    ask: vi.fn(async (b: { operation_id: string }) => ({ operation_id: b.operation_id, turn_id: 't1', thread, state: 'accepted' as const })),
    askTurn: vi.fn(async (op: string) => ({ operation_id: op, turn_id: 't1', events: [], more: false })),
    setAskSettings,
    ...over,
  } as unknown as HiveClient
  useHive.setState({ client, session: `session-${++n}`, inits: n })
  useAskStore.getState().bind(useHive.getState().session, 'user:p_ada')
}
async function stoppedTurn(outcome: string, extra: Record<string, unknown> = {}) {
  bindWith()
  await useAskStore.getState().send('plan the week', { route: 'hive', experience: 'classic' }, { where: 'on the hive' })
  const op = useAskStore.getState().open!
  seq = 0
  const deliver = (f: Record<string, unknown>) => useAskStore.getState().onEvent({ type: 'ask', operation_id: op, turn_id: 't1', seq: ++seq, at: '2026-10-09T10:00:00Z', ...f } as unknown as AskEvent)
  deliver({ phase: 'accepted', thread })
  deliver({ phase: 'done', spent_usd: 0.23, outcome, ...extra })
  return threadRows(useAskStore.getState()).filter((r) => r.op === op && r.kind === 'note')
}

beforeEach(() => {
  setAskSettings.mockClear()
  useAskStore.getState().reset()
})

describe('the spending stop offers a way on', () => {
  // j0-fixes r1: the offer follows the host's done.limit.kind (ask-limits r1); the thread's own cap is the one the raise helps
  const THREAD = { limit: { kind: 'thread', current_usd: 0.25, limit_usd: 0.25, estimate_usd: 0.01 } }
  it('spend_cap at the thread’s own cap carries New thread and the raise for new threads; other stops carry no offer', async () => {
    const [stop] = await stoppedTurn('spend_cap', THREAD)
    expect(stop.text).toMatch(/spending limit/)
    expect(stop.offer?.map((o) => o.kind)).toEqual(['new-thread', 'raise-budget'])
    expect(stop.offer?.map((o) => o.label)).toEqual(['New thread', 'Raise the limit for new threads (up to $5)'])
    for (const outcome of ['act_cap', 'call_cap', 'time_cap', 'cancelled', 'error']) {
      useAskStore.getState().reset()
      const [row] = await stoppedTurn(outcome)
      expect(row.offer, outcome).toBeUndefined()
    }
  })
  it('j0-fixes r1: a host that does not name the limit gets the plain fallback, no remedy offered', async () => {
    const [stop] = await stoppedTurn('spend_cap')
    expect(stop.text).toMatch(/did not say which one/)
    expect(stop.offer).toBeUndefined()
    useAskStore.getState().reset()
    const [mind] = await stoppedTurn('spend_cap', { limit: { kind: 'mind_total', current_usd: 3.89, limit_usd: 3.92, estimate_usd: 0.25 } })
    expect(mind.text).toMatch(/this mind has reached its own spending limit \(\$3\.89 of \$3\.92\)/)
    expect(mind.offer?.map((o) => o.label)).toEqual(['Usage & limits'])
  })
  it('j0-fixes r1: an unpriced model or a missing key is said as itself, not as a limit', async () => {
    const [unpriced] = await stoppedTurn('error', { error: 'unpriced_model' })
    expect(unpriced.text).toMatch(/has no price set/)
    useAskStore.getState().reset()
    const [key] = await stoppedTurn('error', { error: 'key_unavailable' })
    expect(key.text).toMatch(/key assigned to pay for this mind is gone/)
    useAskStore.getState().reset()
    const [plain] = await stoppedTurn('error')
    expect(plain.text).toMatch(/went wrong/)
  })
  it('the stop renders both buttons as real buttons, with the honest label', async () => {
    const [stop] = await stoppedTurn('spend_cap', THREAD)
    const html = renderToStaticMarkup(createElement(NoteRow, { r: stop }))
    expect(html).toContain('role="note"')
    const buttons = [...html.matchAll(/<button type="button"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1])
    expect(buttons).toEqual(['New thread', 'Raise the limit for new threads (up to $5)'])
    // a note without offers stays a plain line
    expect(renderToStaticMarkup(createElement(NoteRow, { r: { id: 'x', kind: 'note', text: 'Stopped.' } }))).not.toContain('<button')
  })
  it('the spend_limit refusal says the same honest words', () => {
    expect(REFUSAL_WORDS.spend_limit.offer?.map((o) => o.label)).toEqual(['New thread', RAISE_FOR_NEW, 'See usage'])
    expect(DONE_OFFERS.spend_cap?.[1].label).toBe(RAISE_FOR_NEW)
  })
})

describe('the raise never goes above $5', () => {
  it('offers $1, $2, $5 at most, and fewer when the host allows less', () => {
    expect(THREAD_LIMIT_MAX_USD).toBe(5)
    expect(raiseSteps(5)).toEqual([1, 2, 5])
    expect(raiseSteps(undefined)).toEqual([1, 2, 5])
    expect(raiseSteps(50)).toEqual([1, 2, 5])
    expect(raiseSteps(2)).toEqual([1, 2])
  })
  it('sends a step to PUT /api/me/ask; refuses anything above $5 or the host maximum without sending', async () => {
    bindWith()
    expect(await useAskStore.getState().setThreadLimit(2)).toBe(true)
    expect(setAskSettings).toHaveBeenCalledWith({ thread_budget_usd: 2 })
    setAskSettings.mockClear()
    for (const v of [5.01, 6, 100, Number.POSITIVE_INFINITY, Number.NaN, 0, -1]) expect(await useAskStore.getState().setThreadLimit(v), String(v)).toBe(false)
    useAskStore.setState({ settings: { swarm_id: 's_x', thread_budget_usd: 0.25, max_thread_budget_usd: 2 } })
    expect(await useAskStore.getState().setThreadLimit(5)).toBe(false)
    expect(setAskSettings).not.toHaveBeenCalled()
  })
  it('a refused save says false (the page says so plainly) and New thread still starts a thread', async () => {
    bindWith({ setAskSettings: vi.fn(async () => Promise.reject(new Error('refused'))) } as Partial<HiveClient>)
    expect(await useAskStore.getState().setThreadLimit(1)).toBe(false)
    await useAskStore.getState().newThread()
    expect(useAskStore.getState().thread).toBeNull()
  })
})
