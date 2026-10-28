/**
 * J3 r4.3 O3: the person's side of a live Studio session, as Platform's host plan proposes it
 * (coordination/omegareview/PLATFORM_J3R4_HOST_O1_O2_G1_PLAN.md §3.2–§5, contract r4.3 caf18e5b §2–§6).
 *
 * Host R2+R3 routes are LIVE (eb006a94) but inert: Studio is OFF there and no host offers `capabilities.studio_sessions`,
 * so every client path stays closed (`studioCapable`, checked at each host call). R4 (L6 op ids) and R5 (steer, pause /
 * resume, the Stop view's in_flight / unknown_usd / cancel_ack / fenced_at, cancelled directions) are built and reviewed
 * on Platform's branch (R5 94c42da2), not deployed; steering stays behind `studio_directions`. This module reads those
 * shapes (and R3's / the plan's where a host sends less); `?sim=1` plays them (api/sim/studioSessions.ts).
 *
 *   POST /api/ask/{op}/intents {kind:"studio.session", request}   G1 record (creates nothing else)
 *   POST /api/ask/intents/{id}/submit                              G1 admission: session + goal + proposal artifact, once
 *   GET  /api/studio-sessions/{sid}                                the person's ledger (reconnect and gap source)
 *   PUT  /api/studio-sessions/{sid}/piece {seq, body, scene_ref}   the frame's opaque current piece (seq CAS, ≤1/s)
 *   POST /api/studio-sessions/{sid}/steps/{n}/outcome              the frame-reported terminal outcome for step n
 *   POST /api/studio-sessions/{sid}/controls {control_id, action}  pause | resume | stop (idempotent per control_id)
 *   POST /api/ask/{op}/steer                                       directions, intercepted for the live session (O1)
 *   event  studio.session {session_id, state, step?, rev?, outcome?}   body-free: a notice to read the ledger, never proof
 *
 * Every answer is checked strictly here; an answer that does not fit is `null` (never a guess). Figures the host did not
 * send stay `null` and are shown as unknown.
 */
import type { AskSettings } from '../../api/ask'

/** host plan r1.9: `ended` is terminal (after Stop: fenced, settled or unknown, maker released) */
export const SESSION_STATES = ['active', 'paused', 'stopping', 'stopped', 'ended', 'held'] as const
/** Terminal or closing host states: no receiving, no steering, no recovery; settlement stays visible. */
export const CLOSED_STATES: readonly SessionState[] = ['stopping', 'stopped', 'ended']
export type SessionState = (typeof SESSION_STATES)[number]
/** host R3 step states (studio_steps.py): `timed_out_unread` is a step whose maker never read its context (E4c) */
export const STEP_STATES = ['admitted', 'finished', 'settled', 'timed_out', 'timed_out_unread', 'stopped', 'interrupted'] as const
export type StepState = (typeof STEP_STATES)[number]
/** Design's terminal outcomes (J3_R4_DRAWING_STEPS r1 Answer 2), as the host records them, plus the host's own `unreported`. */
/** host R3 OUTCOMES = Design's terminal four + `unknown` (a possible commit with no receipt: fenced, never replayed) */
export const OUTCOMES = ['applied', 'refused', 'accepted-no-source-change', 'invalid', 'unknown', 'unreported'] as const
export type StepOutcome = (typeof OUTCOMES)[number]
/** What the frame may report: a terminal outcome it observed (never `unreported`, which only the host records). */
export type FrameOutcomeKind = Exclude<StepOutcome, 'unreported'>
/** host R5 directions_view: `cancelled` = Stop came before a step took it (it never reaches the maker) */
export const DIRECTION_STATES = ['queued', 'delivered', 'read', 'cancelled'] as const
export type DirectionState = (typeof DIRECTION_STATES)[number]

