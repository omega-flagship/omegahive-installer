/**
 * The universal Ask's store slice (Surface universal Ask, phase 1). One thread per orchestrator across every page,
 * bound to Surface R's store session (a different client, or any re-init) and the signed-in identity: a switch of
 * either clears it, and nothing that started under the earlier one (a reply, a refusal, an event) lands here.
 *
 * MEMORY (the owner, 2026-10-05: "it can always reverse direction and keep the memory right"). The thread is one ordered
 * log. Each mind turn keeps the host's frames in `seq` order plus what the page did with each (its outcome: moved,
 * held as a Go card, kept, undone, reverted); the rows are DERIVED from that (threadRows), so a reconnect that reads
 * the turn back with GET /api/ask/{op} rebuilds exactly the same thread. Steers the person typed mid-turn are host
 * frames too (echoed with their seq); until the echo they show optimistically at the seq they were typed at.
 *
 * Rules carried here (UNIVERSAL_ASK_HOST_CONTRACT_DRAFT §4–§5, amendments, the owner's rulings of 2026-10-05):
 *  - every frame is checked (api/ask checkAskEvent); a malformed one is dropped, logged in dev only;
 *  - a gap in `seq` is recovered with GET /api/ask/{op}; frames apply strictly in order, once; a gap that cannot be
 *    read back holds everything after it (no navigation, look, revert or close applies), is retried a few times with
 *    backoff and then shows as incomplete (Review B2); lastSeq never moves past a missing frame;
 *  - refusals are the page's own words from the closed set, never the host's text;
 *  - the mind moves the page as often as it chooses (a flood cap only), instantly unless it asks to animate, never
 *    over unsaved state (a Go card), and never after the person took over the page this turn (until they steer);
 *  - a `revert` undoes the mind's own moves (history for pages, the earlier prefs for looks) and strikes them through
 *    in the trail; a look the person KEPT is never reverted silently: it is offered as a choice;
 *  - a ui proposal is a preview (Keep or Undo); an experience this build does not offer is dropped and said;
 *  - an app act only ever reaches the DecisionDialog; confirming sends the digest of exactly what was shown;
 *  - presence is presentation only: capped per turn, captions are plain text, never moves focus;
 *  - an Ask whose admission is not known (no answer, an unreadable answer, a server error) is never called refused
 *    and never sent under a new id: the page reads the original back by its id, or sends the very same request again
 *    under the same id (the host returns the original turn), until the host settles it (Review B1, 45392df).
 */
import { create } from 'zustand'
import { AskRefusal, checkAskEvent, readCapabilities, type AppActProposal, type AskBody, type AskContext, type AskEvent, type AskSettings, type AskThread, readActingAs, readMyMind, type ActingAs, type MyMind, type AskVia, type AskWho, type PresenceTarget, type PresenceVerb, type RefusalReason } from '../api/ask'
import { ApiError, type HiveClient } from '../api/client'
import { EXPERIENCES } from '../experiences/registry'
import { featureById } from '../features/registry'
import { domUnsaved, hasUnsaved } from '../features/ask/dirty'
import { DONE_OFFERS, DONE_WORDS, doneErrorWords, readDoneLimit, refusalOf, spendStop, TAKEOVER_WORDS, THREAD_LIMIT_MAX_USD, type Offer } from '../features/ask/words'
import { href, navigate, parse, type Route } from '../lib/router'
import { asOwnChoice, DEFAULT_VARIANT, keepLook, lookName, lookState, previewLook, SEED_VARIANTS, withExperience, type Layout, type UiPrefs, type UiVariant } from '../shell/uiVariant'
import { hiveBus, useHive } from './store'
import { OUTCOME_UNKNOWN, outcomeUnknown, type DecisionResult } from '../lib/decisionGate'
import { authIdentity } from '../lib/readContext'
import { readMe } from '../lib/readMe'
import { askMemory, hiveKey, LOST_WORDS, type TurnMark } from '../lib/askMemory'
import { isPrivateHash } from '../features/ask/view'
import { answererChip, PICKER_REASONS, planAsk, resendContext, withPreselected, type Carry } from '../features/ask/answerer'
import { appAskTracked, framePresentsAsk } from './appAsk'
import { askSelector, hostAskRecipient } from '../api/appAsk'

/** Review B1 (commons f0818d8): the connection changed after the confirm was sent; its outcome is not this one's. */
export const CONFIRM_ELSEWHERE = 'The connection to the hive changed after this was sent, so its outcome is not shown here. Check it before asking again.'

/** How a request was made: `via` is audit only (Host §6: voice arrives as text, recorded as via "voice"). */
export type AskOpts = {
  about?: string
  where?: string
  via?: AskVia
  /**
   * Told once, with exactly what the hive admitted these words under (or why it did not). Never stored with held or
   * retried words. Additive: callers that do not pass it are unchanged. Read it through `admit`.
   */
  admission?: (a: AskAdmission) => void
}
/**
 * An Ask's admission (vibe-intents r2): the exact operation the hive admitted these words under, for the person bound
 * when they were asked; or the reason they were not admitted. Anything but `admitted: true` means nothing may ride on
 * them (a linkage intent is recorded only against `op`).
 */
export type AskAdmission =
  | { admitted: true; op: string; principal: string }
  | { admitted: false; reason: 'not_available' | 'refused' | 'unknown' | 'held' | 'unsupported' | 'capped' | 'failed' | 'not_admitted' }
/** The opts as they may be kept (held or retried later): never with an admission callback. */
const kept = (o: AskOpts): AskOpts => {
  const { admission: _a, ...rest } = o
  void _a
  return rest
}

export const PRESENCE_PER_TURN = 40
/** The owner (2026-10-05): the mind moves the page as often as it chooses; only a flood cap stops a runaway turn. */
export const NAV_FLOOD_CAP = 36
/** Platform: about 20 steers per turn. */
export const STEERS_PER_TURN = 20
/** No frame for this long on an open turn: read the turn back (a lost tail frame). */
export const SILENCE_MS = 20_000
/**
 * Recovering a gap (Review B2): a few reads, with backoff between them. While the gap is open nothing after it applies;
 * after the last read the history shows as incomplete and the person may ask for another try.
 */
export const RECOVER_TRIES = 3
export const RECOVER_BACKOFF_MS = [1_000, 3_000]
/** frames held behind a gap, at most (a runaway host cannot grow the page without bound) */
export const AHEAD_CAP = 200
/**
 * Checking an Ask whose admission is not known (Review B1, 45392df): a few checks, with backoff between them; then the
 * turn shows as not confirmed and the person may check again. It is never refused, nor sent under a new id, meanwhile.
 */
export const CHECK_TRIES = 3
export const CHECK_BACKOFF_MS = [2_000, 5_000]

/**
 * Review B1 (45392df): does this error leave an Ask's admission unknown? Only the host's own 4xx refusal says nothing
 * was admitted. No answer (status 0, which includes an unreadable successful answer), any 5xx (the host may fail after
 * it committed), 409 in_progress, and any error that is not the host's answer at all (a raw decode or transport error)
 * do not.
 */
export function admissionUnknown(err: unknown): boolean {
  if (!(err instanceof ApiError)) return true
  return err.status < 400 || err.status >= 500 || err.code === 'in_progress'
}

// ---------------------------------------------------------------- moving the page

/**
 * How a mind's move is made: instantly, or with the experience's own transition when it asks to animate (and the
 * person has not asked for less motion). The host component installs the experience's mover. `selfMoveAt` lets the
 * takeover watch tell the mind's own moves from the person's Back.
 */
export let selfMoveAt = 0
let mover: (r: Route, animate: boolean) => void = (r) => navigate(r)
export function setMover(fn: ((r: Route, animate: boolean) => void) | null): void {
  mover = fn ?? ((r) => navigate(r))
}
function move(r: Route, animate: boolean) {
  selfMoveAt = Date.now()
  mover(r, animate)
}
/** A move of the page made for the mind (the conductor's navigate): through the experience's mover, as the mind's own. */
export const moveAsMind = (r: Route, animate = false): void => move(r, animate)
/** A move about to be made for the mind by another path (the conductor's `open`): the takeover watch must not take it as the person's. */
export function markMindMove(): void {
  selfMoveAt = Date.now()
}

/**
 * The conductor's executor (features/ask/conductor installs it): each `act` frame is handed to it, in seq order, once.
 * Without one installed, acts are not applied (the host times out their results).
 */
type ActFrame = Extract<AskEvent, { phase: 'act' }>
let conductor: ((op: string, e: ActFrame) => void) | null = null
export function setConductor(fn: ((op: string, e: ActFrame) => void) | null): void {
  conductor = fn
}

// ---------------------------------------------------------------- shapes

export type RowState = 'preview' | 'kept' | 'undone' | 'replaced' | 'failed' | 'waiting' | 'confirmed' | 'declined' | 'applied' | 'back' | 'reverted' | 'sending' | 'sent'

export interface AskRow {
  id: string
  /** the mind turn it belongs to; fast-path rows have none (device-local only, Host §2.1) */
  op?: string
  /** the host frame it comes from */
  seq?: number
  kind: 'you' | 'steer' | 'step' | 'local' | 'answer' | 'nav' | 'go' | 'ui' | 'ui-change' | 'confirm' | 'refused' | 'note' | 'revert-offer' | 'gap' | 'checking'
  /** plain text; rendered as text, never as HTML */
  text: string
  /** where it was asked ("on Goals") */
  where?: string
  state?: RowState
  /** the move's id (a proposal id, or a ui-change's history id): reverts name it */
  moveId?: string
  /** nav / go: the route's hash, and where the page was before (for Back) */
  route?: string
  from?: string
  label?: string
  /** ui: the proposed look and the look before it */
  prefs?: UiPrefs
  before?: UiPrefs | null
  dropped?: string[]
  proposal?: AppActProposal
  reason?: RefusalReason
  /** refused rows: what the host counted spent on that turn when it closed (refused frame turn_spent_usd), when given */
  spentUsd?: number
  /** local rows: an Undo or Back is registered */
  undo?: 'undo' | 'back'
  /** the answering mind's name, for answer rows */
  who?: string
  /** refused mind_asleep: the coordinator that is asleep (to offer waking it, behind a confirm) */
  mind?: AskWho
  /** refused rows: the swarm in view when it was asked (no_orchestrator: an admin chooses its coordinator there) */
  swarm?: string
  /** a rerouted note (ask-fix r2): an admin is offered "Set a coordinator for <swarm>" */
  fixCoordinator?: boolean
  /** a note's explanation, kept out of the visible words (a tooltip; j0-fixes r1) */
  detail?: string
  /** refused mind_asleep: the asleep mind is the person's own (Platform P2): "Your mind is resting" */
  own?: boolean
  /** an answer shown although steps before it could not be loaded (nothing of it was applied) */
  incomplete?: boolean
  /** an answer still arriving in pieces (`delta` frames) */
  streaming?: boolean
  /** a stop's own way on (spend-stop r1: a spending stop offers New thread and the raise for new threads) */
  offer?: Offer[]
}

/** What the page did with a frame (only the page knows; the host's frame says what was asked). */
export type Outcome =
  | { kind: 'nav'; from: string; route: string; label: string; state: 'applied' | 'back' | 'reverted' }
  | { kind: 'go'; route: string; label: string; why: 'unsaved' | 'took-over' | 'closed' }
  | { kind: 'ui'; prefs: UiPrefs; before: UiPrefs | null; dropped: string[]; state: 'preview' | 'kept' | 'undone' | 'replaced' | 'failed' | 'reverted' }
  | { kind: 'ui-change'; state?: 'reverted' }
  | { kind: 'confirm'; state: 'waiting' | 'confirmed' | 'declined' }
  | { kind: 'note'; text: string }
  | { kind: 'revert-offer'; target: number; text: string; state?: 'done' | 'kept' }
  | { kind: 'skip' }
  /** a conductor act's row (what it did, said by the page) and whether an Undo or Back is registered for it */
  | { kind: 'act'; text: string; state: RowState; undo?: 'undo' | 'back' }

export interface PendingSteer {
  steer_id: string
  text: string
  /** the turn's last seq when it was typed: where it sits until the host's echo places it */
  at_seq: number
  state: 'sending' | 'sent' | 'failed'
}

