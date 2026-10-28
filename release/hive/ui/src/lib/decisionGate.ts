/**
 * Review R2/R3 for classic decisions (money, revocations): a decision is taken only on the exact thing a person
 * inspected. The dialog keeps a snapshot of what it showed and re-checks the live record on every render; the
 * decide buttons work only while the two agree, never on a held key, and never until the inspection has been on
 * screen, unchanged, for ARM_MS (so a key or tap carried over from opening it cannot land on the decision).
 * The same rules as experiences/canvas/decision.ts, for any record.
 */

import { ApiError } from '../api/client'
import { answerLost } from '../store/store'
import { errorMessage, isUnsupported } from './useResource'

export const ARM_MS = 450

/** Whether an activation counts: never auto-repeat, never inside the arming window. */
export function accepts(ev: { repeat?: boolean; at: number }, armedSince: number): boolean {
  if (ev.repeat) return false
  return ev.at - armedSince >= ARM_MS
}

export type Bound = { kind: 'ready' } | { kind: 'gone' } | { kind: 'changed'; fields: string[] } | { kind: 'closed'; why: string }

/**
 * `seen` is the snapshot shown; `live` the current record (undefined once it is gone). `fields` are what the person
 * read. `closed` names why the record can no longer take this decision (already settled elsewhere), or null.
 */
export function bindTo<T extends object>(seen: T, live: T | undefined, fields: readonly (keyof T)[], closed?: (live: T) => string | null): Bound {
  if (!live) return { kind: 'gone' }
  const why = closed?.(live)
  if (why) return { kind: 'closed', why }
  const changed = fields.filter((f) => !same(seen[f], live[f])).map(String)
  return changed.length ? { kind: 'changed', fields: changed } : { kind: 'ready' }
}

function same(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Review B1 (next22): the answer did not settle what happened (it was lost, or a fresh read could not be had). The
 * text is shown as written, never with "Nothing changed", and the dialog takes no further decision: a retry is a
 * fresh decision. `recheck` (read the record again) is offered as "Check again" and settles it the same way.
 */
export interface DecisionUnsettled {
  unsettled: string
  recheck?: () => Promise<DecisionResult>
}
/**
 * Review B1 (commons f0818d8): a plain error. Something went wrong, but it is neither a known refusal (which says
 * nothing changed) nor a known lost answer (unsettled). The text is shown as written, with no claim either way about
 * what happened, and the decision stays open.
 */
export interface DecisionFailed {
  failed: string
}
/**
 * What a decision's run resolves to: true (taken; the dialog closes), a known refusal's words (a string: the hive or
 * app said no, or the record was stale, so nothing changed and trying again is safe), unsettled (the outcome is not
 * known: the answer was lost, or the far side failed after it may have acted), or a plain error.
 */
export type DecisionResult = true | string | DecisionUnsettled | DecisionFailed
/** What the dialog shows for a result. Only a known refusal (a string) says "Nothing changed"; nothing else does. */
export type DecisionShown = { kind: 'close' } | { kind: 'error'; text: string } | { kind: 'unsettled'; unsettled: DecisionUnsettled }
export const NOTHING_CHANGED = 'Nothing changed; you can try again.'
export const decisionShown = (r: DecisionResult): DecisionShown =>
  r === true
    ? { kind: 'close' }
    : typeof r === 'string'
      ? { kind: 'error', text: `${r} ${NOTHING_CHANGED}` }
      : 'failed' in r
        ? { kind: 'error', text: r.failed }
        : { kind: 'unsettled', unsettled: r }

/** Said when no answer came back for a decision: it may or may not have happened. */
export const OUTCOME_UNKNOWN = 'No answer came back, so whether this happened is not known. Check it before trying again.'

/**
 * Review B1 (commons f0818d8): is an error a decision's unknown outcome? No answer (store answerLost: status 0, which
 * includes `answer_unreadable`, 502, 504, a timeout or a raw fetch failure), the far side failed after it may have
 * acted (any 5xx: a program may raise after it posted), or it is still being carried out (409 in_progress).
 */
export const outcomeUnknown = (e: unknown): boolean =>
  answerLost(e) || (e instanceof ApiError && (e.status >= 500 || e.code === 'in_progress'))

/**
 * Review B1 (commons f0818d8): the one way a decision's thrown error becomes a DecisionResult, for every
 * DecisionDialog consumer (and the dialog itself, for a run that throws). Never "Nothing changed" from an error alone:
 * - not offered here (UnsupportedError): nothing was sent, so a refusal's words;
 * - an unknown outcome (outcomeUnknown): unsettled, with `recheck` when the caller can read the record again;
 * - the hive refused it (any other 4xx): a refusal's words (nothing changed);
 * - anything else (a programming error, an unexpected throw): a plain error, shown as written.
 */
export function decisionFailure(e: unknown, recheck?: () => Promise<DecisionResult>): DecisionResult {
  if (isUnsupported(e)) return e.message
  const said = errorMessage(e)
  if (outcomeUnknown(e)) {
    // a server error the hive itself reported (not a gateway that lost the answer) says so: it may have acted first
    const reported = e instanceof ApiError && e.status >= 500 && e.status !== 502 && e.status !== 504
    const why = reported || !answerLost(e) ? `The hive reported a failure (${said}) and may have acted first, so whether this happened is not known. Check it before trying again.` : OUTCOME_UNKNOWN
    return recheck ? { unsettled: why, recheck } : { unsettled: why }
  }
  if (e instanceof ApiError) return said
  return { failed: said }
}

/** Plain words for why the decision is off (null when it is on). */
export function boundNote(b: Bound, thing = 'This'): string | null {
  switch (b.kind) {
    case 'ready':
      return null
    case 'gone':
      return `${thing} is no longer on the hive. Nothing was decided here.`
    case 'closed':
      return `${b.why} Nothing was decided here.`
    case 'changed':
      return `${thing} changed while it was open (${b.fields.join(', ')}). Close and open it again to review the new version.`
  }
}
