import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from './client'
import { AskRefusal, checkAskEvent, readCapabilities, readResearchView } from './ask'
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

// Every frame a research hand-over turn stores, in the host's own shapes: Intents._frame (ask_intents.py), research.deliver
// (research.py) and Ask.content_free (ask.py) for a personal turn's stored copy. Invented ids and words.
describe('every frame a hand-over turn stores is read, live and as a personal turn stores it', () => {
  const env = { type: 'ask', operation_id: 'ask:op-1', turn_id: 't1', principal: 'user:u_ann', at: '2026-11-16T05:23:01Z' }
  const intent = `ai_${'a'.repeat(24)}`
  const view = {
    request_id: 'rq_res1', title: 'Cepheid distances', state: 'done', by: { mind_id: 'a_res01', name: 'researcher 1a2b' }, created_at: 'x', finished_at: 'y',
    report: { summary: 'Cepheids pulse with a period tied to their luminosity.', open_questions: ['How large is the metallicity effect?'],
      checks: { claims: 2, cited: 1, uncited: 1, path_matched: 0 },
      sections: [{ heading: 'The relation', claims: [
        { text: 'Brighter Cepheids pulse more slowly.', cited: true, citations: [{ url: 'https://example.org/cepheids', fetched_at: 'f', match: 'exact', verified: true, audited_at: 'a', title: 'Cepheids' }] },
        { text: 'The relation was found in 1908.', cited: false, citations: [{ url: 'https://example.org/never-fetched', fetched_at: 'f', match: null, verified: false }] },
      ] }] },
  }

  it('intent frames, live and content-free: pending, dispatching, linked (with the goal it made); never a bad state or count', () => {
    const live = [
      { ...env, seq: 2, phase: 'intent', intent_id: intent, state: 'pending', links_rev: 1 },
      { ...env, seq: 3, phase: 'intent', intent_id: intent, state: 'dispatching', dispatch_id: `ad_${'c'.repeat(24)}`, links_rev: 2 },
      { ...env, seq: 4, phase: 'intent', intent_id: intent, state: 'linked', request_id: 'rq_res1', goal_id: 'g_1', links_rev: 3 },
    ]
    for (const f of live) expect(checkAskEvent(f)).toMatchObject({ phase: 'intent', intent_id: intent, state: f.state })
    // Ask.content_free keeps intent_id, state, links_rev, request_id and dispatch_id, and marks it personal
    expect(checkAskEvent({ ...env, seq: 4, phase: 'intent', intent_id: intent, state: 'linked', request_id: 'rq_res1', links_rev: 3, personal: true })).not.toBeNull()
    expect(checkAskEvent({ ...env, seq: 2, phase: 'intent', intent_id: intent, state: 'sent', links_rev: 1 })).toBeNull()
    expect(checkAskEvent({ ...env, seq: 2, phase: 'intent', intent_id: intent, state: 'pending', links_rev: -1 })).toBeNull()
    expect(checkAskEvent({ ...env, seq: 2, phase: 'link', request_id: 'rq_res1', links_rev: 4 })).toMatchObject({ phase: 'link' })
  })

  it('a research frame keeps the report it carries, read to the host\'s caps; its stored copy keeps none and is read too', () => {
    const live = checkAskEvent({ ...env, seq: 8, phase: 'research', intent_id: intent, request_id: 'rq_res1', state: 'done', research: view }) as { research?: { report: { checks: unknown; sections: { claims: { citations: unknown[] }[] }[] } } }
    expect(live.research?.report.checks).toEqual({ claims: 2, cited: 1 })
    expect(live.research?.report.sections[0].claims[1].citations).toEqual([{ url: 'https://example.org/never-fetched', verified: false }])
    const stored = checkAskEvent({ ...env, seq: 8, phase: 'research', intent_id: intent, request_id: 'rq_res1', state: 'done', personal: true })
    expect(stored).toMatchObject({ phase: 'research', request_id: 'rq_res1', state: 'done' })
    expect(stored).not.toHaveProperty('research')
    // a report this page cannot read is left out, never the frame (its place in the turn stays filled)
    const bad = { ...view, report: { ...view.report, sections: [{ heading: 'x', claims: [{ text: 'y', cited: true, citations: [{ url: 'javascript:alert(1)', verified: true }] }] }] } }
    expect(checkAskEvent({ ...env, seq: 8, phase: 'research', request_id: 'rq_res1', state: 'done', research: bad })).not.toHaveProperty('research')
    expect(checkAskEvent({ ...env, seq: 8, phase: 'research', request_id: 'rq_res1', state: 'lost' })).toBeNull()
  })

  it('reads a report strictly: https sources only, the host\'s caps, nothing partly kept', () => {
    expect(readResearchView(view)?.report?.summary).toBe('Cepheids pulse with a period tied to their luminosity.')
    expect(readResearchView({ ...view, report: null })).toEqual({ request_id: 'rq_res1', title: 'Cepheid distances', state: 'done', report: null })
    expect(readResearchView({ ...view, report: { ...view.report, summary: 'x'.repeat(2001) } })).toBeNull()
    expect(readResearchView({ ...view, report: { ...view.report, sections: Array.from({ length: 13 }, () => view.report.sections[0]) } })).toBeNull()
    const http = { ...view.report.sections[0].claims[0], citations: [{ url: 'http://example.org/a', verified: false }] }
    expect(readResearchView({ ...view, report: { ...view.report, sections: [{ heading: 'h', claims: [http] }] } })).toBeNull()
  })

  it('a phase this page does not know keeps its place and nothing else; one with no readable phase is dropped', () => {
    expect(checkAskEvent({ ...env, seq: 9, phase: 'stage-later', words: '<b>x</b>' })).toEqual({ type: 'ask', operation_id: 'ask:op-1', turn_id: 't1', seq: 9, at: env.at, phase: 'unknown', sent_as: 'stage-later' })
    expect(checkAskEvent({ ...env, seq: 9, phase: 'Not A Phase' })).toBeNull()
    expect(checkAskEvent({ ...env, seq: 9 })).toBeNull()
  })

  it('the live client reads a report with GET /api/research/{request_id}', async () => {
    answer = () => ({ status: 200, body: view })
    const c = new LiveClient('https://hive.invalid')
    expect(await c.research('rq_res1')).toEqual(view)
    expect(calls.map((x) => [x.method, x.url])).toEqual([['GET', 'https://hive.invalid/api/research/rq_res1']])
  })
})
