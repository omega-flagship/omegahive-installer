// Purpose: test that the hive cap is the hive's month rule, else its day rule, as the hive reads it, and that a hive whose
// only hive rule is a total has none.
import { describe, expect, it } from 'vitest'
import { hiveCap } from './hiveCap'
import type { BudgetRow } from './limitsView'

const rule = (scope: string, period: BudgetRow['period']): BudgetRow =>
  ({ id: `${scope}:${period}`, scope, period, limit_usd: 10, spent_usd: 0, note: '', origin: 'rule' })

describe('the hive cap', () => {
  it('is the hive month rule, else the hive day rule', () => {
    expect(hiveCap([rule('hive', 'day'), rule('hive', 'month')])?.period).toBe('month')
    expect(hiveCap([rule('swarm:s_1', 'month'), rule('hive', 'day')])?.period).toBe('day')
  })

  it('is none for a hive whose only hive rule is a total, or that has no hive rule', () => {
    expect(hiveCap([rule('hive', 'total')])).toBeNull()
    expect(hiveCap([rule('person:u_1', 'month'), rule('agent:a_1', 'month')])).toBeNull()
    expect(hiveCap([])).toBeNull()
  })
})
