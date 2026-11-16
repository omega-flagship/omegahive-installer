// Purpose: say a session's step group in plain words: what the mind did, and which steps waited for approval or were not allowed.
import type { SessionItem } from '../../api/types'
import { plural } from '../../lib/plural'

/** One command a mind ran in a session, as the timeline carries it. */
export type SessionStep = Extract<SessionItem, { type: 'step' }>['steps'][number]

/**
 * A step's policy gate beside it: the hive records 'ask' when the command waited for a person's approval, 'deny' when
 * it was not allowed and 'allow' when it ran (core/policy.py), so only the first two say anything.
 */
export function gateWords(gated: SessionStep['gated']): string | null {
  return gated === 'ask' ? 'waited for approval' : gated === 'deny' ? 'not allowed' : null
}

/**
 * The closed header of one step group: "Asha took 3 steps" ("1 step" for one, lib/plural), then a mark for the steps
 * that waited for approval or were not allowed ("1 waited for approval", "2 not allowed"). The commands themselves stay
 * inside the fold, so a person reading the session never meets a line like "(hive-goal-get g_12)" as if the mind had
 * said it.
 */
export function stepsLine(mind: string, steps: readonly SessionStep[]): { did: string; marks: string[] } {
  const held = steps.filter((s) => s.gated === 'ask').length
  const refused = steps.filter((s) => s.gated === 'deny').length
  const marks = [held ? `${held} ${gateWords('ask')}` : null, refused ? `${refused} ${gateWords('deny')}` : null]
  return { did: `${mind} took ${plural(steps.length, 'step')}`, marks: marks.filter((m): m is string => !!m) }
}
