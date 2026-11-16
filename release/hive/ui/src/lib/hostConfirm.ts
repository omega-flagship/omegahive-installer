import { personStartedProgramAct } from './personSwarmAct'
import { ApiError, type HiveClient } from '../api/client'
import type { ActionResult, ProgramAction, ProgramActBody, ProgramDescription } from '../api/types'
import { assertConfirmSize, base64Bytes, canonicalJson, ConfirmTooLargeError, ConfirmValueError, confirmPayload, PAYLOAD_TOO_LARGE, payloadDigest, sha256Hex, UNSUPPORTED_VALUE, wireOf, type ConfirmPayload } from './confirmDigest'

/**
 * Host confirm for app acts (PROGRAMS.md §9d, Platform/Surface agreement 2026-10-05). An act on an action whose
 * describe says `confirm: true` (always so for `person_activity: true`) is shown to the person in the host's own
 * DecisionDialog first; only after they confirm does the host mint a confirm token for exactly that payload
 * (POST /api/programs/{id}/confirm) and send the act with `confirm_token` at the top level of the body. The token
 * stays in the host: it is never put in a reply to a frame, never in params, never stored.
 *
 * One rule for every caller (AppFrame, hive-native forms, the generic program host, Fusion): `prepareConfirm` before
 * the dialog (refuses unsupported values before any call), `runConfirmed` only from the person's confirm.
 *
 * Identity (review B1, 2026-10-05): an intent belongs to the connection it was admitted under. `runConfirmed` takes
 * the ORIGIN client (never the store's current one) and an `alive` check, and asks it before the mint, after every
 * await, and before any act: once it fails, nothing more is minted or sent and no outcome is reported as this one's.
 *
 * What the hive promises (§9d, review B2): one effectful delivery per confirm, not exactly-once effects.
 * - A lost or failed answer means the earlier attempt's effect is unknown. For an action with a host intent record
 *   (`person_activity`), the host first presents the SAME token once more: the hive accepts a spent token only to
 *   return a DONE intent's recorded result (nothing is delivered again), so a completed act is shown as done and the
 *   person is not asked twice (case a). A token the first send never spent is still that one confirmed delivery.
 * - Otherwise (the intent failed, is still running, or the answer is lost again) the person is asked afresh, told that
 *   the earlier attempt may already have had its effect and that confirming again may repeat it unless the app
 *   recovers it (case b). Only that new confirm mints a NEW token; the act carries the SAME idempotency key, so the
 *   hive marks it `prior_failed` for the app, or returns the recorded result if the intent completed meanwhile.
 * - An action that is not `person_activity` (confirm: true only) has no intent record and no host recovery: a fresh
 *   confirm says so plainly, since it can repeat the effect (case c).
 * - Still running (Kimi next22b/23b r2 #3): a send or the recovery check answered 409 `in_progress` means the intent is
 *   still being carried out. That is not a failure: the host re-checks a few times with backoff, presenting the SAME
 *   token (the hive answers `in_progress` before it looks at the token, and once the intent is done it returns the
 *   recorded result, §9d). It never mints, re-confirms or re-delivers while the hive says the intent is running. If
 *   it is still running when the re-checks run out, the outcome stays unknown and the person is offered only a
 *   further check, never a new confirm.
 */

/** The plain sentence for a confirm the hive no longer accepts (confirm_required, confirm_invalid). */
export const CONFIRM_AGAIN = 'This needs your confirmation again.'
/** The plain sentence when the hive could not be reached to ask for a confirm, or this hive cannot take one. */
export const CONFIRM_UNAVAILABLE = 'The hive could not take this confirmation just now. Nothing was sent.'
/** The plain sentence when the hive computed a different digest (a host bug; it should never happen). */
export const CONFIRM_MISMATCH = 'The hive could not match this confirmation to the action. Nothing was sent.'
/** Review B1: the connection, app or swarm changed before anything was sent for this confirm. */
export const IDENTITY_CHANGED = 'The connection, app or swarm changed while this was waiting, so it was not sent. Ask again from here if you still want it.'
/** Review B1: the change came after the act may have been sent; its outcome belongs to the earlier connection. */
export const IDENTITY_CHANGED_SENT = 'The connection, app or swarm changed after this was sent, so its outcome is not shown here. It may already have had its effect; check the app before trying again.'