/** The app-reported native scene reference (envelope r1: exactly scene_id/revision/digest; host carries it opaquely). */
export interface SceneRef { scene_id: string; revision: number; digest: string }
/** An exact proposal artifact revision (outside the body; established by the exact authorized read). */
export interface ProposalRef { artifact_id: string; revision: number; digest: string }
/** The acknowledged-upload tuple an outcome binds to (contract r4.3 :75, mandatory; host field names are Platform's). */
export interface UploadBinding { seq: number; body_sha256: string; scene_ref: SceneRef; edit_generation: number }

export interface LedgerStep {
  n: number
  state: StepState
  proposal_n: number | null
  proposal_digest: string | null
  outcome: StepOutcome | null
  reason: string | null
  piece_before: SceneRef | null
  piece_after: SceneRef | null
  receiver_generation: number | null
  direction_seqs: number[]
  /** the outcome arrived after the step's paid window had closed (case #2): disclosed, never dropped */
  late: boolean
  /** the acknowledged upload this outcome was bound to, as the host recorded it */
  upload: UploadBinding | null
  /** the acknowledged upload the maker's context read served for this step (host plan r1.1 S3.3 `piece_read`): the
   *  receiver's observedBase. null until the host exposes it on the person ledger (a Platform pin) → the frame holds */
  piece_read: UploadBinding | null
  /** host-recorded words for the step (e.g. "headline and photo frame"); optional */
  summary: string | null
  spent_usd: number | null
  /** host R4 (r1.8 L6): the op ids the step's proposal DECLARED (step view `op_ids`); null where the host sends none.
   *  Used only to cross-check the receiver's own list before sending; never copied into a report. */
  op_ids: string[] | null
}
export interface LedgerDirection { seq: number; steer_id: string; state: DirectionState }
/** One monthly limit row. `held` is INCLUSIVE (reserved + dispatched + unknown, host scope_held); `unknown` is only its
 *  disclosed subset, never subtracted again. `headroom` is the host's own figure when it sends one. */
export interface MonthlyRow { scope: string; limit: number | null; spent: number | null; held: number | null; unknown: number | null; period: string | null; headroom?: number | null }
export interface LedgerBudget {
  cap: number | null
  spent: number | null
  held: number | null
  unknown: number | null
  step_cap: number | null
  step_spent: number | null
  step_seconds: number | null
  monthly: MonthlyRow[]
}
export interface LedgerStop {
  state: 'none' | 'stopping' | 'stopped' | 'ended'
  fenced_at: string | null
  /** host R5 stop_view: reserved or dispatched calls under the session's label (null where a host sends none, as R3) */
  in_flight: number | null
  /** host R5: the session label's unknown hold, the same query as `budget.unknown` (which stays authoritative) */
  unknown_usd: number | null
  /** host R5: the maker's GOAL-CANCELLED ack, shown, never gating */
  cancel_ack: 'pending' | 'acknowledged' | null
  /** host R3 stop view: the maker is released (the last step of a confirmed stop), the failure flags and the host's words */
  maker_released: boolean | null
  stop_failed: boolean
  release_stale: boolean
  message: string | null
  /** host R3/R5: Stop is parked (stop_failed or release_stale while stopping); the person's one `finish_stopping` is offered */
  finish_stopping: boolean
}
export interface PieceUploadView { seq: number; body_sha256: string; scene_ref: SceneRef | null; at: string | null }
export interface Ledger {
  session_id: string
  /** the host-minted P2a stream identity (Platform 2615: minted at G1, opaque, never from sid/proposal/mount/maker); null: not admitted yet → hold */
  stream_id: string | null
  state: SessionState
  reason: string | null
  ask_turn_id: string
  goal_id: string
  proposal_artifact_id: string
  maker_id: string
  swarm_id: string
  program_id: string
  scene_id: string | null
  payer: string | null
  model: string | null
  steps: LedgerStep[]
  directions: LedgerDirection[]
  budget: LedgerBudget
  stop: LedgerStop
  piece: PieceUploadView | null
  /** host R3 `piece_custody.piece_state` (null when the host does not say) */
  piece_state: 'current' | 'missing' | 'revoked' | 'stale' | null
  /** r1.13: the session's admitted saved canvas (host ledger `piece.source_ref`), exactly; null when none */
  piece_source: { artifact_id: string; revision: number; digest: string } | null
  /** the host's current mount epoch (null: never mounted), the CAS's expected_epoch */
  mount_epoch: number | null
}

