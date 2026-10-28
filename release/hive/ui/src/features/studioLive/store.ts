/**
 * J3 r4.3 O3: one live Studio session, bound to the person who started it (contract §5, §7 Surface O3; follow-ups #2,
 * #3, #4, #6). The person's state here dies with an identity change (lib/identityEpoch): the change closes local
 * receiving in the frame FIRST (synchronously), then nothing more is written; a newly signed-in person's bearer is never
 * used for anything the earlier person confirmed. A→B→A starts empty: an old mount or setup card cannot come back.
 *
 * Writes:
 *  - setup card: record → submit, both through ONE bindOperation made when the card was shown (case #3: a card shown
 *    before a sign-in change or unmount must be confirmed again; its chain refuses to send under the new sign-in);
 *  - frame writes (piece uploads, step outcomes): through a bindOperation made when the frame mounted for this session,
 *    alive only while that mount is the attached one;
 *  - Stop and directions: a bindOperation made when the person presses the button (the person acts now).
 */
import { create } from 'zustand'
import { ApiError } from '../../api/client'
import type { AskContext, AskVia } from '../../api/ask'
import { bindOperation, stopped, type BoundOperation } from '../../lib/boundOperation'
import { bindEpoch, guard, onIdentityChange, STALE } from '../../lib/identityEpoch'
import { useHive } from '../../store/store'
import { useAskStore } from '../../store/ask'
import {
  CLOSED_STATES, SETUP_DEFAULT_MINUTES, SETUP_DEFAULT_STEPS, readAdmission, readConsent, readLedger, readStudioEvent, readStudioSteer, sha256Hex, studioCapable,
  type Admission, type ConsentPayload, type Ledger, type SetupPrep, type SetupTurn, type StudioHostClient, type StudioSessionRequest,
} from './api'
import { PieceCustody, type Capture } from './custody'
import { ledgerPieceAck, readPieceAck, toHostPiece } from './pieceAdapter'
import { OutcomeReporter, type FrameReport, type ReportEntry } from './outcomes'
import { buildCards, type ReceiptCard } from './receipts'
import { moneyDrifted } from './cost'
import { reloadMayForget, remoteStopConfirmed } from './words'
import { setupRefusal, studioRefusal, type StudioRefusal } from './refusals'
import { captureMessage, closeMessage, openMessage, recoverMessage, stepMessage, type CloseReason, frameBodySha } from './wire'
import { MountLease, type LostReason } from './mount'
import { registerStudioRoute } from './route'
import { exactPieceRef, readPieceList, readPieceScene, samePiece, STUDIO_SOURCE_KIND, type PieceListed, type PieceRef } from './pieces'
import { sourceFocus } from '../../forms/designCanvas/model'
import { navigate } from '../../lib/router'

/** What the Ask prepared for the person to confirm (G1). The live source of this is Platform's studio tool; sim invents it. */
export interface SetupProposal {
  operation_id: string
  request: Omit<StudioSessionRequest, 'consent_digest'>
  /** the host's consent payload the card renders verbatim, and the host's digest of it (sent as consent_digest) */
  consent: ConsentPayload
  consent_digest: string
  /** display names the host read back (never authority): the maker's name, the key's label, the audience of directions */
  maker_name: string
  key_label: string
  audience: string
  /** monthly headroom before admission in micro-dollars, if the host said (null: unknown; the card says so) */
  month_left_micros: number | null
  /** r1.10 (host R7): the card came from POST /api/studio/setup: its `request` is recorded UNCHANGED (never rebuilt) */
  hostRequest?: boolean
  /** r1.10: the person's own Studio maker the host provisioned (its Studio home is a private swarm they own) */
  maker?: { id: string; name: string; swarm_id: string }
  /** r1.10: what the person chose, kept to read the card again (setup again) on a drift */
  prep?: SetupPrep
}
export interface SetupCard {
  proposal: SetupProposal
  /** r1.9: `stale` = the shown values are no longer what the host would admit (a drift or own-key refusal): it can NEVER
   *  be confirmed; `refreshing` loads the fresh card; `refresh-failed` offers only "Try loading again" (never a confirm) */
  state: 'open' | 'sending' | 'refused' | 'needs-reconfirm' | 'refreshing' | 'refresh-failed'
  /** r1.9: set once the host refused these values for drift or own key; cleared only by a freshly loaded card */
  stale?: boolean
  refusal: StudioRefusal | null
  /** the host said what was confirmed changed; this card shows the host's new values */
  changed?: boolean
  /** r1.6 (host R5 resume refusal): a refreshed card for a NEW session; it starts only once the current one is stopped
   *  (the host admits no second live session for a person, nor a maker another session still owns) */
  afterStop?: boolean
  /** r1.8: why this card was read again (shown above the values), e.g. the paying key changed */
  notice?: string
  /** r1.8: what differs from the card the person saw before, named plainly (old → new); empty: nothing they can see */
  changes?: string[]
  /** the bound operation made when the card was shown (case #3) */
  op: BoundOperation
}
/** held-reload: this page was reloaded mid-session. Remount continuity, the private retention receipt and O2 recovery
 *  are not proven (Design native r2), so this page neither receives nor reports for it: it shows the record as held. */
export type LocalState = 'receiving' | 'waiting-for-studio' | 'closed-unmount' | 'stopped' | 'held-reload' | 'mount-lost' | 'not-offered' | 'host-paused'
export interface HeldWords { id: string; text: string; refusal: StudioRefusal }
/** a direction the Ask routed to steer the session; `queuedToo`: the person overruled it with one tap (the owner 2640) */
export interface SentDirection { steer_id: string; text: string; seq: number | null; context: AskContext | null; queuedToo: boolean }
export interface NextTurn { id: string; text: string; context: AskContext; from: string | null }

export interface FramePort { mount: number; programId: string; swarmId: string; post(msg: object): void }

interface State {
  setup: SetupCard | null
  admission: Admission | null
  ledger: Ledger | null
  local: LocalState | null
  stopRequested: boolean
  stopError: StudioRefusal | null
  held: HeldWords[]
  sent: SentDirection[]
  /** queued next Ask turns, in order; none is ever replaced silently (Design routing review P2) */
  next: NextTurn[]
  custody: { state: string; reason: string | null; seq: number | null; fresh: 'none' | 'fresh' | 'stale' }
  reports: ReportEntry[]
  cards: ReceiptCard[]
  principal: string | null
  /** for tests and the review: the order things happened in (local close before host stop) */
  trace: string[]
  /** why receiving is not opened yet (no admitted stream or scene), if so */
  openHold: string | null
  /** the attached mount is reopening a progressed session: held until its first acknowledged capture */
  remount: 'held' | 'recovered' | null
  /** Kimi K1: the money figures stopped adding up between two ledger reads (an unknown amount vanished unsettled) */
  moneyDrift: boolean
  /** an earlier mount's reports: shown with their original bindings, NEVER sent again (Design O3 finding P1 #2) */
  retired: ReportEntry[]
  /** host R5 controls: the pause/resume/finish-stopping control in flight, and the last refusal of one (with its way on) */
  control: { action: 'pause' | 'resume' | 'finish_stopping'; state: 'sending' | 'refused'; refusal: StudioRefusal | null } | null
  /** the person's one Finish stopping was used for this session (a second parked Stop reads the host's admin words) */
  finishUsed: boolean
  /** r1.13: choosing the saved canvas to draw on (listed from the person's own Studio space), before any card */
  pick: PieceStep | null
  /** r1.13: the Studio frame reports edits it has not kept (app-dirty); a pending open never overrides them */
  frameDirty: boolean
}
/** r1.13: the piece step. `none`: no saved canvas in their Studio space; `unavailable`: Studio isn't ready there */
export interface PieceStep {
  state: 'listing' | 'list' | 'none' | 'unavailable' | 'reading'
  programId: string
  turn: SetupTurn | null
  swarm: string | null
  pieces: PieceListed[]
  note: string | null
  op: BoundOperation
}
const NO_STREAM = 'The hive has not admitted a drawing stream and scene for this session yet, so Studio here waits.'
export const ELSEWHERE = 'This session draws in your own Studio space, not in the swarm open here. Open Studio there to watch and edit.'

const EMPTY: State = {
  setup: null, admission: null, ledger: null, local: null, stopRequested: false, stopError: null, held: [], sent: [], next: [],
  custody: { state: 'idle', reason: null, seq: null, fresh: 'none' }, reports: [], cards: [], principal: null, trace: [], openHold: null, retired: [], moneyDrift: false, remount: null,
  control: null, finishUsed: false, pick: null, frameDirty: false,
}

export const useStudioLive = create<State>(() => ({ ...EMPTY }))
const set = useStudioLive.setState
const get = useStudioLive.getState

// ---------------------------------------------------------------- runtime (not React state)

