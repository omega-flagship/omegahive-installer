import { bindTo, type Bound, type DecisionResult } from '../../lib/decisionGate'
import type { FormActResult } from '../contract'
import { gapWords, truthShort, type Unfolded } from './model'

/**
 * The commons' consequential acts, and what a confirm is bound to (Review R2/R3, C2).
 *
 * "Look for counterevidence" (challenge) and "Research this" (investigate-gap) post a goal to the swarm: minds pick
 * it up and may spend on it. Both go through the host DecisionDialog with the full context on screen. The dialog is
 * bound to what the person read: the statement, its truth, its independent sources and the commons revision (the
 * program refuses an act on any other revision). If any of these moves while the dialog is open, the decision turns
 * off and says what changed; the act is sent with the inspected revision, never a newer one.
 *
 * "Open source" and "Compare" only read; they run at once.
 */

export type AskAction = 'challenge' | 'investigate-gap'

export const CONSEQUENTIAL: readonly string[] = ['challenge', 'investigate-gap']
export const isConsequential = (action: string) => CONSEQUENTIAL.includes(action)

/** What the person inspected. The keys are the words the dialog uses when one of them changes. */
export interface Seen {
  statement: string
  truth: string
  'independent sources': number
  'missing research': string
  'commons revision': string
}

export interface Ask {
  action: AskAction
  /** The item the act is about: the belief (challenge) or the gap (investigate-gap). */
  target: string
  /** The belief it concerns. */
  belief: string
  seen: Seen
  /** Shown in the dialog as it was read: the source names and, for a gap, the gap. */
  sources: string[]
  gap?: { label: string; reason: string }
  /** Unique per opening. */
  seq: number
}

export const SEEN_FIELDS: readonly (keyof Seen)[] = ['statement', 'truth', 'independent sources', 'missing research', 'commons revision']

/** The snapshot of a belief (and, for a gap, that gap) as currently shown; undefined when it is no longer there. */
export function seenOf(u: Unfolded | null, action: AskAction, target: string): Seen | undefined {
  if (!u) return undefined
  if (action === 'investigate-gap' && !u.gaps.some((g) => g.id === target)) return undefined
  if (action === 'challenge' && u.star.id !== target) return undefined
  return {
    statement: u.star.statement,
    truth: truthShort(u.star.truth),
    'independent sources': u.star.independent,
    'missing research': u.gaps.map((g) => gapWords(g.reason)).join('; ') || 'none',
    'commons revision': u.revision,
  }
}

/** The dialog's binding: ready only while the live record still says exactly what was inspected. */
export function askBound(ask: Ask, live: Unfolded | null): Bound {
  return bindTo(ask.seen, seenOf(live, ask.action, ask.target), SEEN_FIELDS)
}

/** What a result means to the person, in words (null: nothing to say). */
export function outcomeWords(status: string, message?: string | null): { tone: 'good' | 'bad' | 'info'; text: string } {
  switch (status) {
    case 'started':
      return { tone: 'good', text: message ? `${message[0].toUpperCase()}${message.slice(1)}.` : 'Posted to the swarm.' }
    case 'done':
      return { tone: 'good', text: message ?? 'Done.' }
    case 'stale':
      return { tone: 'bad', text: 'The commons changed since you opened this, so nothing was done. Review the new version.' }
    case 'needs_input':
      return { tone: 'info', text: message ?? 'The app needs more before it can do this.' }
    case 'refused':
      return { tone: 'bad', text: `Refused: ${message ?? 'the app did not accept this.'}` }
    default:
      // an error alone does not establish that nothing was done (Review B1, f0818d8)
      return { tone: 'bad', text: message ?? 'Something went wrong.' }
  }
}

/** Review B1 (f0818d8): what the dialog says when a goal's delivery is not known. */
export const GOAL_MAY_BE_POSTED = 'The task may have been posted. Check the commons for it before asking again.'
/** After "Check again": the belief was read again, but a posted goal does not show on it. */
export const GOAL_READ_AGAIN = 'The belief was read again. A posted task shows in the swarm’s tasks, not on the belief, so look for it there before asking again.'

/**
 * Review B1 (f0818d8): a challenge or investigate-gap result, for the DecisionDialog. Only a known no says "nothing
 * changed" (a string): the program refused it, it was stale, or it needs more. An outcome that is not known (the
 * host's `unknown`: a lost answer, a failure after it may have posted, a closed re-ask) is unsettled with the way to
 * read the belief again; it never invites a plain retry. Any other error is plain: shown as written, no claim either way.
 */
export function askDecision(r: FormActResult, recheck?: () => Promise<DecisionResult>): DecisionResult {
  if (r.status === 'started' || r.status === 'done') return true
  if (r.unknown) return recheck ? { unsettled: GOAL_MAY_BE_POSTED, recheck } : { unsettled: GOAL_MAY_BE_POSTED }
  const words = outcomeWords(r.status, r.message).text
  if (r.status === 'refused' || r.status === 'stale' || r.status === 'needs_input') return words
  return { failed: words }
}
