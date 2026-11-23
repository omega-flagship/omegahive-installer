// Purpose: the universal Ask's wire contract on the page: its requests, frames, acts and act results, and the checks
// that read each one exactly as the host sends or takes it.
import type { KeySetup } from '../features/ownKey/addOwnKey'
import { ApiError } from './client'
import { readAppAskRecipient, type AppAskRecipient } from './appAsk'
import type { Exchange } from '../lib/askMemory/types'

/**
 * The universal Ask's wire shapes (UNIVERSAL_ASK_HOST_CONTRACT_DRAFT_20261005 §1, §4, and its amendments: context.view,
 * Jon's ruling that the swarm's orchestrator answers, and the presence phase). Platform owns these; Surface reads them.
 * Every frame is checked here before the store uses it: a malformed one is dropped (logged in dev only).
 */

export type AskVia = 'typed' | 'voice'
export type SelectionKind = 'mind' | 'swarm' | 'goal' | 'room' | 'artifact' | 'item' | 'feature'

/**
 * What the page shows and can do (Host amendment §1.1; ≤ 2 KB; untrusted page data on the host). Exact keys on the
 * built host (6100794): refs ≤ 50 of {kind, ref}, acts ≤ 50, summary ≤ 500, which the host accepts but never
 * forwards to the mind. Labels and titles stay on the page.
 */
export interface AskView {
  refs?: { kind: SelectionKind; ref: string }[]
  acts?: string[]
  summary?: string
  /** fields the conductor may fill (vocabulary v1 §3): never sent for private apps */
  fields?: AskField[]
  /** named regions it may point at, highlight or scroll to (vocabulary v1 §3) */
  regions?: string[]
}

/** A field a page declared fillable (features/ask/fields useAskFillable). */
export interface AskField {
  id: string
  label: string
  kind: 'text' | 'search' | 'prompt'
}
/**
 * The host's limits on the view's fields and regions (Platform r2 Q1): at most 32 of each; ids and region names match
 * VIEW_NAME; a label is 1–80 characters with no control characters; kind is text, search or prompt.
 */
export const VIEW_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const VIEW_FIELDS_MAX = 32
export const VIEW_REGIONS_MAX = 32
export const FIELD_LABEL_MAX = 80
export const FIELD_KINDS: readonly AskField['kind'][] = ['text', 'search', 'prompt']
/**
 * Not printable as the host judges it (Python str.isprintable(), ask.py:185): control, format, surrogate, private-use,
 * unassigned, line/paragraph separators, and every space separator except the ASCII space (so U+200B, U+00A0, U+00AD fail).
 */
const NOT_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u
/** A field label as the host takes it: trimmed to 80, or null when empty or holding anything the host calls unprintable. */
export function fieldLabel(v: unknown): string | null {
  if (typeof v !== 'string' || NOT_PRINTABLE.test(v)) return null
  const t = v.trim().slice(0, FIELD_LABEL_MAX)
  return t ? t : null
}
/** A field exactly as the host takes it ({id, label, kind}, conforming), or null. */
export function conformingField(f: unknown): AskField | null {
  if (!f || typeof f !== 'object') return null
  const o = f as Record<string, unknown>
  const label = fieldLabel(o.label)
  if (typeof o.id !== 'string' || !VIEW_NAME.test(o.id) || !label || !FIELD_KINDS.includes(o.kind as AskField['kind'])) return null
  return { id: o.id, label, kind: o.kind as AskField['kind'] }
}

/**
 * A private app's page (Atlas, Truth): the turn context is exactly `{ private: true }`, with no route, ids, kinds or
 * view (Platform r2 Q6, 2026-10-07; supersedes the 10-05 ids-and-kinds allowance for the Ask turn context).
 */
export interface PrivateAskContext {
  private: true
}
/** The turn context: a page's, or a private app's `{ private: true }`. */
export type AskContext = PageAskContext | PrivateAskContext

/** A page's context (any page but a private app's). */
export interface PageAskContext {
  route: string
  experience: string
  program?: string
  swarm_id?: string
  /** a mind the person addressed: its swarm's coordinator answers, about it (Jon's ruling; context only, no authority) */
  mind?: string
  /**
   * the mind whose chat or card the person is using (features/ask/mindInUse): the turn is routed to its swarm and that
   * mind speaks (Jon, 16 Nov: "the ask will auto route to whichever mind you're interacting with"); `mind` and an
   * explicit choice still win, and the host passes over one whose swarm the Ask may not use
   */
  with?: string
  /**
   * the person chose the mind in `mind` to answer (their pick in the Ask, or an @Name address: "@Name still lets you
   * choose"), so it speaks for the turn; a mind only named in the words is asked about. Only ever true, beside `mind`
   */
  chosen?: true
  selection?: { kind: SelectionKind; ref: string }[]
  view?: AskView
}

export interface AskBody {
  /** Only after the page-owned Iter is ready; the host still decides route eligibility. */
  answer_in?: 'browser'
  operation_id: string
  text: string
  context: AskContext
  /** an existing thread to continue; omitted = the person's current thread with that orchestrator */
  thread?: string
  /** Continue alone names the accepted, ended turn whose hand-overs must not be repeated (Jon on #394). */
  continues?: string
  via: AskVia
  /**
   * The page opens this turn only to carry the words to another swarm on its intent (Create's Code bench: the person's
   * change goes to Code as a code.request). The host admits it for that intent and closes it at once: no conductor,
   * model or mind answers it, so the words never become a build of their own (API.md, POST /api/ask). Never with
   * memory_notes or answer_in.
   */
  carry?: true
  /**
   * The person's own memory, recalled by this browser for this turn only (lib/askMemory; Jon 2026-10-07: memory is kept
   * by the browser, the hive stores none of it). At most 20 notes and 8 KB; each `{id, text}` so a revise can name it.
   * Accepted only while the hive's conductor answers (otherwise 400 invalid: the page sends again without them).
   */
  memory_notes?: (string | { id: string; text: string })[]
  /**
   * The person's Ask conversation so far, kept by this browser (lib/askMemory `conversation`): its latest exchanges,
   * oldest first, each with the mind that answered. Every turn carries it to whichever mind answers (Jon, 16 Nov: "context
   * and continuity are consistently persistent regardless of which model you interact"); the host holds it for that turn
   * only. At most 8 exchanges and 8 KB (host conductor.check_conversation).
   */
  conversation?: Exchange[]
  /**
   * The person said Go ahead after this answer stopped as expensive (Jon on #294: an outlier asks once): this turn never
   * stops to ask. Only `true`; the host refuses anything else (400 invalid). Sent only from that offer, never kept.
   */
  go_ahead?: true
}