interface Runtime {
  sid: string
  binding: ReturnType<typeof bindEpoch>
  port: FramePort | null
  frameOp: BoundOperation | null
  custody: PieceCustody | null
  reporter: OutcomeReporter | null
  /** the frame mount's host authority (E3); its token never leaves mount.ts */
  lease: MountLease | null
  /** the highest mount epoch this page has seen (its own wins included): the next CAS's expected_epoch */
  lastEpoch: number | null
  /**
   * Remount disposition (owner decision, r1.1): a NEW mount on a session that already has proposals starts HELD; after its
   * first acknowledged capture it gets one studio.recover (k from the ledger) and only proposals after k are forwarded.
   */
  recovery?: { mount: number; state: 'held' | 'reading' | 'recovered'; k: number | null } | null
  /** the mount a close was last sent to (cleared when receiving opens again) */
  closedMount?: number | null
  /** step records already forwarded to a mount (`mount:n`) */
  sentSteps?: Set<string>
  stopControlId: string
  offEvents: (() => void) | null
  timers: Set<ReturnType<typeof setTimeout>>
}
let rt: Runtime | null = null
let lastPort: FramePort | null = null

const client = () => useHive.getState().client as unknown as (StudioHostClient & { subscribe(fn: (e: unknown) => void): () => void }) | null
const principalNow = () => useAskStore.getState().bound?.principal ?? null
type Host = Required<Omit<StudioHostClient, 'mode'>>
export const NOT_OFFERED_WORDS = 'This hive stopped offering live Studio, so nothing more was sent. The piece here stays.'
/** Whether the host offers live Studio sessions right now (re-read every time; never a latch). */
const offered = () => studioCapable(client(), useAskStore.getState().settings)
/** Directions to the maker (O1, host R5): their own host capability `studio_directions`; the simulator plays it. */
const directionsOffered = () => { const c = client(); if (c?.mode === 'sim') return true; const caps = useAskStore.getState().settings?.capabilities as Record<string, unknown> | undefined; return caps?.studio_directions === true }
/**
 * r1.1 (stand-in P1-1, Kimi K-sharpest): EVERY host call goes through here. The capability is re-read at the operation
 * boundary, synchronously right before the request (inside op.write), and fails closed: no capability, no call, and a
 * running session closes local receiving and says so.
 */
function call<T>(fn: (c: Host) => Promise<T>): Promise<T> {
  const c = client()
  if (!c || !offered()) {
    notOffered()
    return Promise.reject(new ApiError(0, 'studio_not_offered', NOT_OFFERED_WORDS))
  }
  return fn(c as unknown as Host)
}
const newId = (p: string) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const later = (ms: number, fn: () => void) => {
  const t = setTimeout(() => { rt?.timers.delete(t); fn() }, ms)
  rt?.timers.add(t)
  return () => { clearTimeout(t); rt?.timers.delete(t) }
}
const note = (s: string) => set((x) => ({ trace: [...x.trace.slice(-40), s] }))

// which session this tab's person is in, so a reload can show it as HELD (never as running or settled). Per person: an
// identity change removes it; a different person never reads another's.
const KEEP = 'omegahive.studioLive.session'
type Kept = { principal: string; sid: string; programId: string; swarmId: string }
function keep(k: Kept | null) {
  try {
    if (k) sessionStorage.setItem(KEEP, JSON.stringify(k))
    else sessionStorage.removeItem(KEEP)
  } catch { /* optional */ }
}
function kept(): Kept | null {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEEP) ?? 'null') as Kept | null
    return v && typeof v.principal === 'string' && typeof v.sid === 'string' ? v : null
  } catch {
    return null
  }
}

/** True while the person directs a running session: the Ask routes words to it as a direction (the owner 2640: no manual toggle;
 *  until the host's routing decision exists, a live session means steer, shown with a chip and a one-tap overrule). */
export function directing(): boolean {
  const s = get()
  // host R5 decision 3: a held session queues directions as a paused one does (studio_steer.direction)
  return !!s.ledger && !!rt && s.local !== 'stopped' && s.local !== 'held-reload' && (s.ledger.state === 'active' || s.ledger.state === 'paused' || s.ledger.state === 'held')
}

function recompute() {
  const s = get()
  const reports = [...s.retired, ...(rt?.reporter ? [...rt.reporter.entries.values()] : s.reports.filter((e) => !s.retired.includes(e)))]
  const cards = buildCards(s.ledger, { principal: s.principal ?? '', admission: s.admission, localStopped: s.local === 'stopped', reports })
  set({ cards, reports, custody: rt?.custody ? { state: rt.custody.state, reason: rt.custody.heldReason, seq: rt.custody.latest?.seq ?? null, fresh: rt.custody.freshness() } : s.custody })
  foldAskOnFirstDraw(cards)
}

/**
 * r1.13 (Design phone P2): on a phone the open Ask sheet covers most of the piece, so once the host acknowledges the
 * session's FIRST drawn step the sheet folds away and the work shows. Once per session (a person who reopens it with
 * Direct keeps it open), never when they pinned it, and never while something waits on them (a refused step, held
 * words, a refused control, an unconfirmed stop). The capsule (voice) and the bar's Direct and Stop stay.
 */
let foldedFor: string | null = null
export const PHONE_FOLD_QUERY = '(max-width: 759px)'
const narrow = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(PHONE_FOLD_QUERY).matches
function foldAskOnFirstDraw(cards: ReceiptCard[]) {
  const s = get()
  const sid = s.ledger?.session_id
  if (!sid || foldedFor === sid || s.local !== 'receiving') return
  if (!cards.some((c) => c.kind === 'drawn')) return
  foldedFor = sid
  const ask = useAskStore.getState()
  const waiting = cards.some((c) => c.kind === 'refused') || s.held.length > 0 || s.control?.state === 'refused' || !!s.stopError || !!s.setup
  if (!narrow() || ask.pinned || waiting || !ask.threadOpen) return
  note('ask-folded')
  ask.setThreadOpen(false)
}

// ---------------------------------------------------------------- identity: close first, then nothing more

function closeLocal(reason: CloseReason) {
  if (!rt) return
  const port = rt.port
  // one close per opened mount: a second cause in the same change (identity + capability) adds nothing
  if (port && rt.closedMount !== port.mount) {
    rt.closedMount = port.mount
    try { port.post(closeMessage(rt.sid, reason)) } catch { /* the frame may already be gone */ }
  }
  note(`local-close:${reason}`)
  rt.custody?.close()
}

function teardown() {
  if (!rt) return
  rt.lease?.forget()   // no host call: after an identity change the new person's bearer is never used for this mount
  rt.offEvents?.()
  for (const t of rt.timers) clearTimeout(t)
  rt.reporter?.closeWrites()
  rt = null
}

onIdentityChange(() => {
  // synchronously, inside the identity change: the frame stops receiving before anyone sees the new person
  closeLocal('identity')
  teardown()
  keep(null)
  lastPort = null
  // r1.11 (stand-in r1.10 P1): EVERY per-person value goes with the sign-in, at once: the remembered setup choice (title,
  // brief, scene, Ask turn), the watched Ask turn and the restore marker. Store fields (card, drafts, directions, next
  // turns, held words, controls, the finish latch) reset through EMPTY. Audit of module state: rt, lastPort, lastPrep,
  // watchedOpen (cleared here), restoredFor (a principal marker: the Ask subscription below re-arms it when the bound
  // person changes or unbinds, so the new person's own kept session, if any, is restored once); route.ts holds only
  // function references (no person data).
  lastPrep = null
  watchedOpen = null
  foldedFor = null
  set({ ...EMPTY })
})

// ---------------------------------------------------------------- setup (G1), case #3 and #4

/**
 * The G1 request DERIVED from the host consent payload the card shows (stand-in P1-3): every field the card renders and
 * the host recomputes comes from that one object, with the host's digest. Money goes back as the decimal the host's
 * integer micros name (shortest round-trip form; the host re-derives micros with Decimal(str(value)) and checks the digest).
 */
export function requestFromConsent(c: ConsentPayload, consent_digest: string): StudioSessionRequest {
  return {
    swarm_id: c.swarm_id, program_id: c.program_id, app_pin: c.app_pin, maker_id: c.maker_id, title: c.title, detail: c.detail,
    piece: c.piece, key_id: c.key_id, model: c.model, role_id: c.role_id, tools: [...c.tools],
    cap_usd: c.cap_micros / 1_000_000, step_cap_usd: c.step_cap_micros / 1_000_000, coordinator_exclusive: c.coordinator_exclusive,
    max_steps: c.max_steps, window_minutes: c.window_minutes, consent_digest,
  }
}

/** What the Ask (or the sim) prepared, checked: the consent must be the host's complete payload with every mandatory
 *  disclosure, and its digest the host's. Anything else is refused and said, never shown as a card to confirm. */
