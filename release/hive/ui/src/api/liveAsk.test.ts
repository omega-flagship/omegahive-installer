import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { AskRefusal, checkAskEvent, readCapabilities } from './ask'
import { LiveClient } from './live'
import { turnOutcome } from '../features/ask/Earlier'

// conductor-live: the live client's steer against the host's own shape (core/app.py ask_steer at 32afcf7), the
// takeover done frame (Platform ask-takeover r2) and the capabilities read. fetch, window and storage are stand-ins; invented ids only.

let calls: { url: string; method: string; body: unknown }[] = []
let answer: (url: string) => { status: number; body: unknown } = () => ({ status: 200, body: {} })

beforeEach(() => {
  calls = []
  vi.stubGlobal('window', { location: { href: 'https://hive.invalid/', search: '' }, addEventListener() {}, removeEventListener() {} })
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined })
    const a = answer(url)
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json' } })
  }))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('steer reaches the host', () => {
  it('POST /api/ask/{op}/steer with exactly {steer_id, text, at_seq, via}; the 202 answer is returned', async () => {
    answer = () => ({ status: 202, body: { steer_id: 'st_abc12345', operation_id: 'ask:op-1', turn_id: 't1', new_turn: false, seq: 7, via: 'typed' } })
    const c = new LiveClient('https://hive.invalid')
    const r = await c.askSteer('ask:op-1', { steer_id: 'st_abc12345', text: 'not that one', at_seq: 4, via: 'typed' })
    expect(calls).toEqual([{ url: 'https://hive.invalid/api/ask/ask%3Aop-1/steer', method: 'POST', body: { steer_id: 'st_abc12345', text: 'not that one', at_seq: 4, via: 'typed' } }])
    expect(r).toMatchObject({ operation_id: 'ask:op-1', new_turn: false, seq: 7 })
  })
  it('the live client sends steer and keeps confirm unsent', () => {
    const c = new LiveClient('https://hive.invalid') as unknown as Record<string, unknown>
    expect(typeof c.askSteer).toBe('function')
    expect(c.askConfirm).toBeUndefined()
  })
  it('a closed turn answers a fresh turn under a new operation_id; a 2xx that is not this steer’s answer is unreadable', async () => {
    answer = () => ({ status: 202, body: { steer_id: 'st_abc12345', operation_id: 'steer:st_abc12345', turn_id: 't2', new_turn: true, thread: { id: 'ses_1' }, state: 'accepted', via: 'voice' } })
    const c = new LiveClient('https://hive.invalid')
    expect(await c.askSteer('ask:op-1', { steer_id: 'st_abc12345', text: 'and the next', at_seq: 9, via: 'voice' })).toMatchObject({ operation_id: 'steer:st_abc12345', new_turn: true })
    answer = () => ({ status: 202, body: { steer_id: 'st_other999', operation_id: 'ask:op-1' } })
    await expect(c.askSteer('ask:op-1', { steer_id: 'st_abc12345', text: 'x', at_seq: 1 })).rejects.toMatchObject({ status: 0, code: 'answer_unreadable' })
  })
  it('a conductor turn refuses steering (not_available): the refusal keeps its code', async () => {
    answer = () => ({ status: 404, body: { error: 'not_available', message: 'not available' } })
    const c = new LiveClient('https://hive.invalid')
    const err = await c.askSteer('ask:op-1', { steer_id: 'st_abc12345', text: 'x', at_seq: 1 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect(err).toBeInstanceOf(AskRefusal)
    expect((err as ApiError).code).toBe('not_available')
  })
})

describe('takeover: the host’s done frame (Platform ask-takeover; the live route is Platform’s own patch)', () => {
  it('the done frame keeps taken_over only as true with outcome cancelled', () => {
    const base = { type: 'ask', operation_id: 'ask:op-1', turn_id: 't1', seq: 5, at: 'x', phase: 'done', outcome: 'cancelled', spent_usd: 0.01, turn_spent_usd: 0.01 }
    expect(checkAskEvent({ ...base, taken_over: true })).toMatchObject({ taken_over: true, outcome: 'cancelled' })
    expect(checkAskEvent({ ...base, taken_over: 'yes' })).not.toHaveProperty('taken_over')
    expect(checkAskEvent({ ...base, outcome: 'complete', taken_over: true })).not.toHaveProperty('taken_over')
  })
})

describe('takeover: the recovery view (state refused, reason takeover)', () => {
  it('reads as the person’s own act, never as a refusal', () => {
    expect(turnOutcome({ state: 'refused', reason: 'takeover' })).toBe('You took over — the Ask stopped.')
    expect(turnOutcome({ state: 'refused', reason: 'stopped' })).toMatch(/^not answered: /)
  })
})

describe('capabilities', () => {
  it('booleans only; memory needs the conductor; anything else is not given', () => {
    expect(readCapabilities({ conductor: true, memory: true })).toEqual({ conductor: true, memory: true })
    expect(readCapabilities({ conductor: false, memory: true })).toEqual({ conductor: false, memory: false })
    expect(readCapabilities({ conductor: 'on', memory: true })).toBeNull()
    expect(readCapabilities(undefined)).toBeNull()
  })
})
