import type { Goal } from '../../api/types'
import type { IconName } from '../../ui/Icon'

/**
 * The status actions on a Goals-board card (Surface request H, G2; Review D1). Every one of them (Done, Failed,
 * Cancel and Re-open) is a terminal or re-open change, so every one is a decision: the board opens the shared
 * DecisionDialog (experiences/GoalDecision) on the goal as seen, stamped with the session it was shown under. There is
 * no one-click status change on the card (Platform ruling, D1). The hive still decides every change
 * (hive/core/goals.py); this is only what the card offers.
 */
export interface CardAction {
  to: Goal['status']
  label: string
  icon: IconName
  color: string
}

export function cardActions(g: Pick<Goal, 'status'>): CardAction[] {
  const s = g.status
  if (s === 'open' || s === 'claimed' || s === 'waiting' || s === 'stalled')
    return [
      ...(s === 'stalled' ? [{ to: 'open' as const, label: 'Re-open', icon: 'reset' as const, color: '#a5b4fc' }] : []),
      { to: 'done', label: s === 'waiting' ? 'Accept · done' : 'Done', icon: 'check', color: 'var(--color-good)' },
      { to: 'failed', label: 'Failed', icon: 'x', color: 'var(--color-bad)' },
      { to: 'cancelled', label: 'Cancel', icon: 'ban', color: 'var(--color-ink-3)' },
    ]
  if (s === 'done' || s === 'failed' || s === 'cancelled') return [{ to: 'open', label: 'Reopen', icon: 'reset', color: '#a5b4fc' }]
  return []
}

/**
 * What the board opens GoalDecision with: the goal exactly as the card showed it, the change asked for, and the store
 * session the card was rendered under (a change asked under an earlier session is refused, by the binding and by the
 * store at dispatch).
 */
export interface CardAsk {
  seen: Goal
  to: Goal['status']
  session: string
}
export const cardAsk = (g: Goal, to: Goal['status'], session: string): CardAsk => ({ seen: { ...g }, to, session })

/** The dialog's close button: "Cancel" could be read as cancelling the goal, so it says what dismissing does. */
export const KEEP_THE_GOAL = 'Keep the task'
