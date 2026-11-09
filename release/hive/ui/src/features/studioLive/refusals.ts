/**
 * J3 r4.3 O3: what a refusal from the Studio session routes says, in plain words, with the way on that actually helps.
 *
 * The missing monthly total (follow-up case #4) has its own words and remedy. It is the existing common envelope, never a
 * new top-level code: 402 `spend_limit`, `limit.kind:"own_key_limit"`, `detail.reason:"monthly_total_required"`, unknown
 * figures null (contract :170). Words the person typed are always kept when a direction is refused (429 included).
 */
import { ApiError } from '../../api/client'
import { keySetupFrom, limitOnlySetup, type KeySetup } from '../ownKey/addOwnKey'

export interface StudioRefusal {
  code: string
  words: string
  /** the remedy that helps, if any (go: the route it opens) */
  remedy?: { label: string; go: 'me' | 'usage' | 'keys' }
  /** host R5: the way on in this panel. `confirm-new-card`: ONLY consent_mismatch at resume, where a refreshed consent
   *  card (current values) helps; `stop-then-new`: Stop, then start a new session with what is true now (no card is
   *  implied); `wait`: nothing to press, the hive clears it; `none`: nothing is needed */
  next?: 'confirm-new-card' | 'stop-then-new' | 'wait' | 'none' | 'ask'
  /** a direction refused this way keeps its words for the person to send again */
  keepWords: boolean
  /** Jon 11-05: the one add-your-key step, shown inline (features/ownKey) instead of sending the person to Keys */
  keySetup?: KeySetup
}

const rec = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null)

/** The `limit` and `detail` of a refusal, from the error envelope or the whole body (the host merges details in). */
function limitParts(e: ApiError): { kind: string | null; reason: string | null } {
  const env = rec(e.envelope)
  const body = rec(e.body)
  const err = rec(body?.error)
  const limit = rec(env?.limit) ?? rec(err?.limit) ?? rec(body?.limit)
  const detail = rec(env?.detail) ?? rec(err?.detail) ?? rec(body?.detail)
  return { kind: typeof limit?.kind === 'string' ? limit.kind : null, reason: typeof detail?.reason === 'string' ? detail.reason : null }
}

/** Why the host holds or paused a session, in plain words with what helps (never a silent wait, never "released"). */
const HELD_WORDS: Record<string, string> = {
  execution_retirement_failed: 'Studio couldn’t hand over cleanly from the last session. Nothing new will draw until that’s cleared. Ask Platform, or try again later.',
  budget_exhausted: 'This session’s money is used up, so it paused. The piece stays as it is.',
  host_restart: 'The hive restarted, so this session paused. The piece stays; nothing new draws until it resumes.',
  mount_revoked: 'Studio here is no longer the one connected to this session, so it paused. The piece stays.',
  // host R3 (studio_handoff.py) hold reasons
  handoff_retry_exhausted: 'Studio tried to restart its mind a few times this hour and has stopped trying, so the session is held. You can Stop, or wait for the hive to clear it.',
  handoff_interrupted: 'The hive restarted while Studio’s mind was being handed over, so the session is held. Nothing new will draw until it is cleared; the piece stays.',
  consent_legacy: 'This session was confirmed under an older card, so it is held. Start a new session to go on; the piece stays.',
  // host plan r1.9 L1 (Kimi K1): never re-sent or replayed; recovery is the hive's, so say what the person can do now
  delivery_uncertain: 'Studio couldn’t confirm the last step reached the maker, so that step is not confirmed and nothing is sent again. You can Stop, or wait for the hive to clear it.',
  // host R5 pause (studio_steps._pause): the person's own pause
  paused_by_person: 'You paused this session. A step already running finishes; nothing new starts until you resume. Directions you send now wait for it.',
  maker_unresponsive: 'The maker isn’t responding (this isn’t the canvas being slow), so the last step is not confirmed and nothing is sent again. You can Stop, or wait for the hive to clear it.',
}
export function heldWords(reason: string | null): string {
  return (reason && HELD_WORDS[reason]) || 'The hive is holding this session. Nothing new will draw until it is cleared; the piece stays.'
}

/** OI-13 (Jon 10-19: "everyone needs studio, they just need to use their own keys"): 402 own_key_needed, raised before
 *  any reservation or dispatch (ownhive.person_key_check). Words kept; never retried on its own. */
export const OWN_KEY_WORDS = 'This would run on someone else’s key, so nothing was started and nothing was spent. Add your own key in Keys, then try again.'
export const OWN_KEY_REMEDY = 'Add your own key'
/** with the inline step: what the refusal says above the sheet (nothing was started or spent; the sheet is the way on) */
export const OWN_KEY_SHEET_WORDS = 'Drawing with a mind runs on your own key. Add it once here and the drawing starts; nothing was spent.'