export function readSetupProposal(v: unknown): SetupProposal | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  const consent = readConsent(o?.consent)
  if (!o || !consent || typeof o.operation_id !== 'string' || typeof o.consent_digest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(o.consent_digest) || !o.request || typeof o.request !== 'object') return null
  const m = o.month_left_micros
  // r1.10 (host R7): a setup answer names the person's own maker; its request carries the host's own digest, which must
  // be the card's (the request is recorded unchanged)
  const mk = o.maker && typeof o.maker === 'object' ? (o.maker as Record<string, unknown>) : null
  const maker = mk && typeof mk.id === 'string' && typeof mk.swarm_id === 'string' ? { id: mk.id, name: String(mk.name ?? mk.id).slice(0, 80), swarm_id: mk.swarm_id } : undefined
  const req = o.request as Record<string, unknown>
  if (maker && (req.consent_digest !== o.consent_digest || req.maker_id !== consent.maker_id || req.key_id !== consent.key_id)) return null
  const pr = o.prep && typeof o.prep === 'object' ? (o.prep as SetupPrep) : undefined
  return {
    operation_id: o.operation_id, request: o.request as SetupProposal['request'], consent, consent_digest: o.consent_digest,
    maker_name: String(o.maker_name ?? consent.maker_id).slice(0, 80), key_label: String(o.key_label ?? consent.key_id).slice(0, 80),
    audience: String(o.audience ?? (maker ? 'you and your own Studio maker (its Studio space is private to you)' : 'the people and minds who can see this swarm')).slice(0, 200),
    month_left_micros: typeof m === 'number' && Number.isSafeInteger(m) && m >= 0 ? m : null,
    ...(maker ? { maker, hostRequest: true } : {}), ...(pr ? { prep: pr } : {}),
  }
}

/**
 * r1.10: what the person chose, for POST /api/studio/setup: their latest own Ask turn on this page (the intent is recorded
 * on it) and its words as the title and brief, a new piece. Null when there is no Ask turn to start from (the page says
 * so: Studio starts from the Ask). Never a maker, key, model or role: the host derives those.
 */
export function prepFromAsk(): SetupTurn | null {
  const a = useAskStore.getState()
  const ops = a.log.filter((l) => l.kind === 'turn').map((l) => (l as { op: string }).op)
  for (let i = ops.length - 1; i >= 0; i--) {
    const t = a.turns[ops[i]]
    if (!t || t.state === 'refused' || t.state === 'sending' || t.state === 'checking' || !t.you.trim()) continue
    const words = t.you.trim()
    // r1.13: the turn only; the piece is the person's picked saved canvas (never a random scene)
    return { operation_id: t.op, title: words.length > 80 ? `${words.slice(0, 79)}…` : words, detail: words.slice(0, 4000), max_steps: SETUP_DEFAULT_STEPS, window_minutes: SETUP_DEFAULT_MINUTES }
  }
  return null
}

/** r1.10: the last setup choice made from the app page (a resume's refreshed card reads setup again with it) */
let lastPrep: { principal: string; prep: SetupPrep } | null = null
/** r1.11: bound to the person who chose it; read back only for that same person (and cleared on any identity change) */
export function rememberPrep(p: SetupPrep | null) {
  const who = principalNow()
  lastPrep = p && who ? { principal: who, prep: p } : null
}
function prepFor(who: string | null): SetupPrep | null {
  return lastPrep && who && lastPrep.principal === who ? lastPrep.prep : null
}

/** Show the setup card for the person signed in now; its writes are bound to this sign-in from this moment. */
export function proposeSetup(proposal: SetupProposal, alive: () => boolean = () => true) {
  set({ setup: { proposal, state: 'open', refusal: null, op: bindOperation(alive) }, principal: principalNow() })
}
export function dismissSetup() {
  set({ setup: null })
}


/** The person pressed Start on the card: record, then submit, both under the card's own binding. */
export async function confirmSetup(): Promise<void> {
  const shown = get().setup
  if (!shown || shown.state === 'sending') return
  // r1.9 (stand-in r1.8 blocking): a card the host refused for drift or own key is never submitted, whatever the UI shows
  if (shown.stale || shown.state === 'refreshing' || shown.state === 'refresh-failed') return
  if (!offered()) { set({ setup: { ...shown, state: 'refused', refusal: { code: 'studio_not_offered', words: NOT_OFFERED_WORDS, keepWords: true } } }); return }
  // r1.6: a refreshed card after a resume refusal starts nothing while the current session is not confirmed stopped
  if (shown.afterStop && currentNotStopped()) return
  // a card the person confirms AGAIN (after a sign-in change of this page, an unmount or changed host values) is bound to
  // the sign-in of this new confirmation; a first confirmation uses the binding made when the card was shown (case #3)
  const card = shown.state === 'needs-reconfirm' && !shown.op.current() ? { ...shown, op: bindOperation() } : shown
  const op = card.op
  if (!op.current()) { set({ setup: { ...card, state: 'needs-reconfirm' } }); return }
  set({ setup: { ...card, state: 'sending', refusal: null } })
  try {
    // r1.13: the picked canvas is read again NOW; a changed or unlisted one starts nothing (pick it again)
    const prep = card.proposal.prep
    if (prep && !(await pieceStillThere(op, card.proposal.request.program_id, prep))) {
      op.binding.commit(() => set({ setup: { ...card, state: 'refused', stale: true, refusal: { code: 'piece_changed', words: PIECE_CHANGED_WORDS, keepWords: true, next: 'none' } } }))
      return
    }
    // the host's own digest of the payload the card showed; never recomputed here (Code R2.2 binding)
    // r1.1 (stand-in P1-3): what is sent is DERIVED from the consent the card shows, so they cannot diverge
    const consent_digest = card.proposal.consent_digest
    // r1.10 (host R7): a setup card's request is recorded UNCHANGED (the host derived it and digested its consent)
    const request = card.proposal.hostRequest ? ({ ...card.proposal.request, consent_digest } as StudioSessionRequest) : requestFromConsent(card.proposal.consent, consent_digest)
    const rec = await op.write(() => call((c) => c.studioRecordIntent(card.proposal.operation_id, { kind: 'studio.session', request })))
    const intentId = (rec as { intent_id?: unknown })?.intent_id
    if (typeof intentId !== 'string') throw new ApiError(0, 'answer_unreadable', 'The hive’s answer did not name the recorded request.')
    const answer = await op.write(() => call((c) => c.askSubmitIntent(intentId)))
    const admission = readAdmission(answer)
    if (!admission) throw new ApiError(0, 'answer_unreadable', 'The hive’s answer did not name the session it started.')
    op.binding.commit(() => {
      set({ setup: null, admission, principal: principalNow(), local: 'waiting-for-studio', stopRequested: false, stopError: null, held: [], sent: [], trace: [], control: null, finishUsed: false })
      startRuntime(admission.session_id, card.proposal.request.program_id, card.proposal.request.swarm_id)
      const who = principalNow()
      if (who) keep({ principal: who, sid: admission.session_id, programId: card.proposal.request.program_id, swarmId: card.proposal.request.swarm_id })
      // r1.13: open Studio on that exact canvas, where the session draws; ready only once the receiver mounts on it
      if (card.proposal.prep) openStudioOn(card.proposal.request.program_id, card.proposal.prep)
    })
  } catch (e) {
    if (stopped(e) || !op.current()) {
      // the sign-in changed (or the card went away) before the hive had it: never sent as anyone else; confirm again
      if (get().setup === card || get().setup?.op === op) set({ setup: { ...card, state: 'needs-reconfirm' } })
      return
    }
    // 409 consent_mismatch: what was confirmed no longer matches; the host's NEW payload is preview data for a NEW card
    // that the person must confirm again (never resubmitted automatically)
    const fresh = e instanceof ApiError && e.code === 'consent_mismatch' ? readConsent(e.envelope?.consent) : null
    const digest = e instanceof ApiError ? e.envelope?.consent_digest : null
    if (fresh && typeof digest === 'string' && /^sha256:[a-f0-9]{64}$/.test(digest)) {
      // request, consent and digest move together (the request is derived from the consent at confirmation)
      const next = { ...card.proposal, consent: fresh, consent_digest: digest, request: requestFromConsent(fresh, digest) }
      op.binding.commit(() => set({ setup: { ...card, proposal: next, state: 'needs-reconfirm', refusal: null, changed: true, changes: cardChanges(card.proposal, next) } }))
      return
    }
    // r1.8 (stand-in r1.7 blocking): the maker's key, model or payer changed since this card (e.g. the person added their
    // own key after own_key_needed). The host answers key_drift BEFORE consent_mismatch, so the old card can never pass:
    // read a FRESH card (it names the new key, payer and costs) for the person to confirm. Never resubmit the old one.
    if (e instanceof ApiError && SETUP_DRIFT.includes(e.code)) {
      // r1.9: the old card is invalidated NOW, before the fetch; only a freshly loaded card can be confirmed
      op.binding.commit(() => set({ setup: { ...card, state: 'refreshing', stale: true, refusal: null, notice: SETUP_DRIFT_NOTICE[e.code] } }))
      await loadFreshCard(card, op, SETUP_DRIFT_NOTICE[e.code])
      return
    }
    // r1.9: own_key_needed also makes these values unusable (the key that pays will change): never resubmitted
    // r1.12 (stand-in r1.11): after ANY refusal of the record or submit, THIS card is never submitted again. A transient
    // cause offers a deliberate "Try again", which re-reads the current state first (a fresh setup card to confirm);
    // a too-old or unavailable Ask turn needs a NEW Ask turn ("Ask what to draw"), never a resend
    op.binding.commit(() => set({ setup: { ...card, state: 'refused', refusal: setupRefusal(e, 'admit'), stale: true } }))
  }
}

