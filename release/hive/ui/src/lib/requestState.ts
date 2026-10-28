import type { RequestState } from '../api/types'

/**
 * Every cross-swarm request state the host reports (hive/core/collab.py REQUEST_STATE and request_view at ad9e82c),
 * in lifecycle order, with how the UI says and colours each. Exhaustive by type: a new host state fails to compile
 * here before it can be shown as something it is not. `in-review` is submitted work waiting for the requester's
 * review; it is never shown as completed.
 */
export const REQUEST_STATES: readonly RequestState[] = ['queued', 'accepted', 'working', 'needs-approval', 'in-review', 'completed', 'failed', 'cancelled']

export const REQUEST_STATE_LABEL: Record<RequestState, string> = {
  queued: 'Queued',
  accepted: 'Accepted',
  working: 'Working',
  'needs-approval': 'Needs approval',
  'in-review': 'In review',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** One plain line per state: what it means for the person reading it. */
export const REQUEST_STATE_MEANING: Record<RequestState, string> = {
  queued: 'Waiting for the receiving swarm to take it',
  accepted: 'Accepted; no receiving task reported',
  working: 'The receiving swarm is working on it',
  'needs-approval': 'Waiting on an approval',
  'in-review': 'Work submitted; waiting for the requester to accept or return it',
  completed: 'Accepted by the requester',
  failed: 'The receiving task failed',
  cancelled: 'Cancelled',
}

export type RequestTone = 'idle' | 'active' | 'attention' | 'review' | 'good' | 'bad' | 'muted'
export const REQUEST_STATE_TONE: Record<RequestState, RequestTone> = {
  queued: 'idle',
  accepted: 'idle',
  working: 'active',
  'needs-approval': 'attention',
  'in-review': 'review',
  completed: 'good',
  failed: 'bad',
  cancelled: 'muted',
}

/** Tailwind classes per tone (classic tokens, which the experience chrome re-points through .xc-dress). */
export const REQUEST_TONE_CLASS: Record<RequestTone, string> = {
  idle: 'border-line-2 text-ink-2',
  active: 'border-accent/40 text-accent',
  attention: 'border-warn/50 text-warn',
  review: 'border-accent/60 bg-accent/10 text-accent',
  good: 'border-good/40 text-good',
  bad: 'border-bad/40 text-bad',
  muted: 'border-line text-ink-3',
}

/** States after which nothing more happens to a request (cancel is not offered). In review is not one of them. */
export const REQUEST_TERMINAL: ReadonlySet<RequestState> = new Set<RequestState>(['completed', 'failed', 'cancelled'])

export const isRequestState = (v: unknown): v is RequestState => typeof v === 'string' && (REQUEST_STATES as readonly string[]).includes(v)

/** The label for a state as received: an unknown value is shown as unknown, never mapped onto a known state. */
export const requestStateLabel = (v: unknown): string => (isRequestState(v) ? REQUEST_STATE_LABEL[v] : `Unknown state (${String(v)})`)

export const isTerminalRequest = (r: { state: unknown; cancelled_at?: unknown }): boolean => !!r.cancelled_at || (isRequestState(r.state) && REQUEST_TERMINAL.has(r.state))