/** The admission G1 submit answers (recorded and replayed byte for byte). */
export interface Admission {
  session_id: string
  stream_id: string | null
  goal_id: string
  proposal_artifact_id: string
  state: SessionState
  maker_id: string
  payer: string | null
  cap_usd: number
  step_cap_usd: number
  app_pin: Record<string, unknown> | null
}

/** The G1 request inside a `studio.session` intent (host plan §3.2: exact key set; never a payer/actor/goal field). */
export interface StudioSessionRequest {
  swarm_id: string
  program_id: string
  app_pin: Record<string, unknown>
  maker_id: string
  title: string
  detail: string
  piece: { scene_id: string; source_ref: Record<string, unknown> | null }
  key_id: string
  model: string
  /** the maker's effective role and tools, as the host read them back (null role / empty tools are explicit) */
  role_id: string | null
  tools: string[]
  cap_usd: number
  step_cap_usd: number
  coordinator_exclusive: boolean
  max_steps: number
  window_minutes: number
  /** the HOST's digest of the consent payload the card showed (never recomputed here to send) */
  consent_digest: string
}

/**
 * The host's consent payload (`omega-studio-consent-1`, host R2.2 studio_sessions.consent_payload; Code's binding
 * J3_HOST_R22…). The card renders from THIS object verbatim; money is integer micro-dollars from the host and is only
 * formatted for display (never computed with floats, never sent back as a figure).
 */
export interface ConsentPayload {
  schema: 'omega-studio-consent-1'
  swarm_id: string
  program_id: string
  app_pin: Record<string, unknown>
  maker_id: string
  model: string
  key_id: string
  role_id: string | null
  tools: string[]
  payer: 'own_key' | 'hive_key'
  monthly: { kind: string; limit_micros: number | null }
  cap_micros: number
  step_cap_micros: number
  step_window_s: number
  max_steps: number
  window_minutes: number
  piece: { scene_id: string; source_ref: Record<string, unknown> | null }
  coordinator_exclusive: boolean
  title: string
  detail: string
  /** the card's fixed disclosures, as ids the card renders in words (host R2.2c, plan r1.3 F1.9/F5.4); all mandatory */
  disclosures: ConsentDisclosure[]
}
/** Every disclosure the host may name, with the card's words; an id not listed here cannot be rendered, so the card refuses. */
export const CONSENT_DISCLOSURES = {
  maker_restarts_between_steps: 'The maker starts fresh at each step: it remembers nothing between steps beyond what this session records for it.',
  maker_reads_unsaved_piece_while_live: 'While the session is live, the maker can read your unsaved piece, including your hand edits.',
} as const
export type ConsentDisclosure = keyof typeof CONSENT_DISCLOSURES
export const MANDATORY_DISCLOSURES: readonly ConsentDisclosure[] = ['maker_restarts_between_steps', 'maker_reads_unsaved_piece_while_live']
/** A lone UTF-16 surrogate anywhere in the payload: the browser cannot hash it as the host does, so the card refuses it. */
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
function wellFormed(v: unknown, depth = 0): boolean {
  if (depth > 32) return false
  if (typeof v === 'string') return !LONE.test(v)
  if (typeof v === 'number') return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v))
  if (Array.isArray(v)) return v.every((x) => wellFormed(x, depth + 1))
  if (v && typeof v === 'object') return Object.entries(v).every(([k, x]) => !LONE.test(k) && wellFormed(x, depth + 1))
  return true
}
const micro = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
/** The host's consent payload, checked field by field; null when anything does not fit. */
export function readConsent(v: unknown): ConsentPayload | null {
  if (!isObj(v) || v.schema !== 'omega-studio-consent-1') return null
  const m = v.monthly
  const piece = v.piece
  if (!isObj(m) || typeof m.kind !== 'string' || !(m.limit_micros === null || micro(m.limit_micros))) return null
  if (!isObj(piece) || !id(piece.scene_id) || !(piece.source_ref === null || isObj(piece.source_ref))) return null
  if (!id(v.swarm_id) || !id(v.program_id) || !isObj(v.app_pin) || !id(v.maker_id) || typeof v.model !== 'string' || typeof v.key_id !== 'string') return null
  if (!(v.role_id === null || typeof v.role_id === 'string') || !Array.isArray(v.tools) || !v.tools.every((t) => typeof t === 'string')) return null
  if ((v.payer !== 'own_key' && v.payer !== 'hive_key') || !micro(v.cap_micros) || !micro(v.step_cap_micros) || !nat(v.step_window_s) || !nat(v.max_steps) || !nat(v.window_minutes)) return null
  if (typeof v.coordinator_exclusive !== 'boolean' || typeof v.title !== 'string' || typeof v.detail !== 'string') return null
  // every mandatory disclosure present, and nothing the card cannot say in words (Code 215311Z: refuse, never auto-accept)
  const d = v.disclosures
  if (!Array.isArray(d) || !d.every((x) => typeof x === 'string' && Object.hasOwn(CONSENT_DISCLOSURES, x)) || !MANDATORY_DISCLOSURES.every((x) => d.includes(x))) return null
  if (!wellFormed(v)) return null
  return v as unknown as ConsentPayload
}
/** Display only: integer micro-dollars as dollars and cents, rounded UP to the cent (integer arithmetic, no floats). */
export function usdFromMicros(m: number): string {
  const cents = Math.floor(m / 10_000) + (m % 10_000 > 0 ? 1 : 0)
  return `$${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`
}

