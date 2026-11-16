// Purpose: tests for the held-call and estimate words and checks: how and when each held call settles itself, amounts,
// reasons, timing, limit names, what a correction still needs, and Correct all's totals and binding.
import { describe, expect, it } from 'vitest'
import type { CostReservation, EstimatedCall } from '../../api/moneyWork'
import { bindEstimates, canCorrect, correctBlocked, ESTIMATE_WORDS, estimateSummary, estimateTiming, estimateWords, heldFor, heldReason, inWords, isFreeFloor, overrunUsd, parseUsd, reasonBlocked, refusedWords, scopeWords, settlesWords, splitHeld } from './settle'

const row = (id: string, state: CostReservation['state']): CostReservation => ({ id, state, held_usd: 0.1, scopes: [], metadata: {}, observation: null, settles: state === 'unknown' ? 'estimate' : 'answer' })

describe('held calls settle themselves; a person only corrects an estimate', () => {
  it('reads dollar amounts strictly', () => {
    expect(parseUsd('0.31')).toBe(0.31)
    expect(parseUsd('$1,204.5')).toBe(1204.5)
    expect(parseUsd('.5')).toBe(0.5)
    expect(parseUsd('0')).toBe(0)
    for (const bad of ['', '-1', 'abc', '1e3', '0.1234567', 'NaN', '1.2.3']) expect(parseUsd(bad)).toBeNull()
  })

  it('a correction needs the billed cost and a reason, and each missing one names the field that gives it', () => {
    expect(correctBlocked('', 'x')).toEqual({ why: 'Enter the billed cost from the provider’s billing.', field: 'amount' })
    expect(correctBlocked('abc', 'x')).toMatchObject({ field: 'amount', why: expect.stringMatching(/an amount in dollars/) })
    expect(correctBlocked('0.2', '  ')).toEqual({ why: 'Give a reason, recorded with the correction.', field: 'reason' })
    expect(correctBlocked('0.2', 'billing says 0.2')).toBeNull()
    expect(reasonBlocked('')).toEqual({ why: 'Give a reason, recorded with the correction.', field: 'reason' })
    expect(reasonBlocked('provider refunded')).toBeNull()
  })

  it('splits held calls by state: unknown outcomes and calls still in flight', () => {
    const s = splitHeld([row('a', 'unknown'), row('b', 'dispatched'), row('c', 'reserved')])
    expect(s.unknown.map((r) => r.id)).toEqual(['a'])
    expect(s.inFlight.map((r) => r.id)).toEqual(['b', 'c'])
  })


  it('names scopes in words and converts overruns from micro-dollars', () => {
    expect(scopeWords('agent:a_x:total', (_k, id) => (id === 'a_x' ? 'Vega' : id))).toBe('mind Vega in total')
    expect(scopeWords('swarm:s_y:month')).toBe('swarm s_y this month')
    expect(scopeWords('hive:hard-total')).toBe('the whole hive’s hard cap')
    expect(overrunUsd({ reservation: 'r', agent: null, maximum: 120_000, actual: 163_400, source: 'settle', at: 0 })).toEqual({ held: 0.12, actual: 0.1634, over: 0.0434 })
  })

  it('names every kind of limit by what it limits and when, the hive by its period, a scope it may not see by its kind', () => {
    const name = (k: string, id: string) => `${k}-${id}`
    for (const [label, words] of [
      ['hive:month', 'the whole hive this month'], ['hive:day', 'the whole hive today'], ['hive:hard-total', 'the whole hive’s hard cap'],
      ['hive:all-time', 'the whole hive’s hard cap'], ['hive', 'the whole hive’s hard cap'],
      ['agent:a_x:total', 'mind agent-a_x in total'], ['swarm:s_y:day', 'swarm swarm-s_y today'], ['key:k_z:month', 'key key-k_z this month'],
      ['person:u_p:month', 'a person’s allowance this month'], ['keyuse:4f2a:month', 'the own-key limit this month'],
      ['key::month', 'key this month'], ['person::month', 'a person’s allowance this month'],
      ['agent:a_x:', 'mind agent-a_x'],
    ] as const) expect(scopeWords(label, name), label).toBe(words)
  })

  it('says which limit refused a call, what is spent and held against it, and the limit', () => {
    expect(refusedWords({ scope: 'swarm:s_c', period: 'day', limit_usd: 2, spent_usd: 1.98, held_usd: 0.04 }, (_k, id) => (id === 's_c' ? 'Create · Code' : id)))
      .toBe('No room under swarm Create · Code today: $1.98 spent and $0.04 held for calls not yet settled, of $2.00.')
    expect(refusedWords({ scope: 'hive', period: 'month', limit_usd: 50, spent_usd: 50 })).toBe('No room under the whole hive this month: $50 spent, of $50.')
  })

  it('says what the refused call could cost, which is why a limit with room left still refused it', () => {
    // nothing spent of a $0.01 day limit, and a call whose worst case is $0.0527
    expect(refusedWords({ scope: 'swarm:s_r', period: 'day', limit_usd: 0.01, spent_usd: 0, call_usd: 0.0527 }, (_k, id) => (id === 's_r' ? 'Review team' : id)))
      .toBe('No room under swarm Review team today: $0 spent, of $0.01, and its next call could cost up to $0.05.')
    expect(refusedWords({ scope: 'agent:a_c', period: 'total', limit_usd: 0.1, spent_usd: 0, held_usd: 0.0538, call_usd: 0.0538 }, (_k, id) => (id === 'a_c' ? 'Checker' : id)))
      .toBe('No room under mind Checker in total: $0 spent and $0.05 held for calls not yet settled, of $0.10, and its next call could cost up to $0.05.')
  })
})

