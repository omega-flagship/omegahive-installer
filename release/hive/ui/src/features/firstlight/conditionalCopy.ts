// Purpose: describe observed First Light saves, spending limits and incomplete wake outcomes, and what the card can't
// tell about a mind asking first.
import { usd } from './honest'
import type { MonthlyLimit } from './host'

export type WriteState = 'not_sent' | 'sent' | 'saved' | 'unknown' | 'unchanged'
export interface ProfileSaveState {
  name: WriteState
  purpose: WriteState
  preferences: WriteState
  priorLimitSaved: boolean
  readback?: { name: string; purpose: string }
}

/** R1.1 copy consumes local send/ack observations and actual readback, never invented host flags. */
export function profileSaveCopy(s: ProfileSaveState): string {
  const rows = [['name', s.name], ['purpose', s.purpose], ['preferences', s.preferences]] as const
  if (rows.every(([, value]) => value === 'saved' || value === 'unchanged')) return 'Saved.'
  if (rows.every(([, value]) => value === 'not_sent' || value === 'unchanged') && !s.priorLimitSaved) return "Couldn't save just now. Nothing changed."
  const saved = rows.filter(([, value]) => value === 'saved').map(([key]) => key)
  const unknown = rows.filter(([, value]) => value === 'unknown' || value === 'sent').map(([key]) => key)
  const notSent = rows.filter(([, value]) => value === 'not_sent').map(([key]) => key)
  return [saved.length ? `Your mind's ${saved.join(' and ')} ${saved.length === 1 && saved[0] !== 'preferences' ? 'was' : 'were'} saved.` : '', unknown.length ? `We couldn't tell whether its ${unknown.join(' and ')} ${unknown.length === 1 && unknown[0] !== 'preferences' ? 'was' : 'were'} saved.` : '', notSent.length ? `Its ${notSent.join(' and ')} ${notSent.length === 1 && notSent[0] !== 'preferences' ? "wasn't" : "weren't"} sent.` : '', s.priorLimitSaved ? 'Your monthly limit was saved.' : ''].filter(Boolean).join(' ')
}

/** A retained amount is evidence of an amount, never of a live request. */
export function spendingCopy(limit: MonthlyLimit | null, proposed: number | null, savedUnconfirmed: number | null, checking = false, uncertain = false, hiveUsd: number | null = null): string {
  if (checking) return 'Checking your limit…'
  if (uncertain || savedUnconfirmed !== null) return "We couldn't read your monthly limit."
  if (limit?.enforced && limit.limit_usd !== null) return `Your minds may spend up to ${usd(limit.limit_usd)} a month.`
  if (proposed !== null) return `Proposed limit: ${usd(proposed)} a month. It starts when you save.`
  // no own-key total: the hive's own monthly total governs (the starting limit a first key brings); else none is set
  if (hiveUsd !== null) return `Your hive may spend up to ${usd(hiveUsd)} a month.`
  if (limit && !limit.enforced) return 'No monthly limit is set yet.'
  return "We couldn't read your monthly limit."
}

/** The limit line while the mind thinks with the hive's free inference (plans.freeWay): no money of the person's is spent,
 *  and the model calls a day the host states bound it. */
export const freeLimitCopy = (dailyCalls: number | null): string =>
  `Free inference spends no money of yours${dailyCalls === null ? '.' : `: up to ${dailyCalls} model calls a day.`}`

/** Current APIs expose no charge receipt, so a Wake whose outcome is unknown says so. */
export const unknownChargeCopy = (omega: string): string => `${omega} couldn't finish waking. We couldn't confirm whether this was charged.`
export const unknownRetryCopy = 'Try again: this may use credit'
export const unknownModelCopy = 'We don’t know how your mind thinks yet. Choose a way above.'

/** No API tells the card whether a mind asks before it sends or posts anything: GET /api/policy lists only the rules
 *  people added, never the built-in defaults a mind acts under. So the card never promises that it asks, and says
 *  plainly that it can't tell. */
export const outboundCopy = 'We can’t tell whether it asks you before it sends or posts anything.'
