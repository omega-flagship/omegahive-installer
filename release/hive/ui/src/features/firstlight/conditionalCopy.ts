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
  return [saved.length ? `Your omega's ${saved.join(' and ')} ${saved.length === 1 && saved[0] !== 'preferences' ? 'was' : 'were'} saved.` : '', unknown.length ? `We couldn't confirm what saved for ${unknown.join(' and ')}.` : '', notSent.length ? `Its ${notSent.join(' and ')} ${notSent.length === 1 && notSent[0] !== 'preferences' ? "wasn't" : "weren't"} sent.` : '', s.priorLimitSaved ? 'The own-key limit was saved and read back.' : ''].filter(Boolean).join(' ')
}

/** A retained amount is evidence of an amount, never of a live request. */
export function spendingCopy(limit: MonthlyLimit | null, proposed: number | null, savedUnconfirmed: number | null, checking = false, uncertain = false): string {
  if (checking) return 'Checking your limit…'
  if (uncertain || savedUnconfirmed !== null) return "We couldn't confirm a spending limit here."
  if (limit?.enforced && limit.limit_usd !== null) return `Your minds may spend up to ${usd(limit.limit_usd)} a month.`
  if (proposed !== null) return `Proposed limit: ${usd(proposed)} a month. It starts when you save.`
  return "We couldn't confirm a spending limit here."
}

/** Current APIs expose no outbound-policy flag or charge receipt; only the unknown variants are usable here. */
export const outboundCopy = "The outbound-approval policy could not be confirmed here"
export const unknownChargeCopy = (omega: string): string => `${omega} couldn't finish waking. We couldn't confirm whether this was charged.`
export const unknownRetryCopy = 'Try again: this may use credit'
