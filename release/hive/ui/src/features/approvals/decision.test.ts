import { describe, expect, it } from 'vitest'
import { APP_ACTIONS_EXACT, DECISION_ORDER, HIGH_RISK_ONE_AT_A_TIME, ruleOffer } from './decision'

describe('approval decisions', () => {
  it('puts Deny before Approve, with no third neighbouring button', () => {
    expect(DECISION_ORDER).toEqual(['deny', 'approve'])
  })

  it('previews the exact rule it would save: this mind only, this exact skill, allow', () => {
    expect(ruleOffer({ agent_id: 'a_vega', skill: 'shell', risk: 'medium' })).toEqual({
      kind: 'offer',
      rule: { scope: 'agent:a_vega', skill: 'shell', mode: 'allow' },
    })
    expect(ruleOffer({ agent_id: 'a_1', skill: 'write-file', risk: 'low' })).toMatchObject({ kind: 'offer' })
  })

  it('never offers a rule for high-risk requests', () => {
    expect(ruleOffer({ agent_id: 'a_vega', skill: 'shell', risk: 'high' })).toEqual({ kind: 'withheld', reason: HIGH_RISK_ONE_AT_A_TIME })
    expect(HIGH_RISK_ONE_AT_A_TIME).toBe('High-risk actions are approved one at a time')
  })

  it('never offers a rule for app actions, which the hive refuses to remember', () => {
    expect(ruleOffer({ agent_id: 'a_vega', skill: 'program:notes.correct', risk: 'medium' })).toEqual({ kind: 'withheld', reason: APP_ACTIONS_EXACT })
  })
})
