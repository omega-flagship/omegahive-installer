import { ApiError } from './client'
import { readAppAskRecipient, type AppAskRecipient } from './appAsk'

/**
 * The universal Ask's wire shapes (UNIVERSAL_ASK_HOST_CONTRACT_DRAFT_20261005 §1, §4, and its amendments: context.view,
 * The owner's ruling that the swarm's orchestrator answers, and the presence phase). Platform owns these; Surface reads them.
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
  /** a mind the person addressed: its swarm's coordinator answers, about it (the owner's ruling; context only, no authority) */
  mind?: string
  selection?: { kind: SelectionKind; ref: string }[]
  view?: AskView
}

export interface AskBody {
  operation_id: string
  text: string
  context: AskContext
  /** an existing thread to continue; omitted = the person's current thread with that orchestrator */
  thread?: string
  via: AskVia
  /**
   * The person's own memory, recalled by this browser for this turn only (lib/askMemory; the owner 2026-10-07: memory is kept
   * by the browser, the hive stores none of it). At most 20 notes and 8 KB; each `{id, text}` so a revise can name it.
   * Accepted only while the hive's conductor answers (otherwise 400 invalid: the page sends again without them).
   */
  memory_notes?: (string | { id: string; text: string })[]
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
  state: 'accepted' | 'thinking' | 'done' | 'refused'
  reason?: RefusalReason | null
  text?: string
  /** how the request was made (audit only; the host's turn view carries it) */
  via?: AskVia
  turn_spent_usd?: number | null
  /** present when the hive's conductor answers this turn (hive/core/ask.py view): memory frames may come */
  conductor?: { model: string } | null
  /** the person's own mind answers for them (Platform P2; absent on older hosts): read with readActingAs */
  acting_as?: unknown
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
  /** the recovery view of a turn the person took over (POST /api/ask/{op}/takeover, Platform 07bf554): never a frame */
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
  /** play the experience's own transition (the owner, 2026-10-05); default false: the page moves instantly */
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
/** POST /api/ask/{op}/takeover's receipt: `taken_over` on the first call and every repeat; a turn that had already ended
 *  another way answers its own closed state. The turn's done frame carries outcome 'cancelled' with taken_over: true. */
export interface AskTakeover {
  operation_id: string
  turn_id: string
  state: 'taken_over' | 'done' | 'refused'
  ended_at: string
}
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
}
export const ACT_RESULT_MAX_BYTES = 8192