/** r1.10: the card's intent is recorded on the person's own Ask turn (host: POST /api/ask/{op}/intents) */
export const SETUP_NEEDS_TURN_WORDS = 'Studio starts from your Ask: ask the hive what to draw (for example “a poster for the picnic”), then choose Draw live with a mind. Nothing was started.'
export const STUDIO_OFF_WORDS = 'Live Studio is switched off on this hive, so nothing was started.'
export const TURN_TOO_OLD_WORDS = 'This Studio request came from an Ask message that’s now too old. Ask what to draw again.'
/** r1.12: admission's 404 not_available names no reason (studio_sessions.admit: Studio off, a deleted Ask turn or a swarm
 *  no longer available; ask_intents._turn the same), so the words say all three, honestly */
export const ADMIT_UNAVAILABLE_WORDS = 'Studio can’t start this right now: Studio may be off here, or the Ask message or space it came from is gone. Nothing was started.'

/** r1.10: a refusal of setting up or starting the card (POST /api/studio/setup, the intent record and submit) */
const SETUP_WORDS: Record<string, string> = {
  // r1.11: admission codes whose general words speak of resuming; at setup they mean the card can't start
  execution_binding_unqualified: 'This maker can’t be restarted between steps by this hive, so this card can’t start a session. Nothing was created or spent.',
  maker_is_coordinator: 'That maker is your Ask mind, and this card didn’t agree to set it aside while it draws, so nothing was started.',
  source_not_bindable: 'That canvas can’t be used for live drawing here: it isn’t a saved canvas in your own Studio space. Nothing was started. Pick another canvas.',
  intent_in_flight: 'This card is already being started. Wait a moment for it; nothing was started twice.',
  intent_pending: 'A Studio request from this Ask turn is already waiting. Nothing new was started.',
  operation_conflict: 'That clashed with an earlier start of this card. Nothing new was started.',
  maker_not_member: 'The maker on this card is no longer in its Studio space, so nothing was started.',
}
/** `where: 'admit'`: a refusal of the intent record or submit (the card's start); otherwise of POST /api/studio/setup,
 *  whose only 404 is Studio being off (StudioMakers.setup: `if not self.enabled()`) */
/** r1.13 (Dot 002701Z): until host R8.2, Studio isn't activated in the person's own Studio swarm; reads and saves there
 *  answer app_inactive (or say the program isn't active). That is "not ready in your space", never Studio off. */
export const SPACE_NOT_READY_WORDS = 'Studio isn’t ready in your space yet. Nothing was started.'
export function notActiveThere(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false
  const env = rec(e.envelope)
  const why = [e.code, env?.refusal_code, env?.reason, rec(env?.detail)?.reason].map((x) => String(x ?? ''))
  return why.includes('app_inactive') || /isn.?t active|not active/i.test(e.message)
}
export function setupRefusal(e: unknown, where?: 'admit'): StudioRefusal {
  if (notActiveThere(e)) return { code: 'app_inactive', words: SPACE_NOT_READY_WORDS, keepWords: true, next: 'none' }
  if (e instanceof ApiError && SETUP_WORDS[e.code]) return { code: e.code, words: SETUP_WORDS[e.code], keepWords: true, next: 'none' }
  if (e instanceof ApiError && e.status === 404 && e.code === 'not_available') return where === 'admit' ? { code: 'admit_unavailable', words: ADMIT_UNAVAILABLE_WORDS, keepWords: true, next: 'ask' } : { code: 'studio_off', words: STUDIO_OFF_WORDS, keepWords: true, next: 'none' }
  if (e instanceof ApiError && e.status === 400 && (rec(e.envelope)?.reason === 'turn_too_old' || rec(rec(e.envelope)?.detail)?.reason === 'turn_too_old')) return { code: 'turn_too_old', words: TURN_TOO_OLD_WORDS, keepWords: true, next: 'ask' }
  return studioRefusal(e)
}

export const MONTHLY_TOTAL_WORDS = 'Studio can’t start yet: you haven’t set your total monthly limit. That one limit covers everything you spend here, the Ask included. Nothing was spent and nothing was started; set it, then start again.'
export const MONTHLY_TOTAL_REMEDY = 'Set your monthly limit'

/** True for exactly the missing-monthly-total envelope (no other 402 qualifies). */
export function isMonthlyTotalRequired(e: unknown): boolean {
  if (!(e instanceof ApiError) || e.status !== 402 || e.code !== 'spend_limit') return false
  const { kind, reason } = limitParts(e)
  return kind === 'own_key_limit' && reason === 'monthly_total_required'
}

