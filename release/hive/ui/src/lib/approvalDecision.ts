import type { Approval } from '../api/types'
import { useHive } from '../store/store'
import { accepts, bindTo, boundNote, type Bound } from './decisionGate'

/**
 * Review R2/R3 for approval requests, shared by the experiences that answer them in the shared DecisionDialog (Cosmos,
 * Flux) or at a command line (Construct): a request is answered only as the person inspected it. The same fields and
 * the same refusals as Canvas's reviewed inspection (experiences/canvas/decision.ts):
 *  - `gone`: it left the hive; `closed`: it was already answered elsewhere; `changed`: an inspected field moved.
 * The hive still decides (policy, rules, budgets); this binds what the person saw, it is not authority.
 */

/** The fields a person reads before answering. Any change to these means they have not seen the request. */
export const APPROVAL_SEEN_FIELDS = ['id', 'agent_id', 'skill', 'command', 'reason', 'risk', 'created_at'] as const

/** Surface R (O-B1): `session` is the store session the request was read under; an answer goes only in that session. */
export type ApprovalSeen = Pick<Approval, (typeof APPROVAL_SEEN_FIELDS)[number]> & { session: string }

export const approvalSeenOf = (a: Approval): ApprovalSeen => ({ id: a.id, agent_id: a.agent_id, skill: a.skill, command: a.command, reason: a.reason, risk: a.risk, created_at: a.created_at, session: useHive.getState().session })

const WORD: Record<string, string> = { approved: 'approved', denied: 'denied', expired: 'expired', used: 'approved and used' }

/** Is the live request still the pending one that was inspected? */
export function approvalBound(seen: ApprovalSeen, live: Approval | undefined): Bound {
  // read under an earlier connection: whatever now has this id is not what was inspected
  if (seen.session !== useHive.getState().session) return { kind: 'closed', why: 'This request was opened under an earlier connection to the hive.' }
  return bindTo<ApprovalSeen>(seen, live ? approvalSeenOf(live) : undefined, APPROVAL_SEEN_FIELDS, () =>
    live && live.status !== 'pending' ? `This request was already ${WORD[live.status] ?? live.status}${live.decided_by ? ` by ${live.decided_by}` : ''} elsewhere.` : null,
  )
}

/** The refusal in plain words, or null when the answer may go (for confirms that are not a dialog: Construct). */
export const approvalDrift = (seen: ApprovalSeen, live: Approval | undefined): string | null => boundNote(approvalBound(seen, live), 'This request')

/**
 * A command-line answer (Construct's `yes`): it counts only as a fresh activation (not auto-repeat, not inside the
 * arming window that began when the preview was shown) and only while the request is still the one previewed.
 */
export function confirmApproval(seen: ApprovalSeen, shownAt: number, live: Approval | undefined, ev: { at: number; repeat?: boolean }): { ok: true } | { ok: false; why: string } {
  if (ev.repeat) return { ok: false, why: 'A held key does not answer. Let go, read it, then answer.' }
  if (!accepts(ev, shownAt)) return { ok: false, why: 'This just appeared. Read it, then answer.' }
  const drift = approvalDrift(seen, live)
  return drift ? { ok: false, why: drift } : { ok: true }
}

/** Exact local time a request was asked. */
export function askedAt(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** Review B1 (commons f0818d8): an answer the hive did not confirm (refused, or its answer was lost): no claim either way. */
export const APPROVAL_UNCONFIRMED = 'Not confirmed as approved: the hive did not confirm the answer. Check the request before answering again.'
export const APPROVAL_REFUSAL_UNCONFIRMED = 'Not confirmed as refused: the hive did not confirm the answer. Check the request before answering again.'