describe('exact amounts', () => {
  it('never rounds a money decision to cents', async () => {
    const { exactUsd } = await import('./settle')
    expect(exactUsd(0.4875)).toBe('$0.4875')
    expect(exactUsd(0.0021)).toBe('$0.0021')
    expect(exactUsd(3)).toBe('$3.00')
  })
})

describe('how and when a held call settles itself (outstanding: settles and the timing fields)', async () => {
  const { span } = await import('./settle')
  const now = 1_800_000_000_000
  const t = now / 1000
  it('without the timing fields names the rule and shows no age', () => {
    expect(settlesWords(row('a', 'unknown'), now)).toBe('settles at its worst case an hour after its outcome went unknown: an upper bound that’s usually lower, which you can correct afterwards')
    expect(heldFor(row('a', 'unknown'), now)).toBeNull()
  })
  it('an OpenRouter call settles from its record, with the expiry as the backstop', () => {
    const r: CostReservation = { ...row('r', 'unknown'), settles: 'record', unknown_at: t - 18 * 60, auto_settles_at: t + 42 * 60 }
    expect(settlesWords(r, now)).toBe('settles from OpenRouter’s record of it, or at its worst case in 42 minutes if no record comes')
    expect(settlesWords({ ...r, held_usd: 0.000001 }, now)).toBe('settles from OpenRouter’s record of it, or at $0, the free model’s price, in 42 minutes if no record comes')
  })
  it('any other unknown call settles at its worst case, an upper bound that’s usually lower, a free model’s at $0', () => {
    const r: CostReservation = { ...row('a', 'unknown'), dispatched_at: t - 2 * 60 - 120, unknown_at: t - 2 * 60, auto_settles_at: t + 58 * 60 }
    expect(settlesWords(r, now)).toBe('settles at its worst case in 58 minutes: an upper bound that’s usually lower, which you can correct afterwards')
    expect(settlesWords({ ...r, auto_settles_at: t + 50 }, now)).toMatch(/^settles at its worst case in under a minute:/)
    expect(settlesWords({ ...r, auto_settles_at: t - 10 }, now)).toMatch(/^settles at its worst case on the hive’s next pass:/)
    expect(settlesWords({ ...r, held_usd: 0.000001 }, now)).toBe('settles at $0, the free model’s price, in 58 minutes')
    expect([isFreeFloor(0.000001), isFreeFloor(0.000002), isFreeFloor(0)]).toEqual([true, false, true])
    expect(heldFor(r, now)).toBe('outcome unknown for 2m (sent 4m ago)')
  })
  it('a call in flight settles when it answers, and says how long it has been out', () => {
    expect(settlesWords({ ...row('b', 'dispatched'), dispatched_at: t - 42 * 60 }, now)).toBe('settles when the call answers')
    expect(heldFor({ ...row('b', 'dispatched'), dispatched_at: t - 42 * 60 }, now)).toBe('in flight for 42m')
    expect(heldFor({ ...row('c', 'reserved'), dispatched_at: null }, now)).toBe('reserved, not sent yet')
    expect(span(30)).toBe('under a minute')
    expect(span(3 * 86400 + 3600)).toBe('3d 1h')
    expect([inWords(30), inWords(60), inWords(58 * 60 + 59), inWords(3 * 3600)]).toEqual(['under a minute', '1 minute', '58 minutes', '3h'])
  })
})