/** Host gateway r1b DONE_WORDS; closing never changes an existing operation's owner. */
export type BrowserOutcome = 'answered' | 'incomplete' | 'spend_cap' | 'failed' | 'stopped'
export interface BrowserAskClosed {
  operation_id: string
  turn_id: string
  route: 'browser_mind'
  state: 'done' | 'refused'
}

export interface AskWho {
  id: string
  name: string
}

/** One Ask thread: a Session with the swarm's orchestrator. */
export interface AskThread {
  id: string
  /** the orchestrator answering (the swarm's coordinator) */
  mind: AskWho
  /** the mind the person addressed, when they did */
  about?: AskWho | null
  swarm?: AskWho | null
  /** always 0 now: an Ask thread holds no cap of its own (Jon on #294), so the page shows its spend only */
  budget_usd: number
  spent_usd: number
}

/** The host's turn view (202 from POST /api/ask; also the base of the recovery read). */
export interface AskAccepted {
  /** Persistent P1 origin metadata: recovery must suppress unstamped legacy automatic effects. */
  app_ask?: true
  operation_id: string
  turn_id: string
  thread: AskThread
  state: 'accepted' | 'thinking' | 'done' | 'refused' | 'browser'
  route?: 'browser_mind'
  month_remaining_usd?: number | null
  reason?: RefusalReason | null
  text?: string
  /** how the request was made (audit only; the host's turn view carries it) */
  via?: AskVia
  turn_spent_usd?: number | null
  /** present when the hive's conductor answers this turn (hive/core/ask.py view): memory frames may come */
  conductor?: { model: string } | null
  /** the person's own mind answers for them (Platform P2; absent on older hosts): read with readActingAs */
  acting_as?: unknown
  /** the mind whose voice answers, {mind_id, name} (hive/core/personal.py speaker; absent on older hosts): read with readActingAs */
  speaks_as?: unknown
}

export type RefusalReason =
  | 'not_available'
  | 'not_allowed'
  | 'person_required'
  | 'no_mind'
  | 'no_orchestrator'
  /** the coordinator is answering another person's turn (one person's open turn at a time; c63a53f) */
  | 'coordinator_busy'
  | 'mind_asleep'
  | 'spend_limit'
  | 'ask_busy'
  | 'rate_limited'
  | 'too_large'
  | 'timed_out'
  | 'operation_conflict'
  | 'invalid'
  | 'stopped'
  /** a turn a hive closed when the person touched the page, before the person's use of the page stopped ending turns:
   *  its record and recovery view only, never a frame */
  | 'takeover'
  /** ordinary Sessions (not an Ask reason): two people on one mind; mapped in case a Sessions call surfaces here */
  | 'payer_conflict'
  /** OI-13: the mind would run on another person's key (402 before any spend); the way on is the person's own key */
  | 'own_key_needed'

export const REFUSAL_REASONS: readonly RefusalReason[] = ['not_available', 'not_allowed', 'person_required', 'no_mind', 'no_orchestrator', 'coordinator_busy', 'mind_asleep', 'spend_limit', 'ask_busy', 'rate_limited', 'too_large', 'timed_out', 'operation_conflict', 'invalid', 'stopped', 'takeover', 'payer_conflict', 'own_key_needed']

export type PresenceVerb = 'look' | 'point' | 'go' | 'arrange' | 'propose' | 'sketch'
export const PRESENCE_VERBS: readonly PresenceVerb[] = ['look', 'point', 'go', 'arrange', 'propose', 'sketch']
/** A hand-drawn mark (verb `sketch`): points normalised 0..1 to the target element's box. */
export type InkShape = 'circle' | 'underline' | 'arrow' | 'tick' | 'cross' | 'path'
export const INK_SHAPES: readonly InkShape[] = ['circle', 'underline', 'arrow', 'tick', 'cross', 'path']
export const INK_MAX_POINTS = 64
export interface Ink {
  shape: InkShape
  points?: [number, number][]
}
export type PresenceKind = 'mind' | 'swarm' | 'goal' | 'room' | 'artifact' | 'item'
export const PRESENCE_KINDS: readonly PresenceKind[] = ['mind', 'swarm', 'goal', 'room', 'artifact', 'item']
export interface PresenceTarget {
  feature?: string
  entity?: { kind: PresenceKind; ref: string }
  region?: string
}

export interface NavigateProposal {
  id: string
  kind: 'navigate'
  /** a hash route, e.g. "#/goals" or a route name */
  route: string
  /** play the experience's own transition (Jon, 2026-10-05); default false: the page moves instantly */
  animate?: boolean
  digest: string
  label?: string
}
export interface UiProposal {
  id: string
  kind: 'ui'
  prefs: { variant?: unknown; layout?: string | null; experience?: string | null; density?: string }
  digest: string
  label?: string
}
export interface AppActProposal {
  id: string
  kind: 'app_act'
  program: string
  action: string
  items: string[]
  params: Record<string, unknown>
  digest: string
  label: string
}

/**
 * The conductor's on-screen acts (ASK_CONDUCTOR_ACTION_VOCABULARY_v1_20261007 §1, confirmed by Platform). Every one is
 * on-screen only and instant: navigate, open and look get Undo, presence acts fade. Nothing here changes the hive.
 */
export type ConductorAct = { act_id: string; label?: string } & (
  | { kind: 'navigate'; route: string; animate?: boolean }
  | { kind: 'open'; feature: string; entity?: { kind: PresenceKind; ref: string } }
  | { kind: 'look'; prefs: { variant?: string | null; layout?: string | null; experience?: string | null; density?: string } }
  | { kind: 'point'; target: PresenceTarget; caption?: string }
  | { kind: 'highlight'; target: PresenceTarget; caption?: string; ink?: Ink }
  | { kind: 'fill'; field: string; text: string }
  | { kind: 'scroll'; target?: PresenceTarget; to?: 'top' | 'bottom' }
  | { kind: 'tour.step'; script: string; step: number }
)
export type ConductorActKind = ConductorAct['kind']
export const ACT_KINDS: readonly ConductorActKind[] = ['navigate', 'open', 'look', 'point', 'highlight', 'fill', 'scroll', 'tour.step']
/** An act frame whose act could not be read: never applied, only answered ok:false (so the host does not wait). */
export interface UnreadableAct {
  act_id: string
  kind: 'unreadable'
}
export const ACT_CAPTION_MAX = 140
export const ACT_FILL_MAX = 4000

