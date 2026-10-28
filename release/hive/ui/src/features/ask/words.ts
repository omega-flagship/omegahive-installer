/**
 * The Ask's plain words. Refusals are said by the page, from the closed reason set (Host §7.2); the host's own text
 * is never shown, and neither is any raw error. The answering mind is never called Omega (the owner's ruling; the host
 * enforces it on the thread label and the page mirrors it).
 */
import type { DoneOutcome, RefusalReason } from '../../api/ask'
import type { HiveCapabilities, HiveMemory } from '../../lib/askMemory'
import { CHOOSE_WHO, HOST_SAY } from './answerer'

export interface Offer {
  kind: 'choose-swarm' | 'open-swarms' | 'wake' | 'new-thread' | 'raise-budget' | 'usage' | 'keys' | 'sessions' | 'retry' | 'stop'
  label: string
}

/** The owner 2026-10-05: an Ask thread starts at $0.25 and the person may raise it to $5. The page never sends more. */
export const THREAD_LIMIT_MAX_USD = 5
/** The steps offered when raising the limit for new threads (never above the host's maximum, never above $5). */
export const RAISE_STEPS_USD = [1, 2, 5] as const
export function raiseSteps(hostMax?: number | null): number[] {
  const cap = Math.min(typeof hostMax === 'number' && hostMax > 0 ? hostMax : THREAD_LIMIT_MAX_USD, THREAD_LIMIT_MAX_USD)
  return RAISE_STEPS_USD.filter((v) => v <= cap)
}
/** The raise offer's honest label: an open thread's limit is fixed when it starts; the raise is for new threads. */
export const RAISE_FOR_NEW = `Raise the limit for new threads (up to $${THREAD_LIMIT_MAX_USD})`

export const REFUSAL_WORDS: Record<RefusalReason, { say: string; offer?: Offer[] }> = {
  not_available: { say: 'Asking a mind isn’t available on this hive yet. Opening pages, looks and search still work here.' },
  not_allowed: { say: 'You don’t take part in that swarm, so its coordinator can’t answer you here.', offer: [{ kind: 'choose-swarm', label: CHOOSE_WHO }] },
  person_required: { say: 'Asking needs you signed in as yourself (with Google), not with the hive’s operator password.' },
  // who answers (Thread renders these with the picker, features/ask/Answerer): the host's own words, mirrored
  no_mind: { say: HOST_SAY.no_mind!, offer: [{ kind: 'choose-swarm', label: CHOOSE_WHO }] },
  no_orchestrator: { say: HOST_SAY.no_orchestrator!, offer: [{ kind: 'choose-swarm', label: CHOOSE_WHO }] },
  coordinator_busy: { say: 'The coordinator is working for someone else; try again shortly.', offer: [{ kind: 'retry', label: 'Try again' }] },
  payer_conflict: { say: 'Someone else is already working with that mind, so it can’t start for you now. Try again later.' },
  mind_asleep: { say: 'The coordinator that would answer is asleep. Ask never wakes it on its own.', offer: [{ kind: 'wake', label: 'Wake it' }] },
  spend_limit: { say: 'This has reached its spending limit. Nothing more was spent.', offer: [{ kind: 'new-thread', label: 'New thread' }, { kind: 'raise-budget', label: RAISE_FOR_NEW }, { kind: 'usage', label: 'See usage' }] },
  ask_busy: { say: 'Your earlier request is still being answered; it is shown here so you can follow it.', offer: [{ kind: 'stop', label: 'Stop it' }] },
  rate_limited: { say: 'That was a lot of asks in a short time. Wait a minute, then try again.' },
  too_large: { say: 'That request is too long to send. Shorten it to under 4,000 characters.' },
  // ask-send-r1 (live walk): the host's timed_out says only that the turn's deadline passed (hive/core/ask.py expire():
  // the turn RECORD closes; a late reply still lands in the room, ask.py module doc). The mind is not fenced and may
  // still spend or act, and no host frame says the turn settled after that, so no "Nothing was done" and no "Ask again"
  // here (the field stays open for a new request). The spend the host reports with it is added by refusedSay.
  timed_out: { say: 'No answer came in time.' },
  // operation_conflict and invalid are only ever HTTP refusals raised before anything is admitted (hive/core/ask.py
  // _decide and the admission transaction: `raise refusal(hive, "operation_conflict")` before the turn row is inserted;
  // _validate/_steer_body: "invalid"; steer: raised before any write), never a turn's frame (_close's reasons are
  // answer, stopped, takeover, timed_out, spend_limit). So for THIS request nothing was done: the claim holds.
  operation_conflict: { say: 'That request clashed with an earlier one. Nothing was done; ask again.', offer: [{ kind: 'retry', label: 'Ask again' }] },
  invalid: { say: 'The hive couldn’t take that request as it was. Nothing was done.' },
  stopped: { say: 'Stopped. Any later reply stays in the conversation.' },
  takeover: { say: 'You took over — the Ask stopped.' },
  // OI-13: never retried on its own; the request stays in the conversation to ask again once the key is added
  own_key_needed: { say: 'This mind would run on someone else’s key, so nothing was sent and nothing was spent. Add your own key in Keys, then ask again.', offer: [{ kind: 'keys', label: 'Add your own key' }] },
}