/** The mount fields every upload, refresh, heartbeat and outcome carries (host plan r1.2 E3). */
export interface MountWire { mount_token: string; mount_epoch: number; receiver_generation: number }
export interface OutcomeBody {
  proposal: ProposalRef
  outcome: FrameOutcomeKind
  reason?: string
  piece_before: SceneRef
  piece_after: SceneRef
  receiver_generation: number
  receipt_digest: string
  /** the acknowledged upload this outcome binds to (host plan r1.1 S3.5 `piece_upload`) */
  piece_upload: UploadBinding
  /** host R4 L6 (contract r4.3:120): the op ids the RECEIVER validated, from its own outcome receipt, never the ledger.
   *  Required by the host for applied / refused / accepted-no-source-change; sent for invalid only when the receiver gave them. */
  op_ids?: string[]
}
/** host plan r1.2: {seq, body, scene_ref, edit_generation} plus the mount fields */
export interface PieceBody extends MountWire { seq: number; body: string; scene_ref: SceneRef; edit_generation: number }
export interface MountBody { expected_epoch: number | null; receiver_generation: number; stream_id: string; mount_id: string; attempt_id: string }
export interface ControlBody { control_id: string; action: 'pause' | 'resume' | 'stop' | 'finish_stopping' }
/** host R5 steer answer's `studio` object: {session_id, seq, state:"queued", session_state} (studio_steer.direction) */
/**
 * r1.10 (host R7 client contract): what the person chose for the card, sent to POST /api/studio/setup as `request`
 * (title, detail, piece, max_steps, window_minutes, program_id; never maker/key/model/role: the host derives those),
 * plus the Ask turn the intent is recorded on (POST /api/ask/{op}/intents needs the person's own turn, < 24 h old).
 */
export interface SetupPrep {
  operation_id: string; title: string; detail: string; max_steps: number; window_minutes: number
  /** r1.13: the person's picked SAVED canvas, exactly: its scene id read from Studio's own view of that exact source
   *  (pieces.ts readPieceScene), its exact artifact ref, and the Studio space (swarm) it was listed from. Never random. */
  scene_id: string
  source_ref: { artifact_id: string; revision: number; digest: string }
  studio_swarm: string
}
/** r1.13: what the Ask turn gives a setup (the piece comes from the person's pick) */
export type SetupTurn = Pick<SetupPrep, 'operation_id' | 'title' | 'detail' | 'max_steps' | 'window_minutes'>
export const SETUP_DEFAULT_STEPS = 12
export const SETUP_DEFAULT_MINUTES = 60

