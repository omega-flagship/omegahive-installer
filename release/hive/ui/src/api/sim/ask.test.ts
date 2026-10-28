import { describe, expect, it } from 'vitest'
import { SimAsk } from './ask'
import type { AskEvent } from '../ask'
import type { Agent, Goal, Swarm } from '../types'

/** SIM ONLY: the invented host plays the built host's shapes (platform/ask-p1 6100794) and the owner's routing ruling. */
const agents = [
  { id: 'a_vega01', name: 'Vega', status: 'awake', swarm_id: 's_lyra' },
  { id: 'a_altr03', name: 'Altair', status: 'asleep', swarm_id: 's_lyra' },
  { id: 'a_coral5', name: 'Coral', status: 'asleep', swarm_id: 's_kelp' },
  { id: 'a_wisp12', name: 'Wisp', status: 'awake', swarm_id: null },
] as unknown as Agent[]
const swarms = [
  { id: 's_lyra', name: 'Lyra', coordinator_id: 'a_vega01' },
  { id: 's_kelp', name: 'Kelp Commons', coordinator_id: 'a_coral5' },
  { id: 's_none', name: 'Leaderless', coordinator_id: null },
] as unknown as Swarm[]

function host() {
  const events: AskEvent[] = []
  const queue: [number, () => void][] = []
  const h = new SimAsk({ emit: (e) => events.push(e), later: (ms, fn) => queue.push([ms, fn]), agents: () => agents, swarms: () => swarms, goals: () => [] as Goal[], principal: () => 'user:p_ada' })
  const step = () => {
    queue.sort((a, b) => a[0] - b[0])
    queue.shift()?.[1]()
  }
  const flush = () => {
    while (queue.length) step()
  }
  return { h, events, flush, step }
}
const body = (text: string, ctx: Record<string, unknown> = {}, op = `ask:t:${Math.random().toString(36).slice(2, 10)}`) => ({ operation_id: op, text, via: 'typed' as const, context: { route: 'hive', experience: 'classic', ...ctx } })