/** The person took over the page and the host ended the turn (done {outcome: cancelled, taken_over: true}). */
export const TAKEOVER_WORDS = 'You took over — the Ask stopped.'

/** A reason from an HTTP refusal (ApiError.code) or a frame; anything outside the closed set is "not available". */
/**
 * How the host ended a turn, in the page's own words (Platform r2 Q5: done carries no free text). `complete` says
 * nothing: the answer is there.
 */
export const DONE_WORDS: Record<DoneOutcome, string | null> = {
  complete: null,
  act_cap: 'Stopped here: the orchestrator reached its limit of steps on the page for one request.',
  call_cap: 'Stopped here: the orchestrator reached its limit of thinking for one request.',
  time_cap: 'Stopped here: this request ran out of time.',
  spend_cap: 'Stopped here: this request reached its spending limit.',
  cancelled: 'This request was stopped.',
  error: 'Stopped here: something went wrong on the hive’s side. Nothing more was done.',
}

/** What a stop offers right where it appears (spend-stop r1: a spending stop is never a dead end). */
export const DONE_OFFERS: Partial<Record<DoneOutcome, Offer[]>> = {
  spend_cap: [{ kind: 'new-thread', label: 'New thread' }, { kind: 'raise-budget', label: RAISE_FOR_NEW }],
}

/**
 * j0-fixes r1 (J0 live): which limit stopped a spending stop. Platform's ask-limits r1 adds `limit {kind, current_usd,
 * limit_usd, estimate_usd}` to the done frame; until a host sends it, the page knows only the thread's own figures.
 * Read as untrusted: a kind is a short word, figures are finite non-negative numbers or absent.
 */
export interface DoneLimit {
  kind: string
  current_usd: number | null
  limit_usd: number | null
  estimate_usd: number | null
}
export function readDoneLimit(v: unknown): DoneLimit | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o.kind !== 'string' || !/^[a-z_]{1,40}$/.test(o.kind)) return null
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null)
  return { kind: o.kind, current_usd: n(o.current_usd), limit_usd: n(o.limit_usd), estimate_usd: n(o.estimate_usd) }
}

/** Where a person sees and changes limits (the Usage panel's limits). */
export const USAGE_AND_LIMITS: Offer = { kind: 'usage', label: 'Usage & limits' }
/** Where a person's own model keys and their limits live (features/registry money.keys). */
export const YOUR_KEYS: Offer = { kind: 'keys', label: 'Your keys' }
const RAISE: Offer = { kind: 'raise-budget', label: RAISE_FOR_NEW }
const NEW: Offer = { kind: 'new-thread', label: 'New thread' }

/** The period a host figure is counted over is not in done.limit (Platform r1 open point 3): figures say only "of". */
const amounts = (l: DoneLimit) => (l.current_usd !== null && l.limit_usd !== null ? ` (${money(l.current_usd)} of ${money(l.limit_usd)})` : '')

/**
 * What each limit kind says, and the way on that actually helps with it (Platform ask-limits r1 LIMIT_KINDS):
 *  - the raise for new threads only for the thread's own cap. The per-turn cap is the hive's setting
 *    (HIVE_ASK_CONDUCTOR_TURN_USD), which the raise never changes, so a per-turn stop offers asking again instead;
 *  - a mind's, swarm's, hive's or person's limit is named with its figures and links to Usage & limits;
 *  - the key kinds point to the person's keys;
 *  - `session`: an ordinary work session on the mind caps it (ended from Messages, where sessions are listed).
 */