/** Why the person is asked again: the earlier attempt's answer was lost, it failed, or it is still running. */
export type PriorAttempt = 'lost' | 'failed' | 'running'

/**
 * The words for a repeat confirm (review B2, §9d). `recovery`: the action has a host intent record (person_activity),
 * so a completed earlier attempt is returned as its recorded result rather than delivered again.
 */
export function priorWords(prior: PriorAttempt, recovery: boolean, app: string): string {
  if (!recovery) {
    const first = prior === 'failed'
      ? `The earlier attempt failed, and the hive cannot tell whether ${app} acted before it failed.`
      : 'The hive did not answer last time, so the earlier attempt may already have had its effect.'
    return `${first} This action has no recovery in the hive: confirming again sends it again, and ${app} may do it a second time unless it recovers the earlier attempt itself.`
  }
  if (prior === 'running')
    return `The earlier attempt is still being carried out, so it may already have had its effect. Wait a moment before confirming again: if it has finished by then, you see its result and nothing is sent again; if it failed, confirming sends it again and ${app} may repeat it unless it recovers it.`
  const first = prior === 'failed'
    ? `The earlier attempt did not finish, and the hive cannot tell whether ${app} acted before it failed.`
    : 'The hive did not answer last time, so the earlier attempt may already have had its effect.'
  return `${first} Confirming again sends it again: if the hive finished it, you see that result and nothing is sent again; otherwise ${app} may repeat it unless it recovers the earlier attempt.`
}

/** Said when the person cancels a repeat confirm: the earlier attempt's outcome stays unknown. */
export const DECLINED_UNKNOWN = 'You cancelled. Nothing more was sent, but the earlier attempt may already have had its effect; check the app before trying again.'

/**
 * Still running after the bounded re-check (Kimi r2 #3): the outcome is not known yet. Nothing more is sent while the
 * hive says it is running; the person may check again (the same token, which can only return the result) or close.
 */
export function runningWords(app: string): string {
  return `The earlier attempt is still being carried out, and the hive had not finished it when it was checked again. Whether ${app} has acted is not known yet. Nothing more is sent while it is running: check again in a moment to see how it ended.`
}
/** Said when the person closes the still-running dialog: the outcome stays unknown. */
export const CLOSED_RUNNING = 'You closed this while the earlier attempt was still running. Nothing more was sent, but it may still finish and have its effect; check the app before trying again.'

/**
 * The bounded re-check of an intent the hive says is still running: one check after each delay (backoff), with the
 * same token. Mutable only so tests can run it without waiting.
 */
export const RECHECK = { delaysMs: [1000, 2000, 4000] as number[] }
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

export { PAYLOAD_TOO_LARGE, UNSUPPORTED_VALUE }

/** The action as the host's describe shows it (undefined when describe is not loaded or does not list it). */
export function actionOf(describe: ProgramDescription | null | undefined, action: string): ProgramAction | undefined {
  return describe?.actions?.find((a) => a.id === action)
}

/**
 * Whether an act on this action needs the host confirm. The hive's describe carries the effective `confirm` on every
 * action; `person_activity: true` always needs it. Unknown (describe not loaded, or the action not in it): confirm, to
 * be safe.
 */
export function needsConfirm(describe: ProgramDescription | null | undefined, action: string): boolean {
  const a = actionOf(describe, action)
  if (!a) return true
  return a.confirm === true || a.person_activity === true
}

/** person_activity as describe shows it; null when unknown. */
export function personActivity(describe: ProgramDescription | null | undefined, action: string): boolean | null {
  const a = actionOf(describe, action)
  return a ? a.person_activity === true : null
}

/** What the person is asked to confirm, and the exact body that will be sent (without the token). */
export interface ConfirmIntent {
  programId: string
  /** The act body as it will be sent: swarm fixed by the host, the host's idempotency key. No confirm_token. */
  body: ProgramActBody
  /**
   * person_activity as describe showed it when the intent was prepared (null: unknown). True: the hive keeps an intent
   * record, so a completed earlier attempt is recovered, not delivered again. False: a confirm: true action, whose
   * token is strictly single use with no recovery (§9d).
   */
  personActivity?: boolean | null
  /** Set once an earlier attempt of this same intent got no answer, failed, or was still running: the dialog says so. */
  prior?: PriorAttempt
}

