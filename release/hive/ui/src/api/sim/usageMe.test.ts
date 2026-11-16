// Purpose: the simulator answers GET /api/usage/me as Hive.my_spend does, for the operator, an admin and a member, and agrees with its own Limits view, so the battery meter and Your spend show on the demo. INVENTED DATA only.
import { describe, expect, it } from 'vitest'
import { SimClient } from './SimClient'

const sim = () => new SimClient({ seed: 3, latency: false, autoStart: false, historyDays: 3 })

describe("the simulator's own spend for the signed-in person", () => {
  it('gives the operator and an admin without a rule no allowance, and a member the default one', async () => {
    const c = sim()
    expect(await c.usageMe()).toMatchObject({ principal: 'user:operator', allowance_usd: null, allowance_origin: null, remaining_usd: null, held_usd: 0 })
    c.simSignInAs('person')
    expect(await c.usageMe()).toMatchObject({ principal: 'user:p_ada', allowance_usd: null, allowance_origin: null })
    c.simSignInAs('member')
    const rowan = await c.usageMe()
    expect(rowan).toMatchObject({ principal: 'user:p_rowan', allowance_usd: 50, allowance_origin: 'member-default', own_keys: 0, by_mind: [] })
    expect(rowan.remaining_usd).toBeCloseTo(50 - rowan.hive_paid_usd, 6)
  })

  it("follows a person's own month rule and agrees with the Limits view's row for them", async () => {
    const c = sim()
    c.simSignInAs('person')
    await c.setBudget({ scope: 'person:p_ada', period: 'month', limit_usd: 20 })
    const ada = await c.usageMe()
    expect(ada).toMatchObject({ allowance_usd: 20, allowance_origin: 'rule' })
    const view = (await c.budgetLimitsView()) as { people: { person_id: string; allowance: { limit_usd: number; spent_usd: number; held_usd: number } | null }[] }
    const row = view.people.find((p) => p.person_id === 'p_ada')!.allowance!
    expect([ada.allowance_usd, ada.hive_paid_usd, ada.held_usd]).toEqual([row.limit_usd, row.spent_usd, row.held_usd])
  })
})