const LIMIT_STOP: Record<string, { say: string; offer: Offer[] }> = {
  thread: { say: 'Stopped here: this thread has used its spending limit{amounts}. Start a new thread to go on.', offer: [NEW, RAISE] },
  per_turn: { say: 'Stopped here: this request reached the spending limit for one turn{amounts}. Each turn starts with a fresh limit, so you can ask again to carry on.', offer: [{ kind: 'retry', label: 'Ask again' }] },
  mind_total: { say: 'Stopped here: this mind has reached its own spending limit{amounts}. Raising this thread’s limit would not help; an admin can raise the mind’s limit.', offer: [USAGE_AND_LIMITS] },
  session: { say: 'Stopped here: a work session on this mind caps what it may spend{amounts}. Ending that session lifts the cap.', offer: [{ kind: 'sessions', label: 'Sessions' }, USAGE_AND_LIMITS] },
  swarm: { say: 'Stopped here: this swarm has reached its spending limit{amounts}. An admin can raise the swarm’s limit.', offer: [USAGE_AND_LIMITS] },
  hive: { say: 'Stopped here: the hive has reached its spending limit{amounts}. An admin can raise the hive’s limit.', offer: [USAGE_AND_LIMITS] },
  member_allowance: { say: 'Stopped here: you have reached your spending allowance{amounts}. An admin can raise it.', offer: [USAGE_AND_LIMITS] },
  key: { say: 'Stopped here: the key that pays for this mind has reached its limit{amounts}. The key’s owner can raise it.', offer: [YOUR_KEYS] },
  own_key_limit: { say: 'Stopped here: the limit on the key paying for you has been reached{amounts}. If it is your own key, you can raise that limit.', offer: [YOUR_KEYS] },
  own_key_required: { say: 'Stopped here: this hive asks you to use your own model key. Add one to go on.', offer: [YOUR_KEYS] },
  no_key_grant: { say: 'Stopped here: you don’t have permission to spend on this hive’s key. Ask its owner, or add your own key.', offer: [YOUR_KEYS] },
  // OI-13 (a done.limit kind once the conductor names it; at 2d6c9f44 limit_kind maps scope "use" to "unknown")
  own_key_needed: { say: 'Stopped here: this mind would run on someone else’s key. Add your own key in Keys, then ask again.', offer: [{ kind: 'keys', label: 'Add your own key' }] },
}

/**
 * ask-send-r1: a refusal row's words, with the spend the host reported for that turn where it gave one (the refused
 * frame's turn_spent_usd, hive/core/ask.py _close). Only timed_out adds it: the deadline passed while the mind may have
 * been spending, so what the host counted by then is said as a fact, never as a final figure.
 */
export function refusedSay(reason: RefusalReason | undefined, turnSpentUsd?: number | null): string {
  const say = REFUSAL_WORDS[reason ?? 'not_available'].say
  if (reason !== 'timed_out' || typeof turnSpentUsd !== 'number' || !Number.isFinite(turnSpentUsd) || turnSpentUsd < 0) return say
  return `${say} The hive had counted ${money(turnSpentUsd)} spent on it by then.`
}

/** The plain fallback: the host did not name the limit (today's host, or kind `unknown`). No remedy is promised. */
export const SPEND_STOP_UNNAMED = 'Stopped here: a spending limit stopped this request, and the hive did not say which one. Usage & limits shows every limit.'

/** The thread's own limit is the visible block: what is left is less than one turn's reservation, or under a tenth. */
export const TURN_RESERVE_USD = 0.25
export function threadBinds(t: { spent_usd: number; budget_usd: number } | null | undefined): boolean {
  if (!t || !(t.budget_usd > 0)) return false
  const left = t.budget_usd - t.spent_usd
  return left <= Math.max(TURN_RESERVE_USD, t.budget_usd * 0.1)
}

/**
 * A spending stop in plain words, picked by the host's `done.limit.kind` (J0: "Raise the limit for new threads" was
 * offered when the thread had $0.00 of $5.00 spent, so it changed nothing). A known kind names its limit, with the
 * host's figures, and offers only the way on that helps. An unknown kind, or no `limit` at all (today's host), gets the
 * plain fallback with no remedy offered; the thread's own figures are added as a fact when the page has them. Nothing
 * is invented: no figure the host did not send.
 */
export function spendStop(limit: DoneLimit | null, thread?: { spent_usd: number; budget_usd: number } | null): { text: string; offer: Offer[] } {
  const known = limit ? LIMIT_STOP[limit.kind] : undefined
  if (limit && known) return { text: known.say.replace('{amounts}', amounts(limit)), offer: known.offer }
  const used = thread && Number.isFinite(thread.spent_usd) && Number.isFinite(thread.budget_usd) ? ` This thread has used ${money(thread.spent_usd)} of its ${money(thread.budget_usd)}.` : ''
  return { text: `${SPEND_STOP_UNNAMED}${used}`, offer: [] }
}

/**
 * Platform ask-limits r1: a model with no price, or a key that is gone, is not a limit. The turn ends with outcome
 * `error` and `done.error` naming it; each gets its own words. Any other code keeps the plain error words.
 */
