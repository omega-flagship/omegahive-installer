import { describe, expect, it } from 'vitest'
import type { Agent, Usage } from '../../api/types'
import { atCap, capSentence, recentRefusals, restOf, sleepRule, spendPicture } from './sleepSpend'

const mind = (over: Partial<Agent>): Agent => ({ id: 'a1', name: 'Pebble', kind: 'omega', swarm_id: 's1', model: 'm', persona: '', hue: 1, status: 'awake', driver: 'local', budget_usd: 5, spent_usd: 1, connected: true, last_active_at: null, created_at: '2026-10-01T00:00:00Z', ...over })

describe('Health: sleep and spend, in plain words', () => {
  it('names the hive’s sleep rule', () => {
    expect(sleepRule({ idle_sleep_minutes: 15 })).toBe('Goes to sleep after 15 minutes with nothing to do')
    expect(sleepRule({ idle_sleep_minutes: 60 })).toBe('Goes to sleep after an hour with nothing to do')
    expect(sleepRule({ idle_sleep_minutes: 120 })).toBe('Goes to sleep after 2 hours with nothing to do')
    expect(sleepRule({ idle_sleep_minutes: 0 })).toBe('Stays awake until someone puts it to sleep')
    expect(sleepRule({})).toBe('Stays awake until someone puts it to sleep')
    expect([restOf('starting'), restOf('asleep'), restOf('stopped')]).toEqual(['awake', 'asleep', 'other'])
  })

  it('a mind at its cap: what happened, what the hive does, and how many calls it refused', () => {
    const q = mind({ name: 'Quench', budget_usd: 10, spent_usd: 10, status: 'asleep' })
    expect(atCap(q)).toBe(true)
    expect(atCap(mind({ budget_usd: 0, spent_usd: 4 }))).toBe(false)   // no cap is not a cap
    expect(capSentence(q, { code: 'budget_exhausted', count: 3, at: '2026-10-09T10:00:00Z' })).toBe(
      'Quench has used all of its $10 budget ($10 spent), so the hive refuses its model calls. It is asleep until someone raises the cap. 3 calls refused so far.',
    )
    expect(capSentence({ ...q, status: 'awake' })).toBe('Quench has used all of its $10 budget ($10 spent), so the hive refuses its model calls. Its next model call will be refused.')
  })

  it('the spend picture: in all, the last day, and the biggest spenders with their caps', () => {
    const now = Date.parse('2026-10-09T12:00:00Z')
    const use = (cost: number, hoursAgo: number): Usage => ({ agent_id: 'a1', model: 'm', prompt_tokens: 1, completion_tokens: 1, cost_usd: cost, created_at: new Date(now - hoursAgo * 3_600_000).toISOString() })
    const p = spendPicture([mind({ id: 'a1', spent_usd: 3 }), mind({ id: 'a2', name: 'Shingle', spent_usd: 7, budget_usd: 7 }), mind({ id: 'a3', spent_usd: 0 })], [use(0.5, 2), use(0.25, 30)], now)
    expect(p).toMatchObject({ total: 10, day: 0.5, dayCalls: 1, capped: 1 })
    expect(p.top.map((t) => t.id)).toEqual(['a2', 'a1'])
  })

  it('refusals newest first, each with its plain reason; unknown minds are left out', () => {
    const agents = { a1: mind({ id: 'a1' }), a2: mind({ id: 'a2', name: 'Shingle' }) }
    const out = recentRefusals({ a1: { code: 'no_budget', count: 1, at: '2026-10-09T10:00:00Z' }, a2: { code: 'budget_exhausted', count: 4, at: '2026-10-09T11:00:00Z' }, gone: { code: 'x', count: 1, at: '2026-10-09T12:00:00Z' } }, agents)
    expect(out.map((r) => r.agent.id)).toEqual(['a2', 'a1'])
    expect(out[1].why).toBe('It runs a paid model with no budget, so every model call is refused.')
  })
})