/**
 * Why an act was not done, or how it was done (a closed set; Platform r2 Q3). Blocks: `invalid` (malformed, or it cannot
 * be done as asked), `not_declared` (a field, region, feature, route or script the page or registry does not declare),
 * `act_cap` (past 32 acts in a turn), `private` (Atlas/Truth), `blocked` (it could not proceed, for no more specific
 * reason: the page could not open it here, or applying it failed; as in the vocabulary, r3). Kept from the confirmed result body (§2): `stale_origin`
 * (the turn is not the open one, or the person has the page) and `reduced_motion_skipped` (ok, shown without motion).
 */
export type ActReason = 'invalid' | 'not_declared' | 'act_cap' | 'private' | 'blocked' | 'stale_origin' | 'reduced_motion_skipped'
export const ACT_REASONS: readonly ActReason[] = ['invalid', 'not_declared', 'act_cap', 'private', 'blocked', 'stale_origin', 'reduced_motion_skipped']
/** How the host ended a turn (Platform r2 Q5): a closed set, said in the page's own words (features/ask/words). */
export type DoneOutcome = 'complete' | 'act_cap' | 'call_cap' | 'time_cap' | 'spend_cap' | 'cancelled' | 'error'
export const DONE_OUTCOMES: readonly DoneOutcome[] = ['complete', 'act_cap', 'call_cap', 'time_cap', 'spend_cap', 'cancelled', 'error']
/** POST /api/ask/{op}/acts/{act_id}/result: what the act did, and the page as it is now. At most 8 KB. */
export interface ActResult {
  ok: boolean
  reason?: ActReason
  view: AskView
  route: string
  experience: string
  /** Reads still in flight when the page was read (features/ask/conductor settledPage ran out of time): its view may be
   *  incomplete or the page before. 1 to 1000; absent once the page settled, and never for a private app's page. */
  loading?: number
}
export const ACT_RESULT_MAX_BYTES = 8192

/** A linkage intent the host handed elsewhere (shown only; its progress comes from the intent and proposal reads). */
export interface DispatchedTo {
  kind: 'swarm' | 'service' | 'app'
  ref: string
  name?: string
}

/** Where an intent recorded on a turn stands (hive/core/ask_intents.py STATES). */
export const INTENT_STATES = ['pending', 'dispatching', 'linked', 'refused', 'abandoned'] as const
export type IntentState = (typeof INTENT_STATES)[number]
/** How a research task ended (hive/core/research.py FINISHED). */
export const RESEARCH_STATES = ['done', 'failed', 'cancelled'] as const
export type ResearchState = (typeof RESEARCH_STATES)[number]

/** A source one claim cites, as research.check judged it: `verified` only for the very address the researcher fetched. */
export interface ResearchCitation {
  url: string
  title?: string
  quote?: string
  verified: boolean
  /** how the address matched a page the researcher fetched (research.check): exact, by path, or not at all */
  match?: 'exact' | 'path' | null
}
/** One claim of a report; `cited` when at least one of its sources is a page the researcher fetched. */
export interface ResearchClaim {
  text: string
  cited: boolean
  citations: ResearchCitation[]
}
export interface ResearchSection {
  heading: string
  claims: ResearchClaim[]
}
export interface ResearchReport {
  summary: string
  sections: ResearchSection[]
  open_questions: string[]
  /** how many claims there are, and how many cite a page the researcher fetched */
  checks: { claims: number; cited: number }
}
/** GET /api/research/{request_id} (research.view): a report as the person who asked may read it; null until it is done. */
export interface ResearchView {
  request_id: string
  title: string
  state: string
  report: ResearchReport | null
}

interface Frame<P extends string> {
  app_ask?: true
  type: 'ask'
  operation_id: string
  turn_id: string
  seq: number
  at: string
  phase: P
}