/** A linkage intent the host handed elsewhere (shown only; its progress comes from the intent and proposal reads). */
export interface DispatchedTo {
  kind: 'swarm' | 'service' | 'app'
  ref: string
  name?: string
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
  | (Frame<'accepted'> & { thread: AskThread })
  /** `truncated: true` with an empty step: the host trimmed later thinking frames (said once, quietly) */
  | (Frame<'thinking'> & { step?: string; truncated?: boolean })
  /** `delta: true`: a piece of streamed text, appended until a non-delta answer (the whole text) or `done` */
  | (Frame<'answer'> & { text: string; message_id?: string; delta?: true })
  | (Frame<'proposal'> & { proposal: NavigateProposal | UiProposal | { id: string; kind: 'app_read' | 'layout'; digest: string } })
  | (Frame<'ui-change'> & { prefs_before?: unknown; prefs_after?: unknown; undo?: { history_id: string } })
  | (Frame<'action-needs-confirm'> & { proposal: AppActProposal })
  | (Frame<'presence'> & { actor: AskWho; verb: PresenceVerb; target: PresenceTarget; caption?: string; ink?: Ink; animate?: boolean })
  | (Frame<'steer'> & { steer_id: string; text: string; at_seq?: number; via?: AskVia })
  | (Frame<'revert'> & { target_id?: string; to_seq?: number })
  | (Frame<'done'> & { spent_usd?: number; turn_spent_usd?: number; outcome?: DoneOutcome; /** the person took over (host takeover route): outcome cancelled */ taken_over?: true; /** ask-limits r1 (forward-compatible): which limit stopped a spend_cap turn; read with words.readDoneLimit */ limit?: unknown; /** ask-limits r1: outcome error's code (unpriced_model | key_unavailable | not_available); read with words.doneErrorWords */ error?: unknown })
  | (Frame<'refused'> & { reason: RefusalReason; say?: string; offer?: { kind: string; label?: string }; /** the thread's spend (hive/core/ask.py _close) */ spent_usd?: number | null; /** what the host counted for this turn when it closed */ turn_spent_usd?: number | null })
  | (Frame<'act'> & { act: ConductorAct | UnreadableAct; recipient?: AppAskRecipient })
  | (Frame<'dispatched'> & { intent_id: string; intent_kind: string; to: DispatchedTo; label?: string })
  /**
   * Something for this browser to remember about the person (conductor `remember`; asker-only). Live, it carries the
   * item and, for a revise, the note id it revises; the stored copy read back later is `{op, digest}` only (both blank
   * after the thread was deleted). Kept by lib/askMemory; the hive keeps none of it.
   */
  | (Frame<'memory'> & { op: MemoryOp; digest: string; item?: { statement: string; kind: string; truth: { frequency: number; confidence: number } }; target_id?: string | null })

export type MemoryOp = 'remember' | 'revise' | ''

/** GET /api/ask/{op}?after=&limit=: the turn view plus its frames after `after`, in seq order (paged). */
export interface AskTurnState extends Partial<Omit<AskAccepted, 'operation_id' | 'turn_id'>> {
  operation_id: string
  turn_id: string
  events: AskEvent[]
  next_after?: number
  more?: boolean
}

/** A steer: words the person typed while the turn is open (the owner, 2026-10-05; Platform phase 1.1). */
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

/** GET /api/me/ask: the default swarm (its coordinator answers), a new thread's limit, and the swarms one may pick. */
export interface AskSettings {
  swarm_id: string | null
  swarm?: AskSwarmChoice | null
  thread_budget_usd: number
  max_thread_budget_usd?: number
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
}
/** The capabilities as the page trusts them: booleans only; anything else reads as not given. */
export function readCapabilities(v: unknown): AskCapabilities | null {
  if (!v || typeof v !== 'object') return null
  const c = v as Record<string, unknown>
  if (typeof c.conductor !== 'boolean' || typeof c.memory !== 'boolean') return null
  return { conductor: c.conductor, memory: c.conductor && c.memory }
}
/** The person's own mind (GET /api/me/mind, Platform P1/P2; absent or 404 on older hosts). */
export interface MyMind {
  id: string
  name: string
  swarm_id?: string | null
  status?: string
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
/** An `acting_as` value, if well formed; anything else is ignored. */
export function readActingAs(v: unknown): ActingAs | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  return id(r.mind_id) && plainName(r.name) ? { mind_id: r.mind_id, name: r.name } : null
}

/** PUT /api/me/ask. */
export interface AskSettingsPut {
  swarm_id?: string | null
  mind_id?: string
  thread_budget_usd?: number
}

/** A refusal with the host's details (mind_asleep carries `mind`, ask_busy the open `operation_id`). */
export interface AskRefusalDetails {
  mind?: AskWho
  operation_id?: string
}

// ---------------------------------------------------------------- frame checks (defence in depth)

const ID = /^[A-Za-z0-9_.:-]{1,200}$/
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const who = (v: unknown): v is AskWho => !!v && typeof v === 'object' && id((v as AskWho).id) && str((v as AskWho).name, 120)
export const PRESENCE_CAPTION_MAX = 120

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
      // the turn closes whatever it says; an outcome outside the closed set is not echoed (no free text on done);
      // taken_over is kept only as true with the cancelled outcome (the host's takeover frame)
      const { taken_over: took, ...g } = f
      const out = took === true && g.outcome === 'cancelled' ? { ...g, taken_over: true } : g
      if (out.outcome === undefined || DONE_OUTCOMES.includes(out.outcome as DoneOutcome)) return out as unknown as AskEvent
      const { outcome: _drop, ...rest } = out
      void _drop
      return rest as unknown as AskEvent
    }
    case 'refused':
      // the turn still closes on a reason outside the closed set; it is said as "not available here", never echoed
      return (REFUSAL_REASONS.includes(f.reason as RefusalReason) ? f : { ...f, reason: 'not_available' }) as unknown as AskEvent
    default:
      return null
  }
}

/** Plain words: a string within the cap and with no angle brackets (rendered as text anyway). */
const plain = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[<>]/.test(v)
const only = (o: Record<string, unknown>, keys: string[]) => Object.keys(o).every((k) => keys.includes(k))
const optBool = (v: unknown) => v === undefined || typeof v === 'boolean'
const optStrOrNull = (v: unknown, max: number) => v === undefined || v === null || (typeof v === 'string' && v.length <= max)
export const FIELD_ID = VIEW_NAME
const SCRIPT_ID = /^[a-z0-9][a-z0-9.-]{0,60}$/
const FEATURE_ID = /^[a-z]+\.[a-z]+$/

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
  return out
}
