// Purpose: prove the Ask's plain words for spending stops, refusals, the paid row and the person's open threads.
import { describe, expect, it } from 'vitest'
import { appShown, DONE_WORDS, doneErrorWords, GO_AHEAD, MONTHLY_TOTAL_STOP, paysLine, readDoneLimit, refusalOf, REFUSAL_WORDS, SPEND_STOP_UNNAMED, spendStop, spokenRefusal, USAGE_AND_LIMITS, YOUR_KEYS } from './words'
import { limitDraft, limitToSave } from '../usage/limitsScreen'
import { openThreadsOf, END_SAYS } from './threadList'
import type { WorkSession } from '../../api/types'

/** j0-fixes r1 items 2-5, pure: honest limit words, the payer line, the limit editor's cents, own open threads. INVENTED data. */
const kinds = (o: { kind: string }[]) => o.map((x) => x.kind)

describe('item 3: a spending stop offers only a remedy that helps', () => {
  const lim = (kind: string, current = 3.89, limit = 3.92) => readDoneLimit({ kind, current_usd: current, limit_usd: limit, estimate_usd: 0.25 })
  it('a host that does not name the limit: the plain fallback, and no remedy offered', () => {
    expect(spendStop(null)).toEqual({ text: SPEND_STOP_UNNAMED, offer: [] })
    expect(SPEND_STOP_UNNAMED).toBe('Stopped here: a spending limit stopped this request, and the hive did not say which one. Usage & limits shows every limit.')
  })
  it('kind unknown (or one this page does not know): the plain fallback, no remedy', () => {
    expect(spendStop(lim('unknown')).offer).toEqual([])
    expect(spendStop(readDoneLimit({ kind: 'galaxy' }))).toEqual({ text: SPEND_STOP_UNNAMED, offer: [] })
  })
  it('no stop offers a new thread or a raise: an Ask thread and turn have no cap of their own (Jon on #294)', () => {
    for (const kind of ['expensive', 'mind_total', 'session', 'swarm', 'hive', 'member_allowance', 'key', 'own_key_limit', 'own_key_required', 'no_key_grant', 'own_key_needed', 'unknown'])
      expect(kinds(spendStop(lim(kind)).offer).filter((k) => k === 'new-thread' || k === 'raise-budget'), kind).toEqual([])
    // the retired kinds are no longer sent; one that arrives anyway is a limit the page does not know
    for (const kind of ['thread', 'per_turn']) expect(spendStop(lim(kind)), kind).toEqual({ text: SPEND_STOP_UNNAMED, offer: [] })
  })
  it('an expensive stop says what it had spent, as the question did, and offers Go ahead', () => {
    const stop = spendStop(readDoneLimit({ kind: 'expensive', current_usd: 1.2, limit_usd: 1, estimate_usd: null }))
    expect(stop.text).toBe('Stopped here: this one looks expensive (about $1.20 so far), and no go-ahead came in time.')
    expect(stop.offer).toEqual([GO_AHEAD])
    expect(GO_AHEAD).toEqual({ kind: 'go-ahead', label: 'Go ahead' })
    // its spend unreadable: said without a figure, never an invented one
    expect(spendStop(readDoneLimit({ kind: 'expensive', current_usd: 'lots', limit_usd: 1 })).text).toBe('Stopped here: this one looks expensive, and no go-ahead came in time.')
  })
  it('mind_total, swarm and hive name that limit with its figures and link to Usage & limits', () => {
    const mind = spendStop(lim('mind_total'))
    expect(mind.text).toBe('Stopped here: this mind has reached its own spending limit ($3.89 of $3.92). An admin can raise the mind’s limit.')
    expect(mind.offer).toEqual([USAGE_AND_LIMITS])
    expect(spendStop(lim('swarm', 45.66, 45.66)).text).toBe('Stopped here: this swarm has reached its spending limit ($45.66 of $45.66). An admin can raise the swarm’s limit.')
    expect(spendStop(lim('hive', 1000, 1000)).text).toContain('the hive has reached its spending limit ($1000.00 of $1000.00)')
    for (const kind of ['swarm', 'hive', 'member_allowance']) expect(spendStop(lim(kind)).offer, kind).toEqual([USAGE_AND_LIMITS])
    expect(USAGE_AND_LIMITS.label).toBe('Usage & limits')
  })
  it('the key kinds point to the person’s keys; a permission kind has no figures', () => {
    for (const kind of ['key', 'own_key_limit', 'own_key_required', 'no_key_grant']) expect(spendStop(lim(kind)).offer, kind).toEqual([YOUR_KEYS])
    const grant = spendStop(readDoneLimit({ kind: 'no_key_grant', current_usd: null, limit_usd: null, estimate_usd: null }))
    expect(grant.text).toBe('Stopped here: you don’t have permission to spend on this hive’s key. Ask its owner, or add your own key.')
    expect(grant.text).not.toMatch(/\$/)
  })
  it('an untrusted limit is read strictly', () => {
    expect(readDoneLimit({ kind: '<b>x</b>' })).toBeNull()
    expect(readDoneLimit({ kind: 'thread', current_usd: -1, limit_usd: Infinity })).toEqual({ kind: 'thread', current_usd: null, limit_usd: null, estimate_usd: null })
    expect(readDoneLimit('thread')).toBeNull()
    expect(readDoneLimit(null)).toBeNull()
    // figures missing: the sentence is said without them, never with an invented one
    expect(spendStop(readDoneLimit({ kind: 'mind_total' })).text).toBe('Stopped here: this mind has reached its own spending limit. An admin can raise the mind’s limit.')
  })
  it('a missing monthly total is no limit reached: it says so and offers where that total is set', () => {
    const none = { current_usd: null, limit_usd: null, estimate_usd: null }
    const own = readDoneLimit({ kind: 'own_key_limit', ...none, reason: 'monthly_total_required' })
    expect(own).toEqual({ kind: 'own_key_limit', ...none, reason: 'monthly_total_required' })
    expect(spendStop(own)).toEqual({ text: MONTHLY_TOTAL_STOP, offer: [YOUR_KEYS] })
    // the hive's money: an admin's own mind waits on a month rule set in Usage & limits (conductor waits_for_monthly_total)
    const hive = readDoneLimit({ kind: 'member_allowance', ...none, reason: 'monthly_total_required' })
    expect(spendStop(hive)).toEqual({ text: MONTHLY_TOTAL_STOP, offer: [USAGE_AND_LIMITS] })
    expect(MONTHLY_TOTAL_STOP).not.toMatch(/reached/)
    expect(readDoneLimit({ kind: 'member_allowance', reason: 'galaxy' })).toEqual({ kind: 'member_allowance', ...none })
  })
  it('the HTTP spend refusal is a mind’s, swarm’s, hive’s or person’s limit, so it offers Usage & limits only', () => {
    expect(REFUSAL_WORDS.spend_limit).toEqual({ say: 'This has reached its spending limit. Nothing more was spent.', offer: [USAGE_AND_LIMITS] })
  })
  it('the new error outcomes get their own words; anything else keeps the plain error words', () => {
    expect(doneErrorWords('unpriced_model')).toBe('Stopped here: the model the Ask uses has no price set, so the hive won’t spend money on it. An admin can set its price or choose another model.')
    expect(doneErrorWords('key_unavailable')).toBe('Stopped here: the key assigned to pay for this mind is gone or doesn’t fit its model. An admin can assign another key, or use the hive’s default.')
    expect(doneErrorWords('mind_not_connected')).toBe('Stopped here: your mind isn’t connected to a model yet. Add your key under You & your keys, then ask again.')
    for (const odd of [undefined, null, 'not_available', 'toString', '__proto__', 42]) expect(doneErrorWords(odd), String(odd)).toBe(DONE_WORDS.error)
  })
  it('a refusal the hive spoke has no stop words of the page: its answer said it once, and done.remedy says what helps', () => {
    for (const code of ['free_inference_busy', 'free_inference_daily_cap', 'free_inference_off']) expect(doneErrorWords(code), code).toBe(DONE_WORDS.error)
    for (const remedy of ['wait', 'credit', 'key', 'model']) expect(spokenRefusal(remedy), remedy).toBe(true)
    for (const odd of [undefined, null, '', 'WAIT', 'toString', '__proto__', 42, ['wait']]) expect(spokenRefusal(odd), String(odd)).toBe(false)
  })
})

