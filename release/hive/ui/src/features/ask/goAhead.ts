// Purpose: state the facts and words of the ask-go-ahead screen (goAhead.metta) for one waiting turn: whether its
// question stands, whether the hive gave its spend so far, and what became of the person's answer.
import type { ScreenFacts } from '../../screens/screenSpace'
import type { AskRow } from '../../store/ask'
import { money } from './words'

/** What MeTTa composes the question from, the values its parts draw, and whether its buttons wait. */
export interface GoAheadScreen {
  data: Record<string, unknown>
  facts: ScreenFacts
  busy: boolean
}

/**
 * The question stands while the person has not answered, while their answer is in flight (its buttons wait) and when it
 * did not reach the hive (they may answer again). Once the hive took the answer, or the turn stopped waiting, only
 * what became of it is said. Pure.
 */
export function goAheadScreen(q: NonNullable<AskRow['goAhead']>): GoAheadScreen {
  const said = q.state === undefined || q.state === 'sending' ? null : q.state
  return {
    data: { 'go.spent': q.spentUsd === null ? '' : money(q.spentUsd), 'go.error': q.error ?? '' },
    facts: {
      flags: { 'go.asking': q.state === undefined || q.state === 'sending' || q.state === 'failed', 'go.figured': q.spentUsd !== null },
      ...(said ? { values: { 'go.said': said } } : {}),
    },
    busy: q.state === 'sending',
  }
}