export type AskEvent =
  /**
   * `conducted`: the host's conductor answers this turn (hive/core/ask.py), whose tools hold no web search, with the
   * asker's own mind's model (`mind`, a turn with that mind) or the model the Ask uses (`ask`)
   */
  | (Frame<'accepted'> & { thread: AskThread; conducted?: 'mind' | 'ask' })
  /** `truncated: true` with an empty step: the host trimmed later thinking frames (said once, quietly) */
  | (Frame<'thinking'> & { step?: string; truncated?: boolean })
  /** `delta: true`: a piece of streamed text, appended until a non-delta answer (the whole text) or `done` */
  | (Frame<'answer'> & { text: string; message_id?: string; delta?: true })
  /**
   * The turn's settled spend reached the person's threshold (Jon on #294: "this one looks expensive (about $X), go
   * ahead?"): it waits for their answer (POST /api/ask/{op}/go-ahead) while this is its latest frame; a later thinking,
   * act, answer or done frame means it moved on. A figure the page cannot read is null (the question still shows).
   */
  | (Frame<'go_ahead'> & { spent_usd: number | null; limit_usd: number | null })
  | (Frame<'proposal'> & { proposal: NavigateProposal | UiProposal | { id: string; kind: 'app_read' | 'layout'; digest: string } })
  | (Frame<'ui-change'> & { prefs_before?: unknown; prefs_after?: unknown; undo?: { history_id: string } })
  | (Frame<'action-needs-confirm'> & { proposal: AppActProposal })
  | (Frame<'presence'> & { actor: AskWho; verb: PresenceVerb; target: PresenceTarget; caption?: string; ink?: Ink; animate?: boolean })
  | (Frame<'steer'> & { steer_id: string; text: string; at_seq?: number; via?: AskVia })
  | (Frame<'revert'> & { target_id?: string; to_seq?: number })
  | (Frame<'done'> & { spent_usd?: number; turn_spent_usd?: number; outcome?: DoneOutcome; /** ask-limits r1 (forward-compatible): which limit stopped a spend_cap turn; read with words.readDoneLimit */ limit?: unknown; /** ask-limits r1: outcome error's code (unpriced_model | key_unavailable | not_available | mind_not_connected, or a refusal from hive/core/refusals.py such as free_inference_busy); read with words.doneErrorWords */ error?: unknown; /** a refusal the hive spoke: what the person can do (words.REMEDIES); its words are the turn's answer, so the page adds none (words.spokenRefusal) */ remedy?: unknown })
  | (Frame<'refused'> & { reason: RefusalReason; say?: string; offer?: { kind: string; label?: string }; /** the thread's spend (hive/core/ask.py _close) */ spent_usd?: number | null; /** what the host counted for this turn when it closed */ turn_spent_usd?: number | null })
  | (Frame<'act'> & { act: ConductorAct | UnreadableAct; recipient?: AppAskRecipient })
  | (Frame<'dispatched'> & { intent_id: string; intent_kind: string; to: DispatchedTo; label?: string })
  /** linkage r2.13 (ask_intents Intents._frame): an intent this turn recorded moved on. A hint (its record is GET
   *  /api/ask/{op}/links) that applies nothing, but it holds its place in the turn's order like every frame. */
  /** one of this turn's intents moved (hive/core/ask_intents.py: a hint, the intent's view is the record); a refusal says
   * its kind's reason, a host enum: researcher_asleep is a research request held back because the Research swarm's
   * coordinator is stopped, which the person may wake to send it as it is (askResearchWake) */
  | (Frame<'intent'> & { intent_id: string; state: IntentState; links_rev?: number; request_id?: string; dispatch_id?: string; reason?: string })
  /** a direct link of this turn to a request (Intents.link): a hint like an intent */
  | (Frame<'link'> & { request_id: string; links_rev: number })
  /** research.deliver: the report back at its turn, after the turn's done; a personal turn's stored copy has no `research`.
   *  reason, on a failed one: the cause its task was stopped with (hive/core/goals.py STOP_CAUSES), an enum, never words */
  | (Frame<'research'> & { intent_id?: string | null; request_id: string; state: ResearchState; research?: ResearchView; reason?: string | null })
  /** a frame of a phase this page does not know (`sent_as`): it holds its seq and is never applied or shown */
  | (Frame<'unknown'> & { sent_as: string })
  | (Frame<'research'> & ResearchFrame)
  /**
   * Something for this browser to remember about the person (conductor `remember`; asker-only). Live, it carries the
   * item and, for a revise, the note id it revises; the stored copy read back later is `{op, digest}` only (both blank
   * after the thread was deleted). Kept by lib/askMemory; the hive keeps none of it.
   */
  | (Frame<'memory'> & { op: MemoryOp; digest: string; item?: { statement: string; kind: string; truth: { frequency: number; confidence: number } }; target_id?: string | null })

export type MemoryOp = 'remember' | 'revise' | ''

export type ResearchHold = 'spending_limit' | 'asleep' | 'stopped' | 'worker_error'
/** research.py _hold: a researcher held, with why and until when, or back at work; a report comes in the deliver frame */
type ResearchFrame =
  /** limit: the limit that held it, kind_period such as hive_day, or unseen for one its asker may not see; an enum */
  | { request_id: string; state: 'held'; reason: ResearchHold; until?: string | null; limit?: string | null }
  | { request_id: string; state: 'resumed' }

/** A refusal's reason as the host keeps it: an enum, never words (ask_intents REASON). */
const INTENT_REASON = /^[a-z][a-z0-9_]{0,40}$/
/** The research refusal a person can lift by waking the Research swarm (hive/core/research.py admit). */
export const RESEARCHER_ASLEEP = 'researcher_asleep'

/**
 * A research request of the person's still held back by an asleep Research swarm, read strictly from its intent view
 * (GET /api/ask/intents/{id}): the swarm whose coordinator to wake. Anything else (another kind, a request already sent
 * or closed, another refusal) is null, so nothing is woken or sent for it.
 */
export function readAsleepResearch(v: unknown): { swarm: string } | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const refusal = o.last_refusal as Record<string, unknown> | null | undefined
  const to = (o.destination as Record<string, unknown> | null | undefined)?.to_swarm
  if (o.kind !== 'research.request' || o.state !== 'refused' || refusal?.reason !== RESEARCHER_ASLEEP || !id(to)) return null
  return { swarm: to }
}

/** GET /api/ask/{op}?after=&limit=: the turn view plus its frames after `after`, in seq order (paged). */
export interface AskTurnState extends Partial<Omit<AskAccepted, 'operation_id' | 'turn_id'>> {
  operation_id: string
  turn_id: string
  events: AskEvent[]
  next_after?: number
  more?: boolean
}

/** A steer: words the person typed while the turn is open (Jon, 2026-10-05; Platform phase 1.1). */
export interface AskSteerBody {
  steer_id: string
  text: string
  /** the last seq the page had when it was typed */
  at_seq: number
  /**
   * how the words were made, as on a request (audit only; Kimi r3 #1): the same spoken words are recorded the same way
   * whether they steer an open turn or start a new one. The host's steer route (core/app.py ask_steer, core/ask.py
   * steer) takes {steer_id, text, at_seq, via?}; the live client sends it.
   */
  via?: AskVia
}
/** The host's answer: the steer joined the open turn, or (a closed turn) it started a fresh one. */
export interface AskSteerResult {
  steer_id: string
  operation_id: string
  turn_id?: string
  new_turn?: boolean
  thread?: AskThread
  /** the open turn's steer: its frame's seq (core/ask.py _steer_answer) */
  seq?: number
  via?: AskVia
  /** a closed turn's fresh one: its state (core/ask.py _new_turn_answer) */
  state?: string
}

export interface AskSwarmChoice {
  id: string
  name: string
  orchestrator?: { id: string; name: string; status?: string } | null
}

/** GET /api/me/ask: the default swarm (its coordinator answers), the expensive-answer question, and the swarms one may pick. */
export interface AskSettings {
  swarm_id: string | null
  swarm?: AskSwarmChoice | null
  /** an answer that looks expensive stops once to ask (on unless the person turned it off). Read with readExpensive. */
  ask_when_expensive?: boolean
  /** the person's threshold now, by the hive's HIVE_ASK_EXPENSIVE_* settings (hive/API.md, "The threshold") */
  expensive_usd?: number
  eligible?: AskSwarmChoice[]
  /** The host's own switches (core/ask.py capabilities(), on GET and PUT /api/me/ask). Absent on an older host. */
  capabilities?: AskCapabilities
}
/**
 * What this hive's Ask can do, as the host says (never guessed from replies): `conductor` (HIVE_ASK_CONDUCTOR) and
 * `memory` (conductor and HIVE_ASK_MEMORY both on).
 */