describe('SimAsk', () => {
  it('the coordinator answers: of the addressed mind’s swarm, else the page’s swarm, else the default', () => {
    const { h } = host()
    expect(h.ask(body('hi', { mind: 'a_altr03' })).thread.mind.name).toBe('Vega')
    expect(() => h.ask(body('hi', { swarm_id: 's_kelp' }))).toThrow(expect.objectContaining({ code: 'mind_asleep', details: { mind: { id: 'a_coral5', name: 'Coral' } } }))
    expect(() => h.ask(body('hi', { swarm_id: 's_none' }))).toThrow(expect.objectContaining({ code: 'no_orchestrator' }))
    expect(() => h.ask(body('hi', { mind: 'a_wisp12' }))).toThrow(expect.objectContaining({ code: 'no_mind' }))
  })
  it('exact keys, as the built host: `to` and authority fields are not_allowed; unknown keys invalid; view refs {kind, ref}', () => {
    const { h } = host()
    expect(() => h.ask({ ...body('hi'), to: 'a_vega01' } as never)).toThrow(expect.objectContaining({ code: 'not_allowed' }))
    expect(() => h.ask({ ...body('hi'), colour: 'red' } as never)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => h.ask(body('hi', { view: { refs: [{ kind: 'goal', ref: 'g1', label: 'x' }] } }))).toThrow(expect.objectContaining({ code: 'invalid' }))
  })
  it('one turn in flight: ask_busy carries the open operation_id; idempotent retries return the same turn', () => {
    const { h } = host()
    const b = body('hello')
    const t = h.ask(b)
    expect(h.ask(b).turn_id).toBe(t.turn_id)
    expect(() => h.ask(body('again'))).toThrow(expect.objectContaining({ code: 'ask_busy', details: { operation_id: b.operation_id } }))
  })
  it('plays the phases in seq order, and the recovery read pages them after a seq', () => {
    const { h, events, flush } = host()
    const b = body('tell me about the swarm')
    h.ask(b)
    flush()
    const all = h.turn(b.operation_id, 0).events
    expect(all.map((e) => e.seq)).toEqual(all.map((_, i) => i + 1))
    expect(all.map((e) => e.phase)).toEqual(expect.arrayContaining(['accepted', 'thinking', 'answer', 'done']))
    expect(h.turn(b.operation_id, 2).events[0].seq).toBe(3)
    expect(events.length).toBeLessThanOrEqual(all.length) // a dropped frame is only in the recovery read
  })
  it('"lose a step" (Review B2): a frame is lost before a move and the recovery read fails for that turn', () => {
    const { h, events, flush } = host()
    const b = body('please lose a step')
    h.ask(b)
    flush()
    const seqs = events.map((e) => e.seq)
    const missing = seqs.find((s, i) => i > 0 && s !== seqs[i - 1] + 1)
    expect(missing).toBeDefined()
    expect(events.some((e) => e.phase === 'proposal' && e.seq > seqs[seqs.indexOf(missing!) - 1])).toBe(true)
    expect(() => h.turn(b.operation_id, 0)).toThrow(expect.objectContaining({ code: 'not_available' }))
  })
  it('a steer joins the open turn, the mind reverts its last move on "go back", and the answer takes the steer in', () => {
    const { h, flush, step } = host()
    const b = body('give me a tour')
    h.ask(b)
    // play until two moves have been made
    const t = h.turn.bind(h)
    let guard = 0
    while (t(b.operation_id).events.filter((e) => e.phase === 'proposal').length < 2 && guard++ < 200) step()
    const r = h.steer(b.operation_id, { steer_id: 'st_123456', text: 'no, go back', at_seq: 3 })
    expect(r.operation_id).toBe(b.operation_id)
    flush()
    const ev = t(b.operation_id).events
    const revert = ev.find((e) => e.phase === 'revert') as { target_id?: string } | undefined
    expect(revert?.target_id).toMatch(/^p_tour1/)
    expect(ev.filter((e) => e.phase === 'proposal')).toHaveLength(5) // it carries on after reversing one
    expect((ev.find((e) => e.phase === 'answer') as { text: string }).text).toContain('no, go back')
    // after it closed, a steer becomes a fresh request
    const fresh = h.steer(b.operation_id, { steer_id: 'st_999999', text: 'one more', at_seq: 99 })
    expect(fresh.new_turn).toBe(true)
    expect(fresh.operation_id).not.toBe(b.operation_id)
  })
  it('coordinator_busy: one person’s open turn at a time per coordinator, and a fixture to play it', () => {
    let who = 'user:p_ada'
    const h = new SimAsk({ emit: () => undefined, later: () => undefined, agents: () => agents, swarms: () => swarms, goals: () => [] as Goal[], principal: () => who })
    h.ask(body('hello'))
    who = 'user:p_bo'
    expect(() => h.ask(body('me too'))).toThrow(expect.objectContaining({ code: 'coordinator_busy' }))
    const h2 = host().h
    h2.coordinatorBusyNext()
    expect(() => h2.ask(body('hi'))).toThrow(expect.objectContaining({ code: 'coordinator_busy' }))
    expect(h2.ask(body('hi again')).thread.mind.name).toBe('Vega')
  })
})

describe('SimAsk steer via (Kimi r3 #1)', () => {
  it('a steer frame carries via; a steer to a closed turn starts a request recorded with the steer’s own via', () => {
    const { h, events, flush } = host()
    const b = body('show the swarm')
    h.ask(b)
    h.steer(b.operation_id, { steer_id: 'st_v00001', text: 'only lyra', at_seq: 1, via: 'voice' })
    const fr = events.find((e) => (e as { phase?: string }).phase === 'steer') as { via?: string } | undefined
    expect(fr?.via).toBe('voice')
    flush()
    const fresh = h.steer(b.operation_id, { steer_id: 'st_v00002', text: 'and kelp', at_seq: 99, via: 'voice' })
    expect(fresh.new_turn).toBe(true)
    expect(h.turn(fresh.operation_id, 0).via).toBe('voice')
  })
})