export interface StudioSteerAnswer { steer_id: string; session_id: string; seq: number; state: DirectionState; session_state: SessionState | null }

/** The host routes this module calls (live: api/live.ts; sim: api/sim/studioSessions.ts). All optional on the client. */
export interface StudioHostClient {
  studioRecordIntent?(operationId: string, body: { kind: 'studio.session'; request: StudioSessionRequest }): Promise<unknown>
  askSubmitIntent?(intentId: string): Promise<unknown>
  studioSession?(sessionId: string): Promise<unknown>
  studioPiece?(sessionId: string, body: PieceBody): Promise<unknown>
  studioOutcome?(sessionId: string, n: number, body: OutcomeBody): Promise<unknown>
  studioControl?(sessionId: string, body: ControlBody): Promise<unknown>
  studioMount?(sessionId: string, body: MountBody): Promise<unknown>
  studioMountHeartbeat?(sessionId: string, body: MountWire): Promise<unknown>
  studioUnmount?(sessionId: string, body: { mount_token: string }): Promise<unknown>
  studioMountReadback?(sessionId: string, attemptId: string): Promise<unknown>
  /** the setup card's consent preview (sim; a Platform pin on live): read again for a refreshed card after a resume refusal */
  studioSetupProposal?(programId: string, swarmId: string, prep?: SetupPrep): Promise<unknown>
  /** r1.13 (host R7 POST /api/studio/setup with body {}): the person's own maker, made if missing; its Studio space */
  studioMaker?(): Promise<unknown>
  /** r1.13: the person's saved canvases in their Studio space (the host's artifact list) */
  swarmArtifacts?(swarmId: string, opts?: { kind?: string; limit?: number }): Promise<unknown>
  /** r1.13: Studio's own view, to read one exact saved canvas */
  programView?(id: string, body: { swarm_id: string; focus?: string | null }): Promise<unknown>
  askSteer?(operationId: string, body: import('../../api/ask').AskSteerBody): Promise<import('../../api/ask').AskSteerResult>
  readonly mode?: 'live' | 'sim'
}

/**
 * The live use is gated on the host saying so: `capabilities.studio_sessions === true` on GET /api/me/ask (a NEW key
 * Platform adds with R2–R5; absent today, so live stays off) and every route present on the client. The simulator plays
 * the routes itself. Without the gate a steer on a closed turn would buy a fresh paid turn on today's host (ask.py:1237).
 */
export function studioCapable(client: StudioHostClient | null | undefined, settings: AskSettings | null | undefined): boolean {
  if (!client || !client.studioSession || !client.studioPiece || !client.studioOutcome || !client.studioControl || !client.studioMount || !client.studioMountHeartbeat || !client.studioUnmount || !client.studioMountReadback || !client.studioRecordIntent || !client.askSubmitIntent || !client.askSteer) return false
  if (client.mode === 'sim') return true
  const caps = settings?.capabilities as Record<string, unknown> | undefined
  return caps?.studio_sessions === true
}

// ---------------------------------------------------------------- strict readers

const ID = /^[A-Za-z0-9_.:@-]{1,200}$/
const SHA = /^(sha256:)?[a-f0-9]{64}$/
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const id = (v: unknown): v is string => typeof v === 'string' && ID.test(v)
const nat = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const money = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null)
const str = (v: unknown, max = 400): string | null => (typeof v === 'string' && v.length <= max ? v : null)
const oneOf = <T extends string>(v: unknown, xs: readonly T[]): T | null => (typeof v === 'string' && (xs as readonly string[]).includes(v) ? (v as T) : null)