export interface AskCapabilities {
  conductor: boolean
  memory: boolean
  /** mind-voice r1: a turn to the person's own mind reads their memory whatever `memory` says (conductor on) */
  mind_memory?: boolean
  /** Installed code.test protocol support, independently checked for each operation. */
  code_test_intents?: boolean
}
/** The capabilities as the page trusts them: booleans only; anything else reads as not given. */
export function readCapabilities(v: unknown): AskCapabilities | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  if (typeof c.conductor !== 'boolean' || typeof c.memory !== 'boolean') return null
  return { conductor: c.conductor, memory: c.conductor && c.memory, ...(c.conductor && c.mind_memory === true ? { mind_memory: true } : {}), ...(typeof c.code_test_intents === 'boolean' ? { code_test_intents: c.code_test_intents } : {}) }
}
/** The name the hive gives a person's own mind until they name it (core/personal.py DEFAULT_MIND_NAME). */
export const UNNAMED_MIND = 'Your mind'
/** The person's own mind (GET /api/me/mind, Platform P1/P2; absent or 404 on older hosts). */
export interface MyMind {
  id: string
  /** the name they gave it, else UNNAMED_MIND */
  name: string
  swarm_id?: string | null
  status?: string
}
/** GET /api/me/mind, personal.py: host readiness and this person's preference are separate facts. */
export interface BrowserMindRoute {
  mindId: string
  gateway: boolean
  available: boolean
  preference: boolean
}
/** `acting_as` on the turn view and the first `ask` frame (Platform P2): the person's own mind answering for them. */
export interface ActingAs {
  mind_id: string
  name: string
}
const plainName = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 120 && !/\p{Cc}/u.test(v)
/** GET /api/me/mind's `mind`, if well formed; anything else (null, a malformed body) is no mind. */
export function readMyMind(v: unknown): MyMind | null {
  const m = v && typeof v === 'object' ? (v as { mind?: unknown }).mind : null
  if (!m || typeof m !== 'object') return null
  const r = m as Record<string, unknown>
  if (!id(r.id) || !plainName(r.name)) return null
  return { id: r.id, name: r.name, swarm_id: id(r.swarm_id) ? r.swarm_id : null, status: typeof r.status === 'string' ? r.status.slice(0, 20) : undefined }
}

/** Missing/older/malformed advertisements never opt a person into browser-owned admission. */
export function readBrowserMindRoute(v: unknown): BrowserMindRoute | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const root = v as Record<string, unknown>, mind = readMyMind(v)
  const caps = root.capabilities, raw = root.mind
  if (!mind || !caps || typeof caps !== 'object' || Array.isArray(caps) || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const c = caps as Record<string, unknown>, m = raw as Record<string, unknown>
  if (typeof c.gateway !== 'boolean' || typeof c.browser_mind !== 'boolean' || typeof m.browser_mind !== 'boolean') return null
  return { mindId: mind.id, gateway: c.gateway, available: c.browser_mind, preference: m.browser_mind }
}
/** An `acting_as` value, if well formed; anything else is ignored. */
export function readActingAs(v: unknown): ActingAs | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  return id(r.mind_id) && plainName(r.name) ? { mind_id: r.mind_id, name: r.name } : null
}

/** PUT /api/me/ask: any other key is 400 invalid (thread_budget_usd retired with the per-thread cap). */
export interface AskSettingsPut {
  swarm_id?: string | null
  mind_id?: string
  ask_when_expensive?: boolean
}

/** The expensive-answer question as the host says it: whether it is on, and the person's threshold now. */
export interface AskExpensive {
  on: boolean
  usd: number
}
/** The settings' question, read strictly: a boolean switch and a finite threshold, or null (an older host, or malformed). */
export function readExpensive(st: AskSettings | null | undefined): AskExpensive | null {
  const usd = st?.expensive_usd
  return typeof st?.ask_when_expensive === 'boolean' && typeof usd === 'number' && Number.isFinite(usd) && usd >= 0 ? { on: st.ask_when_expensive, usd } : null
}

/** POST /api/ask/{operation_id}/go-ahead {go}: the turn's asker answered its question. */
export interface AskGoAheadResult {
  ok: true
  go: boolean
}

/** A refusal with the host's details (mind_asleep carries `mind`, ask_busy the open `operation_id`). */
export interface AskRefusalDetails {
  mind?: AskWho
  operation_id?: string
  /** own_key_needed (Jon 11-05): what the one add-your-key step needs (ownhive.OwnHive.key_setup) */
  keySetup?: KeySetup
}

// ---------------------------------------------------------------- frame checks (defence in depth)

const ID = /^[A-Za-z0-9_.:-]{1,200}$/
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const who = (v: unknown): v is AskWho => !!v && typeof v === 'object' && id((v as AskWho).id) && str((v as AskWho).name, 120)
export const PRESENCE_CAPTION_MAX = 120

function checkedResearch(frame: Record<string, unknown>): boolean {
  if (!id(frame.request_id)) return false
  if (frame.state === 'held') {
    if (frame.reason === 'spending_limit') {
      return frame.until == null && (frame.limit == null || (typeof frame.limit === 'string' && INTENT_REASON.test(frame.limit)))
    }
    return (frame.reason === 'asleep' || frame.reason === 'stopped' ||
      frame.reason === 'worker_error') && frame.until == null && frame.limit == null
  }
  if (frame.state === 'failed' || frame.state === 'cancelled' || frame.state === 'resumed') return true
  if (frame.state !== 'done') return false
  // A personal replay or a server that has retired the report can send the outcome without its content.
  if (frame.research === undefined) return true
  const report = (frame.research as { report?: ResearchReport | null } | null)?.report
  return report === null || !!report && str(report.summary, 4000) &&
    Array.isArray(report.sections) && report.sections.length <= 12 && report.sections.every(section =>
      !!section && str(section.heading, 400) && Array.isArray(section.claims) && section.claims.length <= 30 &&
      section.claims.every(claim => !!claim && str(claim.text, 2000) && typeof claim.cited === 'boolean' &&
        Array.isArray(claim.citations) && claim.citations.length <= 8 && claim.citations.every(citation =>
          !!citation && str(citation.url, 2048) && citation.url.startsWith('https://') &&
          (citation.match === 'exact' || citation.match === 'path' || citation.match === null)))) &&
    Array.isArray(report.open_questions) && report.open_questions.length <= 10 &&
    report.open_questions.every(question => str(question, 600))
}