describe('item 3: the limit editor shows cents, and an unchanged figure saves nothing', () => {
  it('3.914502… shows as 3.91; saving it unchanged is not a change', () => {
    expect(limitDraft(3.914502318)).toBe('3.91')
    expect(limitToSave('3.91', 3.914502318)).toBeNull()
    expect(limitToSave('18.91', 3.914502318)).toBe(18.91)
    expect(limitToSave('', 3.9)).toBeNull()
    expect(limitToSave('abc', 3.9)).toBeNull()
  })
})

describe('item 2: the paid row names who pays, and never invents an estimate', () => {
  it('a new request, a steer, the threshold it stops to ask at, and none known', () => {
    const thread = { spent_usd: 0.4, mind: { id: 'a_kelp' } }
    const on = { on: true, usd: 0.62 }
    expect(paysLine({ steering: false, thread, answererId: 'a_other', expensive: on })).toBe('Paid by you · stops to ask past $0.62 · no estimate before it starts')
    expect(paysLine({ steering: true, thread, answererId: 'a_other', expensive: on })).toBe('Paid by you · this thread has used $0.40 · stops to ask past $0.62 · no estimate before it starts')
    expect(paysLine({ steering: false, thread, answererId: 'a_kelp', expensive: { on: false, usd: 0.62 } })).toBe('Paid by you · this thread has used $0.40 · no estimate before it starts')
    expect(paysLine({ steering: false, thread: null, answererId: null, expensive: null })).toBe('Paid by you · no estimate before it starts')
  })
})