export function readSceneRef(v: unknown): SceneRef | null {
  if (!isObj(v)) return null
  const keys = Object.keys(v)
  if (keys.length !== 3 || !keys.every((k) => k === 'scene_id' || k === 'revision' || k === 'digest')) return null
  if (!id(v.scene_id) || !(nat(v.revision) && (v.revision as number) >= 1) || typeof v.digest !== 'string' || !SHA.test(v.digest)) return null
  return { scene_id: v.scene_id, revision: v.revision as number, digest: v.digest }
}
export function readProposalRef(v: unknown): ProposalRef | null {
  if (!isObj(v) || !id(v.artifact_id) || !(nat(v.revision) && (v.revision as number) >= 1) || typeof v.digest !== 'string' || !SHA.test(v.digest)) return null
  return { artifact_id: v.artifact_id, revision: v.revision as number, digest: v.digest }
}
export function readUploadBinding(v: unknown): UploadBinding | null {
  if (!isObj(v) || !nat(v.seq) || typeof v.body_sha256 !== 'string' || !SHA.test(v.body_sha256) || !nat(v.edit_generation)) return null
  const scene_ref = readSceneRef(v.scene_ref)
  return scene_ref ? { seq: v.seq as number, body_sha256: v.body_sha256, scene_ref, edit_generation: v.edit_generation as number } : null
}

/** host R4 L6 (studio_gateway `_op_ids`): 1-16 distinct ids, each `[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}`; else null */
export const OP_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/
export function readOpIds(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length < 1 || v.length > 16 || !v.every((x) => typeof x === 'string' && OP_ID.test(x)) || new Set(v).size !== v.length) return null
  return [...(v as string[])]
}
/** L6 compares SETS (the host compares sorted lists of distinct ids): order never matters */
export const sameOpIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === a.length && a.every((x) => b.includes(x))
const lateByClock = (at: unknown, deadline: unknown): boolean => {
  const a = typeof at === 'string' ? Date.parse(at) : NaN
  const d = typeof deadline === 'string' ? Date.parse(deadline) : NaN
  return Number.isFinite(a) && Number.isFinite(d) && a > d
}
function readStep(v: unknown): LedgerStep | null {
  if (!isObj(v) || !(nat(v.n) && (v.n as number) >= 1)) return null
  const state = oneOf(v.state, STEP_STATES)
  if (!state) return null
  const outcome = v.outcome == null ? null : oneOf(v.outcome, OUTCOMES)
  if (v.outcome != null && !outcome) return null
  const seqs = Array.isArray(v.direction_seqs) ? v.direction_seqs.filter(nat) : []
  return {
    n: v.n as number,
    state,
    // host R3 names it `proposal_revision` (the plan's `proposal_n`)
    proposal_n: nat(v.proposal_revision) ? (v.proposal_revision as number) : nat(v.proposal_n) ? (v.proposal_n as number) : null,
    proposal_digest: typeof v.proposal_digest === 'string' && SHA.test(v.proposal_digest) ? v.proposal_digest : null,
    outcome,
    reason: str(v.outcome_reason ?? v.reason, 200),   // R3: outcome_reason
    piece_before: readSceneRef(v.piece_before),
    // R3's step view carries no before/after; the outcome's acknowledged upload IS the observed after-state (exact custody)
    piece_after: readSceneRef(v.piece_after) ?? readUploadBinding(v.piece_upload)?.scene_ref ?? null,
    receiver_generation: nat(v.receiver_generation) ? (v.receiver_generation as number) : null,
    direction_seqs: seqs as number[],
    // R3 has no `late` and recording an outcome does not change the step state, so a step that closed AFTER an on-time
    // outcome must not read late (r1.4 field sweep): late = the host's outcome_at after the step's deadline
    late: v.late === true || lateByClock(v.outcome_at, v.deadline),
    upload: readUploadBinding(v.piece_upload ?? v.upload),
    piece_read: readUploadBinding(v.piece_read),
    summary: str(v.summary, 160),
    spent_usd: money(v.spent_usd) ?? (isObj(v.spend) ? money(v.spend.spent) : null),   // R3: spend {scope, spent, held}
    op_ids: readOpIds(v.op_ids),   // R4: the proposal's declared op ids
  }
}