/**
 * r1.11 audit of host R7.3 admission refusals (studio_sessions.admit, ask_intents._record_studio, StudioMakers.fill /
 * key_refusal at a80972e1), by what they mean for the card the person saw:
 *  - SETUP_DRIFT: its values can never pass again; invalidate, then set up again for a fresh card;
 *  - SETUP_STALE: its values can never pass and a fresh setup would not change that; invalidate, say why, no Start
 *    and no Try again;
 *  - r1.12: turn_too_old and 404 not_available (admission names no reason): invalidate; "Ask what to draw" (a NEW Ask
 *    turn); for not_available also "Set up again";
 *  - anything else (maker_busy / studio_owned, person_session_live, execution_fenced, intent_in_flight, intent_pending,
 *    operation_conflict, rate_limited, the money 402s incl. own_key_needed, a lost answer): invalidate too (r1.12: the
 *    SAME card is never submitted twice); a deliberate "Try again" re-reads the current state (a fresh card) first.
 */
const SETUP_DRIFT = ['key_drift', 'model_drift', 'payer_mismatch', 'role_drift', 'consent_mismatch', 'studio_maker_missing', 'maker_not_member', 'maker_not_yours']
/** r1.12: what the refused card offers (never its own Start): Ask what to draw, Set up again (Try again), or neither */
export function refusedCardActions(r: StudioRefusal | null): { ask: boolean; again: boolean; pick: boolean } {
  if (!r) return { ask: false, again: true, pick: false }
  if (r.code === 'turn_too_old') return { ask: true, again: false, pick: false }
  if (r.code === 'admit_unavailable') return { ask: true, again: true, pick: false }
  // r1.13: the picked canvas changed, is gone, or the host won't bind it: choose a canvas again (never resend this one)
  if (r.code === 'piece_changed' || r.code === 'source_not_bindable') return { ask: false, again: false, pick: true }
  return { ask: false, again: !SETUP_STALE.includes(r.code), pick: false }
}
/** r1.13: "Pick a canvas" from a refused card: list the person's saved canvases again, same Ask turn */
export function pickAgain(): void {
  const s = get().setup
  const prep = s?.proposal.prep
  const turn = prep ? { operation_id: prep.operation_id, title: prep.title, detail: prep.detail, max_steps: prep.max_steps, window_minutes: prep.window_minutes } : null
  void beginLiveStudio(s?.proposal.request.program_id ?? 'omegadesign', turn && turn.operation_id ? turn : null)
}
const SETUP_STALE = ['maker_kind_unsupported', 'execution_binding_unqualified', 'app_not_attached', 'maker_is_coordinator', 'source_not_bindable', 'person_required', 'own_key_only']
const SETUP_DRIFT_NOTICE: Record<string, string> = {
  key_drift: 'Your key changed since this card was shown, so nothing was started. Review the new card: it names the key that pays now, who pays and the costs.',
  model_drift: 'The maker’s model changed since this card was shown, so nothing was started. Review the new card before you confirm.',
  payer_mismatch: 'Who pays changed since this card was shown, so nothing was started. Review the new card before you confirm.',
  role_drift: 'The maker’s role or tools changed since this card was shown, so nothing was started. Review the new card before you confirm.',
  studio_maker_missing: 'Your Studio maker isn’t set up (or was removed) since this card was shown, so nothing was started. It is being set up again; review the new card before you confirm.',
  maker_not_member: 'The maker on this card is no longer in its Studio space (it was removed), so nothing was started. Your Studio maker is being set up again; review the new card before you confirm.',
  maker_not_yours: 'The maker on this card isn’t your own Studio maker, so nothing was started. Review the new card for yours before you confirm.',
  consent_mismatch: 'What you confirmed no longer matches what the hive has now, so nothing was started. Review the new card before you confirm.',
}

const payerName = (p: SetupProposal) => (p.consent.payer === 'own_key' ? `your own key “${p.key_label}”` : `this hive’s key “${p.key_label}”`)
const usdM = (m: number) => `$${(m / 1_000_000).toFixed(2)}`
/** r1.8: what a fresh card changes against the one shown before, in plain words (old → new); never values not shown */
export function cardChanges(before: SetupProposal, after: SetupProposal): string[] {
  const a = before.consent, b = after.consent
  const out: string[] = []
  if (a.key_id !== b.key_id || a.payer !== b.payer || before.key_label !== after.key_label) out.push(`Paid by: ${payerName(before)} → ${payerName(after)}`)
  if (a.model !== b.model) out.push(`Model: ${a.model} → ${b.model}`)
  if (a.maker_id !== b.maker_id) out.push(`Maker: ${before.maker_name} → ${after.maker_name}`)
  if ((a.role_id ?? '') !== (b.role_id ?? '') || a.tools.join(',') !== b.tools.join(',')) out.push(`Role and tools: ${a.role_id ?? 'none'} (${a.tools.join(', ') || 'no tools'}) → ${b.role_id ?? 'none'} (${b.tools.join(', ') || 'no tools'})`)
  if (a.cap_micros !== b.cap_micros) out.push(`Most this session can spend: ${usdM(a.cap_micros)} → ${usdM(b.cap_micros)}`)
  if (a.step_cap_micros !== b.step_cap_micros) out.push(`Each step at most: ${usdM(a.step_cap_micros)} → ${usdM(b.step_cap_micros)}`)
  if (a.monthly.limit_micros !== b.monthly.limit_micros) out.push(`Your monthly limit: ${a.monthly.limit_micros === null ? 'not set' : usdM(a.monthly.limit_micros)} → ${b.monthly.limit_micros === null ? 'not set' : usdM(b.monthly.limit_micros)}`)
  return out
}

/**
 * r1.8/r1.9: read the consent card again for the same app and swarm. On success the FRESH card is shown in
 * needs-reconfirm (explicit confirmation only). On failure the card stays STALE in `refresh-failed`: an honest line and
 * "Try loading again" (a re-fetch), never a confirm of the old values. The old card was invalidated before this call.
 */
async function loadFreshCard(card: SetupCard, op: BoundOperation, notice: string): Promise<void> {
  const p = card.proposal.request
  let fresh: SetupProposal | null = null
  let why: StudioRefusal | null = null
  try {
    // r1.10: setup again with what the person chose (host R7 re-resolves the maker's key); the Ask turn is kept
    fresh = readSetupProposal(await op.write(() => call((c) => c.studioSetupProposal(p.program_id, p.swarm_id, card.proposal.prep))))
  } catch (e) {
    if (!(e instanceof ApiError) && stopped(e)) return   // the sign-in changed: this card is not the new person's
    why = e instanceof ApiError ? setupRefusal(e) : null
  }
  // r1.10 (host R7.2): setup again says the person has no own key (e.g. after key_drift `not_own_key`): the own-key card
  // (Keys, then Try again), still stale; a named setup refusal says what it is; anything else is the plain failure
  if (!fresh && why?.code === 'own_key_needed') {
    if (get().setup?.proposal === card.proposal) set({ setup: { ...card, state: 'refused', stale: true, refusal: why, notice } })
    return
  }
  if (fresh) {
    op.binding.commit(() => set({ setup: { proposal: fresh, state: 'needs-reconfirm', refusal: null, op: bindOperation(), changed: true, notice, changes: cardChanges(card.proposal, fresh) }, principal: principalNow() }))
    return
  }
  const named = why && NAMED_SETUP.includes(why.code) ? ` ${why.words}` : ''
  if (get().setup?.proposal === card.proposal) set({ setup: { ...card, state: 'refresh-failed', stale: true, refusal: { code: 'card_unavailable', words: REFRESH_FAILED_WORDS + named, keepWords: true }, notice } })
}
export const REFRESH_FAILED_WORDS = 'Couldn’t load the updated card. Nothing was started.'
const NAMED_SETUP = ['studio_maker_unavailable', 'studio_maker_attach_unsupported', 'maker_not_yours', 'app_not_attached', 'studio_off', 'turn_too_old', 'monthly_total_required']