describe('item 5: Studio is shown by its name', () => {
  it('omegadesign is "Studio"; other apps keep their own name', () => {
    expect(appShown('omegadesign', 'OmegaDesign')).toBe('Studio')
    expect(appShown('omegacode', 'Code')).toBe('Code')
    expect(appShown('x', '')).toBe('the app')
  })
})

describe('item 4: your own open threads on a mind, with End', () => {
  const s = (id: string, o: Partial<WorkSession>): WorkSession => ({ id, room_id: `r_${id}`, agent_id: 'a_pd', goal_id: null, owner: 'user:me', title: 'Ask thread', status: 'active', budget_usd: 5, spent_usd: 0, created_at: '2026-10-17T13:55:00Z', ended_at: null, workspace: null, mind: { id: 'a_pd', name: 'Product Design' }, goal: null, ...o })
  it('only mine, only open, only this mind, never the thread on the page; newest first', () => {
    const all = [s('old', { created_at: '2026-10-17T10:00:00Z' }), s('new', {}), s('cur', {}), s('ended', { status: 'ended' }), s('theirs', { owner: 'user:other' }), s('elsewhere', { mind: { id: 'a_x', name: 'X' } })]
    expect(openThreadsOf(all, 'user:me', { mind: 'a_pd', current: 'cur' }).map((x) => x.id)).toEqual(['new', 'old'])
    expect(openThreadsOf(all, 'user:me', {}).map((x) => x.id)).toEqual(['new', 'cur', 'elsewhere', 'old'])
    expect(openThreadsOf(all, null)).toEqual([])
  })
  it('says what ending does', () => {
    expect(END_SAYS).toBe('Ends the thread; its words stay.')
  })
})

describe('OI-13 own_key_needed in the ordinary Ask (j3r43-o3 r1.7)', () => {
  it('an HTTP refusal own_key_needed reads its own words with a way to Keys, never "not available"', () => {
    expect(refusalOf('own_key_needed')).toBe('own_key_needed')
    const w = REFUSAL_WORDS.own_key_needed
    expect(w.say).toMatch(/someone else’s key.*Add your own key in Keys/)
    expect(kinds(w.offer ?? [])).toEqual(['keys'])                     // no automatic retry offered or done
  })
  it('a spend stop of kind own_key_needed (once the conductor names it) says so and offers Keys', () => {
    const r = spendStop(readDoneLimit({ kind: 'own_key_needed', current_usd: null, limit_usd: null, estimate_usd: null }))
    expect(r.text).toMatch(/someone else’s key/)
    expect(kinds(r.offer)).toEqual(['keys'])
  })
})