export interface TurnMeta {
  appAsk?: true
  /** Canonical identity for P1 live adoption; a reused operation cannot attach another turn's frames. */
  appAskTurnId?: string
  /** Live events can precede the send reply; only that same admitted request may fill its placeholder. */
  appAskPlaceholder?: true
  op: string
  you: string
  where?: string
  /** checking: sent, but whether the host admitted it is not known yet (Review B1, 45392df) */
  state: 'sending' | 'checking' | 'open' | 'done' | 'refused'
  lastSeq: number
  /** the host's frames, applied, in seq order */
  events: AskEvent[]
  /** what the page did with each frame, by seq */
  outcomes: Record<number, Outcome>
  /** page notes placed after a seq ("You took over") */
  notes: { after: number; text: string }[]
  steers: PendingSteer[]
  moves: number
  /** the person touched the page during this turn: the mind's moves are paused until they steer again */
  tookOver: boolean
  /** the takeover as the host has it: sent once the turn is admitted (never while it is still being sent or checked, when
   *  the host has no turn yet to end), confirmed, or failed (the page says so; the person may stop the turn) */
  takeover?: 'sending' | 'sent' | 'inert' | 'failed'
  presence: number
  step?: string
  recovering?: boolean
  /** frames that arrived ahead of a gap, applied once the gap is filled (never before: Review B2) */
  ahead: AskEvent[]
  /** a gap in seq that is not filled yet: being read, waiting to read again, or given up (the person may try again) */
  gap?: { tries: number; state: 'loading' | 'retrying' | 'gave-up' }
  /** a refusal before any frame (HTTP) */
  refusedEarly?: RefusalReason
  /** mind_asleep: the coordinator that is asleep (from the host's details) */
  asleep?: AskWho
  /** that asleep mind is the person's own (GET /api/me/mind) */
  asleepOwn?: boolean
  /** the mind the person addressed: the thread reads "<coordinator> about <mind>" */
  about?: string
  /** the person's own mind answering for them (`acting_as`, Platform P2): said in the thread */
  actingAs?: ActingAs
  /** ask-fix r1: the page's swarm could not answer, so another did; a quiet line says who */
  rerouted?: string
  /** why it was rerouted, for the note's tooltip (j0-fixes r1: the visible line stays plain) */
  reroutedWhy?: string
  /** ask-fix r2: a make/draw request fell back to the person's own mind; an admin may set this swarm's coordinator */
  fixSwarm?: string
  /** the swarm in view when it was asked (a refused row links an admin to its settings) */
  swarm?: string
  /** this refused request was already sent once more after the person chose who answers (never twice) */
  resent?: boolean
  /**
   * While the admission is not known: the ORIGINAL request (same operation_id, same body) and the person it was sent
   * as. A check reads it back, or sends exactly this again; nothing else is ever sent for this turn meanwhile.
   */
  unsure?: { body: AskBody; principal: string; tries: number; state: 'checking' | 'waiting' | 'unresolved' }
  /**
   * Words the person typed while the admission was not known: never sent then, never dropped. Released in order once
   * it is known: as steering if the hive has the request, as a new request if the hive refused it.
   */
  held?: { text: string; context: AskContext; opts: AskOpts }[]
  /** asked from a private app's page (Atlas, Truth): nothing it says is remembered here (the host fences it too) */
  privatePage?: boolean
  /**
   * When the person asked, as the Ask's memory saw it (lib/askMemory `turnMark`): a frame of this turn is not kept if
   * they forgot its words, or everything, after that (stand-in r2 P1). Absent on a turn rejoined after a reload: its
   * frames are then timed by the host's `accepted` frame (lib/askMemory `hostMark`, r3b).
   */
  memorySince?: TurnMark
}

export interface PresenceItem {
  id: string
  op: string
  actor: AskWho
  verb: PresenceVerb
  target: PresenceTarget
  caption: string
  at: number
  /** a highlight in place: no light travels to it (conductor `highlight`) */
  still?: boolean
}

/** The thread's order: fast-path rows and mind turns, as they happened. */
export type LogEntry = { kind: 'row'; row: AskRow } | { kind: 'turn'; op: string }

interface AskState {
  /**
   * the store session and identity this thread belongs to; null until identity is known. `auth` is the client's
   * sign-in it was bound under (readContext authIdentity: Platform person-session authContext; null for a client
   * that does not report one): a credential-only change on the same client is an identity change too (Review B1, 06ce9e7)
   */
  bound: { session: string; principal: string; auth: string | null } | null
  /** bumped on every reset, so a late answer from before it never writes */
  epoch: number
  thread: AskThread | null
  log: LogEntry[]
  turns: Record<string, TurnMeta>
  /** the turn in flight */
  open: string | null
  confirm: { op: string; proposal: AppActProposal; seq: number } | null
  presence: PresenceItem[]
  settings: AskSettings | null
  /** the person's own mind (GET /api/me/mind, Platform P1/P2): undefined until read; null when none or not on this hive */
  personal: MyMind | null | undefined
  /**
   * j0-fixes r1: the mind the showing thread answers through, for plain follow-ups (features/ask/answerer planAsk).
   * Cleared by an explicit choice of who answers, by closing the thread, and by a new thread or person.
   */
  carry: Carry | null
  /** UI: the thread is showing, and pinned beside the world (desktop) */
  threadOpen: boolean
  pinned: boolean
  /** fast-path rows' later states (an Undo that ran) */
  local: Record<string, Partial<AskRow>>
}

interface AskActions {
  /**
   * Bind the thread to the store session and the person `me()` named, under the sign-in that read was made under
   * (`auth`, default: the client's current one). A sign-in that is no longer current binds nothing.
   */
  bind(session: string, principal: string, auth?: string | null): void
  reset(): void
  /**
   * A fast-path row. With `origin`, nothing is written unless the thread is still the one the act started in (Review
   * B1), and its Undo only ever runs under that same origin. Returns the row id, or '' when nothing was written.
   */
  addLocal(you: string, text: string, opts?: { where?: string; undo?: () => Promise<void> | void; back?: boolean; origin?: AskOrigin; state?: RowState }): string
  /** A later word on a fast-path row (an answer that arrived): only under the origin it started in. */
  settleLocal(rowId: string, text: string, origin: AskOrigin, state?: RowState): void
  note(text: string): void
  /** A mind turn. `about`: the name of the mind the person addressed (context.mind carries its id). */
  send(text: string, context: AskContext, opts?: AskOpts): Promise<void>
  /** Mid-turn words: a steer to the open turn (never a new turn while it is open; never locks the field). */
  steer(text: string, context: AskContext, opts?: AskOpts): Promise<void>
  /** Steer one named turn (never whichever turn is open now); a closed or missing turn takes the words as a new request. */
  steerTo(op: string | null, text: string, context: AskContext, opts?: AskOpts): Promise<void>
  /**
   * As send (a steer to the open turn while one is open), resolving to the exact admission: the operation the hive
   * admitted these words under, bound to the person asking, or why not. Failed, unsupported, capped and held steers,
   * refusals and unknown admissions are all `admitted: false`. Never "whatever turn is open".
   */
  admit(text: string, context: AskContext, opts?: AskOpts): Promise<AskAdmission>
  /** ask_busy: the person's thread already has a turn in flight; show that one instead of starting another. */
  rejoin(op: string): Promise<void>
  /** Host-only adoption of an admitted app turn into this same memory-only Ask log. Never sends another Ask. */
  adoptAppTurn(op: string, turn: string, text?: string): boolean
  /** P1 nonterminal recovery of this exact existing turn; never calls takeover or creates a replacement. */
  showAppTurn(op: string): Promise<void>
  retryLast(): Promise<void>
  /** Check again whether an Ask of unknown admission reached the hive (the same request, under the same id). */
  checkAgain(op: string): Promise<void>
  onEvent(e: unknown): void
  recover(op: string): Promise<void>
  /** The person asked to try loading the missed steps again (after the bounded reads gave up). */
  retryRecover(op: string): Promise<void>
  /** Read every turn of the thread back from the host and rebuild it (a reconnect). No effect is applied twice. */
  rebuild(): Promise<void>
  stop(): Promise<void>
  newThread(): Promise<void>
  deleteThread(): Promise<boolean>
  runUndo(rowId: string): Promise<void>
  goTo(rowId: string): void
  revisit(rowId: string): void
  keepUi(rowId: string): Promise<void>
  undoUi(rowId: string): void
  answerRevertOffer(rowId: string, undo: boolean): Promise<void>
  confirmAct(): Promise<DecisionResult>
  declineAct(): void
  openConfirm(rowId: string): void
  dropPresence(id: string): void
  /** Conductor: show a point or highlight (already resolved on screen by the caller). */
  showPresence(item: PresenceItem): void
  /** Conductor: what an act did, as the turn's row at its seq, with its Undo or Back (run only under `origin`). */
  actOutcome(op: string, seq: number, row: { text: string; state: RowState; back?: boolean }, undo?: () => Promise<void> | void, origin?: AskOrigin): void
  /** Conductor: a page note in the turn ("stopped after 32 steps"). */
  turnNote(op: string, text: string): void
  personTookOver(): void
  loadSettings(): Promise<void>
  setDefaultSwarm(swarmId: string | null): Promise<boolean>
  /**
   * The person chose who answers: saved as their default Ask swarm, then (when `op` is the last request, refused for
   * who answers) its same words are sent once more, only while the same person, sign-in and epoch still hold.
   */
  chooseAnswerer(swarmId: string, op?: string): Promise<'resent' | 'saved' | 'failed'>
  /** A new limit for new threads (the host says the most allowed); the current thread's cap never rises. */
  setThreadLimit(usd: number): Promise<boolean>
  setThreadOpen(open: boolean): void
  setPinned(pinned: boolean): void
}

export type AskStore = AskState & AskActions

