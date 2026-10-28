import type { Approval, PolicyScope } from '../../api/types'

/** The decision row, left to right, at every breakpoint. Approve sits last, where the eye ends. */
export const DECISION_ORDER = ['deny', 'approve'] as const

/** The exact rule that "Create a rule…" would save. Mirrors hive/core/policy.py decide_approval(remember=True). */
export interface RulePreview {
  scope: PolicyScope
  skill: string
  mode: 'allow'
}

export type RuleOffer = { kind: 'offer'; rule: RulePreview } | { kind: 'withheld'; reason: string }

export const HIGH_RISK_ONE_AT_A_TIME = 'High-risk actions are approved one at a time'
export const APP_ACTIONS_EXACT = 'App actions are approved one exact request at a time'

/**
 * Whether a standing rule may be offered from this request, and if so exactly which one.
 * Never for high risk; never for app actions (the hive refuses those as exact_only).
 */
export function ruleOffer(a: Pick<Approval, 'agent_id' | 'skill' | 'risk'>): RuleOffer {
  if (a.risk === 'high') return { kind: 'withheld', reason: HIGH_RISK_ONE_AT_A_TIME }
  if (a.skill.startsWith('program:')) return { kind: 'withheld', reason: APP_ACTIONS_EXACT }
  return { kind: 'offer', rule: { scope: `agent:${a.agent_id}`, skill: a.skill, mode: 'allow' } }
}
