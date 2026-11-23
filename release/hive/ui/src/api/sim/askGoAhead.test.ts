// Purpose: prove the simulated Ask host keeps the Ask's money as the host does (hive/API.md "Ask money"): no thread or
// turn cap, the person's threshold and switch on GET/PUT /api/me/ask, the go_ahead body key, one question when a turn
// looks expensive, POST /api/ask/{op}/go-ahead, and the 5-minute stop. SIM ONLY, invented data.
import { describe, expect, it } from 'vitest'
import { GO_AHEAD_WAIT_MS, SimAsk } from './ask'
import type { AskBody, AskEvent } from '../ask'
import type { Agent, Goal, Swarm } from '../types'

const agents = [{ id: 'a_vega01', name: 'Vega', status: 'awake', swarm_id: 's_lyra' }] as unknown as Agent[]
const swarms = [{ id: 's_lyra', name: 'Lyra', coordinator_id: 'a_vega01' }] as unknown as Swarm[]

/** The invented host with a clock the test moves: each scheduled call runs once its time has come. */
function host() {
  const events: AskEvent[] = []
  /** when each event was emitted, on the test's clock */
  const at: number[] = []
  let now = 0
  let queue: [number, () => void][] = []
  const h = new SimAsk({ emit: (e) => void (events.push(e), at.push(now)), later: (ms, fn) => void queue.push([now + ms, fn]), agents: () => agents, swarms: () => swarms, goals: () => [] as Goal[], principal: () => 'user:p_ada' })
  /** Run everything due by `ms` from now, in time order (calls scheduled meanwhile included). */
  const advance = (ms: number) => {
    const until = now + ms
    for (;;) {
      queue.sort((a, b) => a[0] - b[0])
      const next = queue[0]
      if (!next || next[0] > until) break
      queue = queue.slice(1)
      now = next[0]
      next[1]()
    }
    now = until
  }
  const phases = (op: string) => events.filter((e) => e.operation_id === op).map((e) => e.phase)
  return { h, events, at, advance, phases }
}
let count = 0
const body = (text: string, over: Partial<AskBody> = {}): AskBody => ({ operation_id: `ask:sim:${(++count).toString().padStart(4, '0')}`, text, via: 'typed', context: { route: 'hive', experience: 'classic' }, ...over })
const ANSWER = 30_000