export const DONE_ERROR_WORDS: Record<string, string> = {
  unpriced_model: 'Stopped here: the model the Ask uses has no price set, so the hive won’t spend money on it. An admin can set its price or choose another model.',
  key_unavailable: 'Stopped here: the key assigned to pay for this mind is gone or doesn’t fit its model. An admin can assign another key, or use the hive’s default.',
}
export function doneErrorWords(code: unknown): string {
  return typeof code === 'string' && Object.prototype.hasOwnProperty.call(DONE_ERROR_WORDS, code) ? DONE_ERROR_WORDS[code] : DONE_WORDS.error!
}

/** The HTTP spend refusal's ways on, by the same rule: the thread raise only when the thread is the visible block. */
export function spendRefusalOffers(thread: { spent_usd: number; budget_usd: number } | null | undefined): Offer[] {
  return threadBinds(thread) ? [NEW, RAISE, { kind: 'usage', label: 'See usage' }] : [USAGE_AND_LIMITS]
}

export function refusalOf(code: unknown): RefusalReason {
  return typeof code === 'string' && code in REFUSAL_WORDS ? (code as RefusalReason) : code === 'not_found' || code === 'wrong_route' || code === 'bad_request' ? 'invalid' : 'not_available'
}

/** The answering mind's name as shown. Never presented as Omega (Ω is the hive's mark; Omega is the name of one particular mind). */
export function shownMind(name: string | null | undefined): string {
  const n = (name ?? '').trim()
  if (!n || /^\s*omega\s*$/i.test(n) || /^Ω$/.test(n)) return 'the orchestrator'
  return n.slice(0, 60)
}

/** "Vega", "Vega about Altair": the thread's label (the owner's ruling: the orchestrator, about the addressed mind). */
export function threadLabel(mind: string | null | undefined, about?: string | null): string {
  const m = shownMind(mind)
  return about ? `${m} about ${shownMind(about)}` : m
}

export const money = (n: number) => `$${n.toFixed(2)}`

/**
 * j0-fixes r1: who pays for a paid Ask row, and the limit that holds, from what the page already has. The host bills
 * the asking person on the hive's key (core/conductor.py, Billing); a turn in flight, or a request to the thread's own
 * mind, shows that thread's figures; a new thread shows the limit new threads start with. The cost of a request is not
 * known before it starts, and is said so: no estimate is ever invented.
 */
export function paysLine(o: { steering: boolean; thread: { spent_usd: number; budget_usd: number; mind: { id: string } } | null; answererId: string | null; newThreadUsd: number | null | undefined }): string {
  // the same thread's figures only for the same mind, by IDENTITY (j0-fixes r1.6): two minds may share a name
  const sameThread = !!o.thread && (o.steering || (!!o.answererId && o.thread.mind.id === o.answererId))
  const limit = sameThread && o.thread ? `this thread has used ${money(o.thread.spent_usd)} of ${money(o.thread.budget_usd)}` : typeof o.newThreadUsd === 'number' && o.newThreadUsd > 0 ? `a new thread may spend up to ${money(o.newThreadUsd)}` : null
  return `Paid by you${limit ? ` · ${limit}` : ''} · no estimate before it starts`
}

/** j0-fixes r1: an app as the Ask names it to a person (the program id stays internal): omegadesign is "Studio". */
const APP_SHOWN: Record<string, string> = { omegadesign: 'Studio' }
export function appShown(id: string, name?: string | null): string {
  return APP_SHOWN[id] ?? (name || 'the app')
}

const KEPT = ' What this browser already keeps stays until you forget it.'
/**
 * The section's one line, in plain words. Once the host has said its switches (GET /api/me/ask capabilities) the
 * state is never "unknown": memory is off on this hive (its own switch, or the Ask's conductor is off), on with
 * nothing learned yet, or learning. Before the host says (an older host), the line hedges as before.
 */
export function memoryStatus(signedIn: boolean, hive: HiveMemory, caps: HiveCapabilities | null, learned: number): string {
  if (!signedIn) return 'Sign in and the Ask can start to remember you, in this browser.'
  if (caps && !caps.conductor) return `Memory is off on this hive: its Ask runs without the part that learns, so nothing new is learned here.${learned ? KEPT : ''}`
  if (hive === 'off') return `Memory is off on this hive: nothing new is learned here.${learned ? KEPT : ''}`
  if (hive === 'learning' || learned) return 'Kept only in this browser, for you on this hive. The hive stores none of it; each question sends the few notes that matter, for that answer only.'
  if (caps) return 'Nothing learned yet. Memory is on: when the Ask learns something about you, it is kept here, in this browser only.'
  return 'Nothing learned yet. When the hive’s Ask learns something about you, it is kept here, in this browser only. If this hive’s memory is off, nothing will be.'
}
