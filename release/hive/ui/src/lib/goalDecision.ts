import type { Goal } from '../api/types'
import { NOT_CONFIRMED, useHive, type GoalWrite } from '../store/store'
import { accepts, bindTo, boundNote, type Bound, type DecisionResult } from './decisionGate'

/**
 * Review D1: a goal's terminal or re-open change (done, failed, cancel, reopen) is a decision, taken only on the
 * exact goal the person inspected. Every experience binds the same snapshot and refuses the same drift:
 *  - Flux and Cosmos open the shared DecisionDialog (ui/DecisionDialog) with these facts and this binding;
 *  - Construct's `goal done|failed|cancel|reopen` and Still's inline confirm recheck it before dispatch.
 * The hive still decides (hive/core/goals.py update); this is what the person saw, not authority.
 */

export type GoalVerb = 'done' | 'failed' | 'cancel' | 'reopen'
export const GOAL_TO: Record<GoalVerb, Goal['status']> = { done: 'done', failed: 'failed', cancel: 'cancelled', reopen: 'open' }
export const verbFor = (to: Goal['status']): GoalVerb | null => (to === 'done' ? 'done' : to === 'failed' ? 'failed' : to === 'cancelled' ? 'cancel' : to === 'open' ? 'reopen' : null)

/** What the person inspected: named as they read it (these names appear in "changed while it was open (…)"). */
export interface GoalSeen {
  title: string
  status: Goal['status']
  holder: string | null
  swarm: string
  version: string
  /** Surface R (O-B1): the store session the goal was read under; the change goes only in that session. */
  session: string
}
export const GOAL_SEEN_FIELDS = ['title', 'status', 'holder', 'swarm', 'version'] as const satisfies readonly (keyof GoalSeen)[]

export const seenOf = (g: Goal): GoalSeen => ({ title: g.title, status: g.status, holder: g.claimed_by ?? null, swarm: g.swarm_id, version: g.updated_at, session: useHive.getState().session })

/** Why a goal whose last change got no answer (store goalsUnsure) takes no decision until it is read again. */
export const GOAL_UNCHECKED = 'An earlier change to this task got no answer, so whether it happened is not confirmed. Check the task again first.'

/**
 * Is the goal still the one that was inspected, and can it still take this change? `ready`, `gone`, `closed` (it is
 * already where the change would put it) or `changed` (status, holder, swarm, title or version moved).
 */
export function goalBound(seen: GoalSeen, live: Goal | undefined, to: Goal['status']): Bound {
  // read under an earlier connection: whatever now has this id is not what was inspected
  if (seen.session !== useHive.getState().session) return { kind: 'closed', why: 'This task was opened under an earlier connection to the hive.' }
  // Review B1 (next22): an earlier change to it got no answer and has not been checked yet; nothing more goes until it is
  if (live && useHive.getState().goalsUnsure[live.id]) return { kind: 'closed', why: GOAL_UNCHECKED }
  return bindTo(seen, live ? seenOf(live) : undefined, GOAL_SEEN_FIELDS, (l) => (l.status === to && seen.status !== to ? `This task is ${to} now.` : null))
}

/** For confirms that are not a dialog (Construct, Still): the refusal in plain words, or null when it may go. */
export const goalDrift = (seen: GoalSeen, live: Goal | undefined, to: Goal['status']): string | null => boundNote(goalBound(seen, live, to), 'This task')

/** What the change does, from the hive's own rules (hive/core/goals.py), for the person to read before deciding. */
export function goalEffect(g: Pick<Goal, 'status' | 'claimed_by' | 'assignee'>, to: Goal['status'], holderName: string | null): string {
  const holder = holderName ?? (g.claimed_by ? 'the mind holding it' : null)
  if (to === 'open')
    return g.status === 'done' || g.status === 'cancelled'
      ? `A ${g.status} task stays ${g.status}: the hive refuses to re-open it, and nothing changes.`
      : `It starts again: no holder, no lapsed claims${holder ? ` (${holder} no longer holds it)` : ''}. Any mind may take it.`
  if (to === 'cancelled')
    return `It stops for good (a cancelled task cannot be re-opened).${holder || g.assignee ? ` ${holder ?? 'Its assigned mind'} is told to stop and acknowledge.` : ''} Any snapshot shared for it stops being readable.`
  if (to === 'done') return g.status === 'submitted' ? 'Its result is waiting for its reviewer: the hive refuses this until it is accepted or returned.' : `It is finished for good (a done task cannot be re-opened).${holder ? ` ${holder}'s work on it ends.` : ''}`
  if (to === 'failed') return `It is marked failed; it can be re-opened later as a fresh start.${holder ? ` ${holder}'s work on it ends.` : ''}`
  return `It becomes ${to}.`
}

/**
 * An inline confirm (Still): the "Yes" counts only as a fresh activation (not auto-repeat, not inside the arming
 * window that began when the confirm appeared) and only while the goal is still the one it showed.
 */
export function confirmGoalChange(seen: GoalSeen, to: Goal['status'], shownAt: number, live: Goal | undefined, ev: { at: number; repeat?: boolean }): { ok: true } | { ok: false; why: string } {
  if (ev.repeat) return { ok: false, why: 'A held key does not answer. Let go, read it, then answer.' }
  if (!accepts(ev, shownAt)) return { ok: false, why: 'This just appeared. Read it, then answer.' }
  const drift = goalDrift(seen, live, to)
  return drift ? { ok: false, why: drift } : { ok: true }
}

/**
 * Review B1 (next22): what GoalDecision's dialog says for a write's outcome. Taken (by the answer, or by a fresh read
 * after a lost answer): it closes. Refused: the hive's no ("Nothing changed" is true then). Lost answer, re-read shows
 * it unchanged: not confirmed, and this dialog is spent (a retry is a fresh GoalDecision). Lost answer, no re-read:
 * not confirmed, with "Check again".
 */
export function goalWriteResult(r: GoalWrite, recheck: () => Promise<DecisionResult>): DecisionResult {
  if (r.kind === 'taken') return true
  if (r.kind === 'refused') return 'The hive did not take this change.'
  if (r.kind === 'untaken') return { unsettled: `${r.why} Close this to ask again.` }
  return { unsettled: r.why, recheck }
}

/** "Check again" after a lost answer: what a fresh read of the goal (null: it could not be read) settles. */
export function goalRecheckResult(g: Goal | null, seen: Pick<Goal, 'updated_at'>, to: Goal['status'], recheck: () => Promise<DecisionResult>): DecisionResult {
  if (!g) return { unsettled: `${NOT_CONFIRMED} The task still could not be read again.`, recheck }
  if (g.status === to) return true
  return { unsettled: `${NOT_CONFIRMED} The task was read again: it is ${g.status}${g.updated_at === seen.updated_at ? ', unchanged' : ' now and changed since you saw it'}. Ask again if you still want it.` }
}

export const GOAL_VERB_LABEL: Record<GoalVerb, string> = { done: 'Mark done', failed: 'Mark failed', cancel: 'Cancel task', reopen: 'Re-open' }