/** The words may promise host recovery only when describe said person_activity; unknown is worded as no recovery. */
export const recoveryOf = (intent: ConfirmIntent) => intent.personActivity === true
/** The recovery check (re-presenting the spent token) is tried unless describe said the action is not person_activity. */
const mayRecover = (intent: ConfirmIntent) => intent.personActivity !== false

export type Prepared = { ok: true; intent: ConfirmIntent } | { ok: false; reason: 'invalid' | 'too-large'; message: string }

/**
 * Before the dialog: fix the body that will be sent and refuse what cannot be confirmed (unsupported numbers), so
 * nothing is shown or minted for it. A person_activity act (or one whose describe is unknown) gets an idempotency key
 * the host makes, one per confirmed intent, unless the caller already chose one for this intent.
 */
export function prepareConfirm(programId: string, body: ProgramActBody, describe: ProgramDescription | null | undefined, opts: { key?: string } = {}): Prepared {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { confirm_token: _never, ...rest } = body as ProgramActBody & { confirm_token?: unknown }
  const pa = personActivity(describe, body.action)
  const key = opts.key ?? rest.idempotency_key ?? (pa !== false || rest.file ? crypto.randomUUID() : undefined)
  const out = { ...rest, ...(key ? { idempotency_key: key } : {}) } as ProgramActBody
  try {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { file: _file, ...plain } = out
    // the file entry is strings and a byte count (always supported, and small); its bytes are never in the payload
    assertConfirmSize(canonicalJson(confirmPayload(wireOf(plain))))
  } catch (e) {
    if (e instanceof ConfirmTooLargeError) return { ok: false, reason: 'too-large', message: PAYLOAD_TOO_LARGE }
    return { ok: false, reason: 'invalid', message: UNSUPPORTED_VALUE }   // ConfirmValueError, or a body that is not JSON at all
  }
  return { ok: true, intent: { programId, body: out, personActivity: pa } }
}

/** The payload the token binds and its digest, for the body exactly as it will be sent (file bytes hashed as sent). */
export async function payloadOf(body: ProgramActBody): Promise<{ payload: ConfirmPayload; digest: string }> {
  const wire = wireOf(body)
  const f = wire.file
  const file = f ? { name: f.name, mime: f.mime, size: f.size, sha256: `sha256:${await sha256Hex(base64Bytes(f.content_base64))}` } : null
  const payload = confirmPayload(wire, file)
  return { payload, digest: await payloadDigest(payload) }
}
export const digestOf = async (body: ProgramActBody) => (await payloadOf(body)).digest

export type ConfirmOutcome =
  /** `recovered`: the answer came from the recovery check (a done intent's recorded result; nothing delivered again). */
  | { kind: 'done'; result: ActionResult; recovered?: boolean }
  /**
   * The earlier attempt's effect is unknown (`intent.prior` says why) and the hive did not return it as done. Ask the
   * person again with the repeat-risk words (same intent, same key; a new token only from that new confirm).
   */
  | {
      kind: 'uncertain'
      intent: ConfirmIntent
      /**
       * Set only while the hive still says the intent is running (`intent.prior === 'running'`) after the bounded
       * re-check: another bounded check with the same token. It never mints, and the person is not asked to confirm.
       */
      recheck?: () => Promise<ConfirmOutcome>
    }
  /** The identity the intent was admitted under changed (review B1): nothing more was minted or sent. `sent`: the act may already have gone. */
  | { kind: 'stale'; sent: boolean; message: string }
  /** The hive refused the confirm (confirm_required / confirm_invalid): ask again. */
  | { kind: 'again'; message: string }
  /** The payload holds a value the hive cannot check (refused here, or 400 confirm_unsupported_value). */
  | { kind: 'unsupported'; message: string }
  /** The canonical payload is over 2 MiB (refused here, or 413 confirm_payload_too_large at mint or act). */
  | { kind: 'too-large'; message: string }
  /** Any other refusal or failure (not about the confirm). */
  | { kind: 'failed'; error: unknown }

export const lostAnswer = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.code === 'network')
/** 409 in_progress: the intent this key names is still being carried out (§9d). */
const inProgress = (e: unknown) => e instanceof ApiError && e.code === 'in_progress'

