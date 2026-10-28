/**
 * The person's confirmed OK for one proposal, as the hive's copy-apply consent (r4 [P1]; Platform "copy-apply consent
 * r1", 66312cd on ce8001d, in review). The owner: the person accepts. The team's controller can put a proposal into the
 * person's copy only with a live consent from the request's own person for exactly that proposal digest (otherwise its
 * copy_apply is refused 403 consent_required, or 409 consent_stale when the proposal changed since).
 *
 *   POST /api/requests/{request_id}/proposals/{suggestion_id}/accept   {suggestion_digest}   → a consent, ten minutes
 *   POST /api/requests/{request_id}/proposals/{suggestion_id}/decline  {suggestion_digest}   → voids every accept
 *
 * This is the ONE place that step lives. It is used only where the host's copy-apply is on (the probe), and only for a
 * whole-proposal decision; otherwise Accept → confirm records the person's own decision (the suggestion decide).
 */
import { ApiError, type HiveClient } from '../../../api/client'

export type ConsentDecision = 'accept' | 'decline'
export interface Consent {
  decision: ConsentDecision
  request_id: string
  suggestion_id: string
  suggestion_digest: string
  /** accept only */
  consent_id: string | null
  expires_at: string | null
  expires_in: number | null
  /** when the host recorded it */
  created_at: string
}

/** The words when the host wants a fresh confirmed OK (403 consent_required). */
export const CONFIRM_AGAIN = 'Your OK didn’t reach the hive, or this proposal changed after you gave it. Nothing went into your copy. Confirm again.'
/** The words while the team may put it in only after the person's OK (the controller is refused without it). */
export const WAITING_FOR_YOU = 'Waiting for you to accept: the swarm can put this into your copy only after you accept and confirm.'
/** The words when the proposal changed after the person saw it (409 consent_stale, or another digest on a re-read). */
export const CHANGED_REVIEW_AGAIN = 'It changed since you saw it — review again. Open it in the drawer’s Proposals, or ask again.'

const HEX64 = /^[0-9a-f]{64}$/
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Strictly read a consent answer for exactly what was sent. */
export function parseConsent(raw: unknown, sent: { decision: ConsentDecision; request_id: string; suggestion_id: string; suggestion_digest: string }): Consent {
  const bad = (why: string): never => {
    throw new Error(`The hive’s answer to your ${sent.decision === 'accept' ? 'OK' : 'decline'} was not understood (${why}).`)
  }
  if (!obj(raw)) return bad('not an object')
  if (raw.decision !== sent.decision) bad('another decision')
  if (raw.request_id !== sent.request_id || raw.suggestion_id !== sent.suggestion_id || raw.suggestion_digest !== sent.suggestion_digest) bad('another proposal')
  if (typeof raw.created_at !== 'string' || Number.isNaN(Date.parse(raw.created_at))) bad('created_at')
  if (sent.decision === 'accept') {
    if (typeof raw.consent_id !== 'string' || !/^cns_[0-9a-f]{32}$/.test(raw.consent_id)) bad('consent_id')
    if (typeof raw.expires_at !== 'string' || Number.isNaN(Date.parse(raw.expires_at))) bad('expires_at')
    if (typeof raw.expires_in !== 'number' || !(raw.expires_in > 0)) bad('expires_in')
  }
  return {
    decision: sent.decision,
    request_id: sent.request_id,
    suggestion_id: sent.suggestion_id,
    suggestion_digest: sent.suggestion_digest,
    consent_id: sent.decision === 'accept' ? (raw.consent_id as string) : null,
    expires_at: sent.decision === 'accept' ? (raw.expires_at as string) : null,
    expires_in: sent.decision === 'accept' ? (raw.expires_in as number) : null,
    created_at: raw.created_at as string,
  }
}

/** Accept or decline exactly the proposal digest the person was shown (read with include_request_binding=true). */
export async function giveConsent(client: HiveClient, decision: ConsentDecision, c: { request_id: string; suggestion_id: string; suggestion_digest: string }): Promise<Consent> {
  if (!client.proposalConsent) throw new ApiError(404, 'not_available', 'This client cannot send your OK to the hive.')
  if (!HEX64.test(c.suggestion_digest)) throw new Error('The proposal you were shown has no digest the hive can bind your OK to.')
  return parseConsent(await client.proposalConsent(c.request_id, c.suggestion_id, decision, c.suggestion_digest), { decision, ...c })
}

/**
 * Was this application made under the person's own consent? (r5 [P2], stand-in r4 #2) Only the host's evidence on the
 * application record counts: its consent_id equal to the consent this page holds, and applied_at inside that consent's
 * validity (from its created_at to its expires_at), with no grace. No evidence on the record: unverified. A record that
 * says it was made under no consent: unconsented.
 */
export type Authorization = 'consented' | 'unconsented' | 'unverified'
export function authorization(evidence: { consent_id: string | null; applied_at: string | null } | null, mine: Consent | null): Authorization {
  if (!evidence) return 'unverified'
  if (evidence.consent_id === null) return 'unconsented'
  if (!mine || mine.decision !== 'accept' || mine.consent_id !== evidence.consent_id || !mine.expires_at || !evidence.applied_at) return 'unverified'
  const at = Date.parse(evidence.applied_at)
  return at >= Date.parse(mine.created_at) && at <= Date.parse(mine.expires_at) ? 'consented' : 'unverified'
}

/** "valid for 10 minutes" (from the host's own expires_in). */
export function validFor(c: Consent): string {
  const m = Math.max(1, Math.round((c.expires_in ?? 600) / 60))
  return `valid for ${m} minute${m === 1 ? '' : 's'}`
}

/** Plain words for a refused accept or decline (66312cd copy_apply_consent and g_person). */
export function consentWords(e: unknown): string {
  if (!(e instanceof ApiError)) return e instanceof Error ? e.message : String(e)
  const w: Record<string, string> = {
    origin_required: 'This page’s address is not one the hive accepts for this. Nothing was recorded.',
    origin_refused: 'This page’s address is not one the hive accepts for this. Nothing was recorded.',
    person_required: 'Only a named, signed-in person can accept a mind’s change (not the hive’s password login). Nothing was recorded.',
    not_request_person: 'Only the person who asked for this change can accept or decline it. Nothing was recorded.',
    lease_required: 'This request is no longer live, so the swarm can’t put anything in. Ask again.',
    not_controller: 'This request has no swarm that can put a change into your copy. Ask again.',
    unauthorized: 'Sign in again, then confirm again. Nothing was recorded.',
    not_found: 'This request is no longer there, or isn’t visible to you. Nothing was recorded.',
    bad_request: 'The hive did not accept this OK as sent. Nothing was recorded.',
    request_closed: 'This request has ended (finished or cancelled), so the swarm can’t put this in. Ask again.',
    consent_required: CONFIRM_AGAIN,
    consent_stale: CHANGED_REVIEW_AGAIN,
  }
  return w[e.code] ?? `${e.message} (${e.code}). Nothing was recorded.`
}