/** host R5 admission: 409 maker_busy with `reason: "studio_owned"` (a held, stopping or unreleased session owns it) */
function studioOwned(e: ApiError): boolean {
  const env = rec(e.envelope)
  const err = rec(rec(e.body)?.error)
  return (env?.reason ?? err?.reason ?? rec(env?.detail)?.reason) === 'studio_owned'
}

/** host R5 `_resume` (studio_steps 1033-1061), refusals AFTER the state checks: the binding drift codes and payer
 *  (`_drift`, `_payer_drift`) need a NEW session with new values (no refreshed card is implied: the host would refuse the
 *  same values again); money (402) waits for room under the limits, then Resume again. The session stays paused. */
const RESUME_DRIFT = ['model_drift', 'key_drift', 'payer_mismatch', 'role_drift', 'maker_not_member', 'attachment_drift', 'execution_binding_unqualified', 'person_required']
function resumeRefusal(e: ApiError): StudioRefusal | null {
  if (RESUME_DRIFT.includes(e.code))
    return { code: e.code, words: 'Something about the maker changed since you confirmed (its model, key, payer, role, swarm or how it runs), so this session can’t resume. It stays paused. Stop it, then start a new session with what is true now; the piece stays.', keepWords: true, next: 'stop-then-new' }
  if (e.status === 402 && (e.code === 'budget_exhausted' || e.code === 'spend_limit'))
    return { code: e.code, words: 'There isn’t room for another step under your limits, so this session can’t resume yet. It stays paused; nothing more was spent. Make room in Usage & limits, then Resume again, or Stop it.', remedy: { label: 'Usage & limits', go: 'usage' }, keepWords: true, next: 'none' }
  return null
}