let last: { text: string; context: AskContext; opts: AskOpts } | null = null
/** the operation id of the last request sent (retryLast checks it before anything new is sent) */
let lastOp: string | null = null
const undos = new Map<string, { fn: () => Promise<void> | void; origin?: AskOrigin }>()
const silence = new Map<string, ReturnType<typeof setTimeout>>()
const retries = new Map<string, ReturnType<typeof setTimeout>>()
const checks = new Map<string, ReturnType<typeof setTimeout>>()
/** checks in flight, by operation id: never two at once for one request */
const checking = new Set<string>()
/** A private app's page, by the turn context it sends or the page's own address (double fence; view.ts). */
const isPrivate = (context: AskContext): boolean => ('private' in context && context.private === true) || (typeof window !== 'undefined' && isPrivateHash(window.location.hash || ''))
const clearRetries = () => {
  for (const t of retries.values()) clearTimeout(t)
  retries.clear()
  for (const t of checks.values()) clearTimeout(t)
  checks.clear()
  checking.clear()
}
let rowSeq = 0
const rid = () => `r${++rowSeq}`
const opId = () => `ask:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`
const steerId = () => `st_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
const dev = typeof import.meta !== 'undefined' && !!import.meta.env?.DEV

const fresh = (): Pick<AskState, 'thread' | 'log' | 'turns' | 'open' | 'confirm' | 'presence' | 'local' | 'carry'> => ({ thread: null, log: [], turns: {}, open: null, confirm: null, presence: [], local: {}, carry: null })

// ---------------------------------------------------------------- pure helpers (tested)

/** A short plain name for a route, for "Opened Usage". */
export function routeLabel(r: Route): string {
  const names: Partial<Record<Route['name'], string>> = { hive: 'the hive', approvals: 'Decisions', programs: 'Apps', program: 'the app', dot: 'the mind', swarm: 'the swarm', me: 'You', new: 'Create a mind', launch: 'Start a swarm' }
  return names[r.name] ?? r.name[0].toUpperCase() + r.name.slice(1)
}

/** A proposal's route as a hash this UI can open, or null (an unknown page is never opened). */
export function proposalRoute(raw: string): { route: Route; hash: string } | null {
  const h = raw.startsWith('#') ? raw : raw.startsWith('/') ? `#${raw}` : `#/${raw}`
  const route = parse(h)
  const canonical = href(route)
  if (route.name === 'hive' && !/^#\/?$/.test(h)) return null
  // Goals and Boards became Tasks: an old address still opens, at the address it lives at now (same filter)
  if (route.name === 'tasks' && /^#\/(goals|boards)(\/|\?|$)/.test(h)) return { route, hash: canonical }
  if (canonical !== h && canonical !== h.replace(/\/$/, '')) return null
  return { route, hash: canonical }
}

/** The look a ui proposal asks for, against the saved one; what this build cannot show is dropped and named. */
export function proposedLook(prefs: { variant?: unknown; layout?: string | null; experience?: string | null; density?: string }, saved: UiPrefs | null, offered: { id: string; name: string }[]): { next: UiPrefs; dropped: string[] } {
  const next: UiPrefs = { variant: saved?.variant ?? null, layout: saved?.layout ?? null, apps: saved?.apps ?? null, experience: saved?.experience ?? null }
  const dropped: string[] = []
  // a look the mind proposes is the person's own choice, by id or as a whole object: marked the same way when it is
  // the companion of the experience it will be worn in (uiVariant.asOwnChoice; stand-in r3 P2)
  const wornIn = prefs.experience !== undefined ? (prefs.experience === 'classic' ? null : prefs.experience) : next.experience
  if (typeof prefs.variant === 'string') {
    const v = prefs.variant === 'default' ? null : SEED_VARIANTS.find((s) => s.id === prefs.variant)
    if (v === undefined) dropped.push('a look this hive does not have')
    else next.variant = v && asOwnChoice(v, wornIn)
  } else if (prefs.variant && typeof prefs.variant === 'object' && (prefs.variant as UiVariant).schema === 'omegasurface.variant/0.1') next.variant = asOwnChoice(prefs.variant as UiVariant, wornIn)
  if (prefs.layout === null || prefs.layout === 'rail' || prefs.layout === 'topbar' || prefs.layout === 'dock') next.layout = (prefs.layout ?? null) as Layout | null
  // text size (shell/uiVariant TEXT_SCALE): the same as a described look's; a density this build has no
  // scale for is not guessed at
  if (prefs.density !== undefined) {
    if (prefs.density === 'compact' || prefs.density === 'regular' || prefs.density === 'roomy') next.variant = { ...(next.variant ?? DEFAULT_VARIANT), density: prefs.density }
    else dropped.push(`a text size this build does not have (${String(prefs.density).slice(0, 20)})`)
  }
  if (prefs.experience !== undefined) {
    // the same choice as Change UI (uiVariant.withExperience); a look the mind also proposed is kept
    const choose = (id: string | null) => {
      const proposed = next.variant
      Object.assign(next, withExperience(next, id))
      if (prefs.variant !== undefined) next.variant = proposed
    }
    if (prefs.experience === null || prefs.experience === 'classic') choose(null)
    else if (offered.some((e) => e.id === prefs.experience)) choose(prefs.experience as string)
    else dropped.push(`the ${String(prefs.experience).slice(0, 30)} experience (not offered in this build)`)
  }
  return { next, dropped }
}

/** an answer streamed in pieces is held to this many characters */
export const ANSWER_MAX = 16_000

const proposalLabel = (label: string | undefined, r: Route) => (label ?? '').replace(/[<>]/g, '').slice(0, 60) || routeLabel(r)

/**
 * A turn's rows, derived from its frames and the page's outcomes: the person's words, then every frame in seq order
 * with the steers (echoed or still pending) and page notes in their places. Pure: the same turn gives the same rows.
 */
export function turnRows(t: TurnMeta, mindName?: string, thread?: { spent_usd: number; budget_usd: number } | null): AskRow[] {
  const rows: AskRow[] = [{ id: `${t.op}#you`, op: t.op, kind: 'you', text: t.you, where: t.where }]
  if (t.actingAs) rows.push({ id: `${t.op}#as`, op: t.op, kind: 'note', text: `Answering for you: your mind ${t.actingAs.name.slice(0, 60)}.` })
  // the rerouted note, also beside "Answering for you" when it carries the admin's fix (ask-fix r2)
  if (t.rerouted && (!t.actingAs || t.fixSwarm)) rows.push({ id: `${t.op}#around`, op: t.op, kind: 'note', text: t.rerouted, ...(t.reroutedWhy ? { detail: t.reroutedWhy } : {}), ...(t.fixSwarm ? { swarm: t.fixSwarm, fixCoordinator: true } : {}) })
  const echoed = new Set<string>()
  for (const e of t.events) if (e.phase === 'steer') echoed.add(e.steer_id)
  const pending = t.steers.filter((s) => !echoed.has(s.steer_id))
  const notesAt = (seq: number) => t.notes.filter((n) => n.after === seq)
  const steersAt = (seq: number) => pending.filter((s) => s.at_seq === seq)
  const place = (seq: number) => {
    for (const s of steersAt(seq)) rows.push({ id: `${t.op}~${s.steer_id}`, op: t.op, kind: 'steer', text: s.text, state: s.state === 'failed' ? 'failed' : 'sending' })
    for (const [i, n] of notesAt(seq).entries()) rows.push({ id: `${t.op}!${seq}.${i}`, op: t.op, kind: 'note', text: n.text })
  }
  place(0)
  // an answer arriving in pieces: deltas append to one row until the whole answer (or the turn's end) settles it
  let streaming: AskRow | null = null
  for (const e of t.events) {
    const o = t.outcomes[e.seq]
    const id = `${t.op}#${e.seq}`
    const base = { id, op: t.op, seq: e.seq }
    switch (e.phase) {
      case 'thinking':
        if (e.truncated) {
          // the host trimmed later steps: said once per turn, quietly
          if (!rows.some((r) => r.op === t.op && r.kind === 'note' && r.id.endsWith('#more'))) rows.push({ id: `${t.op}#more`, op: t.op, seq: e.seq, kind: 'note', text: '…more steps not shown' })
        } else if (e.step) rows.push({ ...base, kind: 'step', text: e.step })
        break
      case 'steer':
        rows.push({ ...base, kind: 'steer', text: e.text, state: 'sent' })
        break
      case 'answer':
        if (e.delta) {
          if (streaming) streaming.text = (streaming.text + e.text).slice(0, ANSWER_MAX)
          else rows.push((streaming = { ...base, kind: 'answer', text: e.text, who: mindName, streaming: true }))
        } else if (streaming) {
          // the whole answer replaces the pieces (Platform: the host always ends with one non-delta answer, or done)
          streaming.text = e.text
          streaming.streaming = false
          streaming = null
        } else rows.push({ ...base, kind: 'answer', text: e.text, who: mindName })
        break
      case 'act':
        if (o?.kind === 'act') rows.push({ ...base, kind: 'local', text: o.text, state: o.state, undo: o.undo })
        break
      case 'dispatched':
        rows.push({ ...base, kind: 'local', text: `Handed to ${e.to.name ?? e.to.ref}: ${e.label ?? e.intent_kind}`, state: 'sent' })
        break
      case 'proposal':
        if (o?.kind === 'nav') rows.push({ ...base, kind: 'nav', text: `Opened ${o.label}`, route: o.route, from: o.from, label: o.label, state: o.state, moveId: e.proposal.id })
        else if (o?.kind === 'go') rows.push({ ...base, kind: 'go', text: `Suggested: ${o.label}`, route: o.route, label: o.label, moveId: e.proposal.id })
        else if (o?.kind === 'ui') rows.push({ ...base, kind: 'ui', text: `A look: ${('label' in e.proposal && e.proposal.label ? e.proposal.label : lookName(o.prefs)).slice(0, 60)}`, prefs: o.prefs, before: o.before, dropped: o.dropped, state: o.state, moveId: e.proposal.id })
        else if (o?.kind === 'note') rows.push({ ...base, kind: 'note', text: o.text })
        break
      case 'presence':
        if (o?.kind === 'nav') rows.push({ ...base, kind: 'nav', text: `Opened ${o.label}`, route: o.route, from: o.from, label: o.label, state: o.state })
        else if (o?.kind === 'go') rows.push({ ...base, kind: 'go', text: `Suggested: ${o.label}`, route: o.route, label: o.label })
        break
      case 'ui-change':
        rows.push({ ...base, kind: 'ui-change', text: o?.kind === 'ui-change' && o.state === 'reverted' ? 'Look change reverted.' : 'Look saved. The hive keeps the earlier one, so it can be undone.', moveId: e.undo?.history_id, state: o?.kind === 'ui-change' ? o.state : undefined })
        break
      case 'action-needs-confirm':
        rows.push({ ...base, kind: 'confirm', text: `Proposed by ${mindName ?? 'the orchestrator'}: ${e.proposal.label}`, proposal: e.proposal, state: o?.kind === 'confirm' ? o.state : 'waiting' })
        break
      case 'revert':
        if (o?.kind === 'revert-offer') rows.push({ ...base, kind: 'revert-offer', text: o.text, state: o.state === 'done' ? 'reverted' : o.state === 'kept' ? 'kept' : 'waiting' })
        else if (o?.kind === 'note') rows.push({ ...base, kind: 'note', text: o.text })
        break
      case 'memory':
        if (o?.kind === 'note') rows.push({ ...base, kind: 'note', text: o.text })
        break
      case 'refused':
        rows.push({ ...base, kind: 'refused', text: '', reason: e.reason, ...(typeof e.turn_spent_usd === 'number' && Number.isFinite(e.turn_spent_usd) && e.turn_spent_usd >= 0 ? { spentUsd: e.turn_spent_usd } : {}) })
        break
      case 'done': {
        // a turn the host stopped at a limit says so, in the page's words (never the host's); the person's own
        // takeover is said plainly, not as a stop or an error
        // j0-fixes r1: a spending stop names the limit that stopped it and offers only a remedy that helps (words.ts)
        // (ask-limits r1); a model with no price or a missing key is its own error, not a limit
        const stop = !e.taken_over && e.outcome === 'spend_cap' ? spendStop(readDoneLimit(e.limit), thread) : null
        const said = e.taken_over ? TAKEOVER_WORDS : stop ? stop.text : e.outcome === 'error' ? doneErrorWords(e.error) : e.outcome ? DONE_WORDS[e.outcome] : null
        const offer = stop ? (stop.offer.length ? stop.offer : undefined) : !e.taken_over && e.outcome ? DONE_OFFERS[e.outcome] : undefined
        if (said) rows.push({ ...base, kind: 'note', text: said, ...(offer ? { offer } : {}) })
        break
      }
    }
    place(e.seq)
  }
  // a closed turn settles an answer still arriving: what came is what it said
  if (streaming && t.state !== 'open' && t.state !== 'sending') streaming.streaming = false
  if (t.gap) {
    // Review B2: the history is not whole. Said plainly; nothing after the gap was applied.
    const gaveUp = t.gap.state === 'gave-up'
    rows.push({ id: `${t.op}#gap`, op: t.op, kind: 'gap', text: gaveUp ? 'Some steps could not be loaded. Nothing after them was done on this page.' : 'Some steps have not arrived yet; loading them before going on.', state: gaveUp ? 'failed' : 'waiting' })
    // a final answer held behind the gap may be read, marked incomplete; it changes nothing
    if (gaveUp) for (const e of t.ahead) if (e.phase === 'answer') rows.push({ id: `${t.op}#${e.seq}?`, op: t.op, seq: e.seq, kind: 'answer', text: e.text, who: mindName, incomplete: true })
  }
  if (t.state === 'checking' && t.unsure) {
    // Review B1 (45392df): not known whether the hive has it. Never said as refused; it is not sent twice.
    const stuck = t.unsure.state === 'unresolved'
    rows.push({ id: `${t.op}#checking`, op: t.op, kind: 'checking', text: stuck ? 'Could not confirm whether the hive received this. It is kept here and will not be sent twice; check again in a moment.' : 'Checking whether the hive received this. It will not be sent twice.', state: stuck ? 'failed' : 'waiting' })
  }
  if (t.refusedEarly) rows.push({ id: `${t.op}#refused`, op: t.op, kind: 'refused', text: '', reason: t.refusedEarly, mind: t.asleep, swarm: t.swarm, ...(t.asleepOwn ? { own: true } : {}) })
  // a steer typed at a seq not (yet) received sits at the end
  for (const s of pending) if (s.at_seq > t.lastSeq) rows.push({ id: `${t.op}~${s.steer_id}`, op: t.op, kind: 'steer', text: s.text, state: 'sending' })
  return rows
}

/** The whole thread, in order. */
export function threadRows(s: Pick<AskState, 'log' | 'turns' | 'thread' | 'local'>): AskRow[] {
  const out: AskRow[] = []
  for (const e of s.log) {
    if (e.kind === 'row') out.push({ ...e.row, ...s.local[e.row.id] })
    // a turn row's later state (a conductor act's Undo that ran) is kept the same way as a fast-path row's
    else if (s.turns[e.op]) for (const r of turnRows(s.turns[e.op], s.thread?.mind.name, s.thread)) out.push(s.local[r.id] ? { ...r, ...s.local[r.id] } : r)
  }
  return out
}

/** The mind's moves this turn, in order, for the trail. */
export const movesOf = (t: TurnMeta): { seq: number; o: Extract<Outcome, { kind: 'nav' }> }[] =>
  t.events.flatMap((e) => {
    const o = t.outcomes[e.seq]
    return o?.kind === 'nav' ? [{ seq: e.seq, o }] : []
  })

// ---------------------------------------------------------------- the store

/** ask-fix r2: the route a compatibility re-send takes (set just before it, read once by send) */
type Routed = { context: AskContext; note: string | null; why?: string; fixSwarm?: string }
/** a send's planned route (answerer.ts planAsk), or the compatibility re-send's */
type Around = Routed & { through?: { mind: string; why: string }; compat?: Routed }
let compatNext: Routed | null = null
/** ask-fix r2: the mind each coordinator-less swarm's thread answers through, kept for its follow-ups */
const throughMinds = new Map<string, string>()
/** j0-fixes r1: the mind a coordinator-less swarm's thread answers through (the field plans with the same preference) */
export const throughMindOf = (swarmId: string): string | undefined => throughMinds.get(swarmId)

export const useAskStore = create<AskStore>()((set, get) => {
  const addRow = (r: Omit<AskRow, 'id'>): string => {
    const id = rid()
    set((s) => ({ log: [...s.log, { kind: 'row' as const, row: { ...r, id } }].slice(-300) }))
    return id
  }
  const patchTurn = (op: string, p: Partial<TurnMeta> | ((t: TurnMeta) => Partial<TurnMeta>)) => {
    set((s) => {
      const t = s.turns[op]
      if (!t) return s
      return { turns: { ...s.turns, [op]: { ...t, ...(typeof p === 'function' ? p(t) : p) } } }
    })
    sendTakeover(op)
  }
  /**
   * The person took over (ask-takeover r3): the host is told once the turn is admitted, whichever path admits it (the
   * POST's answer, an `accepted` frame, a check or a recovery), so a takeover made while the request is still being sent
   * is kept, not lost to a 404. If the host does not take it, the turn is stopped instead; if that fails too, the page
   * says so rather than implying the hive stopped.
   */
  function sendTakeover(op: string) {
    const t = get().turns[op]
    const client = useHive.getState().client
    if (!t || !t.tookOver || t.takeover || t.state !== 'open' || !client?.askTakeover) return
    const snap = snapshot()
    patchTurn(op, { takeover: 'sending' })
    client.askTakeover(op).then(
      () => {
        if (snap.ok()) patchTurn(op, { takeover: 'sent' })
      },
      async (err: unknown) => {
        // conductor-live: 404 not_available is the host saying this is not a conductor turn (the conductor is off):
        // inert, never a stop of the coordinator's answer, and nothing said as an error
        if (err instanceof ApiError && err.status === 404 && err.code === 'not_available') {
          if (snap.ok()) patchTurn(op, { takeover: 'inert' })
          return
        }
        // followups-r8 (found by the helper-effect scan): the stop is a second write after the takeover's answer, so it
        // is sent only while the thread, sign-in and client it was taken under are still current
        if (!snap.ok()) return
        try {
          if (!client.askStop) throw new Error('no stop')
          await client.askStop(op)
          if (snap.ok()) patchTurn(op, { takeover: 'sent' })
        } catch {
          if (!snap.ok()) return
          patchTurn(op, { takeover: 'failed' })
          noteAfter(op, 'The hive didn’t confirm that the orchestrator stopped. Stop it to be sure.')
        }
      },
    )
  }
  const outcome = (op: string, seq: number, o: Outcome) => patchTurn(op, (t) => ({ outcomes: { ...t.outcomes, [seq]: o } }))
  const noteAfter = (op: string, text: string) => patchTurn(op, (t) => ({ notes: [...t.notes, { after: t.lastSeq, text }] }))
  const closeTurn = (op: string, state: 'done' | 'refused') => {
    clearTimeout(silence.get(op))
    silence.delete(op)
    patchTurn(op, { state, step: undefined })
    set((s) => ({ open: s.open === op ? null : s.open }))
  }
  const watch = (op: string) => {
    clearTimeout(silence.get(op))
    silence.set(op, setTimeout(() => {
      const t = get().turns[op]
      if (t && (t.state === 'open' || t.state === 'sending')) void get().recover(op)
    }, SILENCE_MS))
  }
  /**
   * Still bound to the session, identity, sign-in and epoch it was taken under. The sign-in is read from the client
   * itself (Review B1, 06ce9e7): a credential replaced on the same client fails this at once, even in the interval
   * before its observer has run and reset the thread.
   */
  const snapshot = () => {
    const { bound, epoch } = get()
    const { client, session, inits } = useHive.getState()
    return { client, ok: () => !!bound && get().epoch === epoch && get().bound === bound && useHive.getState().session === session && useHive.getState().inits === inits && useHive.getState().client === client && authIdentity(client) === bound.auth }
  }
  /** The binding, only while the client's sign-in is still the one it was bound under; otherwise the thread is dropped. */
  const liveBound = () => {
    const b = get().bound
    if (b && authIdentity(useHive.getState().client) !== b.auth) {
      get().reset()
      return null
    }
    return b
  }
  /**
   * A live memory frame, once it is placed in its turn (`accept`: in seq order, every frame before it applied) and
   * before anything draws it: kept in this browser (lib/askMemory), then said in the turn. Never from a private app's
   * page (the turn's, or the page's now). Its turn's start is this page's mark, or for a rejoined turn the host's
   * `accepted` frame (always applied before it, being earlier in seq); with neither it is not kept (stand-in r3b P1).
   */
  const remember = (e: Extract<AskEvent, { phase: 'memory' }>) => {
    const t = get().turns[e.operation_id]
    const p1 = e.app_ask === true || t?.appAsk === true || appAskTracked(e.operation_id)
    // Only the ordinary host send captures an explicit public origin under its bound request before any await.
    // An app turn's unknown origin stays private; a frame, late reply or current route cannot grant public provenance.
    const privatePage = (p1 && t?.privatePage !== false) || !!t?.privatePage || (typeof window !== 'undefined' && isPrivateHash(window.location.hash || ''))
    const r = askMemory.receive({ turn_id: e.turn_id, seq: e.seq, op: e.op, digest: e.digest, item: e.item as never, target_id: e.target_id ?? null }, { privatePage, since: t?.memorySince ?? askMemory.hostMark(t?.events.find((x) => x.phase === 'accepted')?.at) ?? null })
    const text = r.kept
      ? `${e.op === 'revise' ? 'Updated' : 'Remembered'} in this browser: ${r.kept.statement}`
      : r.why === 'private'
        ? p1 ? 'Not remembered: this request stays private.' : 'Not remembered: this page is private.'
        : r.why === 'forgotten'
          ? 'Not remembered: you asked the Ask to forget this.'
          : r.why === 'unplaced'
            ? 'Not remembered: when this turn began is not known here.'
        : r.why === 'nobody'
          ? 'Not remembered: this browser does not know who you are yet.'
          : r.why
            ? 'Something to remember could not be kept here.'
            : 'Remembered in this browser.'
    outcome(e.operation_id, e.seq, { kind: 'note', text: text.slice(0, 600) })
  }
  const newTurn = (op: string, you: string, where?: string, about?: string): TurnMeta => ({ op, you, where, about, state: 'sending', lastSeq: 0, events: [], outcomes: {}, notes: [], steers: [], moves: 0, tookOver: false, presence: 0, ahead: [] })

  /** Stored personal history is content-free. A verified live projection already held here always wins over its
   *  same-identity metadata stub; this never invents missing words or fetches a second private transcript. */
  const readFrame = (raw: unknown, op: string): AskEvent | null => {
    const t = get().turns[op]
    if (t?.appAsk && raw && typeof raw === 'object') {
      const r = raw as Partial<AskEvent>
      if (r.operation_id === op && r.turn_id === t.appAskTurnId) {
        const live = [...t.events, ...t.ahead].find((e) => e.operation_id === r.operation_id && e.turn_id === r.turn_id && e.seq === r.seq && e.phase === r.phase)
        if (live) return live
      }
    }
    return checkAskEvent(raw)
  }

  /** A mind's move of the page: applied unless held (unsaved state, the person took over, the turn closed). */
  const mindMove = (op: string, seq: number, raw: string, label: string | undefined, animate: boolean) => {
    const t = get().turns[op]
    const target = proposalRoute(raw)
    if (!target) {
      outcome(op, seq, { kind: 'note', text: 'The orchestrator suggested a page that isn’t in this hive, so nothing moved.' })
      return
    }
    const name = proposalLabel(label, target.route)
    if (!t) return
    if (t.moves >= NAV_FLOOD_CAP) return outcome(op, seq, { kind: 'skip' })
    const why = t.tookOver ? 'took-over' : t.state !== 'open' && t.state !== 'sending' ? 'closed' : hasUnsaved({ domUnsaved, lookPreview: () => lookState().preview !== null }) ? 'unsaved' : null
    if (why) return outcome(op, seq, { kind: 'go', route: target.hash, label: name, why })
    const from = typeof window !== 'undefined' ? window.location.hash || '#/' : '#/'
    patchTurn(op, (x) => ({ moves: x.moves + 1 }))
    outcome(op, seq, { kind: 'nav', from, route: target.hash, label: name, state: 'applied' })
    move(target.route, animate)
  }

  /** Undo one of the mind's moves (by seq): pages through history, looks to the earlier prefs. Kept looks are asked. */
  const revertSeq = async (op: string, seq: number, revertSeqNo: number): Promise<string | null> => {
    const t = get().turns[op]
    const o = t?.outcomes[seq]
    if (!t || !o) return null
    if (o.kind === 'nav' && o.state === 'applied') {
      outcome(op, seq, { ...o, state: 'reverted' })
      // only if the page is still where the mind put it; the person's own moves are never undone
      if (window.location.hash === o.route) {
        const back = proposalRoute(o.from)
        move(back?.route ?? { name: 'hive' }, false)
      }
      return o.label
    }
    if (o.kind === 'ui' && o.state === 'preview') {
      previewLook(null)
      outcome(op, seq, { ...o, state: 'reverted' })
      return 'the look preview'
    }
    if (o.kind === 'ui' && o.state === 'kept') {
      // a person-confirmed effect is never reverted silently: offer it
      outcome(op, revertSeqNo, { kind: 'revert-offer', target: seq, text: 'The orchestrator suggests undoing the look you kept. Undo it?' })
      return null
    }
    return null
  }

  const apply = async (e: AskEvent) => {
    const op = e.operation_id
    watch(op)
    // Legacy automatic page effects have no recipient/claim. They can be shown by the app, but never replayed on
    // the host merely because a P1 turn is recovered. Explicit host approvals and stamped acts keep their gates.
    const p1 = e.app_ask === true || get().turns[op]?.appAsk === true || appAskTracked(op)
    if (p1) patchTurn(op, { appAsk: true })
    if (p1 && ['proposal', 'presence', 'revert', 'ui-change'].includes(e.phase)) return
    switch (e.phase) {
      case 'accepted': {
        set({ thread: e.thread })
        const as = readActingAs((e as { acting_as?: unknown }).acting_as)
        patchTurn(op, (t) => ({ ...(t.state === 'sending' ? { state: 'open' as const } : {}), ...(as && !t.actingAs ? { actingAs: as } : {}) }))
        return
      }
      case 'thinking':
        if (!e.truncated) patchTurn(op, { step: e.step?.slice(0, 200) || 'thinking' })
        return
      case 'steer':
        patchTurn(op, (t) => ({ steers: t.steers.map((s) => (s.steer_id === e.steer_id ? { ...s, state: 'sent' as const } : s)) }))
        return
      case 'answer':
        return
      case 'proposal': {
        const p = e.proposal
        if (p.kind === 'navigate') mindMove(op, e.seq, p.route, p.label, p.animate === true)
        else if (p.kind === 'ui') {
          const { next, dropped } = proposedLook(p.prefs, lookState().saved, EXPERIENCES)
          // one preview at a time: an earlier one still showing is replaced
          for (const [k, t] of Object.entries(get().turns))
            for (const [seq, o] of Object.entries(t.outcomes)) if (o.kind === 'ui' && o.state === 'preview') outcome(k, Number(seq), { ...o, state: 'replaced' })
          const before = lookState().saved
          previewLook(next)
          outcome(op, e.seq, { kind: 'ui', prefs: next, before, dropped, state: 'preview' })
        } else outcome(op, e.seq, { kind: 'note', text: 'The orchestrator offered something this page can’t show yet.' })
        return
      }
      case 'ui-change':
        outcome(op, e.seq, { kind: 'ui-change' })
        return
      case 'action-needs-confirm':
        outcome(op, e.seq, { kind: 'confirm', state: 'waiting' })
        set({ confirm: { op, proposal: e.proposal, seq: e.seq } })
        return
      case 'presence': {
        const t = get().turns[op]
        if (!t || t.presence >= PRESENCE_PER_TURN) return
        patchTurn(op, { presence: t.presence + 1 })
        const item: PresenceItem = { id: `${op}#${e.seq}`, op, actor: e.actor, verb: e.verb, target: e.target, caption: (e.caption ?? '').slice(0, 120), at: Date.now() }
        set((s) => ({ presence: [...s.presence.slice(-3), item] }))
        // a `go` moves the page like a navigate proposal, with the same guards
        if (e.verb === 'go' && e.target.feature) {
          const f = featureById(e.target.feature)
          if (f?.classic && f.classic.name !== 'hive') mindMove(op, e.seq, href(f.classic), f.label, e.animate === true)
        }
        return
      }
      case 'revert': {
        const t = get().turns[op]
        if (!t) return
        // by id (a move's proposal id, or a ui-change history id), or everything after a seq, newest first
        const targets = e.target_id
          ? t.events.filter((x) => (x.phase === 'proposal' && x.proposal.id === e.target_id) || (x.phase === 'ui-change' && x.undo?.history_id === e.target_id)).map((x) => x.seq)
          : t.events.filter((x) => x.seq > (e.to_seq ?? Infinity) && x.seq < e.seq).map((x) => x.seq).reverse()
        const undone: string[] = []
        for (const seq of targets) {
          const w = await revertSeq(op, seq, e.seq)
          if (w) undone.push(w)
        }
        if (undone.length) outcome(op, e.seq, { kind: 'note', text: `Reverted: ${undone.join(', ')}.` })
        return
      }
      case 'act':
        if (!framePresentsAsk(op) && hostAskRecipient(e.recipient, p1)) conductor?.(op, e)
        return
      case 'dispatched':
        return
      case 'memory': {
        // the live frame was kept once placed (accept, before this); a stub read back later that this browser never had
        // is said as lost, once
        if (e.item) return
        const snap = snapshot()
        void askMemory.stub({ turn_id: e.turn_id, seq: e.seq, op: e.op }).then((lost) => {
          if (lost && snap.ok()) outcome(op, e.seq, { kind: 'note', text: LOST_WORDS })
        })
        return
      }
      case 'done':
        if (typeof e.spent_usd === 'number') set((s) => (s.thread ? { thread: { ...s.thread, spent_usd: e.spent_usd! } } : s))
        closeTurn(op, 'done')
        return
      case 'refused':
        closeTurn(op, 'refused')
        return
    }
  }

  /**
   * Send the words held while a turn was checking, in order, once its admission is known (never inside a frame).
   * Review B1 (82d6fbe): they keep the custody they were typed under. The person, session and epoch are captured
   * here and checked again inside the deferred work and before every send after each await; a reset or another
   * identity drops what is left. Admitted: they steer THIS turn, never another turn that happens to be open.
   * Refused: the first becomes a new request and the rest steer that request; if another request is running instead,
   * nothing is retargeted to it and the thread says so.
   */
  const release = (op: string) => {
    const held = get().turns[op]?.held
    if (!held?.length) return
    patchTurn(op, { held: undefined })
    const snap = snapshot()
    const holds = () => snap.ok() && !!get().turns[op]
    queueMicrotask(() => {
      void (async () => {
        let target = op
        for (const h of held) {
          if (!holds()) return
          const cur = get().turns[target]
          if (cur && (cur.state === 'open' || cur.state === 'sending' || cur.state === 'checking')) {
            await get().steerTo(target, h.text, h.context, h.opts)
            continue
          }
          const running = get().open
          if (running && running !== target) {
            noteAfter(op, 'Not sent: another request is running now, and these words were for this one. Ask again when it finishes.')
            return
          }
          await get().send(h.text, h.context, h.opts)
          if (!holds()) return
          const made = get().open
          if (made && made !== op) target = made
        }
      })()
    })
  }

  /**
   * Apply frames in seq order, once; a gap waits for recovery. A live memory frame is remembered only here, once placed
   * (stand-in r3b P1): one that arrives ahead of a gap waits in `ahead` (bounded by AHEAD_CAP, this page's memory only,
   * gone with the turn); if it is never placed it is never remembered.
   */
  const accept = (frame: AskEvent) => {
    let e = frame
    const t = get().turns[e.operation_id]
    if (!t || e.seq <= t.lastSeq || t.appAskTurnId && e.turn_id !== t.appAskTurnId) return
    if (t.state === 'checking') {
      // a frame of this very operation: the host admitted it (Review B1, 45392df); the check stops
      clearTimeout(checks.get(t.op))
      checks.delete(t.op)
      patchTurn(t.op, { state: 'open', unsure: undefined })
      release(t.op)
    } else if (t.state === 'refused' && t.refusedEarly && t.refusedEarly !== 'stopped' && t.lastSeq === 0 && !t.ahead.length) {
      // admitted after all (an earlier send landed late): any first frame of this operation proves the host has it
      // (Kimi K3 (3): not only an 'accepted' that happens to arrive first, so a gap ahead of it cannot leave it stuck);
      // shown as the admitted turn, never left as refused. A turn the person stopped stays stopped.
      patchTurn(t.op, { state: 'open', refusedEarly: undefined, asleep: undefined })
      set((s) => ({ open: s.open ?? t.op }))
    }
    if (e.seq > t.lastSeq + 1) {
      // held, never applied, until every frame before it is here (Review B2)
      if (!t.ahead.some((x) => x.seq === e.seq) && t.ahead.length < AHEAD_CAP) patchTurn(t.op, { ahead: [...t.ahead, e].sort((a, b) => a.seq - b.seq) })
      if (!get().turns[t.op]?.gap) patchTurn(t.op, { gap: { tries: 0, state: 'loading' } })
      void get().recover(t.op)
      return
    }
    if (e.phase === 'memory' && !e.item) {
      // the stored stub read back for a frame this page holds live (it arrived ahead of the gap): the live one is placed
      const live = t.ahead.find((x): x is Extract<AskEvent, { phase: 'memory' }> => x.seq === e.seq && x.phase === 'memory' && !!x.item)
      if (live) {
        patchTurn(t.op, { ahead: t.ahead.filter((x) => x !== live) })
        e = live
      }
    }
    const placed = e
    patchTurn(t.op, (x) => ({ lastSeq: placed.seq, events: [...x.events, placed] }))
    if (placed.phase === 'memory' && placed.item) remember(placed)
    void apply(placed)
    const now = get().turns[t.op]
    const next = now?.ahead.find((x) => x.seq === now.lastSeq + 1)
    if (next) {
      patchTurn(t.op, { ahead: now.ahead.filter((x) => x !== next) })
      accept(next)
    } else if (now?.gap && !now.ahead.some((x) => x.seq > now.lastSeq)) patchTurn(t.op, { gap: undefined, ahead: [] })
  }

  /**
   * After a recovery read: the gap is closed, or it stays open (nothing after it applies, lastSeq never moves past it)
   * and is read again after a backoff, a bounded number of times; then it shows as incomplete. A final answer held
   * behind it may be shown, marked incomplete, and the turn closes on this page; no held frame's effect runs.
   */
  const afterRead = (op: string, snap: ReturnType<typeof snapshot>) => {
    const t = get().turns[op]
    if (!t) return
    if (!t.ahead.length) {
      if (t.gap) patchTurn(op, { gap: undefined })
      return
    }
    const tries = (t.gap?.tries ?? 0) + 1
    if (tries < RECOVER_TRIES) {
      patchTurn(op, { gap: { tries, state: 'retrying' } })
      clearTimeout(retries.get(op))
      retries.set(op, setTimeout(() => {
        retries.delete(op)
        if (snap.ok()) void get().recover(op)
      }, RECOVER_BACKOFF_MS[Math.min(tries - 1, RECOVER_BACKOFF_MS.length - 1)]))
      return
    }
    patchTurn(op, { gap: { tries, state: 'gave-up' } })
    if (t.ahead.some((x) => x.phase === 'done' || x.phase === 'refused') && (t.state === 'open' || t.state === 'sending')) closeTurn(op, 'done')
  }

  /** The host has the turn (read back, or the same request answered): it is shown and followed as admitted. */
  const admitted = (op: string, view: { thread?: AskThread | null; events?: unknown[]; more?: boolean; app_ask?: true } | null, read: boolean) => {
    const t = get().turns[op]
    if (!t) return
    if (view?.app_ask === true) patchTurn(op, { appAsk: true })
    clearTimeout(checks.get(op))
    checks.delete(op)
    if (view?.thread) set({ thread: view.thread })
    if (t.state === 'checking') patchTurn(op, { state: 'open', unsure: undefined })
    watch(op)
    release(op)
    for (const raw of [...(view?.events ?? [])].sort((a, b) => ((a as AskEvent).seq ?? 0) - ((b as AskEvent).seq ?? 0))) {
      const e = readFrame(raw, op)
      if (e && e.operation_id === op) accept(e)
    }
    // frames this page may have missed while it was not known: read them (paged, in order, once)
    if (!read || view?.more) void get().recover(op)
  }

  /**
   * Review B1 (45392df): settle an Ask whose admission is not known, without ever admitting it twice. First read the
   * original back by its id (GET /api/ask/{op}); if that does not find it, send the very same request again under the
   * same id (the host returns the original turn if it had it). Only the host's own 4xx answer to that says nothing was
   * admitted. Anything else leaves it unknown: checked again after a backoff, a few times, then shown as not confirmed.
   * Every step holds only while the store session, identity and epoch it was sent under still hold.
   */
  const check = async (op: string, snap: ReturnType<typeof snapshot>): Promise<void> => {
    const t = get().turns[op]
    const client = snap.client
    if (!t || t.state !== 'checking' || !t.unsure || checking.has(op) || !client?.ask || !snap.ok()) return
    const { body, principal } = t.unsure
    if (get().bound?.principal !== principal || body.operation_id !== op) return
    clearTimeout(checks.get(op))
    checks.delete(op)
    checking.add(op)
    patchTurn(op, (x) => ({ unsure: x.unsure && { ...x.unsure, state: 'checking' } }))
    let found: { thread?: AskThread | null; events?: unknown[]; more?: boolean } | null = null
    let read = false
    let refusedWith: ApiError | null = null
    let readRefused: ApiError | null = null
    try {
      if (client.askTurn) {
        try {
          found = await client.askTurn(op, get().turns[op]?.lastSeq ?? 0)
          read = true
        } catch (err) {
          found = null
          // Kimi K3 (1): a read's error is classified like the POST path's. 404 is the host saying it does not have
          // this turn, and an unknown answer proves nothing: either way the same request may go again (same id, never
          // a second admission). Any other 4xx is the host refusing this read: nothing is sent, the person may check again.
          if (!admissionUnknown(err) && !(err instanceof ApiError && err.status === 404)) readRefused = err instanceof ApiError ? err : new ApiError(0, 'read_refused', String(err))
        }
        if (!snap.ok()) return
      }
      if (!found && !readRefused) {
        // a frame may have settled it meanwhile; otherwise the same request, the same id (never a new one)
        if (get().turns[op]?.state !== 'checking') return
        try {
          found = await client.ask(body)
        } catch (err) {
          if (!snap.ok()) return
          if (err instanceof AskRefusal && err.code === 'ask_busy' && err.details.operation_id === op) found = {}
          else if (err instanceof ApiError && err.code === 'operation_conflict') found = {}
          else if (!admissionUnknown(err) && !(err instanceof ApiError && err.code === 'ask_busy')) refusedWith = err as ApiError
        }
        if (!snap.ok()) return
      }
    } finally {
      checking.delete(op)
    }
    const now = get().turns[op]
    if (!now) return
    if (found) return admitted(op, found, read)
    if (now.state !== 'checking' || !now.unsure) return
    if (readRefused) {
      patchTurn(op, { unsure: { ...now.unsure, state: 'unresolved' } })
      return
    }
    if (refusedWith) {
      // the host's own no to this very request: nothing was admitted; only now may a new request be sent
      const details = refusedWith instanceof AskRefusal ? refusedWith.details : {}
      patchTurn(op, { refusedEarly: refusalOf(refusedWith.code), asleep: details.mind, unsure: undefined })
      closeTurn(op, 'refused')
      release(op)
      return
    }
    const tries = now.unsure.tries + 1
    if (tries >= CHECK_TRIES) {
      patchTurn(op, { unsure: { ...now.unsure, tries, state: 'unresolved' } })
      return
    }
    patchTurn(op, { unsure: { ...now.unsure, tries, state: 'waiting' } })
    checks.set(op, setTimeout(() => {
      checks.delete(op)
      if (snap.ok()) void check(op, snap)
    }, CHECK_BACKOFF_MS[Math.min(tries - 1, CHECK_BACKOFF_MS.length - 1)]))
  }

  /** Settings read under the current binding (the caller checked its snapshot): kept, and the host's switches drive
   *  the memory's state (on, off, or the conductor off) for this same person and identity. */
  const settled = (st: AskSettings) => {
    set({ settings: st })
    askMemory.hiveCaps(readCapabilities(st?.capabilities))
  }

  const findRow = (rowId: string) => threadRows(get()).find((r) => r.id === rowId)

  return {
    bound: null,
    epoch: 0,
    settings: null,
    personal: undefined,
    pinned: false,
    threadOpen: false,
    ...fresh(),

    bind(session, principal, auth = authIdentity(useHive.getState().client)) {
      // a read made under an earlier sign-in never binds (the host reads me() again for the current one)
      if (auth !== authIdentity(useHive.getState().client)) return
      watchAuth(useHive.getState().client)
      const b = get().bound
      if (b && b.session === session && b.principal === principal && b.auth === auth) return
      get().reset()
      set({ bound: { session, principal, auth } })
      // the Ask's own memory follows the person and the hive (nobody known: nothing is kept or sent)
      askMemory.use(principal && principal !== 'unknown' ? { principal, hive: hiveKey(useHive.getState().client?.mode ?? 'live') } : null)
    },

    reset() {
      throughMinds.clear()   // another person or sign-in never inherits the minds a thread answered through
      undos.clear()
      last = null
      lastOp = null
      for (const t of silence.values()) clearTimeout(t)
      silence.clear()
      clearRetries()
      set((s) => ({ ...fresh(), bound: null, epoch: s.epoch + 1, settings: null, personal: undefined, threadOpen: false }))
      askMemory.use(null)
    },

    addLocal(you, text, opts = {}) {
      if (opts.origin && !opts.origin.ok()) return ''
      addRow({ kind: 'you', text: you, where: opts.where })
      const id = addRow({ kind: 'local', text, where: opts.where, state: opts.state, undo: opts.undo ? (opts.back ? 'back' : 'undo') : undefined })
      if (opts.undo) undos.set(id, { fn: opts.undo, origin: opts.origin })
      return id
    },

    settleLocal(rowId, text, origin, state) {
      if (!rowId || !origin.ok() || !get().log.some((e) => e.kind === 'row' && e.row.id === rowId)) return
      set((s) => ({ local: { ...s.local, [rowId]: { ...s.local[rowId], text, state } } }))
    },

    note(text) {
      addRow({ kind: 'note', text })
    },

    async send(text, context, opts = {}) {
      const words = text.trim()
      if (!words) return
      const { client } = useHive.getState()
      if (!liveBound() || !client?.ask) {
        addRow({ kind: 'you', text: words, where: opts.where })
        addRow({ kind: 'refused', text: '', reason: 'not_available' })
        opts.admission?.({ admitted: false, reason: 'not_available' })
        return
      }
      if (get().open) return get().steer(words, context, opts)
      // exactly one swarm can answer and nothing else decides: it is named, so the first send works (answerer.ts)
      const pageSwarm = 'private' in context ? undefined : context.swarm_id
      // a swarm the Ask cannot use is never targeted because the person stands near it (ask-fix r1)
      const hive = useHive.getState()
      const forced = compatNext
      compatNext = null
      const appId = 'private' in context ? undefined : context.program
      const pageApp = appId ? hive.programs?.find((p) => p.id === appId) ?? { id: appId } : null
      // j0-fixes r1: ONE decision (answerer.ts planAsk), the same one the chip and the paid row read (useAskField): an
      // explicit choice beats continuity, a closed or new thread carries nothing, and a showing thread that answers
      // through a mind names that mind again (Platform 80d066e: context.mind on every turn)
      const st = get()
      const around: Around = forced
        ? { ...forced, context: withPreselected(forced.context, answererChip({ settings: st.settings, personal: st.personal, pageSwarm, to: 'private' in forced.context ? undefined : forced.context.mind }), st.settings) }
        : planAsk(context, { settings: st.settings, personal: st.personal, swarmOf: (id) => hive.swarms[id], words, through: { minds: Object.values(hive.agents), app: pageApp, prefer: (id) => throughMinds.get(id) }, thread: st.thread, carry: st.carry, threadOpen: st.threadOpen })
      context = around.context
      const op = opId()
      last = { text: words, context, opts: kept(opts) }
      lastOp = op
      const snap = snapshot()
      const principal = get().bound!.principal
      // when the person asked: what they forget after this is never learned from this turn
      const memorySince = askMemory.turnMark()
      // the person's own memory for this turn, recalled in this browser; never from a private app's page
      const privatePage = isPrivate(context)
      const recalled = privatePage ? { notes: [], ids: [] } : askMemory.notesFor(words)
      // the original request: kept as sent, so a check can send exactly it again under the same id (Review B1, 45392df)
      const body: AskBody = { operation_id: op, text: words.slice(0, 4000), context, via: opts.via ?? 'typed', ...(recalled.notes.length ? { memory_notes: recalled.notes } : {}) }
      set((s) => ({ open: op, threadOpen: true, turns: { ...s.turns, [op]: { ...newTurn(op, words, opts.where, opts.about), memorySince, privatePage, ...(pageSwarm ? { swarm: pageSwarm } : {}), ...(around.note ? { rerouted: around.note } : {}), ...(around.why ? { reroutedWhy: around.why } : {}), ...(around.fixSwarm ? { fixSwarm: around.fixSwarm } : {}) } }, log: [...s.log, { kind: 'turn' as const, op }] }))
      watch(op)
      try {
        // the host takes memory_notes whatever its switches (core/ask.py _validate): no resend without them
        const r = await client.ask(body)
        if (!snap.ok()) return
        // one turn's metadata never overwrites the host's switches; a disagreement reads them again (r2 P2)
        if (askMemory.sawHive(!!r.conductor)) void get().loadSettings()
        if (body.memory_notes) askMemory.markUsed(recalled.ids)
        set({ thread: r.thread })
        const as = readActingAs(r.acting_as)
        // answered through a mind of a swarm with no coordinator: the note names the mind as the host does
        const through = around.through && r.thread?.mind?.id === around.through.mind ? `Answering: ${r.thread.mind.name.slice(0, 60)}` : null
        const sw = 'swarm_id' in around.context ? around.context.swarm_id : undefined
        if (through && sw) throughMinds.set(sw, around.through!.mind)
        // the showing thread now answers through this mind: a plain follow-up continues it (planAsk), until a choice
        if (through) set((s) => ({ carry: sw ? { mind: around.through!.mind, swarm: sw } : s.carry }))
        patchTurn(op, (t) => ({ ...(t.state === 'sending' ? { state: 'open' as const } : {}), ...(as && !t.actingAs ? { actingAs: as } : {}), ...(through ? { rerouted: through, reroutedWhy: `${around.through!.why}, so ${r.thread.mind.name.slice(0, 60)} answers directly` } : {}) }))
        opts.admission?.({ admitted: true, op, principal })
      } catch (err) {
        if (!snap.ok()) return
        // a host without the answer-through-mind route refuses the addressed mind (no_orchestrator): the turn is sent
        // once more with the r1 fallback, and the refused attempt leaves no row (ask-fix r2 compatibility)
        // ...and so is a mind asleep where the host has no conductor (Platform 80d066e: mind_asleep)
        const throughRefused = err instanceof ApiError ? refusalOf(err.code) : null
        if (around.compat && (throughRefused === 'no_orchestrator' || throughRefused === 'mind_asleep')) {
          const sw = 'swarm_id' in around.context ? around.context.swarm_id : undefined
          if (sw) throughMinds.delete(sw)
          closeTurn(op, 'refused')
          set((s) => {
            const { [op]: _gone, ...turns } = s.turns
            void _gone
            return { turns, log: s.log.filter((l) => !(l.kind === 'turn' && l.op === op)) }
          })
          compatNext = around.compat
          return get().send(words, around.compat.context, opts)
        }
        opts.admission?.({ admitted: false, reason: admissionUnknown(err) ? 'unknown' : 'refused' })
        if (admissionUnknown(err)) {
          // not known whether the host has it: never refused, never re-sent under a new id; checked by its own id
          clearTimeout(silence.get(op))
          silence.delete(op)
          patchTurn(op, (t) => (t.state === 'sending' ? { state: 'checking', unsure: { body, principal, tries: 0, state: 'checking' } } : {}))
          await check(op, snap)
          return
        }
        const reason = refusalOf(err instanceof ApiError ? err.code : null)
        const details = err instanceof AskRefusal ? err.details : {}
        const own = reason === 'mind_asleep' && !!details.mind && details.mind.id === get().personal?.id
        patchTurn(op, { refusedEarly: reason, asleep: details.mind, ...(own ? { asleepOwn: true } : {}) })
        closeTurn(op, 'refused')
        // the thread already has a turn in flight (another tab, or a reload): show that one, live
        if (reason === 'ask_busy' && details.operation_id && !get().turns[details.operation_id]) void get().rejoin(details.operation_id)
      }
    },

    steer(text, context, opts = {}) {
      return get().steerTo(get().open, text, context, opts)
    },

    async steerTo(target, text, context, opts = {}) {
      liveBound()
      const words = text.trim().slice(0, 4000)
      const op = target
      const t = op ? get().turns[op] : undefined
      const { client } = useHive.getState()
      if (op && t?.state === 'checking') {
        // Review B1 (45392df): nothing new is sent while it is not known whether the last request arrived
        // held, never dropped: released once it is known whether the hive has the request
        patchTurn(op, (x) => ({ held: [...(x.held ?? []), { text: words, context, opts: kept(opts) }] }))
        opts.admission?.({ admitted: false, reason: 'held' })
        noteAfter(op, 'Held until the hive confirms it received your last request; then these words are sent.')
        return
      }
      // a closed turn: the words are a fresh request
      if (!op || !t || (t.state !== 'open' && t.state !== 'sending')) return get().send(words, context, opts)
      if (t.steers.length >= STEERS_PER_TURN) {
        noteAfter(op, 'That is a lot of changes for one answer. Let it finish, then ask again.')
        opts.admission?.({ admitted: false, reason: 'capped' })
        return
      }
      const steerer = get().bound?.principal ?? ''
      const s: PendingSteer = { steer_id: steerId(), text: words, at_seq: t.lastSeq, state: 'sending' }
      // if these words become a fresh request, it was asked now
      const memorySince = askMemory.turnMark()
      // optimistic: the words show at once where they were typed; a steer also gives the page back to the mind
      patchTurn(op, (x) => ({ steers: [...x.steers, s], tookOver: false }))
      const snap = snapshot()
      try {
        if (!client?.askSteer) throw new ApiError(0, 'not_available', 'This client cannot steer.')
        const r = await client.askSteer(op, { steer_id: s.steer_id, text: words, at_seq: s.at_seq, via: opts.via ?? 'typed' })
        if (!snap.ok()) return
        if (r && r.operation_id && r.operation_id !== op) {
          // the turn had closed on the host: it became a fresh request, shown as one
          patchTurn(op, (x) => ({ steers: x.steers.filter((y) => y.steer_id !== s.steer_id) }))
          const nop = r.operation_id
          set((st) => ({ open: nop, thread: r.thread ?? st.thread, turns: { ...st.turns, [nop]: { ...newTurn(nop, words, opts.where, opts.about), memorySince, state: 'open' } }, log: [...st.log, { kind: 'turn' as const, op: nop }] }))
          watch(nop)
          opts.admission?.({ admitted: true, op: nop, principal: steerer })
          return
        }
        patchTurn(op, (x) => ({ steers: x.steers.map((y) => (y.steer_id === s.steer_id && y.state === 'sending' ? { ...y, state: 'sent' as const } : y)) }))
        opts.admission?.({ admitted: true, op, principal: steerer })
      } catch (err) {
        if (!snap.ok()) return
        patchTurn(op, (x) => ({ steers: x.steers.map((y) => (y.steer_id === s.steer_id ? { ...y, state: 'failed' as const } : y)) }))
        // the host refuses words while its conductor runs a turn (core/ask.py steer: not_available): said plainly
        if (err instanceof ApiError && err.code === 'not_available') noteAfter(op, 'These words couldn’t join this answer while it runs. Ask again when it finishes.')
        // vibe admission: a client with no steer route at all is "unsupported"; any other failure is "failed"
        opts.admission?.({ admitted: false, reason: client?.askSteer ? 'failed' : 'unsupported' })
      }
    },

    async admit(text, context, opts = {}) {
      const asker = get().bound?.principal ?? null
      let first: AskAdmission | null = null
      const o: AskOpts = { ...kept(opts), admission: (a) => void (first ??= a) }
      await get().send(text, context, o)
      const a = (first as AskAdmission | null) ?? { admitted: false, reason: 'not_admitted' }
      // bound to the person who asked: a change of person (or thread) in between admits nothing for anyone
      if (a.admitted && (!asker || a.principal !== asker || get().bound?.principal !== asker)) return { admitted: false, reason: 'not_admitted' }
      return a
    },

    async rejoin(op) {
      liveBound()
      const { client } = useHive.getState()
      if (!client?.askTurn || get().turns[op]) return
      const snap = snapshot()
      try {
        const v = await client.askTurn(op, 0)
        if (!snap.ok() || get().turns[op]) return
        if (v.app_ask === true && (v.operation_id !== op || !askSelector(v.turn_id))) return
        const open = v.state !== 'done' && v.state !== 'refused'
        set((s) => ({
          open: open ? op : s.open,
          thread: v.thread ?? s.thread,
          turns: { ...s.turns, [op]: { ...newTurn(op, v.text ?? 'Your earlier request'), ...(v.app_ask === true ? { appAsk: true as const, appAskTurnId: v.turn_id, privatePage: true } : {}), state: open ? 'open' : v.state === 'done' ? 'done' : 'refused', ...(readActingAs(v.acting_as) ? { actingAs: readActingAs(v.acting_as)! } : {}) } },
          log: [...s.log, { kind: 'turn' as const, op }],
        }))
        await get().recover(op)
      } catch {
        /* the earlier turn could not be read: nothing to show */
      }
    },

    adoptAppTurn(op, turn, text) {
      const bound = liveBound()
      if (!bound?.principal.startsWith('user:') || !askSelector(op) || !askSelector(turn)) return false
      const old = get().turns[op]
      const knownTurn = old?.appAskTurnId ?? old?.events[0]?.turn_id ?? old?.ahead[0]?.turn_id
      if (knownTurn && knownTurn !== turn) return false
      if (!old && Object.values(get().turns).filter((t) => t.appAsk).length >= 32) return false
      const words = typeof text === 'string' && text.trim() ? text.trim().slice(0, 4000) : null
      set((s) => ({
        turns: { ...s.turns, [op]: old
          ? { ...old, appAsk: true as const, appAskTurnId: turn, privatePage: old.privatePage ?? true, ...(old.appAskPlaceholder && words ? { you: words, appAskPlaceholder: undefined } : {}) }
          : { ...newTurn(op, words ?? 'A request from an app'), state: 'open' as const, appAsk: true as const, appAskTurnId: turn, privatePage: true, ...(!words ? { appAskPlaceholder: true as const } : {}) } },
        ...(!old ? { log: [...s.log, { kind: 'turn' as const, op }] } : {}),
      }))
      // Merely following a frame's live turn does not select the host's composer or claim presentation.
      // The explicit Return action uses showAppTurn after its separate nonterminal ownership claim.
      return true
    },

    async showAppTurn(op) {
      const snap = snapshot()
      await get().rejoin(op)
      if (!snap.ok()) return
      const turn = get().turns[op]
      if (!turn) return
      const accepted = turn.events.find((e): e is Extract<AskEvent, { phase: 'accepted' }> => e.phase === 'accepted')
      set({ threadOpen: true, ...(accepted ? { thread: accepted.thread } : {}), ...(['open', 'sending', 'checking'].includes(turn.state) ? { open: op } : {}) })
    },

    async retryLast() {
      liveBound()
      // Review B1 (45392df): the last request's admission is not known: check it (the same request, the same id)
      const t = lastOp ? get().turns[lastOp] : undefined
      if (t?.state === 'checking') return get().checkAgain(t.op)
      // still being answered: never a second request for it
      if (t && (t.state === 'sending' || t.state === 'open')) return
      // settled (answered, or the host's own no): asking again is a new request, under a new id
      if (last) await get().send(last.text, last.context, last.opts)
    },

    async checkAgain(op) {
      liveBound()
      const t = get().turns[op]
      if (t?.state !== 'checking' || !t.unsure || checking.has(op)) return
      patchTurn(op, (x) => ({ unsure: x.unsure && { ...x.unsure, tries: 0 } }))
      await check(op, snapshot())
    },

    onEvent(raw) {
      if (!raw || typeof raw !== 'object' || (raw as { type?: unknown }).type !== 'ask') return
      const e = checkAskEvent(raw)
      if (!e) {
        if (dev) console.debug('[ask] dropped a malformed ask frame')
        return
      }
      if (!liveBound()) return
      // This listener receives the current authenticated client bus, never raw iframe messages. The server's P1
      // marker lets its first live event arrive before the HTTP admission reply, while exact turn identity fences it.
      if (e.app_ask === true && !get().adoptAppTurn(e.operation_id, e.turn_id)) return
      if (!get().turns[e.operation_id]) return
      // a live memory frame is remembered once accept has placed it in its turn (stand-in r3b P1), never before
      accept(e)
    },

    async recover(op) {
      liveBound()
      const t = get().turns[op]
      const { client } = useHive.getState()
      // given up: only the person's Try again reads again
      if (!t || t.recovering || !client?.askTurn || t.gap?.state === 'gave-up') return
      clearTimeout(retries.get(op))
      retries.delete(op)
      patchTurn(op, { recovering: true })
      const snap = snapshot()
      try {
        // paged: frames after what this page has, 100 at a time, until the host says there are no more
        for (let page = 0; page < 20; page++) {
          const after = get().turns[op]?.lastSeq ?? 0
          const state = await client.askTurn(op, after)
          if (!snap.ok()) return
          if (state.app_ask === true && (state.operation_id !== op || !get().adoptAppTurn(op, state.turn_id))) return
          for (const raw of [...state.events].sort((a, b) => a.seq - b.seq)) {
            const e = readFrame(raw, op)
            if (e && e.operation_id === op) accept(e)
          }
          if (!state.more || (get().turns[op]?.lastSeq ?? 0) <= after) break
        }
      } catch {
        // could not read it back: the gap stays open and nothing after it applies (Review B2); read again later
      } finally {
        if (snap.ok()) patchTurn(op, { recovering: false })
      }
      if (snap.ok()) afterRead(op, snap)
    },

    async retryRecover(op) {
      const t = get().turns[op]
      if (!t?.gap || t.gap.state !== 'gave-up' || t.recovering) return
      patchTurn(op, { gap: { tries: 0, state: 'loading' } })
      await get().recover(op)
    },

    async rebuild() {
      liveBound()
      const { client } = useHive.getState()
      if (!client?.askTurn) return
      const snap = snapshot()
      for (const op of Object.keys(get().turns)) {
        try {
          const events0: unknown[] = []
          for (let page = 0, after = 0; page < 20; page++) {
            const st = await client.askTurn(op, after)
            if (!snap.ok()) return
            if (st.app_ask === true && (st.operation_id !== op || !get().adoptAppTurn(op, st.turn_id))) return
            events0.push(...st.events)
            if (!st.more || typeof st.next_after !== 'number' || st.next_after <= after) break
            after = st.next_after
          }
          const seen = new Set<number>()
          const events = events0
            .map((raw) => readFrame(raw, op))
            .filter((e): e is AskEvent => !!e && e.operation_id === op && !seen.has(e.seq) && !!seen.add(e.seq))
            .sort((a, b) => a.seq - b.seq)
          const t = get().turns[op]
          if (!t) continue
          // frames already applied keep their outcome (no effect runs twice). The host's copy replaces the page's only
          // when it is whole (1..lastSeq, no holes): a rebuilt log is never taken as exact over a gap (Review B2).
          const known = events.filter((e) => e.seq <= t.lastSeq)
          if (known.length === t.lastSeq && known.every((e, i) => e.seq === i + 1)) patchTurn(op, { events: known })
          // new ones go through accept: in order, a gap held and recovered
          for (const e of events) if (e.seq > t.lastSeq) accept(e)
        } catch {
          /* this turn stays as it was */
        }
      }
    },

    async stop() {
      liveBound()
      const op = get().open
      const { client } = useHive.getState()
      if (!op) return
      const snap = snapshot()
      try {
        await client?.askStop?.(op)
      } catch {
        if (!snap.ok()) return
        patchTurn(op, { refusedEarly: 'stopped' })
        closeTurn(op, 'refused')
      }
    },

    async newThread() {
      liveBound()
      const { thread } = get()
      const { client } = useHive.getState()
      if (thread) await client?.askEndThread?.(thread.id).catch(() => undefined)
      undos.clear()
      clearRetries()
      set((s) => ({ ...fresh(), epoch: s.epoch + 1 }))
    },

    async deleteThread() {
      liveBound()
      const { thread } = get()
      const { client } = useHive.getState()
      if (thread) {
        if (!client?.askDeleteThread) return false
        const snap = snapshot()
        try {
          await client.askDeleteThread(thread.id)
        } catch {
          return false
        }
        if (!snap.ok()) return false
      }
      undos.clear()
      clearRetries()
      set((s) => ({ ...fresh(), epoch: s.epoch + 1 }))
      return true
    },

    async runUndo(rowId) {
      const u = undos.get(rowId)
      if (!u) return
      undos.delete(rowId)
      const r = findRow(rowId)
      // an Undo from an earlier connection or person never acts on the current one (Review B1)
      if (u.origin && !u.origin.ok()) return
      const epoch = get().epoch
      try {
        await u.fn()
        if (get().epoch === epoch) set((s) => ({ local: { ...s.local, [rowId]: { undo: undefined, state: 'back', text: `${r?.text ?? ''} · undone` } } }))
      } catch {
        if (get().epoch === epoch) set((s) => ({ local: { ...s.local, [rowId]: { undo: undefined, state: 'failed' } } }))
      }
    },

    goTo(rowId) {
      const r = findRow(rowId)
      if (!r?.route || !r.op || r.seq === undefined) return
      const target = proposalRoute(r.route)
      if (!target) return
      const o = get().turns[r.op]?.outcomes[r.seq]
      if (r.kind === 'nav' && o?.kind === 'nav' && o.state === 'applied') {
        // Back: to where the page was, if the person has not moved on since
        if (window.location.hash === o.route) navigate(proposalRoute(o.from)?.route ?? { name: 'hive' })
        outcome(r.op, r.seq, { ...o, state: 'back' })
        return
      }
      const from = window.location.hash || '#/'
      navigate(target.route)
      outcome(r.op, r.seq, { kind: 'nav', from, route: target.hash, label: r.label ?? routeLabel(target.route), state: 'applied' })
    },

    revisit(rowId) {
      const r = findRow(rowId)
      const target = r?.route ? proposalRoute(r.route) : null
      if (target) navigate(target.route)
    },

    async keepUi(rowId) {
      liveBound()
      const r = findRow(rowId)
      if (!r?.prefs || r.state !== 'preview' || !r.op || r.seq === undefined) return
      const o = get().turns[r.op]?.outcomes[r.seq]
      if (o?.kind !== 'ui') return
      const snap = snapshot()
      try {
        await keepLook(snap.client, r.prefs)
        if (snap.ok()) outcome(r.op, r.seq, { ...o, state: 'kept' })
      } catch {
        if (snap.ok()) outcome(r.op, r.seq, { ...o, state: 'failed' })
      }
    },

    undoUi(rowId) {
      const r = findRow(rowId)
      if (!r || r.state !== 'preview' || !r.op || r.seq === undefined) return
      const o = get().turns[r.op]?.outcomes[r.seq]
      if (o?.kind !== 'ui') return
      previewLook(null)
      outcome(r.op, r.seq, { ...o, state: 'undone' })
    },

    async answerRevertOffer(rowId, undo) {
      liveBound()
      const r = findRow(rowId)
      if (!r?.op || r.seq === undefined) return
      const o = get().turns[r.op]?.outcomes[r.seq]
      if (o?.kind !== 'revert-offer' || o.state) return
      const target = get().turns[r.op]?.outcomes[o.target]
      if (undo && target?.kind === 'ui') {
        const snap = snapshot()
        const blank: UiPrefs = { variant: null, layout: null, apps: target.before?.apps ?? null, experience: target.before?.experience ?? null }
        await keepLook(snap.client, target.before ?? blank).catch(() => undefined)
        if (!snap.ok()) return
        outcome(r.op, o.target, { ...target, state: 'reverted' })
      }
      outcome(r.op, r.seq, { ...o, state: undo ? 'done' : 'kept' })
    },

    async confirmAct() {
      liveBound()
      const c = get().confirm
      const { client } = useHive.getState()
      if (!c || !client?.askConfirm) return 'This hive cannot take that yet.'
      const snap = snapshot()
      // Review B1 (commons f0818d8): once the confirm is sent, only the hive's own no says nothing changed
      try {
        const r = await client.askConfirm(c.op, c.proposal.id, c.proposal.digest)
        if (!snap.ok()) return { unsettled: CONFIRM_ELSEWHERE }
        if (!r.ok) return 'The hive did not take it.'
        outcome(c.op, c.seq, { kind: 'confirm', state: 'confirmed' })
        set({ confirm: null })
        return true
      } catch (err) {
        if (!snap.ok()) return { unsettled: CONFIRM_ELSEWHERE }
        if (outcomeUnknown(err)) return { unsettled: OUTCOME_UNKNOWN }
        if (!(err instanceof ApiError)) return { failed: err instanceof Error ? err.message : String(err) }
        const reason = refusalOf(err.code)
        return reason === 'not_allowed' ? 'You are not allowed to do that here.' : 'The hive did not take it.'
      }
    },

    declineAct() {
      const c = get().confirm
      if (!c) return
      outcome(c.op, c.seq, { kind: 'confirm', state: 'declined' })
      set({ confirm: null })
    },

    openConfirm(rowId) {
      const r = findRow(rowId)
      if (r?.kind === 'confirm' && r.proposal && r.state === 'waiting' && r.op && r.seq !== undefined) set({ confirm: { op: r.op, proposal: r.proposal, seq: r.seq } })
    },

    dropPresence(id) {
      set((s) => ({ presence: s.presence.filter((p) => p.id !== id) }))
    },

    showPresence(item) {
      set((s) => ({ presence: [...s.presence.filter((p) => p.id !== item.id).slice(-3), item] }))
    },

    actOutcome(op, seq, row, undo, origin) {
      if ((origin && !origin.ok()) || !get().turns[op]) return
      outcome(op, seq, { kind: 'act', text: row.text, state: row.state, undo: undo ? (row.back ? 'back' : 'undo') : undefined })
      if (undo) undos.set(`${op}#${seq}`, { fn: undo, origin })
    },

    turnNote(op, text) {
      if (get().turns[op]) noteAfter(op, text)
    },

    personTookOver() {
      if (get().open && framePresentsAsk(get().open!)) return
      liveBound()
      const op = get().open
      const t = op ? get().turns[op] : undefined
      // sending or checking (admission not known yet): the intent is kept and sent once the turn is admitted (sendTakeover)
      if (!op || !t || t.tookOver || (t.state !== 'open' && t.state !== 'sending' && t.state !== 'checking')) return
      noteAfter(op, 'You took over. The orchestrator won’t move the page again unless you tell it to.')
      // the host is told (POST /api/ask/{op}/takeover), now or once the turn is admitted (sendTakeover): it ends the
      // turn with a done frame (taken_over). A 404 not_available (the conductor is off: not a conductor turn) is
      // inert: the page's own pause above holds, and nothing is said as an error
      patchTurn(op, { tookOver: true })
    },

    async loadSettings() {
      const { client } = useHive.getState()
      if (!client?.askSettings) return
      const snap = snapshot()
      // the person's own mind (Platform P1/P2): a host without the route (404), or any failure, is no mind here
      const mine = client.myMind
        ? client.myMind().then(
            (v) => readMyMind(v),
            () => null,
          )
        : Promise.resolve(null)
      void mine.then((m) => {
        if (snap.ok()) set({ personal: m })
      })
      try {
        const st = await client.askSettings()
        if (snap.ok()) settled(st)
      } catch {
        /* no settings yet: the page's swarm still answers */
      }
    },

    async chooseAnswerer(swarmId, op) {
      const snap = snapshot()
      const ok = await get().setDefaultSwarm(swarmId)
      if (!ok || !snap.ok()) return 'failed'
      const t = op ? get().turns[op] : undefined
      const reason = t?.refusedEarly
      const again = !!t && !!last && op === lastOp && t.state === 'refused' && !t.resent && !get().open && !!reason && (PICKER_REASONS.includes(reason) || reason === 'mind_asleep')
      if (!again) return 'saved'
      patchTurn(op!, { resent: true })
      const prev = last!
      await get().send(prev.text, resendContext(prev.context, reason!, swarmId), prev.opts)
      return 'resent'
    },

    async setDefaultSwarm(swarmId) {
      const { client } = useHive.getState()
      if (!client?.setAskSettings) return false
      const snap = snapshot()
      try {
        const st = await client.setAskSettings({ swarm_id: swarmId })
        // j0-fixes r1: an explicit choice of who answers beats continuity: the carried thread mind is dropped
        if (snap.ok()) {
          settled(st)
          set({ carry: null })
        }
        return snap.ok()
      } catch {
        return false
      }
    },

    async setThreadLimit(usd) {
      const { client } = useHive.getState()
      // never above $5 (the owner 2026-10-05), nor above the host's own maximum when it says one
      const max = Math.min(get().settings?.max_thread_budget_usd ?? THREAD_LIMIT_MAX_USD, THREAD_LIMIT_MAX_USD)
      if (!client?.setAskSettings || !(usd > 0) || !(usd <= max)) return false
      const snap = snapshot()
      try {
        const st = await client.setAskSettings({ thread_budget_usd: usd })
        if (snap.ok()) settled(st)
        return snap.ok()
      } catch {
        return false
      }
    },

    setThreadOpen(open) {
      // j0-fixes r1: closing the thread is a routing decision too: a closed thread carries no mind into a new request
      set(open ? { threadOpen: true } : { threadOpen: false, carry: null })
    },
    setPinned(pinned) {
      set({ pinned })
    },
  }
})

// ---- bound to the hive store: a session switch (different client, or any re-init) clears the thread at once;
// identity is re-checked by the host component (me()) and bind() clears it again if the person changed.
let seen = { session: useHive.getState().session, inits: useHive.getState().inits }
useHive.subscribe((s) => {
  watchAuth(s.client)
  if (s.session !== seen.session || s.inits !== seen.inits) {
    seen = { session: s.session, inits: s.inits }
    useAskStore.getState().reset()
  }
})

// ---- a credential replaced on the SAME client (Platform person-session onAuthChange: a re-login without a logout,
// another tab's sign-in or sign-out, a 401 that ended the bearer) is an identity change too (Review B1, 06ce9e7). The
// thread is reset synchronously, inside the change itself, so no held word, scheduled check, read or answer already
// queued for the earlier sign-in runs or shows; the host then reads me() again and binds the new sign-in.
let authWatch: { client: HiveClient; off: () => void } | null = null
function watchAuth(client: HiveClient | null): void {
  if (authWatch?.client === client) return
  authWatch?.off()
  authWatch = null
  if (!client?.onAuthChange) return
  const off = client.onAuthChange(() => {
    if (useHive.getState().client === client) useAskStore.getState().reset()
  })
  authWatch = { client, off }
}
watchAuth(useHive.getState().client)
// the hive store only fans out events from the client it holds (Surface R), so nothing from an earlier session arrives
hiveBus.on((e) => useAskStore.getState().onEvent(e))

/** The look before a fast-path change, for its Undo. Exposed for the runner. */
export const lookBase = (): { saved: UiPrefs | null; base: UiVariant; seeds: UiVariant[] } => ({ saved: lookState().saved, base: DEFAULT_VARIANT, seeds: SEED_VARIANTS })

/**
 * Where a fast-path act started (Review B1): the store client, Surface R's store session and init count, the signed-in
 * principal and the Ask epoch (bumped on every thread reset or identity change). `ok()` is true only while all of
 * them are still the same; every await in an act is followed by it before anything is dispatched, published or undone.
 */
export interface AskOrigin {
  readonly client: HiveClient | null
  readonly session: string
  readonly inits: number
  readonly principal: string | null
  /** the client's sign-in when the act started (readContext authIdentity); null for a client that reports none */
  readonly auth: string | null
  readonly epoch: number
  ok(): boolean
}
export function askOrigin(): AskOrigin {
  const { client, session, inits } = useHive.getState()
  const { bound, epoch } = useAskStore.getState()
  const principal = bound?.principal ?? null
  const boundSession = bound?.session ?? null
  const auth = authIdentity(client)
  return {
    client,
    session,
    inits,
    principal,
    auth,
    epoch,
    ok: () => {
      const h = useHive.getState()
      const a = useAskStore.getState()
      // the sign-in is read from the client itself: a credential replaced before its observer ran fails here too
      return h.client === client && h.session === session && h.inits === inits && a.epoch === epoch && (a.bound?.principal ?? null) === principal && (a.bound?.session ?? null) === boundSession && authIdentity(client) === auth && (!a.bound || a.bound.auth === auth)
    },
  }
}

/**
 * The host's identity read (AskHost): who is signed in on `client` for this store session, read with readMe (a me()
 * answered 409 auth_context_changed is read again, never taken as 'unknown'), bound only if the session, the client
 * and the client's sign-in are all still the ones the read started under. A read that a credential change overtook
 * binds nothing: the host runs this again for the new sign-in (it re-renders on onAuthChange). Returns a cancel.
 */
export function bindAskIdentity(client: HiveClient, session: string, inits: number): () => void {
  let live = true
  const auth = authIdentity(client)
  const who = client.me ? readMe(client).then((m) => ({ principal: m?.principal || 'unknown' })) : Promise.resolve({ principal: 'unknown' })
  void who
    .catch(() => ({ principal: 'unknown' }))
    .then(({ principal }) => {
      const h = useHive.getState()
      if (!live || h.client !== client || h.session !== session || h.inits !== inits || authIdentity(client) !== auth) return
      useAskStore.getState().bind(session, principal, auth)
      void useAskStore.getState().loadSettings()
    })
  return () => {
    live = false
  }
}