/** A presence target: a feature id, an entity of a known kind with a plain id, or a named region; nothing else. */
export function validTarget(t: unknown): t is PresenceTarget {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return false
  const o = t as Record<string, unknown>
  if (Object.keys(o).some((k) => !['feature', 'entity', 'region'].includes(k))) return false
  if (o.feature !== undefined && !(typeof o.feature === 'string' && /^[a-z]+\.[a-z]+$/.test(o.feature))) return false
  if (o.region !== undefined && !(typeof o.region === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(o.region))) return false
  if (o.entity !== undefined) {
    const e = o.entity as Record<string, unknown>
    // exactly {kind, ref}: no arrays, no extra keys (e.g. submit), as the open parser does
    if (!e || typeof e !== 'object' || Array.isArray(e) || Object.keys(e).some((k) => k !== 'kind' && k !== 'ref')) return false
    if (!PRESENCE_KINDS.includes(e.kind as PresenceKind) || !id(e.ref)) return false
  }
  return o.feature !== undefined || o.entity !== undefined || o.region !== undefined
}

/**
 * The frame, if it is a well-formed `ask` event of a known phase; null otherwise (dropped by the caller). Text fields
 * are length-checked here and always rendered as plain text.
 */
export function checkAskEvent(e: unknown): AskEvent | null {
  if (!e || typeof e !== 'object') return null
  const f = e as Record<string, unknown>
  if (f.app_ask !== undefined && f.app_ask !== true) return null
  if (f.type !== 'ask' || !id(f.operation_id) || typeof f.seq !== 'number' || !Number.isInteger(f.seq) || f.seq < 1) return null
  switch (f.phase) {
    case 'accepted': {
      const t = f.thread as AskThread | undefined
      return t && id(t.id) && who(t.mind) && typeof t.budget_usd === 'number' && typeof t.spent_usd === 'number' && (t.about == null || who(t.about)) ? (f as unknown as AskEvent) : null
    }
    case 'thinking':
      return (f.step === undefined || str(f.step, 200)) && (f.truncated === undefined || typeof f.truncated === 'boolean') ? (f as unknown as AskEvent) : null
    case 'answer':
      return str(f.text, 8000) && (f.delta === undefined || f.delta === true) ? (f as unknown as AskEvent) : null
    case 'go_ahead':
      // kept whatever its figures say, as an unreadable act is: the turn waits on the person, so dropping the frame
      // would leave them no question to answer. A figure that is not a finite non-negative number is null.
      return { ...f, spent_usd: usd(f.spent_usd), limit_usd: usd(f.limit_usd) } as unknown as AskEvent
    case 'act': {
      // an act without a readable id cannot even be answered: dropped. Otherwise a malformed act is kept as unreadable,
      // never applied, and answered ok:false, so the turn's seq stays whole and the host does not wait for it.
      const raw = f.act as Record<string, unknown> | undefined
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !id(raw.act_id)) return null
      if (f.recipient !== undefined && !readAppAskRecipient(f.recipient)) return null
      return { ...f, act: checkAct(raw) ?? { act_id: raw.act_id, kind: 'unreadable' } } as unknown as AskEvent
    }
    case 'dispatched': {
      const to = f.to as Record<string, unknown> | undefined
      return id(f.intent_id) && typeof f.intent_kind === 'string' && /^[a-z][a-z0-9_.-]{0,40}$/.test(f.intent_kind) && !!to && typeof to === 'object' && ['swarm', 'service', 'app'].includes(to.kind as string) && id(to.ref) && (to.name === undefined || plain(to.name, 120)) && (f.label === undefined || plain(f.label, 200))
        ? (f as unknown as AskEvent)
        : null
    }
    case 'intent':
      return id(f.intent_id) && INTENT_STATES.includes(f.state as IntentState) && (f.links_rev === undefined || count(f.links_rev)) && optId(f.request_id) && optId(f.dispatch_id)
        && (f.reason === undefined || (typeof f.reason === 'string' && INTENT_REASON.test(f.reason))) ? (f as unknown as AskEvent) : null
    case 'link':
      return id(f.request_id) && count(f.links_rev) ? (f as unknown as AskEvent) : null
    case 'research': {
      // a researcher held or back at work (research.py _hold): checked as the host sends it
      if (f.state === 'held' || f.state === 'resumed') return checkedResearch(f) ? (f as unknown as AskEvent) : null
      // the report back at its turn (research.py deliver)
      if (!id(f.request_id) || !RESEARCH_STATES.includes(f.state as ResearchState) || !optId(f.intent_id)) return null
      // a failed one's cause is an enum (goals.py STOP_CAUSES), never words: a frame with words for it is not the host's
      if (f.state === 'failed' && f.reason != null && !(typeof f.reason === 'string' && INTENT_REASON.test(f.reason))) return null
      // a report this page cannot read is left out, never the frame: the row reads the report again by its id
      const { research, ...rest } = f
      const view = readResearchView(research)
      return { ...rest, ...(view ? { research: view } : {}) } as unknown as AskEvent
    }
    case 'proposal': {
      const p = f.proposal as Record<string, unknown> | undefined
      if (!p || !id(p.id) || typeof p.digest !== 'string') return null
      if (p.kind === 'navigate') return str(p.route, 300) && (p.animate === undefined || typeof p.animate === 'boolean') ? (f as unknown as AskEvent) : null
      if (p.kind === 'ui') return p.prefs && typeof p.prefs === 'object' ? (f as unknown as AskEvent) : null
      return p.kind === 'app_read' || p.kind === 'layout' ? (f as unknown as AskEvent) : null
    }
    case 'ui-change':
      return f as unknown as AskEvent
    case 'memory': {
      // the item is read strictly where it is kept (lib/askMemory readItem); here only its envelope
      if (!id(f.turn_id) || !['remember', 'revise', ''].includes(f.op as string) || typeof f.digest !== 'string' || f.digest.length > 64) return null
      if (f.target_id !== undefined && f.target_id !== null && !(typeof f.target_id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(f.target_id))) return null
      if (f.item !== undefined && (!f.item || typeof f.item !== 'object' || Array.isArray(f.item))) return null
      return f as unknown as AskEvent
    }
    case 'action-needs-confirm': {
      const p = f.proposal as Record<string, unknown> | undefined
      return p && p.kind === 'app_act' && id(p.id) && id(p.program) && id(p.action) && Array.isArray(p.items) && p.items.every(id) && p.params && typeof p.params === 'object' && typeof p.digest === 'string' && str(p.label, 200)
        ? (f as unknown as AskEvent)
        : null
    }
    case 'presence': {
      if (!who(f.actor) || !PRESENCE_VERBS.includes(f.verb as PresenceVerb) || !validTarget(f.target)) return null
      if (f.animate !== undefined && typeof f.animate !== 'boolean') return null
      if (f.caption !== undefined && !(typeof f.caption === 'string' && f.caption.length <= PRESENCE_CAPTION_MAX && !/[<>]/.test(f.caption))) return null
      if (f.verb !== 'sketch' && typeof f.caption !== 'string') return null
      if (f.verb === 'sketch') {
        const ink = checkInk(f.ink)
        if (!ink) return null
        return { ...f, ink } as unknown as AskEvent
      }
      return f.ink === undefined ? (f as unknown as AskEvent) : null
    }
    case 'steer':
      return id(f.steer_id) && str(f.text, 4000) && (f.at_seq === undefined || (typeof f.at_seq === 'number' && Number.isInteger(f.at_seq) && f.at_seq >= 0)) && (f.via === undefined || f.via === 'typed' || f.via === 'voice') ? (f as unknown as AskEvent) : null
    case 'revert':
      // by a move's id, or everything after a seq; one of them, well-formed
      return (f.target_id !== undefined) !== (f.to_seq !== undefined) && (f.target_id === undefined || id(f.target_id)) && (f.to_seq === undefined || (typeof f.to_seq === 'number' && Number.isInteger(f.to_seq) && f.to_seq >= 0))
        ? (f as unknown as AskEvent)
        : null
    case 'done': {
      // the turn closes whatever it says; an outcome outside the closed set is not echoed (no free text on done)
      if (f.outcome === undefined || DONE_OUTCOMES.includes(f.outcome as DoneOutcome)) return f as unknown as AskEvent
      const { outcome: _drop, ...rest } = f
      void _drop
      return rest as unknown as AskEvent
    }
    case 'refused':
      // the turn still closes on a reason outside the closed set; it is said as "not available here", never echoed
      return (REFUSAL_REASONS.includes(f.reason as RefusalReason) ? f : { ...f, reason: 'not_available' }) as unknown as AskEvent
    default:
      // A frame of a phase this page does not know is discarded without becoming a hole, as HTTP/2 discards frames of
      // unknown types (RFC 9113 4.1, 5.5): it keeps its seq, so the turn's later frames still apply, and nothing of it
      // is applied or shown. Only a frame that has not arrived is a gap: reading the turn back can fill that one, never
      // this one (on v0.31 every hand-over's intent frame was dropped this way, and its answer showed as incomplete).
      return typeof f.phase === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(f.phase)
        ? ({ type: 'ask', operation_id: f.operation_id, turn_id: f.turn_id, seq: f.seq, at: f.at, phase: 'unknown', sent_as: f.phase, ...(f.app_ask === true ? { app_ask: true } : {}) } as unknown as AskEvent)
        : null
  }
}

