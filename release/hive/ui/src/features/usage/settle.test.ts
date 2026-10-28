import { describe, expect, it } from 'vitest'
import type { CostReservation } from '../../api/moneyWork'
import { overrunUsd, parseUsd, releaseBlocked, scopeWords, settleBlocked, splitReservations } from './settle'

const row = (id: string, state: CostReservation['state']): CostReservation => ({ id, state, held_usd: 0.1, scopes: [], metadata: {}, observation: null })

describe('settling unknown-cost calls', () => {
  it('reads dollar amounts strictly', () => {
    expect(parseUsd('0.31')).toBe(0.31)
    expect(parseUsd('$1,204.5')).toBe(1204.5)
    expect(parseUsd('.5')).toBe(0.5)
    expect(parseUsd('0')).toBe(0)
    for (const bad of ['', '-1', 'abc', '1e3', '0.1234567', 'NaN', '1.2.3']) expect(parseUsd(bad)).toBeNull()
  })

  it('needs the real cost and a reason to settle, a reason to release', () => {
    expect(settleBlocked('', 'x')).toMatch(/real cost/)
    expect(settleBlocked('abc', 'x')).toMatch(/amount/)
    expect(settleBlocked('0.2', '  ')).toMatch(/reason/)
    expect(settleBlocked('0.2', 'billing says 0.2')).toBeNull()
    expect(releaseBlocked('')).toMatch(/reason/)
    expect(releaseBlocked('provider refunded')).toBeNull()
  })

  it('only unknown-outcome calls are to settle', () => {
    const s = splitReservations([row('a', 'unknown'), row('b', 'dispatched'), row('c', 'reserved')])
    expect(s.toSettle.map((r) => r.id)).toEqual(['a'])
    expect(s.inFlight.map((r) => r.id)).toEqual(['b', 'c'])
  })

  it('names scopes in words and converts overruns from micro-dollars', () => {
    expect(scopeWords('agent:a_x:total', (_k, id) => (id === 'a_x' ? 'Vega' : id))).toBe('mind Vega in total')
    expect(scopeWords('swarm:s_y:month')).toBe('swarm s_y this month')
    expect(scopeWords('hive:hard-total')).toBe('the whole hive’s hard cap')
    expect(overrunUsd({ reservation: 'r', agent: null, maximum: 120_000, actual: 163_400, source: 'settle', at: 0 })).toEqual({ held: 0.12, actual: 0.1634, over: 0.0434 })
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

describe('timing and resolvable (Platform’s coming fields; audit row 20)', async () => {
  const { canSettle, heldTiming, span } = await import('./settle')
  const now = 1_800_000_000_000
  const t = now / 1000
  it('absent fields: today’s rule (only unknown), and no timing is shown', () => {
    expect(canSettle(row('a', 'unknown'))).toBe(true)
    expect(canSettle(row('b', 'dispatched'))).toBe(false)
    expect(heldTiming(row('a', 'unknown'), now)).toEqual({ held: null, autoSettle: null, stuck: false })
  })
  it('the hive’s resolvable wins either way', () => {
    expect(canSettle({ ...row('b', 'dispatched'), resolvable: true })).toBe(true)
    expect(canSettle({ ...row('a', 'unknown'), resolvable: false })).toBe(false)
    expect(splitReservations([{ ...row('b', 'dispatched'), resolvable: true }]).toSettle).toHaveLength(1)
  })
  it('says how long it has been held and when it auto-settles, from the fields only', () => {
    const r = { ...row('a', 'unknown'), dispatched_at: t - 5 * 3600 - 120, unknown_at: t - 5 * 3600, auto_settles_at: t + 19 * 3600, resolvable: true }
    const x = heldTiming(r, now)
    expect(x.held).toBe('outcome unknown for 5h (sent 5h 2m ago)')
    expect(x.autoSettle).toBe('if nobody settles it, the hive settles it at the held amount in 19h')
    expect(heldTiming({ ...r, auto_settles_at: t - 10 }, now).autoSettle).toMatch(/next pass/)
    expect(heldTiming({ ...row('b', 'dispatched'), dispatched_at: t - 42 * 60, resolvable: true }, now)).toEqual({ held: 'in flight for 42m', autoSettle: null, stuck: true })
    expect(heldTiming({ ...row('c', 'reserved'), dispatched_at: null }, now).held).toBe('reserved, not sent yet')
    expect(span(30)).toBe('under a minute')
    expect(span(3 * 86400 + 3600)).toBe('3d 1h')
  })
})