describe('estimates: calls the hive settled at their worst case, which a person corrects for 30 days', () => {
  const now = 1_800_000_000_000
  const t = now / 1000
  const est = (id: string, estimate_usd: number, settled_ago = 3 * 3600, agent?: string, model?: string): EstimatedCall => ({
    id, estimate_usd, settled_at: t - settled_ago, correctable_until: t - settled_ago + 30 * 86_400, metadata: { agent, model }, observation: { cause: 'No answer from Anthropic before the hive stopped waiting.' }, scopes: ['hive:month'],
  })

  it('says an estimate is an upper bound that’s usually lower, and how long it may still be corrected', () => {
    expect(ESTIMATE_WORDS).toMatch(/worst case/)
    expect(ESTIMATE_WORDS).toMatch(/an upper bound that’s usually lower/)
    expect(estimateTiming(est('a', 0.05), now)).toBe('settled at its worst case 3h ago · correct within 29 days')
    expect(estimateTiming(est('b', 0.05, 29 * 86_400 + 3600), now)).toBe('settled at its worst case 29d 1h ago · correct within 23h')
    expect(estimateTiming(est('c', 0.05, 30 * 86_400 + 1), now)).toMatch(/too late to correct$/)
    expect([canCorrect(est('a', 0.05), now), canCorrect(est('c', 0.05, 30 * 86_400 + 1), now)]).toEqual([true, false])
  })

  it('says a free model’s estimate is its price, $0, never a worst case', () => {
    expect(estimateWords(est('f', 0))).toMatch(/^Settled at \$0, the free model’s price/)
    expect(estimateWords(est('a', 0.05))).toBe(ESTIMATE_WORDS)
    expect(estimateTiming(est('f', 0), now)).toBe('settled at $0 3h ago · correct within 29 days')
  })

  it('totals estimates in micro-dollars and groups them by mind and model', () => {
    const rows = Array.from({ length: 46 }, (_, i) => est(`e${i}`, 0.05, 3600 * (i + 1), i % 2 ? 'a_x' : 'a_y', 'm/one'))
    const s = estimateSummary(rows)
    expect([s.count, s.usd]).toEqual([46, 2.3])
    expect(s.groups.map((g) => [g.agent, g.count])).toEqual([['a_y', 23], ['a_x', 23]])
    expect(s.reasons).toEqual([{ reason: 'No answer from Anthropic before the hive stopped waiting.', count: 46 }])
  })

  it('binds Correct all to the estimates the person saw: closed once one is corrected or past its 30 days', () => {
    const seen = [est('a', 0.05), est('b', 0.04)]
    expect(bindEstimates(seen, [...seen, est('new', 0.05)], now)).toEqual({ kind: 'ready' })
    expect(bindEstimates(seen, [seen[0]], now)).toMatchObject({ kind: 'closed', why: expect.stringMatching(/^One of these calls was corrected since this opened/) })
    expect(bindEstimates(seen, [seen[0], { ...seen[1], correctable_until: t - 1 }], now)).toMatchObject({ kind: 'closed' })
    expect(bindEstimates(seen, [seen[0], { ...seen[1], estimate_usd: 0.06 }], now)).toEqual({ kind: 'changed', fields: ['1 call'] })
    expect(bindEstimates(seen, undefined, now)).toEqual({ kind: 'gone' })
  })
})

describe('Correct all: one decision over every estimate', () => {
  const t = 1_800_000_000
  const est = (id: string, estimate_usd: number, agent?: string, model?: string, observation: EstimatedCall['observation'] = null): EstimatedCall => ({
    id, estimate_usd, settled_at: t - 3600, correctable_until: t - 3600 + 30 * 86_400, metadata: { agent, model }, observation, scopes: [],
  })
  it('totals in micro-dollars, so 52 estimates of $0.05 are exactly $2.60, and groups by mind and model, largest first, ties as listed', () => {
    const rows = Array.from({ length: 52 }, (_, i) => est(`c${i}`, 0.05, i % 4 ? 'a_x' : 'a_y', i % 2 ? 'm/one' : 'm/two'))
    const s = estimateSummary(rows)
    expect(s.count).toBe(52)
    expect(s.usd).toBe(2.6)
    expect(s.groups.map((g) => [g.agent, g.model, g.count, g.usd])).toEqual([
      ['a_x', 'm/one', 26, 1.3],
      ['a_y', 'm/two', 13, 0.65],
      ['a_x', 'm/two', 13, 0.65],
    ])
    expect(estimateSummary([est('n', 0.1)]).groups).toEqual([{ agent: undefined, model: undefined, count: 1, usd: 0.1 }])
    expect(estimateSummary([])).toEqual({ count: 0, usd: 0, groups: [], reasons: [] })
  })
  it('counts why the calls were held, the most common first', () => {
    const refused = { cause: 'Anthropic refused the request (billing, 402).' }
    const s = estimateSummary([est('a', 0.05, undefined, undefined, refused), est('b', 0.05), est('c', 0.05, undefined, undefined, refused)])
    expect(s.reasons).toEqual([
      { reason: 'Anthropic refused the request (billing, 402).', count: 2 },
      { reason: 'the provider never reported usage', count: 1 },
    ])
  })
})


describe('why a call is held (gateway.held_cause, recorded with the hold)', () => {
  const held = (id: string, observation: CostReservation['observation']): CostReservation => ({ ...row(id, 'unknown'), observation })
  it('reads the recorded cause, else what the usage record says, else that the provider never reported usage', () => {
    expect(heldReason(held('a', { cause: 'OpenAI refused the request (rate_limited, 429).', usage_origin: 'usage-unverified' }))).toBe('OpenAI refused the request (rate_limited, 429).')
    expect(heldReason(held('b', { usage_origin: 'usage-unverified' }))).toBe('usage-unverified')
    expect(heldReason(held('c', null))).toBe('the provider never reported usage')
  })
})