/** How a hive refusal about the confirm reads; null when it is not one. Hive text is never shown for these. */
export function confirmRefusal(e: unknown): { kind: 'again' | 'unsupported' | 'too-large'; message: string } | null {
  if (e instanceof ConfirmValueError) return { kind: 'unsupported', message: UNSUPPORTED_VALUE }
  if (e instanceof ConfirmTooLargeError) return { kind: 'too-large', message: PAYLOAD_TOO_LARGE }
  if (!(e instanceof ApiError)) return null
  if (e.code === 'confirm_required' || e.code === 'confirm_invalid') return { kind: 'again', message: CONFIRM_AGAIN }
  if (e.code === 'confirm_unsupported_value') return { kind: 'unsupported', message: UNSUPPORTED_VALUE }
  if (e.code === 'confirm_payload_too_large') return { kind: 'too-large', message: PAYLOAD_TOO_LARGE }
  if (e.code === 'confirm_digest_mismatch') {
    // never expected: the host's canonical form disagrees with the hive's (a bug in lib/confirmDigest), shown plainly
    if (import.meta.env?.DEV) console.error('confirm_digest_mismatch: lib/confirmDigest disagrees with the hive (§9d)', e)
    return { kind: 'again', message: CONFIRM_MISMATCH }
  }
  return null
}

export type ConfirmTransport = Pick<HiveClient, 'programAct'> & Partial<Pick<HiveClient, 'confirmAct' | 'hostProgramAct'>>

/** An act error after which the effect is unknown: no answer (lost), or the hive/program failed (5xx: intent failed). */
function priorOf(e: unknown): PriorAttempt | null {
  if (lostAnswer(e)) return 'lost'
  if (e instanceof ApiError && e.code === 'in_progress') return 'running'
  if (e instanceof ApiError && e.status >= 500) return 'failed'
  return null
}

const stale = (sent: boolean): ConfirmOutcome => ({ kind: 'stale', sent, message: sent ? IDENTITY_CHANGED_SENT : IDENTITY_CHANGED })

/**
 * Call ONLY from the person's confirm in the host's dialog (or a caller's own full-context confirm). Mints one token
 * for this body and sends the act with it at the top level, once.
 *
 * `client` is the client the intent was ADMITTED under (never the store's current one), and `alive` says whether that
 * identity (client, store session, app, swarm, the dialog itself) is still the current one. It is checked before the
 * mint, after every await, and before any act; once false, nothing more is minted or sent and the outcome is `stale`.
 *
 * An unknown outcome (lost answer, failed intent) of a person_activity act (or one describe does not show) is checked
 * once by presenting the same token again: the hive answers a DONE intent with its recorded result and delivers
 * nothing (§9d), refuses it for a failed one (confirm_invalid), or says it is still running (in_progress). Anything but
 * a result comes back `uncertain` for the person to be asked afresh; a token is never minted without that confirm.
 * `sending` is told just before the act is sent (from then on a cancellation must not say "nothing was sent").
 */
export async function runConfirmed(client: ConfirmTransport, intent: ConfirmIntent, alive: () => boolean = () => true, sending: () => void = () => undefined): Promise<ConfirmOutcome> {
  const body = wireOf(intent.body)
  let token: string
  try {
    if (!alive()) return stale(false)
    if (!client.confirmAct) return { kind: 'failed', error: new ApiError(0, 'confirm_unavailable', CONFIRM_UNAVAILABLE) }
    const { payload, digest } = await payloadOf(body)
    if (!alive()) return stale(false)
    token = (await client.confirmAct(intent.programId, body.swarm_id, body.action, payload, digest)).confirm_token
  } catch (e) {
    if (!alive()) return stale(false)
    const c = confirmRefusal(e)
    if (c) return c
    // a mint that got no answer changed nothing: the act was never sent
    return { kind: 'failed', error: lostAnswer(e) ? new ApiError(0, 'network', CONFIRM_UNAVAILABLE) : e }
  }
  // the token is discarded unused if the identity moved while it was minted: never sent under another identity
  if (!alive()) return stale(false)
  const sent = { ...body, confirm_token: token }
  let prior: PriorAttempt
  try {
    sending()   // from here the act may have gone, whatever happens next
    const result = await personStartedProgramAct(client, intent.programId, sent, alive)
    return alive() ? { kind: 'done', result } : stale(true)
  } catch (e) {
    if (!alive()) return stale(true)
    const c = confirmRefusal(e)
    if (c) return c
    const p = priorOf(e)
    if (!p) return { kind: 'failed', error: e }
    prior = p
  }
  if (!mayRecover(intent)) return { kind: 'uncertain', intent: { ...intent, prior } }
  // still running: never a failure; re-check (bounded, same token) and never re-confirm or re-deliver meanwhile
  if (prior === 'running') return recheckRunning(client, intent, sent, alive)
  // the recovery check: the same token, the same body. A done intent comes back as its recorded result, delivered
  // nowhere; a failed one is refused (confirm_invalid); a running one is in_progress. Never a second token here.
  const checked = await checkOnce(client, intent, sent, alive)
  if (checked.kind === 'running') return recheckRunning(client, intent, sent, alive)
  if (checked.kind === 'unknown') return { kind: 'uncertain', intent: { ...intent, prior: checked.prior ?? prior } }
  return checked.outcome
}

