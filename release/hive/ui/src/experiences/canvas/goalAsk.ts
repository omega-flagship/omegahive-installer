import type { Goal } from '../sdk'

/**
 * Review D1 on Canvas: a goal's done, cancel, re-open or release is decided in the shared GoalDecision (full context,
 * heading focus, arming, held-key and drift refusal), never written by one tap on the selection bar or the outline.
 * The ask carries the goal as the person saw it and the store session it was read under (Surface R): the change goes
 * only in that session.
 */
export interface GoalAsk {
  seen: Goal
  to: Goal['status']
  session: string
}

export interface GoalBarAction {
  label: 'Mark done' | 'Reopen' | 'Release' | 'Cancel'
  to: Goal['status']
  strong?: boolean
}

export const isClosedGoal = (status: Goal['status']) => status === 'done' || status === 'cancelled' || status === 'failed'

/**
 * The selection bar's status actions for a goal. Every one of them changes status, so every one opens GoalDecision:
 * Release (a stalled or waiting goal back to open) drops its holder and lapsed claims exactly like a re-open, so it is
 * the same decision, named as the bar names it.
 */
export function goalBarActions(status: Goal['status']): GoalBarAction[] {
  const closed = isClosedGoal(status)
  const out: GoalBarAction[] = []
  if (!closed) out.push({ label: 'Mark done', to: 'done', strong: true })
  if (closed) out.push({ label: 'Reopen', to: 'open', strong: true })
  if (status === 'stalled' || status === 'waiting') out.push({ label: 'Release', to: 'open' })
  if (!closed) out.push({ label: 'Cancel', to: 'cancelled' })
  return out
}

/** The ask for one action, stamped with the session the goal was shown under. */
export const goalAsk = (seen: Goal, to: Goal['status'], session: string): GoalAsk => ({ seen, to, session })
