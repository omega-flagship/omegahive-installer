import { useHive, type Approval, type Decision } from '../sdk'

/**
 * A decision is only ever taken on the exact request a person inspected. The inspection keeps a snapshot of
 * what it showed; every render re-checks the live approval against it, and the answer buttons are enabled only
 * while the two still agree and the request is still pending.
 */

/** The fields a person reads before deciding. Any change to these means they have not seen the request. */
export const INSPECTED_FIELDS = ['id', 'agent_id', 'skill', 'command', 'reason', 'risk', 'created_at'] as const

/** Surface R (O-B1): `session` is the store session the request was read under; it is answered only in that session. */
export type Inspected = Pick<Approval, (typeof INSPECTED_FIELDS)[number]> & { session: string }

export const inspect = (a: Approval): Inspected => ({ id: a.id, agent_id: a.agent_id, skill: a.skill, command: a.command, reason: a.reason, risk: a.risk, created_at: a.created_at, session: useHive.getState().session })

export type Binding =
  | { kind: 'ready' }
  | { kind: 'deciding'; d: Decision }
  | { kind: 'gone' }
  | { kind: 'decided'; status: Approval['status']; by: string | null }
  | { kind: 'changed'; fields: string[] }
  | { kind: 'earlier' }

export function bind(seen: Inspected, live: Approval | undefined, deciding: Decision | undefined): Binding {
  if (seen.session !== useHive.getState().session) return { kind: 'earlier' }
  if (!live) return { kind: 'gone' }
  if (live.status !== 'pending') return { kind: 'decided', status: live.status, by: live.decided_by }
  const fields = INSPECTED_FIELDS.filter((f) => live[f] !== seen[f])
  if (fields.length) return { kind: 'changed', fields: [...fields] }
  if (deciding) return { kind: 'deciding', d: deciding }
  return { kind: 'ready' }
}

/** Plain words for why the answer buttons are off (null when they are on). */
export function bindingNote(b: Binding): string | null {
  switch (b.kind) {
    case 'ready':
      return null
    case 'deciding':
      return b.d === 'deny' || b.d === 'never' ? 'Sending your refusal…' : 'Sending your approval…'
    case 'gone':
      return 'This request is no longer on the hive. Nothing was decided here.'
    case 'decided':
      return `This request was already ${STATUS_WORD[b.status] ?? b.status}${b.by ? ` by ${b.by}` : ''} elsewhere. Nothing was decided here.`
    case 'changed':
      return `This request changed while it was open (${b.fields.join(', ')}). Close and open it again to review the new version.`
    case 'earlier':
      return 'This request was opened under an earlier connection to the hive. Nothing was decided here.'
  }
}

const STATUS_WORD: Record<string, string> = { approved: 'approved', denied: 'denied', expired: 'expired', used: 'used', pending: 'pending' }

export const canDecide = (b: Binding) => b.kind === 'ready'

/** After opening (or after the binding last changed) the answer buttons ignore activation for this long. */
export const ARM_MS = 450

/**
 * Whether an activation of an answer button counts. Held keys (auto-repeat) never count, and nothing counts
 * until the inspection has been on screen, unchanged, for ARM_MS: a key or tap carried over from the previous
 * note or request cannot land on Approve.
 */
export function accepts(ev: { repeat?: boolean; at: number }, armedSince: number): boolean {
  if (ev.repeat) return false
  return ev.at - armedSince >= ARM_MS
}

/** Exact local time a request was asked, for the inspection. */
export function askedAt(iso: string): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return iso
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