type Check = { kind: 'outcome'; outcome: ConfirmOutcome } | { kind: 'running' } | { kind: 'unknown'; prior: PriorAttempt | null }

/** One recovery check with the token already presented: done, refused (failed), lost, or still running. */
async function checkOnce(client: ConfirmTransport, intent: ConfirmIntent, sent: ProgramActBody, alive: () => boolean): Promise<Check> {
  try {
    const result = await client.programAct(intent.programId, sent)
    return { kind: 'outcome', outcome: alive() ? { kind: 'done', result, recovered: true } : stale(true) }
  } catch (e) {
    if (!alive()) return { kind: 'outcome', outcome: stale(true) }
    if (inProgress(e)) return { kind: 'running' }
    if (e instanceof ApiError && e.code === 'confirm_invalid') return { kind: 'unknown', prior: 'failed' }   // the hive has it, not done
    return { kind: 'unknown', prior: priorOf(e) }
  }
}

/**
 * Kimi r2 #3: the hive says the intent is still running. Check again after each RECHECK delay with the same token
 * (nothing is minted, confirmed or delivered while it runs). Done: its result. Failed or lost: the person is asked
 * afresh with the repeat-risk words. Still running when the checks run out: unknown, with `recheck` for a further
 * bounded check the person may ask for.
 */
async function recheckRunning(client: ConfirmTransport, intent: ConfirmIntent, sent: ProgramActBody, alive: () => boolean): Promise<ConfirmOutcome> {
  for (const ms of RECHECK.delaysMs) {
    await pause(ms)
    if (!alive()) return stale(true)
    const c = await checkOnce(client, intent, sent, alive)
    if (c.kind === 'outcome') return c.outcome
    if (c.kind === 'unknown') return { kind: 'uncertain', intent: { ...intent, prior: c.prior ?? 'failed' } }
  }
  if (!alive()) return stale(true)
  return { kind: 'uncertain', intent: { ...intent, prior: 'running' }, recheck: () => recheckRunning(client, intent, sent, alive) }
}

/** A short, plain summary of params for the dialog (values truncated; never the whole object dumped). */
export function paramsSummary(params: Record<string, unknown> | undefined, max = 6): string {
  const entries = Object.entries(params ?? {})
  if (!entries.length) return 'None'
  const show = (v: unknown) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
    return s.length > 80 ? `${s.slice(0, 79)}…` : s
  }
  const lines = entries.slice(0, max).map(([k, v]) => `${k}: ${show(v)}`)
  if (entries.length > max) lines.push(`and ${entries.length - max} more`)
  return lines.join(' · ')
}

/** What a frame is told about a confirmed act: the result only (never the token), or a §9c reason. */
export type FrameConfirmReason = 'confirm-required' | 'declined' | 'busy' | 'unavailable' | 'person-required' | 'invalid' | 'too-large'
export function frameConfirmReply(id: string, outcome: { kind: 'done'; result: ActionResult } | { kind: 'refused'; reason: FrameConfirmReason }) {
  return outcome.kind === 'done'
    ? { type: 'app-reply' as const, id, ok: true as const, result: outcome.result }
    : { type: 'app-reply' as const, id, ok: false as const, error: outcome.reason, reason: outcome.reason }
}

/** The §9c reason for a confirm outcome that is not a result. */
export function frameReason(o: Exclude<ConfirmOutcome, { kind: 'done' } | { kind: 'uncertain' } | { kind: 'stale' }>, fallback: (e: unknown) => FrameConfirmReason = () => 'unavailable'): FrameConfirmReason {
  if (o.kind === 'again') return 'confirm-required'
  if (o.kind === 'unsupported') return 'invalid'
  if (o.kind === 'too-large') return 'too-large'
  return fallback(o.error)
}
