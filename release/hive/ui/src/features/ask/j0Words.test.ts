import { describe, expect, it } from 'vitest'
import { appShown, DONE_WORDS, doneErrorWords, paysLine, readDoneLimit, refusalOf, REFUSAL_WORDS, SPEND_STOP_UNNAMED, spendRefusalOffers, spendStop, threadBinds, USAGE_AND_LIMITS, YOUR_KEYS } from './words'
import { limitDraft, limitToSave } from '../usage/Limits'
import { askThreadFigures, openThreadsOf, END_SAYS, withThreadFigures } from './threadList'
import type { WorkSession } from '../../api/types'

/** j0-fixes r1 items 2-5, pure: honest limit words, the payer line, the limit editor's cents, own open threads. INVENTED data. */
const kinds = (o: { kind: string }[]) => o.map((x) => x.kind)

describe('item 3: a spending stop offers only a remedy that helps', () => {
  const lim = (kind: string, current = 3.89, limit = 3.92) => readDoneLimit({ kind, current_usd: current, limit_usd: limit, estimate_usd: 0.25 })
  it('today’s host (no `limit`): the plain fallback, with the thread’s own figures as a fact and no remedy offered', () => {
    const s = spendStop(null, { spent_usd: 0, budget_usd: 5 })
    expect(s.text).toBe('Stopped here: a spending limit stopped this request, and the hive did not say which one. Usage & limits shows every limit. This thread has used $0.00 of its $5.00.')
    expect(s.offer).toEqual([])
    // even when the thread looks spent: the host did not say so, so nothing is promised
    expect(spendStop(null, { spent_usd: 4.99, budget_usd: 5 }).offer).toEqual([])
    expect(spendStop(null, null).text).toBe(SPEND_STOP_UNNAMED)
  })
  it('kind unknown (or one this page does not know): the plain fallback, no remedy', () => {
    expect(spendStop(lim('unknown'), { spent_usd: 4.99, budget_usd: 5 }).offer).toEqual([])
    expect(spendStop(readDoneLimit({ kind: 'galaxy' }), null)).toEqual({ text: SPEND_STOP_UNNAMED, offer: [] })
  })
  it('the raise for new threads is offered for the thread’s own cap only (the per-turn cap is the hive’s setting)', () => {
    for (const kind of ['thread', 'per_turn', 'mind_total', 'session', 'swarm', 'hive', 'member_allowance', 'key', 'own_key_limit', 'own_key_required', 'no_key_grant', 'unknown']) {
      const raise = kinds(spendStop(lim(kind), { spent_usd: 0, budget_usd: 5 }).offer).includes('raise-budget')
      expect(raise, kind).toBe(kind === 'thread')
    }
    expect(kinds(spendStop(lim('thread', 5, 5), null).offer)).toEqual(['new-thread', 'raise-budget'])
    const turn = spendStop(lim('per_turn', 0.25, 0.25), null)
    expect(turn.text).toBe('Stopped here: this request reached the spending limit for one turn ($0.25 of $0.25). Each turn starts with a fresh limit, so you can ask again to carry on.')
    expect(kinds(turn.offer)).toEqual(['retry'])
  })
  it('mind_total, swarm and hive name that limit with its figures and link to Usage & limits', () => {
    const mind = spendStop(lim('mind_total'), { spent_usd: 0, budget_usd: 5 })
    expect(mind.text).toBe('Stopped here: this mind has reached its own spending limit ($3.89 of $3.92). Raising this thread’s limit would not help; an admin can raise the mind’s limit.')
    expect(mind.offer).toEqual([USAGE_AND_LIMITS])
    expect(spendStop(lim('swarm', 45.66, 45.66), null).text).toBe('Stopped here: this swarm has reached its spending limit ($45.66 of $45.66). An admin can raise the swarm’s limit.')
    expect(spendStop(lim('hive', 1000, 1000), null).text).toContain('the hive has reached its spending limit ($1000.00 of $1000.00)')
    for (const kind of ['swarm', 'hive', 'member_allowance']) expect(spendStop(lim(kind), null).offer, kind).toEqual([USAGE_AND_LIMITS])
    expect(USAGE_AND_LIMITS.label).toBe('Usage & limits')
  })
  it('the key kinds point to the person’s keys; a permission kind has no figures', () => {
    for (const kind of ['key', 'own_key_limit', 'own_key_required', 'no_key_grant']) expect(spendStop(lim(kind), null).offer, kind).toEqual([YOUR_KEYS])
    const grant = spendStop(readDoneLimit({ kind: 'no_key_grant', current_usd: null, limit_usd: null, estimate_usd: null }), null)
    expect(grant.text).toBe('Stopped here: you don’t have permission to spend on this hive’s key. Ask its owner, or add your own key.')
    expect(grant.text).not.toMatch(/\$/)
  })
  it('an untrusted limit is read strictly', () => {
    expect(readDoneLimit({ kind: '<b>x</b>' })).toBeNull()
    expect(readDoneLimit({ kind: 'thread', current_usd: -1, limit_usd: Infinity })).toEqual({ kind: 'thread', current_usd: null, limit_usd: null, estimate_usd: null })
    expect(readDoneLimit('thread')).toBeNull()
    expect(readDoneLimit(null)).toBeNull()
    // figures missing: the sentence is said without them, never with an invented one
    expect(spendStop(readDoneLimit({ kind: 'mind_total' }), null).text).toBe('Stopped here: this mind has reached its own spending limit. Raising this thread’s limit would not help; an admin can raise the mind’s limit.')
  })
  it('the HTTP spend refusal offers the thread raise only when the thread is visibly the block', () => {
    expect(kinds(spendRefusalOffers({ spent_usd: 0, budget_usd: 5 }))).toEqual(['usage'])
    expect(kinds(spendRefusalOffers({ spent_usd: 0.24, budget_usd: 0.25 }))).toContain('raise-budget')
    expect(threadBinds({ spent_usd: 4.9, budget_usd: 5 })).toBe(true)
    expect(threadBinds({ spent_usd: 1, budget_usd: 5 })).toBe(false)
    expect(threadBinds(null)).toBe(false)
  })
  it('the new error outcomes get their own words; anything else keeps the plain error words', () => {
    expect(doneErrorWords('unpriced_model')).toBe('Stopped here: the model the Ask uses has no price set, so the hive won’t spend money on it. An admin can set its price or choose another model.')
    expect(doneErrorWords('key_unavailable')).toBe('Stopped here: the key assigned to pay for this mind is gone or doesn’t fit its model. An admin can assign another key, or use the hive’s default.')
    for (const odd of [undefined, null, 'not_available', 'toString', '__proto__', 42]) expect(doneErrorWords(odd), String(odd)).toBe(DONE_WORDS.error)
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
  it('a new request, a steer, and no known limit', () => {
    const thread = { spent_usd: 0.4, budget_usd: 5, mind: { id: 'a_kelp' } }
    expect(paysLine({ steering: false, thread, answererId: 'a_other', newThreadUsd: 0.25 })).toBe('Paid by you · a new thread may spend up to $0.25 · no estimate before it starts')
    expect(paysLine({ steering: true, thread, answererId: 'a_other', newThreadUsd: 0.25 })).toBe('Paid by you · this thread has used $0.40 of $5.00 · no estimate before it starts')
    expect(paysLine({ steering: false, thread, answererId: 'a_kelp', newThreadUsd: 0.25 })).toContain('this thread has used $0.40 of $5.00')
    expect(paysLine({ steering: false, thread: null, answererId: null, newThreadUsd: undefined })).toBe('Paid by you · no estimate before it starts')
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
  it('the limits payload’s ask_threads give each thread its own figures where present; else the session’s stand', () => {
    const mine = [s('a', { spent_usd: 2.004, budget_usd: 5 }), s('b', { spent_usd: 0.5 })]
    // today’s host: no ask_threads anywhere (or the person may not read it): the session list stands
    expect(askThreadFigures({ minds: [{ agent_id: 'a_pd', limits: [] }] })).toBeNull()
    expect(askThreadFigures(null)).toBeNull()
    expect(withThreadFigures(mine, null)).toEqual(mine)
    const f = askThreadFigures({ minds: [{ agent_id: 'a_pd', ask_threads: [
      { id: 'a', owner: 'user:me', key: 'askthread:a', budget_usd: 5, spent_usd: 0.004, created_at: '' },
      { id: 'b', owner: 'user:other', budget_usd: 5, spent_usd: 4 }, // someone else's row never changes mine
      { id: 'bad<', owner: 'user:me', budget_usd: 5, spent_usd: 0 },
      { id: 'c', owner: 'user:me', budget_usd: -1, spent_usd: 0 },
    ] }, { agent_id: 'a_x', ask_threads: [] }] })!
    expect([...f.keys()]).toEqual(['a', 'b'])
    expect(withThreadFigures(mine, f).map((x) => [x.id, x.spent_usd, x.budget_usd])).toEqual([['a', 0.004, 5], ['b', 0.5, 5]])
  })
  it('says what ending does', () => {
    expect(END_SAYS).toBe('Ends the thread; its words stay.')
  })
})

describe('item 3: the raise note never says "$$"', () => {
  it('the amount is money() alone (it carries its own $), in the rendered words', async () => {
    const fsName = 'node:fs'
    const { readFileSync } = (await import(/* @vite-ignore */ fsName)) as { readFileSync: (p: string, e: 'utf8') => string }
    const src = readFileSync(decodeURIComponent(new URL('./Thread.tsx', import.meta.url).pathname), 'utf8')
    expect(src).toContain('(up to {money(steps.at(-1) ?? 5)})')
    expect(src).not.toMatch(/\$\$\{money\(|\$\{money\(steps/)
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