/** A money figure from the host: a finite non-negative number, else null. */
const usd = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
/** Plain words: a string within the cap and with no angle brackets (rendered as text anyway). */
const plain = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[<>]/.test(v)
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k))
/** a whole number from 0 (links_rev) */
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
/** an id when given; absent or null is fine */
const optId = (v: unknown) => v === undefined || v === null || id(v)
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean'
const optStrOrNull = (v: unknown, max: number) => v === undefined || v === null || (typeof v === 'string' && v.length <= max)
export const FIELD_ID = VIEW_NAME
const SCRIPT_ID = /^[a-z0-9][a-z0-9.-]{0,60}$/
const FEATURE_ID = /^[a-z]+\.[a-z]+$/

/** an https address within the host's CITATION_SCHEMA cap (2048), with nothing that could leave an attribute */
const HTTPS = /^https:\/\/[^\s<>"'`]{1,2040}$/
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** every item read, or null if the list is too long or any item is unreadable (nothing is partly shown) */
function readList<T>(v: unknown, max: number, read: (x: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: T[] = []
  for (const x of v) {
    const r = read(x)
    if (r === null) return null
    out.push(r)
  }
  return out
}
/** research.check's judgement of one address: exact, by path, or not a page the researcher fetched (null); a report
 * stored before the check named it has none (undefined). Anything else is unreadable (false). */
const readMatch = (m: unknown): ResearchCitation['match'] | false => (m === undefined || m === null || m === 'exact' || m === 'path' ? m : false)
const readCitation = (v: unknown): ResearchCitation | null => {
  if (!object(v) || typeof v.url !== 'string' || !HTTPS.test(v.url) || (v.title != null && !str(v.title, 300)) || (v.quote != null && !str(v.quote, 500))) return null
  const match = readMatch(v.match)
  if (match === false) return null
  return { url: v.url, verified: v.verified === true, ...(match !== undefined ? { match } : {}), ...(typeof v.title === 'string' && v.title ? { title: v.title } : {}), ...(typeof v.quote === 'string' && v.quote ? { quote: v.quote } : {}) }
}
const readClaim = (v: unknown): ResearchClaim | null => {
  if (!object(v) || !str(v.text, 1000) || !v.text) return null
  const citations = readList(v.citations, 8, readCitation)
  return citations ? { text: v.text, cited: v.cited === true, citations } : null
}
const readSection = (v: unknown): ResearchSection | null => {
  if (!object(v) || !str(v.heading, 200)) return null
  const claims = readList(v.claims, 30, readClaim)
  return claims ? { heading: v.heading, claims } : null
}

/**
 * A research report (GET /api/research/{id}, or a research frame's `research`), read strictly to the caps of the
 * host's REPORT_SCHEMA (research.py: summary 2000, 12 sections of up to 30 claims, 8 https sources a claim, 10 open
 * questions); null otherwise. Everything in it is a researcher's words from the web: shown as plain text only.
 */
export function readResearchView(v: unknown): ResearchView | null {
  if (!object(v) || !id(v.request_id) || !str(v.title, 300) || typeof v.state !== 'string' || v.state.length > 20) return null
  const base = { request_id: v.request_id, title: v.title, state: v.state }
  if (v.report === null) return { ...base, report: null }
  const r = v.report
  if (!object(r) || !str(r.summary, 2000) || !object(r.checks) || !count(r.checks.claims) || !count(r.checks.cited)) return null
  const sections = readList(r.sections, 12, readSection)
  const open = r.open_questions === undefined ? [] : readList(r.open_questions, 10, (q) => (str(q, 300) && q ? q : null))
  if (!sections || !open) return null
  return { ...base, report: { summary: r.summary, sections, open_questions: open, checks: { claims: r.checks.claims, cited: r.checks.cited } } }
}

/**
 * One conductor act, read strictly (vocabulary v1 §5): a known kind, exactly its fields, each well-formed and within
 * its cap (fill text ≤ 4000, caption ≤ 140). Anything else is null: never guessed, never partly applied.
 */
export function checkAct(v: unknown): ConductorAct | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const a = v as Record<string, unknown>
  if (!id(a.act_id) || (a.label !== undefined && !plain(a.label, ACT_CAPTION_MAX))) return null
  const caption = a.caption === undefined || plain(a.caption, ACT_CAPTION_MAX)
  const base = ['act_id', 'label', 'kind']
  const ok = (keys: string[], good: boolean) => (only(a, [...base, ...keys]) && good ? (a as unknown as ConductorAct) : null)
  switch (a.kind) {
    case 'navigate':
      return ok(['route', 'animate'], str(a.route, 300) && a.route.length > 0 && optBool(a.animate))
    case 'open': {
      const e = a.entity as Record<string, unknown> | undefined
      const entity = e === undefined || (!!e && typeof e === 'object' && !Array.isArray(e) && only(e, ['kind', 'ref']) && PRESENCE_KINDS.includes(e.kind as PresenceKind) && id(e.ref))
      return ok(['feature', 'entity'], typeof a.feature === 'string' && FEATURE_ID.test(a.feature) && entity)
    }
    case 'look': {
      const p = a.prefs as Record<string, unknown> | undefined
      if (!p || typeof p !== 'object' || Array.isArray(p) || !Object.keys(p).length || !only(p, ['variant', 'layout', 'experience', 'density'])) return null
      return ok(['prefs'], optStrOrNull(p.variant, 80) && optStrOrNull(p.layout, 40) && optStrOrNull(p.experience, 40) && (p.density === undefined || str(p.density, 40)))
    }
    case 'point':
      return ok(['target', 'caption'], validTarget(a.target) && caption)
    case 'highlight': {
      if (a.ink === undefined) return ok(['target', 'caption', 'ink'], validTarget(a.target) && caption)
      const ink = checkInk(a.ink)
      return ink && only(a, [...base, 'target', 'caption', 'ink']) && validTarget(a.target) && caption ? ({ ...a, ink } as unknown as ConductorAct) : null
    }
    case 'fill':
      return ok(['field', 'text'], typeof a.field === 'string' && FIELD_ID.test(a.field) && str(a.text, ACT_FILL_MAX))
    case 'scroll':
      // exactly one of a target or an end of the page
      return ok(['target', 'to'], (a.target === undefined) !== (a.to === undefined) && (a.target === undefined || validTarget(a.target)) && (a.to === undefined || a.to === 'top' || a.to === 'bottom'))
    case 'tour.step':
      return ok(['script', 'step'], typeof a.script === 'string' && SCRIPT_ID.test(a.script) && typeof a.step === 'number' && Number.isInteger(a.step) && a.step >= 0 && a.step <= 500)
    default:
      return null
  }
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
/** A sketch's ink: a shape from the closed set, at most 64 finite points, each clamped to 0..1. Null when malformed. */
export function checkInk(v: unknown): Ink | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (Object.keys(o).some((k) => k !== 'shape' && k !== 'points')) return null
  if (!INK_SHAPES.includes(o.shape as InkShape)) return null
  if (o.points === undefined) return o.shape === 'path' ? null : { shape: o.shape as InkShape }
  if (!Array.isArray(o.points) || o.points.length > INK_MAX_POINTS || (o.shape === 'path' && o.points.length < 2)) return null
  const pts: [number, number][] = []
  for (const p of o.points) {
    if (!Array.isArray(p) || p.length !== 2 || !p.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
    pts.push([clamp01(p[0]), clamp01(p[1])])
  }
  return { shape: o.shape as InkShape, points: pts }
}

/** An Ask refusal with the host's details; still an ApiError (code = the closed reason). */
export class AskRefusal extends ApiError {
  readonly details: AskRefusalDetails
  constructor(status: number, code: string, message: string, details: AskRefusalDetails = {}) {
    super(status, code, message)
    this.details = details
  }
}

/** The details an Ask refusal may carry, read strictly from the host's error envelope. */
export function refusalDetails(body: unknown): AskRefusalDetails {
  const e = body && typeof body === 'object' ? (body as { error?: unknown }).error : null
  if (!e || typeof e !== 'object') return {}
  const o = e as Record<string, unknown>
  const out: AskRefusalDetails = {}
  if (who(o.mind)) out.mind = { id: o.mind.id, name: o.mind.name }
  if (id(o.operation_id)) out.operation_id = o.operation_id
  if (o.code === 'own_key_needed' && typeof o.provider === 'string' && /^[a-z0-9_-]{1,40}$/.test(o.provider)) {
    const m = o.suggested_month_usd
    out.keySetup = {
      provider: o.provider,
      providerLabel: typeof o.provider_label === 'string' && o.provider_label.length <= 60 ? o.provider_label : o.provider,
      hasTotal: o.has_total === true,
      suggestedMonthUsd: typeof m === 'number' && Number.isFinite(m) && m >= 0 ? m : null,
    }
  }
  return out
}