function readBudget(v: unknown): LedgerBudget {
  const b = isObj(v) ? v : {}
  const monthly = Array.isArray(b.monthly)
    ? b.monthly.filter(isObj).slice(0, 8).map((m) => ({ scope: str(m.scope, 120) ?? 'unknown', limit: money(m.limit), spent: money(m.spent), held: money(m.held), unknown: money(m.unknown), period: str(m.period, 20), headroom: typeof m.headroom === 'number' && Number.isFinite(m.headroom) ? m.headroom : null }))
    : []
  return { cap: money(b.cap), spent: money(b.spent), held: money(b.held), unknown: money(b.unknown), step_cap: money(b.step_cap), step_spent: money(b.step_spent), step_seconds: money(b.step_seconds), monthly }
}

/** r1.7 (Kimi r1.6 #3): the host's stop words, whole up to 1000 chars; a longer one keeps its head AND its last
 *  sentence (host: "…couldn't be stopped. (<status>) An administrator must stop the process."), never cut off the tail */
export function hostWords(v: unknown): string | null {
  if (typeof v !== 'string') return null
  if (v.length <= 1000) return v
  const cut = v.lastIndexOf('. ', v.length - 2)
  const tail = cut >= 0 && v.length - cut <= 300 ? v.slice(cut + 2) : v.slice(-200)
  return `${v.slice(0, 600)} … ${tail}`
}
function readStop(v: unknown): LedgerStop {
  const s = isObj(v) ? v : {}
  return {
    state: oneOf(s.state, ['none', 'stopping', 'stopped', 'ended'] as const) ?? 'none',
    fenced_at: str(s.fenced_at, 64),
    in_flight: nat(s.in_flight) ? (s.in_flight as number) : null,
    unknown_usd: money(s.unknown_usd),
    cancel_ack: oneOf(s.cancel_ack, ['pending', 'acknowledged'] as const),
    maker_released: typeof s.maker_released === 'boolean' ? s.maker_released : null,
    stop_failed: s.stop_failed === true,
    release_stale: s.release_stale === true,
    message: hostWords(s.message),
    finish_stopping: s.finish_stopping === true,
  }
}

function exactSourceRef(v: unknown): { artifact_id: string; revision: number; digest: string } | null {
  const r = isObj(v) ? v : null
  return r && typeof r.artifact_id === 'string' && r.artifact_id && nat(r.revision) && typeof r.digest === 'string' && r.digest ? { artifact_id: r.artifact_id, revision: r.revision as number, digest: r.digest } : null
}
/** The ledger (GET /api/studio-sessions/{sid}), checked; null when it does not fit. */
export function readLedger(v: unknown, expectSession?: string): Ledger | null {
  if (!isObj(v) || !id(v.session_id) || (expectSession && v.session_id !== expectSession)) return null
  const state = oneOf(v.state, SESSION_STATES)
  if (!state || !id(v.goal_id) || !id(v.proposal_artifact_id) || !id(v.maker_id) || !id(v.swarm_id) || !id(v.program_id) || !id(v.ask_turn_id)) return null
  const steps = Array.isArray(v.steps) ? v.steps.map(readStep) : []
  if (steps.some((s) => !s)) return null
  const dirs = Array.isArray(v.directions)
    ? v.directions.filter(isObj).map((d) => (nat(d.seq) && id(d.steer_id) && oneOf(d.state, DIRECTION_STATES) ? { seq: d.seq as number, steer_id: d.steer_id, state: d.state as DirectionState } : null)).filter((d): d is LedgerDirection => !!d)
    : []
  // host R3: the session's `piece` is {scene_id, source_ref}; the latest acknowledged upload is `piece_custody.latest`
  const custody = isObj(v.piece_custody) ? v.piece_custody : null
  const up = isObj(custody?.latest) ? custody.latest : isObj(v.piece) && nat(v.piece.seq) ? v.piece : null
  const p = up && nat(up.seq) && typeof up.body_sha256 === 'string' && SHA.test(up.body_sha256)
    ? { seq: up.seq as number, body_sha256: up.body_sha256, scene_ref: readSceneRef(up.scene_ref), at: str(up.acknowledged_at ?? up.at, 64) }
    : null
  const mount = isObj(custody?.mount) ? custody.mount : null
  const sessionPiece = isObj(v.piece) && !nat(v.piece.seq) ? v.piece : null
  return {
    session_id: v.session_id,
    stream_id: id(v.stream_id) ? v.stream_id : null,
    state,
    reason: str(v.state_reason ?? v.reason, 120),
    ask_turn_id: v.ask_turn_id,
    goal_id: v.goal_id,
    proposal_artifact_id: v.proposal_artifact_id,
    maker_id: v.maker_id,
    swarm_id: v.swarm_id,
    program_id: v.program_id,
    scene_id: id(v.scene_id) ? v.scene_id : id(sessionPiece?.scene_id) ? (sessionPiece!.scene_id as string) : null,
    payer: str(v.payer, 200),
    model: str(v.model, 200),
    steps: (steps as LedgerStep[]).sort((a, b) => a.n - b.n),
    directions: dirs.sort((a, b) => a.seq - b.seq),
    budget: readBudget(isObj(v.budget) && v.budget.step_seconds === undefined && nat(v.step_window_s) ? { ...v.budget, step_seconds: v.step_window_s } : v.budget),
    stop: readStop(v.stop),
    piece: p,
    mount_epoch: nat(v.mount_epoch) ? (v.mount_epoch as number) : nat(mount?.mount_epoch) ? (mount!.mount_epoch as number) : null,
    piece_state: oneOf(custody?.piece_state, ['current', 'missing', 'revoked', 'stale'] as const),
    piece_source: exactSourceRef(sessionPiece?.source_ref),
  }
}