/** r1.10: "Studio starts from your Ask": open the Ask and put the cursor in its field (the person asks what to draw) */
export function focusAsk(): void {
  useAskStore.getState().setThreadOpen(true)
  const go = () => { try { document.querySelector<HTMLElement>('[data-ask-input]')?.focus() } catch { /* no page */ } }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(go)
  else go()
}

/** r1.8: the person's "Try again" after own_key_needed, and r1.9's "Try loading again" after a failed refresh: the old
 *  card is invalidated first, then a FRESH card is loaded; it is never resubmitted. */
export async function reviewAgain(): Promise<void> {
  const shown = get().setup
  if (!shown || shown.state === 'sending' || shown.state === 'refreshing') return
  const op = shown.op.current() ? shown.op : bindOperation()
  const notice = shown.notice ?? 'These are the current values, read again now. Check the key that pays, who pays and the costs, then confirm.'
  set({ setup: { ...shown, state: 'refreshing', stale: true, refusal: null, notice } })
  await loadFreshCard(shown, op, notice)
}

// ---------------------------------------------------------------- the running session

function startRuntime(sid: string, programId: string, swarmId: string) {
  teardown()
  const binding = bindEpoch()
  rt = { sid, binding, port: null, frameOp: null, custody: null, reporter: null, lease: null, lastEpoch: null, stopControlId: newId('stop'), offEvents: null, timers: new Set() }
  const c = client()
  if (c?.subscribe) {
    rt.offEvents = c.subscribe((e) => {
      const ev = readStudioEvent(e)
      if (ev && rt && ev.session_id === rt.sid) void refresh()
    })
  }
  void refresh()
  if (lastPort && lastPort.programId === programId && lastPort.swarmId === swarmId) attachFrame(lastPort)
}

/** Read the ledger again (an event, a reconnect, a reconciling report). Bound to the session's identity. */
export async function refresh(): Promise<void> {
  const r = rt
  if (!r) return
  try {
    const v = await guard(call((c) => c.studioSession(r.sid)), r.binding)
    if (v === STALE || rt !== r) return
    const ledger = readLedger(v, r.sid)
    if (!ledger) return
    const drift = get().moneyDrift || moneyDrifted(get().ledger?.budget ?? null, ledger.budget)
    // r1.7 (Kimi r1.6 #4): Finish stopping is one press PER PARK. The host offers it again when a Stop parks anew
    // (finish_stopping false -> true; host finish_stopping has no count limit), so a fresh park re-arms the button
    const was = get().ledger
    const repark = !!was && was.session_id === ledger.session_id && !was.stop.finish_stopping && ledger.stop.finish_stopping
    r.binding.commit(() => set({ ledger, moneyDrift: drift, ...(repark ? { finishUsed: false } : {}) }))
    reconcileHostState(r)
    // a session that went back to active with a frame attached and receiving closed for pause: open it again
    maybeOpen()
    forwardSteps(r)
    r.reporter?.retryHeld()
    recompute()
  } catch {
    /* the ledger could not be read now: nothing assumed; the next event or action reads it again */
  }
}

/**
 * r1.2 (stand-in P1-1, P1-2): the AUTHORITATIVE host state drives local receiving. Stopping/stopped/ended (a Stop from
 * anywhere, e.g. another tab): close local receiving now, no steering or recovery, settlement stays visible, outstanding
 * outcomes still reconcile under their original bindings. Paused/held: an explicit pause to the frame; receiving opens
 * again only when the host is active.
 */
function reconcileHostState(r: Runtime) {
  const s = get()
  const l = s.ledger
  if (!l || rt !== r) return
  if (CLOSED_STATES.includes(l.state)) {
    if (s.local !== 'stopped') {
      closeLocal('stop')
      note(`host-closed:${l.state}`)
      set({ local: 'stopped' })
      recompute()
    }
    return
  }
  if ((l.state === 'paused' || l.state === 'held') && s.local === 'receiving') {
    const port = r.port
    if (port && r.closedMount !== port.mount) {
      r.closedMount = port.mount
      try { port.post(closeMessage(r.sid, 'pause')) } catch { /* gone */ }
    }
    note(`host-paused:${l.state}`)
    set({ local: 'host-paused' })
    return
  }
}

function maybeOpen() {
  const r = rt
  const s = get()
  if (!r || !r.port || !s.ledger || s.local === 'stopped') return
  if (s.ledger.program_id !== r.port.programId || s.ledger.swarm_id !== r.port.swarmId) {
    // r1.10 (host R7): a personal maker's session lives in the person's own private Studio space; Studio open in another
    // swarm never receives for it (the frame binding stays exact). Say where it draws; the panel offers to go there.
    if (s.openHold !== ELSEWHERE) set({ openHold: ELSEWHERE })
    return
  }
  if (s.openHold === ELSEWHERE) set({ openHold: null })
  if (s.ledger.state !== 'active') return   // receiving opens only while the host is active (paused/held stay closed)
  if (s.local === 'receiving' || s.local === 'not-offered' || s.local === 'mount-lost' || s.local === 'held-reload') return
  // the host-admitted stream and scene are required inputs of Design's receiver: without them, hold (never invent one)
  if (!s.ledger.stream_id || !s.ledger.scene_id) { if (s.openHold !== NO_STREAM) set({ openHold: NO_STREAM }); return }
  if (s.admission?.stream_id && s.admission.stream_id !== s.ledger.stream_id) { set({ openHold: 'The hive’s record names a different drawing stream than the one it admitted. Studio here waits.' }); return }
  // E3: receiving opens only for the mount that WON the host's compare-and-swap
  if (!r.lease && r.frameOp) {
    const op = r.frameOp
    const mount = r.port.mount
    r.lease = new MountLease({
      receiver_generation: mount, stream_id: s.ledger.stream_id, mount_id: `m_${mount}`,
      mount: (body) => op.write(() => call((c) => c.studioMount(r.sid, body))),
      heartbeat: (body) => op.write(() => call((c) => c.studioMountHeartbeat(r.sid, body))),
      unmount: (body) => call((c) => c.studioUnmount(r.sid, body)),
      readback: (attempt) => call((c) => c.studioMountReadback(r.sid, attempt)),
      now: () => performance.now(),   // Kimi K3: the lease on a monotonic clock (the host's expiry is converted once)
      later,
      lost: (why) => mountLost(r, mount, why),
      changed: recompute,
    })
  }
  const lease = r.lease
  if (!lease) return
  if (lease.state === 'none') {
    const port = r.port
    const seen = Math.max(r.lastEpoch ?? 0, s.ledger.mount_epoch ?? 0) || null
    void lease.acquire(seen).then((won) => {
      if (won && rt === r) r.lastEpoch = Math.max(r.lastEpoch ?? 0, lease.epoch ?? 0)
      if (won && rt === r && r.port === port) maybeOpen()
    })
    return
  }
  if (!lease.current()) return
  r.closedMount = null
  r.port.post(openMessage({ session_id: r.sid, stream_id: s.ledger.stream_id, proposal_artifact_id: s.ledger.proposal_artifact_id, goal_id: s.ledger.goal_id, scene_id: s.ledger.scene_id, receiver_generation: r.port.mount }))
  set({ openHold: null })
  note('frame-open')
  set({ local: 'receiving' })
}

/** The host's step records the receiver needs as observedBase (proposal ref + the piece tuple the maker read), each once
 *  per mount, only while receiving. Steps without a host piece_read are not sent: the receiver holds them. */
function forwardSteps(r: Runtime) {
  const s = get()
  // r1.2 (stand-in P1-2): forwarding is fenced on the AUTHORITATIVE host state and each step's own eligibility
  if (!r.port || s.local !== 'receiving' || !s.ledger || s.ledger.state !== 'active') return
  const sent = (r.sentSteps ??= new Set())
  const rec = r.recovery?.mount === r.port.mount ? r.recovery : null
  if (rec && rec.state !== 'recovered') return   // a reopened view replays nothing; it waits for its own acknowledged capture
  for (const st of s.ledger.steps) {
    const key = `${r.port.mount}:${st.n}`
    if (sent.has(key) || st.proposal_n === null || !st.proposal_digest || !st.piece_read) continue
    if (st.outcome !== null || (st.state !== 'admitted' && st.state !== 'finished')) continue   // terminal, interrupted, timed out, stopped
    if (rec && rec.k !== null && st.proposal_n <= rec.k) continue   // history: never forwarded to the new receiver
    sent.add(key)
    r.port.post(stepMessage(r.sid, st.n, { artifact_id: s.ledger.proposal_artifact_id, revision: st.proposal_n, digest: st.proposal_digest }, st.piece_read))
  }
}

