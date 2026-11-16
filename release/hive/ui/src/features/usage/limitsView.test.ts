// Purpose: tests of the Limits view reader: the hive's three parts read whole, and any answer of another shape refused rather than drawn as no limits.
import { describe, expect, it } from 'vitest'
import { SimClient } from '../../api/sim/SimClient'
import { readLimitsView } from './limitsView'

const sim = () => new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })

describe('readLimitsView', () => {
  it('reads the hive cap, every person and every cap set, each stored rule once', async () => {
    const c = sim()
    const view = readLimitsView(await c.budgetLimitsView())!
    expect(view.hive.cap).toMatchObject({ key: 'hive:month', limit_usd: 1200, source: 'set' })
    expect(view.people.find((p) => p.person_id === 'p_tomas')).toMatchObject({ source: 'member-default', allowance: { limit_usd: 50, spent_usd: 12.4, room_usd: 37.6 } })
    expect(view.people.find((p) => p.person_id === 'p_ada')).toMatchObject({ source: 'none', allowance: null })
    expect(view.people.some((p) => p.person_id === 'p_kofi')).toBe(false)          // disabled: no row
    expect(view.caps.map((r) => r.key).sort()).toEqual(['agent:a_deneb2:day', 'swarm:s_forge:month', 'swarm:s_kelp:month'])
    const stored = (await c.listBudgets()).map((b) => b.id).sort()
    const shown = [view.hive.cap!.rule_id, ...view.caps.map((r) => r.rule_id)].sort()
    expect(shown).toEqual(stored)
    expect(view.old_defaults).toEqual([
      expect.objectContaining({ kind: 'mind', id: 'a_qnch11', reset: { kind: 'mind', agent_id: 'a_qnch11' } }),
      expect.objectContaining({ kind: 'mind', id: 'a_wisp12', reset: { kind: 'mind', agent_id: 'a_wisp12' } }),
      expect.objectContaining({ kind: 'swarm', id: 's_kelp', reset: { kind: 'rule', rule_id: expect.any(String) } }),
    ])
  })

  it('refuses an answer of another shape instead of reading it as no limits', async () => {
    const good = (await sim().budgetLimitsView()) as Record<string, unknown>
    expect(readLimitsView(null)).toBeNull()
    expect(readLimitsView({ ...good, people: 'everyone' })).toBeNull()
    expect(readLimitsView({ ...good, caps: [{ key: 'swarm:s:month' }] })).toBeNull()
    expect(readLimitsView({ ...good, hive: { cap: { key: 'hive:month', limit_usd: -1 } } })).toBeNull()
    expect(readLimitsView({ ...good, hive: { cap: null, all_time: null, month_spent_usd: 0, pace_usd_per_day: 0 } })!.hive.cap).toBeNull()
  })
})
