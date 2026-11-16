// Purpose: tests what the feedback area learns from the Ask (features/feedback/watchAsk.ts): which frames say a mind
// stopped while it owed an answer, a hand-over followed through its intent until it settles (a refusal noted once), and
// that only frames after the watch began count.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HiveClient } from '../../api/client'
import type { AskEvent } from '../../api/ask'
import { clearPageErrors, pageErrors } from '../../lib/recentErrors'
import { useAskStore, type TurnMeta } from '../../store/ask'
import { DONE_WORDS, REFUSAL_WORDS } from '../ask/words'
import { followHandover, stoppedMind, watchAsk } from './watchAsk'

const AT = '2026-11-16T03:00:00Z'
const turn = (events: AskEvent[] = []): TurnMeta => ({ op: 'op_1', you: 'Why is it slow?', state: 'open', answerer: { id: 'a_vega01', name: 'Vega' }, lastSeq: events.length,
  events, outcomes: {}, notes: [], steers: [], moves: 0, tookOver: false, presence: 0, ahead: [] }) as TurnMeta
const frame = (seq: number, body: Record<string, unknown>, at = AT) => ({ type: 'ask', operation_id: 'op_1', turn_id: 'turn_1', seq, at, ...body }) as unknown as AskEvent
const DISPATCHED = frame(2, { phase: 'dispatched', intent_id: 'ai_000000000000000000000001', intent_kind: 'code.request', to: { kind: 'swarm', ref: 's_forge', name: 'Forge' }, label: 'a tip calculator' }) as Extract<AskEvent, { phase: 'dispatched' }>
const intent = (state: string, extra: Record<string, unknown> = {}) => ({
  intent_id: 'ai_000000000000000000000001', turn_id: 'turn_1', kind: 'code.request', state, request_operation_id: 'ask.ai_000000000000000000000001',
  request_id: state === 'linked' ? 'r_1' : null, lease_id: null, receiving_goal: null, last_refusal: null, last_dispatch: null, until: null, links_rev: 0, ...extra,
})
const now = () => Promise.resolve()

afterEach(() => clearPageErrors())

describe('a mind that stopped while it owed an answer', () => {
  it.each([
    ['refused for time', frame(3, { phase: 'refused', reason: 'timed_out' }), { code: 'timed_out', message: REFUSAL_WORDS.timed_out.say }],
    ['ended with an error', frame(3, { phase: 'done', outcome: 'error', error: 'key_unavailable' }), { code: 'error key_unavailable' }],
    ['ended out of time', frame(3, { phase: 'done', outcome: 'time_cap' }), { code: 'time_cap', message: DONE_WORDS.time_cap }],
  ])('%s', (_, e, want) => {
    expect(stoppedMind(turn(), e)).toMatchObject({ kind: 'mind', where: 'Vega', at: AT, ...want })
  })
  it.each([
    ['the person stopped it', frame(3, { phase: 'refused', reason: 'stopped' })],
    ['a spending limit', frame(3, { phase: 'refused', reason: 'spend_limit' })],
    ['a complete answer', frame(3, { phase: 'done', outcome: 'complete' })],
    ['the person took over', frame(3, { phase: 'done', outcome: 'cancelled', taken_over: true })],
    ['an answer', frame(3, { phase: 'answer', text: 'Here.' })],
  ])('not when %s', (_, e) => {
    expect(stoppedMind(turn(), e)).toBeNull()
  })
})

describe('a hand-over, followed until it settles', () => {
  const run = async (reads: unknown[], stopped = () => false) => {
    const askIntent = vi.fn(async () => reads.shift() ?? reads.at(-1))
    await followHandover(() => ({ askIntent } as unknown as HiveClient), DISPATCHED, stopped, now)
    return askIntent
  }
  it('a refusal is noted once, with its code and where it was handed', async () => {
    const reads = await run([intent('pending'), intent('dispatching'), intent('refused', { last_refusal: { code: 'not_allowed', status: 403 } })])
    expect(reads).toHaveBeenCalledTimes(3)
    expect(pageErrors().map((e) => [e.kind, e.where, e.code, e.message])).toEqual([
      ['handover', 'Forge', 'not_allowed', 'The hive handed "a tip calculator" to Forge, and it was refused (not_allowed).'],
    ])
  })
  it('given up after a refusal counts as refused; taken, or given up without one, notes nothing', async () => {
    await run([intent('abandoned', { last_refusal: { code: 'refused', status: null } })])
    expect(pageErrors()).toHaveLength(1)
    clearPageErrors()
    await run([intent('linked')])
    await run([intent('abandoned')])
    expect(pageErrors()).toHaveLength(0)
  })
  it("stops at the intent's own lifetime, or when told to", async () => {
    const lapsed = await run([intent('pending', { until: '2026-01-01T00:00:00Z' })])
    expect(lapsed).toHaveBeenCalledTimes(1)
    const told = await run([intent('pending')], () => true)
    expect(told).not.toHaveBeenCalled()
  })
})

describe('watching the Ask', () => {
  it("notes only frames after the watch began, each once however often the store changes", () => {
    const since = Date.parse(AT)
    useAskStore.setState({ turns: { op_1: turn([frame(1, { phase: 'refused', reason: 'timed_out' }, '2026-11-16T02:00:00Z')]) } } as never)
    const stop = watchAsk(() => null, since)
    expect(pageErrors()).toHaveLength(0)
    const later = turn([frame(1, { phase: 'refused', reason: 'timed_out' }, '2026-11-16T02:00:00Z'), frame(2, { phase: 'done', outcome: 'error' })])
    useAskStore.setState({ turns: { op_1: later } } as never)
    useAskStore.setState({ turns: { op_1: { ...later } } } as never)
    expect(pageErrors().map((e) => [e.kind, e.code])).toEqual([['mind', 'error']])
    stop()
  })
})