/** The held new mount's first acknowledged capture: send ONE studio.recover (k from the ledger), then forward after k. */
function recoverIfAcknowledged(r: Runtime, mount: number) {
  const rec = r.recovery
  const ack = r.custody?.latest
  if (!rec || rec.state !== 'held' || rec.mount !== mount || r.port?.mount !== mount || !ack || ack.mount !== mount) return
  rec.state = 'reading'   // one recovery at a time; a duplicate trigger is a no-op
  void (async () => {
    // k and the upload from ONE ledger read: the host's latest piece must be exactly this acknowledged upload
    await refresh()
    const l = get().ledger
    const still = rt === r && r.recovery === rec && r.port?.mount === mount && get().local === 'receiving'
    const piece = l?.piece
    // r1.14d: both sides are the host's `sha256:<hex>` form (the ledger piece and the readPieceAck ack); compare the hex
    const same = !!piece && piece.seq === ack.seq && frameBodySha(piece.body_sha256) === frameBodySha(ack.body_sha256)
    // never after Stop, a host pause or a replacement; a late ack of a superseded mount never reaches here (mount check)
    if (!still || !l || l.state !== 'active' || !same) { if (r.recovery === rec) rec.state = 'held'; return }
    const k = Math.max(0, ...l.steps.map((st) => st.proposal_n ?? 0))
    rec.state = 'recovered'
    rec.k = k
    r.port!.post(recoverMessage(r.sid, mount, k, { seq: ack.seq, body_sha256: ack.body_sha256, scene_ref: ack.scene_ref, edit_generation: ack.edit_generation }))
    note(`recover:${k}`)
    set({ remount: 'recovered' })
    forwardSteps(r)
  })()
}

/** A Studio frame (AppFrame) greeted on this person's page: it may receive for the session if it is the session's app. */
export function attachFrame(port: FramePort) {
  lastPort = port
  const r = rt
  if (!r || get().local === 'held-reload') return
  if (r.port && r.port.mount !== port.mount) detachFrame(r.port.mount, 'unmount')
  r.port = port
  const mount = port.mount
  r.frameOp = bindOperation(() => rt === r && r.port?.mount === mount && r.lease?.state !== 'lost' && r.lease?.state !== 'released')
  const op = r.frameOp
  // E3: the mount's host authority, made once the ledger names the admitted stream (never with an empty or guessed one)
  const withMount = <T,>(send: (f: NonNullable<ReturnType<MountLease['fields']>>) => Promise<T>) => op.write(() => {
    const lease = r.lease
    const f = lease?.fields()
    if (!f) return Promise.reject(new ApiError(0, 'mount_not_current', 'This Studio window is not the connected one.'))
    return send(f).catch((e: unknown) => { lease?.noteRefusal(e); throw e })
  })
  r.lease = null
  r.custody = new PieceCustody({
    mount,
    put: async (seq, capture) => readPieceAck(await withMount((f) => call((c) => c.studioPiece(r.sid, toHostPiece(seq, { scene_id: capture.scene_ref.scene_id, ...capture }, f))))),
    requestCapture: () => { if (r.port?.mount === mount && get().local === 'receiving') r.port.post(captureMessage(r.sid)) },
    ledgerPiece: async () => {
      await refresh()
      return ledgerPieceAck(get().ledger?.piece ?? null)
    },
    sha256: sha256Hex,
    now: () => performance.now(),   // Kimi K3: durations on a monotonic clock
    later,
    changed: () => { recoverIfAcknowledged(r, mount); r.reporter?.retryHeld(); recompute() },
  }, get().ledger?.piece?.seq ?? 0)
  const prior = r.reporter
  r.reporter = new OutcomeReporter({
    proposalArtifact: get().ledger?.proposal_artifact_id ?? get().admission?.proposal_artifact_id ?? '',
    custodyFor: (observed, gen) => r.custody?.custodyFor(observed, gen) ?? null,
    ledger: () => get().ledger,
    refreshLedger: refresh,
    post: (n, body) => withMount((f) => call((c) => c.studioOutcome(r.sid, n, { ...body, ...f }))),
    requestCapture: () => { if (r.port?.mount === mount && get().local === 'receiving') { r.custody?.wantRefresh(); r.port.post(captureMessage(r.sid)) } },
    later,
    changed: recompute,
  })
  // an earlier mount's reports keep their original bindings: retired for display, OUTSIDE this writable reporter, so
  // nothing here can send them again (an authorized recovery of them is an explicit reconciliation, not a remount retry)
  if (prior) set((x) => ({ retired: [...x.retired, ...[...prior.entries.values()].map((e) => Object.freeze({ ...e }))] }))
  // remount disposition: a session that already has proposals is reopened HELD (nothing replayed)
  const published = (get().ledger?.steps ?? []).some((st) => st.proposal_n !== null)
  r.recovery = published ? { mount, state: 'held', k: null } : null
  set({ remount: published ? 'held' : null })
  if (get().local !== 'stopped') set({ local: 'waiting-for-studio' })
  maybeOpen()
  recompute()
}

/** The frame went away (unmount, a new document): close local receiving first, then no more frame writes. */
export function detachFrame(mount: number, reason: CloseReason = 'unmount') {
  if (lastPort?.mount === mount) lastPort = null
  const r = rt
  if (!r || r.port?.mount !== mount) return
  closeLocal(reason)
  r.reporter?.closeWrites()
  r.port = null
  r.frameOp = null
  // E3: the unmount revokes this mount on the host (same person, so a bound write now); never re-acquired
  const lease = r.lease
  r.lease = null
  void lease?.release((fn) => bindOperation(() => rt === r).write(fn))
  if (get().local !== 'stopped') set({ local: 'closed-unmount' })
  recompute()
}

/** E3: this mount lost the host's authority (replaced, revoked, lease expired): close local receiving now and say so. */
function mountLost(r: Runtime, mount: number, why: LostReason) {
  if (rt !== r || r.port?.mount !== mount) return
  closeLocal('replaced')
  r.reporter?.closeWrites()
  note(`mount-lost:${why}`)
  if (get().local !== 'stopped') set({ local: 'mount-lost' })
  recompute()
}

/** A piece capture from the attached frame (wire.ts checked its shape). */
export function framePiece(mount: number, sid: string, capture: Capture) {
  const r = rt
  if (!r || r.sid !== sid || r.port?.mount !== mount || get().local !== 'receiving') return
  r.custody?.offer(capture)
}
/** A terminal outcome the attached frame observed after its canvas CAS and readback. */
export function frameOutcome(mount: number, sid: string, report: FrameReport) {
  const r = rt
  // outcomes for revisions received before Stop still report (lineage stays complete); another mount's never do
  if (!r || r.sid !== sid || r.port?.mount !== mount || report.receiver_generation !== mount) return
  // a reopened view never reports for history (revisions up to k, or anything while still held)
  const rec = r.recovery?.mount === mount ? r.recovery : null
  if (rec && (rec.state !== 'recovered' || (rec.k !== null && report.proposal.revision <= rec.k))) return
  r.reporter?.add(report)
  recompute()
}

// ---------------------------------------------------------------- Stop: local first, then one host stop

/** One logical Stop, from any look. Local receiving closes synchronously before anything is sent to the hive. */
export async function stopSession(): Promise<void> {
  const r = rt
  if (!r) return
  // 1) local: close and pause receiving now; the piece, history, Undo and receipt cursor stay in the frame
  closeLocal('stop')
  set({ local: 'stopped', stopRequested: true, stopError: null })
  recompute()
  // 2) host: one idempotent stop for this session (same control_id on every retry), only while the host offers it
  const op = bindOperation(() => rt === r)
  try {
    note('host-stop')
    const v = await op.write(() => call((c) => c.studioControl(r.sid, { control_id: r.stopControlId, action: 'stop' })))
    void v
    await op.write(() => refresh())   // the read-back can lead to writes (a re-mount): bound like the stop
  } catch (e) {
    if (stopped(e)) return
    op.binding.commit(() => set({ stopError: studioRefusal(e) }))
  }
}

/** A refreshed card waits for this: the current session (if any) is confirmed stopped by the host (state + stop record). */
export function currentNotStopped(): boolean {
  const l = get().ledger
  return !!l && !remoteStopConfirmed(l.state, l.stop)
}

// ---------------------------------------------------------------- host R5 controls: pause, resume, finish stopping

/**
 * One person control (host R5 studio_steps.controls): a fresh control_id per press (a lost answer retries the SAME id, so
 * the host's per-control idempotency answers the original). Refusals keep the session as the host left it and say what
 * helps next; a resume refused for a changed binding or consent reads a refreshed card for a NEW session (afterStop).
 */