describe('the simulated host keeps no Ask cap of its own', () => {
  it('a new thread holds no cap (budget 0), and a thread that spent never refuses the next request', () => {
    const { h, advance } = host()
    const first = h.ask(body('tell me about the swarm'))
    expect(first.thread.budget_usd).toBe(0)
    advance(ANSWER)
    expect(h.ask(body('and again')).thread).toMatchObject({ id: first.thread.id, budget_usd: 0 })
  })
  it('GET /api/me/ask says the switch and the threshold: $1 until five paid answers, then ten times their median', () => {
    const { h, advance } = host()
    expect(h.getSettings()).toMatchObject({ ask_when_expensive: true, expensive_usd: 1 })
    expect(h.getSettings()).not.toHaveProperty('thread_budget_usd')
    for (let i = 0; i < 4; i++) { h.ask(body('hello there')); advance(ANSWER) }
    expect(h.getSettings().expensive_usd).toBe(1)
    h.ask(body('hello there'))
    advance(ANSWER)
    // five answers of the same words cost the same: 0.008 + (11 % 7) * 0.002 = $0.016, so ten times that
    expect(h.threshold('user:p_ada')).toBe(0.16)
    expect(h.getSettings().expensive_usd).toBe(0.16)
  })
  it('PUT /api/me/ask takes the switch; thread_budget_usd and anything else is 400 invalid', () => {
    const { h } = host()
    expect(h.setSettings({ ask_when_expensive: false })).toMatchObject({ ask_when_expensive: false, swarm_id: 's_lyra' })
    for (const bad of [{ thread_budget_usd: 2 }, { ask_when_expensive: 'no' }, { colour: 'red' }])
      expect(() => h.setSettings(bad as never), JSON.stringify(bad)).toThrow(expect.objectContaining({ status: 400, code: 'invalid' }))
    expect(h.getSettings().ask_when_expensive).toBe(false)
  })
  it('go_ahead on a request is true or absent; anything else is 400 invalid', () => {
    const { h } = host()
    for (const bad of [false, 'yes', 1]) expect(() => h.ask(body('hi', { go_ahead: bad as never })), String(bad)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(h.ask(body('hi', { go_ahead: true })).state).toBe('accepted')
  })
})

describe('an answer that looks expensive asks once', () => {
  it('the turn waits on the question with its spend and threshold; Go ahead carries it on and it asks nothing more', () => {
    const { h, advance, phases, events } = host()
    const b = body('make an expensive one')
    h.ask(b)
    advance(ANSWER)
    expect(phases(b.operation_id).at(-1)).toBe('go_ahead')
    expect(events.at(-1)).toMatchObject({ phase: 'go_ahead', spent_usd: 1.05, limit_usd: 1 })
    expect(h.turn(b.operation_id).state).toBe('thinking')
    expect(h.goAhead(b.operation_id, { go: true })).toEqual({ ok: true, go: true })
    expect(() => h.goAhead(b.operation_id, { go: true })).toThrow(expect.objectContaining({ status: 409, code: 'not_waiting' }))
    advance(GO_AHEAD_WAIT_MS + ANSWER)
    expect(phases(b.operation_id).slice(-4)).toEqual(['go_ahead', 'thinking', 'answer', 'done'])
    expect(events.at(-1)).toMatchObject({ phase: 'done', outcome: 'complete', turn_spent_usd: 1.6 })
  })
  it('Stop stops it exactly as POST /api/ask/{op}/stop does', () => {
    const { h, advance, phases, events } = host()
    const b = body('make an expensive one')
    h.ask(b)
    advance(ANSWER)
    expect(h.goAhead(b.operation_id, { go: false })).toEqual({ ok: true, go: false })
    advance(GO_AHEAD_WAIT_MS + ANSWER)
    expect(phases(b.operation_id).slice(-2)).toEqual(['go_ahead', 'refused'])
    expect(events.at(-1)).toMatchObject({ phase: 'refused', reason: 'stopped' })
    expect(() => h.goAhead(b.operation_id, { go: true })).toThrow(expect.objectContaining({ code: 'not_waiting' }))
  })
  it('no answer within five minutes of the question stops it as expensive, in the host’s words', () => {
    const { h, advance, events, at } = host()
    const b = body('make an expensive one')
    h.ask(b)
    advance(ANSWER)
    const asked = at[events.findIndex((e) => e.phase === 'go_ahead')]
    advance(asked + GO_AHEAD_WAIT_MS - 1 - ANSWER)
    expect(events.at(-1)?.phase).toBe('go_ahead')
    advance(1)
    expect(at.at(-1)! - asked).toBe(GO_AHEAD_WAIT_MS)
    const [answer, done] = events.slice(-2) as [Extract<AskEvent, { phase: 'answer' }>, Extract<AskEvent, { phase: 'done' }>]
    expect(answer.text).toMatch(/I stopped here: this one looks expensive \(about \$1\.05 so far\), so I'm waiting for your go-ahead\. Ask again to go ahead\.$/)
    expect(done).toMatchObject({ outcome: 'spend_cap', turn_spent_usd: 1.05, limit: { kind: 'expensive', current_usd: 1.05, limit_usd: 1, estimate_usd: null } })
    expect(() => h.goAhead(b.operation_id, { go: true })).toThrow(expect.objectContaining({ code: 'not_waiting' }))
  })
  it('asking again with go_ahead, or with the question turned off, never asks', () => {
    for (const [b, settle] of [[body('make an expensive one', { go_ahead: true }), () => undefined], [body('make an expensive one'), (h: SimAsk) => h.setSettings({ ask_when_expensive: false })]] as const) {
      const { h, advance, phases } = host()
      settle(h)
      h.ask(b)
      advance(ANSWER)
      expect(phases(b.operation_id)).not.toContain('go_ahead')
      expect(phases(b.operation_id).at(-1)).toBe('done')
    }
  })
  it('the go-ahead route: 404 for a turn the caller cannot see, 400 for any body but {go}, 409 for a turn never asked', () => {
    const { h, advance } = host()
    expect(() => h.goAhead('ask:sim:unknown', { go: true })).toThrow(expect.objectContaining({ status: 404, code: 'not_available' }))
    const b = body('hello there')
    h.ask(b)
    for (const bad of [{}, { go: 'yes' }, { go: true, extra: 1 }]) expect(() => h.goAhead(b.operation_id, bad as never), JSON.stringify(bad)).toThrow(expect.objectContaining({ status: 400, code: 'invalid' }))
    expect(() => h.goAhead(b.operation_id, { go: true })).toThrow(expect.objectContaining({ status: 409, code: 'not_waiting' }))
    advance(ANSWER)
    expect(() => h.goAhead(b.operation_id, { go: true })).toThrow(expect.objectContaining({ code: 'not_waiting' }))
  })
})