/** The G1 admission (submit's 201/200); null when the ids are not all there. A goal alone is never an admission. */
export function readAdmission(v: unknown): Admission | null {
  if (!isObj(v) || !id(v.session_id) || !id(v.goal_id) || !id(v.proposal_artifact_id) || !id(v.maker_id)) return null
  const state = oneOf(v.state, SESSION_STATES)
  const cap = money(v.cap_usd)
  const step = money(v.step_cap_usd)
  if (!state || cap === null || step === null) return null
  return { session_id: v.session_id, stream_id: id(v.stream_id) ? v.stream_id : null, goal_id: v.goal_id, proposal_artifact_id: v.proposal_artifact_id, state, maker_id: v.maker_id, payer: str(v.payer, 200), cap_usd: cap, step_cap_usd: step, app_pin: isObj(v.app_pin) ? v.app_pin : null }
}

/** The steer answer for the live session (O1 §4.3): `studio` must name THIS session, else it was not a direction. */
export function readStudioSteer(v: unknown, sessionId: string): StudioSteerAnswer | null {
  if (!isObj(v) || !isObj(v.studio) || v.new_turn === true) return null
  const s = v.studio
  if (s.session_id !== sessionId || !nat(s.seq)) return null
  const state = oneOf(s.state, DIRECTION_STATES)
  return state && id(v.steer_id) ? { steer_id: v.steer_id, session_id: sessionId, seq: s.seq as number, state, session_state: oneOf(s.session_state, SESSION_STATES) } : null
}

/** The body-free person-scoped notices (host R3: `studio.session` and `studio.step`). Only say "read the ledger again". */
export interface StudioEvent { type: 'studio.session' | 'studio.step'; session_id: string; state: SessionState | null; step: number | null; rev: number | null; outcome: StepOutcome | null }
export function readStudioEvent(v: unknown): StudioEvent | null {
  if (!isObj(v) || (v.type !== 'studio.session' && v.type !== 'studio.step') || !id(v.session_id)) return null
  const rev = nat(v.proposal_revision) ? (v.proposal_revision as number) : nat(v.rev) ? (v.rev as number) : null
  return { type: v.type, session_id: v.session_id, state: oneOf(v.session_state ?? v.state, SESSION_STATES), step: nat(v.step) ? (v.step as number) : null, rev, outcome: oneOf(v.outcome, OUTCOMES) }
}

/** sha256 of the exact UTF-8 bytes, lowercase hex (host custody, envelope r1). */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const d = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}