async function control(action: 'pause' | 'resume' | 'finish_stopping'): Promise<void> {
  const r = rt
  const l = get().ledger
  if (!r || !l || get().control?.state === 'sending') return
  if (action === 'finish_stopping' && get().finishUsed) return
  const op = bindOperation(() => rt === r)
  const control_id = newId(action === 'finish_stopping' ? 'finish' : action)
  set({ control: { action, state: 'sending', refusal: null }, ...(action === 'finish_stopping' ? { finishUsed: true } : {}) })
  let lost = 0
  for (;;) {
    try {
      await op.write(() => call((c) => c.studioControl(r.sid, { control_id, action })))
      op.binding.commit(() => set({ control: null }))
      await op.write(() => refresh())
      // resumed: receiving opens again through reconcileHostState/maybeOpen on the fresh ledger
      return
    } catch (e) {
      if (stopped(e)) return
      // a lost answer: the same control id once more (idempotent on the host), then say it is not confirmed
      if (e instanceof ApiError && (e.status === 0 || e.status >= 500) && lost++ < 1) continue
      const refusal = studioRefusal(e, action === 'resume' ? 'resume' : undefined)
      op.binding.commit(() => set({ control: { action, state: 'refused', refusal } }))
      // r1.7 (Kimi r1.6 #1): ONLY consent_mismatch reads a refreshed card; money waits, drift needs a new session
      if (action === 'resume' && refusal.next === 'confirm-new-card') void refreshedCard(r, l.program_id, l.swarm_id, op)
      void op.write(() => refresh()).catch(() => undefined)
      return
    }
  }
}
export const pauseSession = () => control('pause')
export const resumeSession = () => control('resume')
/** The person's ONE Finish stopping for a parked Stop (stop_failed / release_stale); after it, the host's own words
 *  (an administrator must stop the process) are what the panel shows. */
export const finishStopping = () => control('finish_stopping')
export function dismissControl() {
  set({ control: null })
}
/** r1.6: the consent card read again (current values), shown as a NEW session's card that starts after Stop. */
async function refreshedCard(r: Runtime, programId: string, swarmId: string, op: BoundOperation) {
  try {
    // r1.11: only THIS person's choice (the card's, or the one remembered for them); never a previous sign-in's
    const prep = get().setup?.proposal.prep ?? prepFor(principalNow()) ?? undefined
    const v = await op.write(() => call((c) => c.studioSetupProposal(programId, swarmId, prep)))
    const p = readSetupProposal(v)
    if (p && rt === r) op.binding.commit(() => set({ setup: { proposal: p, state: 'open', refusal: null, op: bindOperation(), changed: true, afterStop: true }, principal: principalNow() }))
  } catch { /* no preview on this host: the refusal's words say Stop, then start a new session */ }
}

// ---------------------------------------------------------------- directions (Steer) and the next turn (Queue)

/** Words for the maker: one direction through the Ask's steer route, intercepted for this session (O1). */
export async function steerSession(text: string, via: AskVia = 'typed', context: AskContext | null = null): Promise<boolean> {
  const r = rt
  const l = get().ledger
  const words = text.trim().slice(0, 4000)
  if (!words) return false
  // a session that is not being directed (stopped here or by the host, ended, not offered) takes no directions
  if (r && l && offered() && !directing()) { set((s) => ({ held: [...s.held, { id: newId('w'), text: words, refusal: studioRefusal(new ApiError(409, 'session_closed', '')) }] })); return false }
  // host R3 has no O1 steer interception (R5): directions need their own capability, else a steer on a closed turn
  // would become a fresh paid turn on the host (ask.py). Fail closed: the words are kept.
  if (r && l && offered() && !directionsOffered()) { set((s) => ({ held: [...s.held, { id: newId('w'), text: words, refusal: studioRefusal(new ApiError(0, 'not_available', '')) }] })); return false }
  if (!r || !l || !offered()) { set((s) => ({ held: [...s.held, { id: newId('w'), text: words, refusal: studioRefusal(new ApiError(0, 'not_available', '')) }] })); return false }
  const op = bindOperation(() => rt === r)
  const steer_id = newId('st')
  set((s) => ({ sent: [...s.sent, { steer_id, text: words, seq: null, context, queuedToo: false }] }))
  try {
    const at = useAskStore.getState().turns[l.ask_turn_id]?.lastSeq ?? 0
    const v = await op.write(() => call((c) => c.askSteer(l.ask_turn_id, { steer_id, text: words, at_seq: at, via })))
    const ok = readStudioSteer(v, r.sid)
    if (!ok) throw new ApiError(0, 'not_available', 'not a direction for this session')
    op.binding.commit(() => set((s) => ({ sent: s.sent.map((x) => (x.steer_id === steer_id ? { ...x, seq: ok.seq } : x)) })))
    void refresh()
    return true
  } catch (e) {
    if (stopped(e)) return false
    op.binding.commit(() => set((s) => ({ sent: s.sent.filter((x) => x.steer_id !== steer_id), held: [...s.held, { id: newId('w'), text: words, refusal: studioRefusal(e) }] })))
    return false
  }
}
export function dropHeld(id: string) {
  set((s) => ({ held: s.held.filter((h) => h.id !== id) }))
}
export async function retryHeld(id: string) {
  const h = get().held.find((x) => x.id === id)
  if (!h) return
  dropHeld(id)
  await steerSession(h.text)
}

/**
 * The chip's one-tap choice, ADDITIVE (Design routing review P1): the same words ALSO wait as new work, the next Ask turn
 * (its own consent and spend check when it starts). The direction already recorded for the maker is NOT withdrawn (a
 * true overrule needs the host's atomic routing record, J2); so it is offered only while that direction is still queued,
 * and the chip says plainly that the original stays active.
 */
export function alsoQueue(steer_id: string) {
  const d = get().sent.find((x) => x.steer_id === steer_id)
  const host = get().ledger?.directions.find((x) => x.steer_id === steer_id)
  // offered while still queued (additive), or once Stop cancelled it (the words were never read: ask them as new work)
  if (!d || d.queuedToo || !d.context || (host?.state !== 'queued' && host?.state !== 'cancelled')) return
  queueNext(d.text, d.context, steer_id)
  set((s) => ({ sent: s.sent.map((x) => (x.steer_id === steer_id ? { ...x, queuedToo: true } : x)) }))
}

/** Queue: the words wait as a next Ask turn (shown dimmed, editable, removable); each one is kept, never overwritten. */
export function queueNext(text: string, context: AskContext, from: string | null = null) {
  const words = text.trim().slice(0, 4000)
  if (words) set((s) => ({ next: [...s.next, { id: newId('nx'), text: words, context, from }] }))
}
export function editNext(id: string, text: string) {
  set((s) => ({ next: s.next.map((n) => (n.id === id ? { ...n, text } : n)) }))
}
export function dropNext(id: string) {
  set((s) => ({ next: s.next.filter((n) => n.id !== id) }))
}
/** Start one queued turn as a new Ask turn now (the person pressed Send, or a turn ended complete; the paid row was shown). */
export async function sendNext(id?: string) {
  const n = id ? get().next.find((x) => x.id === id) : get().next[0]
  if (!n) return
  set((s) => ({ next: s.next.filter((x) => x.id !== n.id) }))
  await useAskStore.getState().send(n.text, n.context)
}

// an open Ask turn that ends COMPLETE starts the queued words; stopped/refused/limited never does (design §1)
let watchedOpen: string | null = null
useAskStore.subscribe((s) => {
  const was = watchedOpen
  watchedOpen = s.open
  if (!was || s.open === was) return
  const t = s.turns[was]
  const done = t?.events.find((e) => e.phase === 'done') as { outcome?: string } | undefined
  if (t?.state === 'done' && done?.outcome === 'complete' && get().next.length && get().principal === principalNow()) void sendNext()
})

/** After a reload: this person's kept session is read and shown HELD (no receiving, no reports, Stop still works). */
export function restoreHeld(): void {
  const k = kept()
  const who = principalNow()
  const c = client()
  // a cached session after the capability is gone: nothing is read or sent (stand-in P1-1)
  if (!k || !who || k.principal !== who || rt || !c || !offered()) return
  rt = { sid: k.sid, binding: bindEpoch(), port: null, frameOp: null, custody: null, reporter: null, lease: null, lastEpoch: null, stopControlId: newId('stop'), offEvents: null, timers: new Set() }
  const r = rt
  if (c.subscribe) r.offEvents = c.subscribe((e) => { const ev = readStudioEvent(e); if (ev && rt === r && ev.session_id === r.sid) void refresh() })
  set({ principal: who, local: 'held-reload' })
  void refresh().then(() => {
    const l = get().ledger
    if (rt === r && l && reloadMayForget(l)) keep(null)   // r1.4: R3-aware stop rule + authoritative budget.unknown
  })
}
let restoredFor: string | null = null
useAskStore.subscribe((s) => {
  const who = s.bound?.principal ?? null
  if (who && who !== restoredFor) { restoredFor = who; restoreHeld() }
  if (!who) restoredFor = null
  // the host stopped offering live Studio mid-session (a settings read): close as for a lost mount, now
  if (rt && !offered()) notOffered()
})

/** The capability dropped: close local receiving, hold outcomes, no more host calls, and say so (Kimi K-sharpest). */
function notOffered() {
  const r = rt
  if (!r || get().local === 'not-offered') return
  closeLocal('replaced')
  r.reporter?.closeWrites()
  r.lease?.forget()
  note('not-offered')
  set({ local: 'not-offered' })
  recompute()
}