/** `context: 'resume'`: a refusal of the person's Resume (the session stays paused); otherwise setup, steer or a control. */
export function studioRefusal(e: unknown, context?: 'resume'): StudioRefusal {
  if (context === 'resume' && e instanceof ApiError) {
    const r = resumeRefusal(e)
    if (r) return r
  }
  if (isMonthlyTotalRequired(e)) return { code: 'monthly_total_required', words: MONTHLY_TOTAL_WORDS, remedy: { label: MONTHLY_TOTAL_REMEDY, go: 'me' }, keepWords: true, keySetup: limitOnlySetup() }
  if (!(e instanceof ApiError)) return { code: 'unknown', words: 'The hive did not answer. Nothing is assumed: your words are kept.', keepWords: true }
  const { kind } = limitParts(e)
  switch (e.code) {
    case 'own_key_needed': {
      const keySetup = keySetupFrom(e) ?? undefined
      return { code: e.code, words: keySetup ? OWN_KEY_SHEET_WORDS : OWN_KEY_WORDS, remedy: { label: OWN_KEY_REMEDY, go: 'keys' }, keepWords: true, ...(keySetup ? { keySetup } : {}) }
    }
    // host R6 (OI-11, studio_sessions.admit): only an Omega mind (hub channel) can take Studio steps; nothing written
    case 'maker_kind_unsupported':
      return { code: e.code, words: 'That maker can’t take Studio steps: it is a kind of mind this hive’s Studio can’t drive yet. Nothing was created or spent. Choose an Omega mind as the maker.', keepWords: true, next: 'none' }
    // ---- host R7 (POST /api/studio/setup and the record of its request)
    // host R7.2: a personal Studio maker pays only with its person's own key (PATCH options.key elsewhere: 403). O3
    // never offers that edit; the words are here in case another page's change surfaces through Studio
    case 'own_key_only':
      return { code: e.code, words: 'Your own Studio maker can only run on your own key, so that change wasn’t made. Choose one of your keys in Keys.', remedy: { label: 'Your keys', go: 'keys' }, keepWords: true, next: 'none' }
    case 'studio_maker_unavailable':
      return { code: e.code, words: 'This hive can’t make your own Studio maker yet: it isn’t set up for that. Nothing was created or spent. An admin needs to set it up.', keepWords: true, next: 'none' }
    case 'studio_maker_missing':
      return { code: e.code, words: 'Your own Studio maker isn’t set up (or was removed), so nothing was started. Load the card again to set it up.', keepWords: true, next: 'none' }
    case 'maker_not_yours':
      return { code: e.code, words: 'That maker is someone else’s own Studio maker, so it can’t draw for you. Nothing was started. Load the card again to use your own.', keepWords: true, next: 'none' }
    case 'studio_maker_attach_unsupported':
      return { code: e.code, words: 'Studio on this hive needs an admin to attach makers to it, so your own maker can’t be set up yet. Nothing was created or spent.', keepWords: true, next: 'none' }
    case 'app_not_attached':
      return { code: e.code, words: 'Studio isn’t available for that app on this hive right now. Nothing was created or spent.', keepWords: true, next: 'none' }
    case 'setup_needs_turn':
      return { code: e.code, words: SETUP_NEEDS_TURN_WORDS, keepWords: true, next: 'none' }
    case 'rate_limited':
      return { code: e.code, words: e.status === 429 ? 'Twenty directions are already waiting for the maker. Your words are kept here; send them once it has read some.' : 'Too many at once. Your words are kept here.', keepWords: true }
    case 'spend_limit':
      return { code: e.code, words: kind === 'own_key_limit' ? 'The limit on the key paying for this has no room for the next step. Nothing more was spent.' : 'A spending limit has no room for the next step. Nothing more was spent.', remedy: { label: 'Usage & limits', go: 'usage' }, keepWords: true }
    case 'budget_exhausted':
      return { code: e.code, words: 'This session’s money is used up, so it paused. The piece stays as it is.', remedy: { label: 'Usage & limits', go: 'usage' }, keepWords: true }
    case 'maker_busy':
    case 'coordinator_busy':
      if (studioOwned(e)) return { code: 'studio_owned', words: 'That maker is still held by another Studio session, so this one did not start. Stop that session first. Nothing was created.', keepWords: true, next: 'stop-then-new' }
      return { code: e.code, words: 'That mind is busy with other work, so Studio did not start. Nothing was created.', keepWords: true }
    case 'session_closed':
      return { code: e.code, words: 'This Studio session has stopped. Your words are kept; start a new session to go on.', keepWords: true }
    // ---- host R5 (studio_steer.direction, studio_steps._pause/_resume, studio_sessions.admit)
    case 'studio_session_closed':
      return { code: e.code, words: 'This Studio session has ended or is stopping, so your words were not sent to the maker. They are kept here: send them as new work, or start a new session.', keepWords: true }
    case 'not_active':
      return { code: e.code, words: 'Only a running session can be paused, and this one isn’t running now. Nothing changed.', keepWords: true, next: 'none' }
    case 'not_paused':
      return { code: e.code, words: 'This session is held by the hive, not paused, so it can’t resume. It waits until the hive clears it; you can Stop it at any time.', keepWords: true, next: 'wait' }
    case 'studio_stopping':
      return { code: e.code, words: 'This session is already stopping, so it can’t resume. Nothing else is needed; it finishes stopping on its own.', keepWords: true, next: 'none' }
    case 'window_ended':
      return { code: e.code, words: 'This session’s time is up, so it can’t resume. Stop it to settle what is owed, then start a new session. The piece stays.', keepWords: true, next: 'stop-then-new' }
    case 'consent_mismatch':
      return { code: e.code, words: 'What you confirmed has changed since this session started (for example your monthly limit), so it can’t resume. It stays paused. Stop it, then confirm the new card to start again; the piece stays.', keepWords: true, next: 'confirm-new-card' }
    case 'execution_fenced':
      return { code: e.code, words: 'That maker’s last Studio run has ended and it hasn’t started again yet, so nothing was started and nothing was spent. Try again in a moment, or choose another maker.', keepWords: true, next: 'wait' }
    case 'person_session_live':
      return { code: e.code, words: 'You already have a Studio session that hasn’t finished, so a new one wasn’t started. Stop it first, then start again.', keepWords: true, next: 'stop-then-new' }
    case 'maker_not_member':
    case 'role_drift':
    case 'attachment_drift':
    case 'execution_binding_unqualified':
      return { code: e.code, words: 'Something about the maker changed since you confirmed (its swarm, role, attachment or how it runs), so this session can’t resume. It stays paused. Stop it, then start a new session.', keepWords: true, next: 'stop-then-new' }
    case 'person_required':
      return { code: e.code, words: 'Only a signed-in person can direct Studio.', keepWords: true }
    case 'not_available':
      return { code: e.code, words: 'This hive can’t take directions for Studio right now. Your words are kept.', keepWords: true }
    case 'model_drift':
    case 'key_drift':
    case 'payer_mismatch':
      return { code: e.code, words: 'The maker’s model, key or payer changed since you confirmed, so nothing was started. Confirm again with what is true now.', keepWords: true }
    default:
      return { code: e.code, words: e.status === 0 ? 'The hive did not answer. Nothing is assumed: your words are kept.' : 'The hive refused that. Nothing is assumed: your words are kept.', keepWords: true }
  }
}
