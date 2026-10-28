import type { Me } from '../api/client'
import type { Agent, Goal } from '../api/types'
import { shown } from './displayName'

/**
 * R17 review state of a goal, in words, from what the hive sent. `review_by` (who must accept the result) is on list
 * rows only once Platform adds it (on live 0aa6330 only GET /api/goals/{id} has it): without it the board says
 * "by a person", exactly as before, and never claims who may review.
 */
export function reviewerWords(reviewBy: string | undefined, mindName: (id: string) => string | undefined = () => undefined): string {
  if (reviewBy === undefined || reviewBy === 'person') return 'a person'
  if (reviewBy === 'none') return 'nobody (this task takes no review)'
  if (reviewBy === 'requester') return 'a mind of the requesting swarm'
  if (reviewBy.startsWith('agent:')) return `${mindName(reviewBy.slice(6)) ?? reviewBy.slice(6)} (a mind)`
  if (reviewBy.startsWith('mandate:')) return `a mind holding the ${reviewBy.slice(8)} mandate`
  return reviewBy
}

/**
 * Whether this viewer may accept or return the goal, as the hive decides it (app.py review_goal + goals.may_review):
 * only a named signed-in person (never the hive password); an admin person for any reviewed goal; a member only when
 * review_by is "person". `may: null` means the hive has not said enough to know (review_by absent): no claim is made.
 */
export function mayReview(g: Pick<Goal, 'review_by'>, me: Pick<Me, 'kind' | 'role' | 'principal'> | undefined): { may: boolean | null; why: string } {
  if (!me) return { may: null, why: '' }
  if (me.kind !== 'sso' || me.principal === 'user:operator') return { may: false, why: 'Only a named signed-in person reviews work; the hive password cannot.' }
  if (g.review_by === undefined) return { may: null, why: '' }
  if (g.review_by === 'none') return { may: false, why: 'This task takes no review.' }
  if (me.role === 'admin') return { may: true, why: 'You may review it (an admin).' }
  if (g.review_by === 'person') return { may: true, why: 'You may review it.' }
  return { may: false, why: `Reviewed by ${reviewerWords(g.review_by)}, not by you.` }
}

/** "Reviewed by X, 2h ago" for a done goal, from reviewed_by/reviewed_at already on list rows; null when not reviewed. */
export function reviewedLine(g: Pick<Goal, 'reviewed_by' | 'reviewed_at'>, who: (principal: string) => string = (p) => p): string | null {
  if (!g.reviewed_by) return null
  return `Reviewed by ${who(g.reviewed_by)}`
}

/** Why a review cannot be sent yet: a return needs notes (the hive refuses one without). */
export function reviewBlocked(decision: 'accept' | 'return', notes: string): string | null {
  return decision === 'return' && !notes.trim() ? 'Say what should change: the mind gets these notes.' : null
}

/** A principal in words: a mind's name for agent:<id> (or a bare mind id), the operator, or the person's id. */
export function principalWords(p: string, agents: Record<string, Agent>): string {
  const id = p.startsWith('agent:') ? p.slice(6) : !p.includes(':') ? p : null
  if (id !== null) return agents[id] ? shown(agents[id].name) : id
  return p === 'user:operator' ? 'the operator' : p.replace(/^user:/, '')
}