/** For tests: drop everything (as an identity change would), without a frame. */
export function resetStudioLiveForTests() {
  teardown()
  keep(null)
  restoredFor = null
  lastPort = null
  watchedOpen = null
  foldedFor = null
  set({ ...EMPTY })
}
/** For tests: the runtime's stop control id and port. */
export const runtimeForTests = () => rt
export const isCapable = () => studioCapable(client(), useAskStore.getState().settings)

registerStudioRoute({ directing, steer: steerSession })

// ---------------------------------------------------------------- r1.13: the saved canvas the session draws on

export const NO_PIECES_WORDS = 'Save a canvas in your Studio space first.'
export const PIECES_UNAVAILABLE_WORDS = 'Studio isn’t ready in your space yet. Nothing was started.'
export const PIECE_CHANGED_WORDS = 'The canvas you picked changed or is no longer in your Studio space, so nothing was started. Pick it again.'
export const OPENING_PIECE_WORDS = 'Opening your piece…'
export const UNSAVED_IN_STUDIO_WORDS = 'You have unsaved changes in Studio. Keep or discard them there first.'
const PIECE_LIST_LIMIT = 24

/** The person's own Studio space (R7: the maker's private "<Name>'s Studio" swarm), from setup {} (provisions the maker). */
async function studioSpace(op: BoundOperation): Promise<string | null> {
  const v = await op.write(() => call((c) => c.studioMaker()))
  const m = v && typeof v === 'object' ? (v as { maker?: { swarm_id?: unknown } }).maker : null
  return m && typeof m.swarm_id === 'string' && m.swarm_id ? m.swarm_id : null
}
/** Their saved canvases, listed from THAT swarm only (host `_source` needs owner_swarm == the session's swarm). */
async function listPieces(op: BoundOperation, swarm: string): Promise<PieceListed[]> {
  return readPieceList(await op.write(() => call((c) => c.swarmArtifacts(swarm, { kind: STUDIO_SOURCE_KIND, limit: PIECE_LIST_LIMIT }))))
}
async function readScene(op: BoundOperation, programId: string, swarm: string, ref: PieceRef) {
  return readPieceScene(await op.write(() => call((c) => c.programView(programId, { swarm_id: swarm, focus: sourceFocus(exactPieceRef(ref)) }))) as never, ref)
}

/**
 * "Draw live with a mind…": the person's Ask turn (live; the simulator has its own), their Studio space, and the saved
 * canvases in it to choose from. No canvas: nothing is admitted and no setup card is asked for; the words say to save one
 * in their Studio space, with a way to open Studio there. Bound to the sign-in it began under.
 */
export async function beginLiveStudio(programId: string, turn: SetupTurn | null): Promise<void> {
  const op = bindOperation()
  set({ pick: { state: 'listing', programId, turn, swarm: null, pieces: [], note: null, op }, setup: null, principal: principalNow() })
  try {
    const swarm = await studioSpace(op)
    if (!swarm) { op.binding.commit(() => set({ pick: { state: 'unavailable', programId, turn, swarm: null, pieces: [], note: PIECES_UNAVAILABLE_WORDS, op } })); return }
    const pieces = await listPieces(op, swarm)
    op.binding.commit(() => set({ pick: { state: pieces.length ? 'list' : 'none', programId, turn, swarm, pieces, note: pieces.length ? null : NO_PIECES_WORDS, op } }))
  } catch (e) {
    if (stopped(e)) return
    const r = setupRefusal(e)
    op.binding.commit(() => set({ pick: { state: 'unavailable', programId, turn, swarm: null, pieces: [], note: r.code === 'unknown' || r.code === 'studio_off' || r.code === 'not_available' || r.code === 'app_inactive' ? PIECES_UNAVAILABLE_WORDS : r.words, op } }))
  }
}
export function dismissPick() {
  set({ pick: null })
}

/** The person picked one listed canvas: read it exactly through Studio's view, then ask setup for its card. */
export async function pickPiece(ref: PieceRef): Promise<void> {
  const p = get().pick
  if (!p || p.state !== 'list' || !p.swarm || !p.pieces.some((x) => samePiece(x, ref))) return
  const { op, swarm, programId } = p
  set({ pick: { ...p, state: 'reading', note: null } })
  try {
    const read = await readScene(op, programId, swarm, ref)
    if (!read.ok) { op.binding.commit(() => set({ pick: { ...p, state: 'list', note: read.why === 'not-a-canvas' ? 'That piece isn’t a canvas Studio can draw on live. Pick another.' : PIECE_CHANGED_WORDS } })); return }
    const turn = p.turn ?? { operation_id: '', title: 'Live drawing in Studio', detail: '', max_steps: SETUP_DEFAULT_STEPS, window_minutes: SETUP_DEFAULT_MINUTES }
    const prep: SetupPrep = { ...turn, scene_id: read.scene_id, source_ref: exactPieceRef(ref), studio_swarm: swarm }
    rememberPrep(prep)
    const v = await op.write(() => call((c) => c.studioSetupProposal(programId, swarm, prep)))
    const card = readSetupProposal(v)
    op.binding.commit(() => {
      if (!card) { set({ pick: { ...p, state: 'list', note: 'The hive’s confirmation card is missing a required part, so nothing was shown or started.' } }); return }
      set({ pick: null })
      proposeSetup({ ...card, prep: card.prep ?? prep })
    })
  } catch (e) {
    if (stopped(e)) return
    const r = setupRefusal(e)
    // app_inactive (R7 before R8.2): Studio isn't ready in their space; nothing is admitted from here
    op.binding.commit(() => set({ pick: r.code === 'app_inactive' ? { ...p, state: 'unavailable', note: PIECES_UNAVAILABLE_WORDS } : { ...p, state: 'list', note: r.words } }))
  }
}

/**
 * At the moment of the call (confirmSetup), the picked canvas is read AGAIN: it must still be listed in the same Studio
 * space at the same exact revision, and Studio's view of it must still give the same scene id. Otherwise nothing is sent.
 */
async function pieceStillThere(op: BoundOperation, programId: string, prep: SetupPrep): Promise<boolean> {
  const listed = await listPieces(op, prep.studio_swarm)
  if (!listed.some((x) => samePiece(x, prep.source_ref))) return false
  const read = await readScene(op, programId, prep.studio_swarm, prep.source_ref)
  return read.ok && read.scene_id === prep.scene_id
}

/** After admission: open Studio on that exact saved canvas in the person's Studio space (the page's own open path: a
 *  frame holding unsaved work asks first or keeps it; nothing here clears or rewrites local work). */
let routeTo: (r: Parameters<typeof navigate>[0]) => void = (r) => navigate(r)
/** For tests: where the page would be sent (no window in the unit tests) */
export function setRouteForTests(fn: typeof routeTo | null) { routeTo = fn ?? ((r) => navigate(r)) }
function openStudioOn(programId: string, prep: SetupPrep) {
  // the app's OWN native view (view: 'studio'), in the person's own Studio space, on that exact source: never a
  // last-shared or public Design home, never Surface's form view (the receiver isn't mounted there)
  try { routeTo({ name: 'program', id: programId, swarm: prep.studio_swarm, source: exactPieceRef(prep.source_ref), view: 'studio' }) } catch { /* no page: the panel's "Open Studio where it draws" still goes there */ }
}

/** r1.13: "Open Studio where it draws": the app's own native view, in the session's swarm, on the session's EXACT admitted
 *  canvas (host ledger piece.source_ref); never a bare program+swarm route (that could remount Surface's form) */
export function openLiveCanvas(): void {
  const l = get().ledger
  if (!l) return
  try { routeTo({ name: 'program', id: l.program_id, swarm: l.swarm_id, ...(l.piece_source ? { source: exactPieceRef(l.piece_source) } : {}), view: 'studio' }) } catch { /* no page */ }
}
/** r1.13: the first-use "Open Studio in your space": the native Studio view in the person's own Studio space */
export function openStudioSpace(programId: string, swarm: string): void {
  try { routeTo({ name: 'program', id: programId, swarm, view: 'studio' }) } catch { /* no page */ }
}

/** The Studio frame says whether it holds edits it has not kept (app-dirty). Only shown; never acted on. */
export function noteFrameDirty(dirty: boolean) {
  if (get().frameDirty !== dirty) set({ frameDirty: dirty })
}

/** r1.13: the live piece is shown only once the receiver actually mounted on it (0.4.20 open(): the snapshot's scene id
 *  equals the admitted scene id). The first acknowledged capture from the frame is that proof; until then: opening. */
export function pieceOpening(s: { local: LocalState | null; custody: { seq: number | null }; ledger: Ledger | null }): boolean {
  return !!s.ledger && (s.local === 'receiving' || s.local === 'waiting-for-studio') && s.custody.seq === null && s.ledger.state === 'active'
}
