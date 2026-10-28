import type { Agent, BudgetRefusal, Usage } from '../../api/types'
import { money } from '../../lib/format'

/**
 * Health's sleep and spend picture (demo D3), from what every hive already reports: each mind's status, its idle rule
 * (`idle_sleep_minutes`: the hive puts an awake mind to sleep after that many quiet minutes; 0 never), its budget and
 * what it has spent, the refusals the hive announced (`budget.refused`) and the recent billed calls (`usage`). Pure.
 */

export type Rest = 'awake' | 'asleep' | 'other'
export const restOf = (s: Agent['status']): Rest => (s === 'awake' || s === 'starting' ? 'awake' : s === 'asleep' ? 'asleep' : 'other')

const minutes = (m: number) => (m >= 120 && m % 60 === 0 ? `${m / 60} hours` : m === 60 ? 'an hour' : `${Math.round(m)} minute${Math.round(m) === 1 ? '' : 's'}`)

/** The hive's sleep rule for this mind, in plain words. */
export function sleepRule(a: Pick<Agent, 'idle_sleep_minutes'>): string {
  const m = a.idle_sleep_minutes ?? 0
  return m > 0 ? `Goes to sleep after ${minutes(m)} with nothing to do` : 'Stays awake until someone puts it to sleep'
}

/** Why the hive refuses a mind's model calls, in plain words (the same wording as the mind's own notice). */
export const REFUSAL_WHY: Record<string, string> = {
  no_budget: 'It runs a paid model with no budget, so every model call is refused.',
  budget_exhausted: 'It has used its own budget; the next model call would pass the cap.',
  spend_limit: 'A spending limit (for the mind, its swarm, its key or the hive) has no room for the next call.',
  hive_budget_exhausted: 'The whole hive has reached its spending cap. Every paid mind is paused until it is raised.',
}

/** A mind that has reached its own spend cap (spent at or past a budget above zero). */
export const atCap = (a: Pick<Agent, 'budget_usd' | 'spent_usd'>) => a.budget_usd > 0 && a.spent_usd >= a.budget_usd

/** The plain sentence for a mind at its spend cap: what happened, what the hive does about it, and the count. */
export function capSentence(a: Pick<Agent, 'name' | 'budget_usd' | 'spent_usd' | 'status'>, refusal?: BudgetRefusal | null): string {
  const calls = refusal && refusal.count > 0 ? ` ${refusal.count} call${refusal.count === 1 ? '' : 's'} refused so far.` : ''
  const rest = a.status === 'asleep' ? ' It is asleep until someone raises the cap.' : ' Its next model call will be refused.'
  return `${a.name} has used all of its ${money(a.budget_usd)} budget (${money(a.spent_usd)} spent), so the hive refuses its model calls.${rest}${calls}`
}

export interface SpendPicture {
  /** what every listed mind has spent in total */
  total: number
  /** billed calls this page has seen in the last 24 hours (the hive's recent usage) */
  day: number
  dayCalls: number
  /** the biggest spenders, with their caps (0: no cap) */
  top: { id: string; name: string; spent: number; budget: number }[]
  capped: number
}

export function spendPicture(agents: Agent[], usage: Usage[], now = Date.now()): SpendPicture {
  const since = now - 86_400_000
  const recent = usage.filter((u) => Date.parse(u.created_at) >= since)
  return {
    total: agents.reduce((t, a) => t + (a.spent_usd || 0), 0),
    day: recent.reduce((t, u) => t + (u.cost_usd || 0), 0),
    dayCalls: recent.length,
    top: [...agents].filter((a) => a.spent_usd > 0).sort((x, y) => y.spent_usd - x.spent_usd).slice(0, 4).map((a) => ({ id: a.id, name: a.name, spent: a.spent_usd, budget: a.budget_usd })),
    capped: agents.filter(atCap).length,
  }
}

/** The refusals the hive announced, newest first, each with its mind. */
export function recentRefusals(refusals: Record<string, BudgetRefusal>, agents: Record<string, Agent>): { agent: Agent; refusal: BudgetRefusal; why: string }[] {
  return Object.entries(refusals)
    .filter(([id]) => agents[id])
    .map(([id, refusal]) => ({ agent: agents[id], refusal, why: REFUSAL_WHY[refusal.code] ?? 'The hive refused its model calls for spending.' }))
    .sort((x, y) => y.refusal.at.localeCompare(x.refusal.at))
}
