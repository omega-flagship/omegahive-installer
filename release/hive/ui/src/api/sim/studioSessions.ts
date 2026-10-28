/**
 * SIM ONLY, INVENTED: Platform's proposed J3 r4.3 host routes for a live Studio session (host plan §3.2–§5), played in
 * the browser so Surface's O3 can be exercised with `?sim=1`. Nothing here is Platform's code or a claim about the live
 * host; it follows the plan's shapes so the client module (features/studioLive) can be built and tested against them.
 *
 * r1.3: the shapes follow the host's R3 build (2975768e: studio_steps.py / studio_sessions.py / studio_handoff.py) where
 * R3 has them: ledger (`piece` = the session's piece, `piece_custody`, steps' `proposal_revision` / `outcome_reason` /
 * `piece_upload` / `spend`, the stop view), the mount body with `attempt_id` and its readback, the upload answer
 * (`sha256:` digests, `refresh`), R3's refusal codes, `studio.session` + `studio.step` notices. Steering (O1, R5) and
 * pause/resume (R5) are still played from the plan.
 *
 * Plays: G1 record + submit (one goal, one host-made proposal artifact, one session, replayed once); the person's ledger;
 * the piece route (seq CAS, 409 stale_piece, ≤1/s, ≤256 KiB); step outcomes (idempotent per (sid, n), wrong proposal
 * 409, late after timeout still against n); controls (pause/resume/stop, idempotent per control_id; stopping → stopped
 * only at zero in-flight; unknown billing kept, never refunded, across a month change); O1 directions (queued →
 * delivered → read; 20 unread → 429; no paid turn per remark); body-free `studio.session` events (person-scoped).
 *
 * A SCRIPTED MAKER stands in for the assigned mind: each admitted step it reads its context (current piece + directions),
 * publishes ONE omega-maker-revision-2 proposal revision in the existing P2a vocabulary, spends an invented amount and says
 * done. Its pictures are invented. `?studiomonthly=missing` plays the missing monthly total (402 spend_limit,
 * limit.kind own_key_limit, detail.reason monthly_total_required); `?studiomonth=rollover` moves the month after a Stop.
 */
import { ApiError } from '../client'
import { sha256HexSync } from './omegadesign'

type Json = Record<string, unknown>
export interface SimStudioDeps {
  emit(e: Json): void
  later(ms: number, fn: () => void): void
  now(): string
  principal(): string
  /** flags from the address (sim only) */
  /** hold: step 3's paid call stays in flight until a Stop fences it (a deterministic in-flight precondition, sim only) */
  flags: { monthlyMissing: boolean; rollover: boolean; speed: number; hold?: boolean; role?: boolean; stopFail?: number; consentDrift?: boolean; fenced?: boolean; keyNone?: boolean; makerKind?: string; piecesNone?: boolean; unbindable?: boolean }
}

interface Step {
  n: number
  state: 'admitted' | 'finished' | 'timed_out' | 'timed_out_unread' | 'stopped' | 'interrupted'
  proposal_n: number | null
  proposal_digest: string | null
  outcome: string | null
  reason: string | null
  piece_before: Json | null
  piece_after: Json | null
  receiver_generation: number | null
  direction_seqs: number[]
  late: boolean
  upload: Json | null
  summary: string | null
  spent_usd: number
  outcome_digest: string | null
  /** the acknowledged piece tuple the (sim) maker's context read served for this step */
  piece_read: Json | null
  /** host R4 L6: the op ids this step's proposal declared (beside its execution, outside the body) */
  op_ids: string[] | null
  more: boolean
  answer?: Json
  inflight: boolean
}
interface Direction { seq: number; steer_id: string; text: string; state: 'queued' | 'delivered' | 'read' | 'cancelled'; digest: string; answer?: Json }
interface Session {
  id: string
  /** FIXTURE: an invented stream id standing in for the host-minted one (never an admission receipt) */
  stream_id: string
  principal: string
  intent_id: string
  ask_turn_id: string
  goal_id: string
  proposal_artifact_id: string
  maker_id: string
  swarm_id: string
  program_id: string
  scene_id: string
  /** r1.13: the admitted saved canvas (the request's piece.source_ref), shown in the ledger as the host does */
  source_ref: Json | null
  payer: string
  model: string
  state: 'active' | 'paused' | 'stopping' | 'stopped' | 'held'
  reason: string | null
  cap: number
  step_cap: number
  steps: Step[]
  directions: Direction[]
  next_dir: number
  revisions: { body: string; digest: string; created_at: string }[]
  piece: { seq: number; body: string; body_sha256: string; scene_ref: Json; at: string; lastAt: number } | null
  controls: Map<string, { digest: string; result: Json }>
  stop: { fenced_at: string | null; unknown_usd: number; cancel_ack: 'pending' | 'acknowledged' | null; in_flight: number }
  script: number
  period: string
  receiverGen: number
  /** E3 (sim): the mount compare-and-swap state; the token is a FIXTURE value */
  mount: { epoch: number; token: string | null; gen: number; until: number }
  /** host R3 studio_mount_attempts: attempt id → {digest, outcome, answer} */
  attempts: Map<string, { digest: string; outcome: 'mounted' | 'mount_conflict'; epoch: number; answer: Json }>
  makerReleased: boolean
  /** host R5 (sim): a parked Stop (stop_failed) and how often the person's Finish stopping ran; the window's end; consent drift */
  stopFailed: boolean
  finishCount: number
  windowEnded: boolean
  consentDrift: boolean
  /** Kimi K4 (r1.2): every op_id this session's maker ever published (a reuse is a sim bug, thrown) */
  opIds: Set<string>
  pieceGen: number | null
}
interface Intent { id: string; op: string; principal: string; digest: string; request: Json; state: 'pending' | 'linked' | 'refused'; answer: Json | null }

const MONTH_LIMIT = 10
/** SIM: the person's own Studio space (R7: "<Name>'s Studio"); the sim's s_lyra owns studio-source canvases */
const STUDIO_SPACE = 's_lyra'
const MONTH_SPENT_BEFORE = 3.12
const ID = /^[A-Za-z0-9_.:@-]{1,200}$/
const REQUEST_KEYS = ['swarm_id', 'program_id', 'app_pin', 'maker_id', 'title', 'detail', 'piece', 'key_id', 'model', 'role_id', 'tools', 'cap_usd', 'step_cap_usd', 'coordinator_exclusive', 'max_steps', 'window_minutes', 'consent_digest']
const refuse = (status: number, code: string, message: string, extra: Json = {}): never => {
  throw new ApiError(status, code, message, { envelope: { code, message, ...extra }, body: { error: { code, message, ...extra } } })
}
const canon = (v: unknown) => JSON.stringify(v)
/** SIM: recursive sorted-key compact JSON (the host's canonical form) */
const canonical = (v: unknown): string => Array.isArray(v) ? `[${v.map(canonical).join(',')}]` : v && typeof v === 'object' ? `{${Object.keys(v as Json).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Json)[k])}`).join(',')}}` : JSON.stringify(v)
const hex = (s: string) => sha256HexSync(s)
/** host R4 `_op_ids`: 1-16 distinct ids, each `[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}`; null otherwise */
const opIdsOf = (v: unknown): string[] | null =>
  Array.isArray(v) && v.length >= 1 && v.length <= 16 && v.every((x) => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(x)) && new Set(v).size === v.length ? [...(v as string[])] : null

/** INVENTED: the drawing script (existing P2a items only); each entry is one step. */
const SCRIPT: { summary: string; items: (sid: string) => Json[] }[] = [
  { summary: 'background', items: () => [{ op_id: 'bg-1', op: 'add-shape', args: { id: 'bg', x: 0, y: 0, width: 600, height: 800, fill: '#f6efe4', absent: true } }] },
  { summary: 'headline', items: () => [{ op_id: 'headline-1', op: 'add-text', args: { id: 'headline', x: 40, y: 60, width: 520, height: 130, text: 'Elm Street spring picnic', fontSize: 52, color: '#24352a', weight: 'bold', absent: true } }, { op_id: 'cursor-1', op: 'cursor', args: { x: 0.5, y: 0.12, caption: 'Headline' } }] },
  { summary: 'photo frame', items: () => [{ op_id: 'photo-1', op: 'add-shape', args: { id: 'photo', x: 40, y: 220, width: 520, height: 300, fill: '#d9e4d0', radius: 18, absent: true } }, { op_id: 'photo-2', op: 'add-text', args: { id: 'photo-label', x: 60, y: 350, width: 480, height: 40, text: 'Photo goes here', fontSize: 22, color: '#5b6b55', weight: 'regular', absent: true } }] },
  { summary: 'details', items: () => [{ op_id: 'details-1', op: 'add-text', args: { id: 'details', x: 40, y: 560, width: 520, height: 120, text: 'Saturday, 2 pm · Elm Street green · bring a blanket', fontSize: 26, color: '#3a4a36', weight: 'regular', absent: true } }] },
  { summary: 'accent stripe', items: () => [{ op_id: 'stripe-1', op: 'add-shape', args: { id: 'stripe', x: 40, y: 700, width: 520, height: 12, fill: '#e07a3f', radius: 6, absent: true } }] },
]

export class SimStudioHost {
  /** r1.14b: the person set their own-key monthly total (Me page): the missing-total refusal no longer applies */
  setMonthlyTotal(present: boolean) { this.d.flags.monthlyMissing = !present }
  private intents = new Map<string, Intent>()
  private sessions = new Map<string, Session>()
  private byArtifact = new Map<string, string>()
  private seq = 0
  constructor(private d: SimStudioDeps) {}

  // ---- what the Ask prepared (sim only: the live source is Platform's studio tool, not pinned yet)
  /** SIM (r1.8): what the maker would run with NOW (the host resolves these at admission: own_key_for / paying_key, the
   *  maker's model, the payer). ?studiokey=none starts on another member's key; addOwnKey() is the person adding theirs. */
  /** SIM: the payer each shown card named (by its consent digest), to play payer_mismatch when it changes */
  private issuedPayer = new Map<string, string>()
  private worldLazy: { key: string; label: string; payer: 'own_key' | 'hive_key'; foreign: boolean; model: string } | null = null
  private get world() {
    return (this.worldLazy ??= this.d.flags.keyNone
      ? { key: 'k_sim_rowan', label: 'Rowan’s key (invented)', payer: 'hive_key', foreign: true, model: 'invented-model' }
      : { key: 'k_sim_own', label: 'Studio key (invented)', payer: 'own_key', foreign: false, model: 'invented-model' })
  }
  /** SIM: the person added their own key in Keys (OI-13): the resolved paying key and payer change */
  addOwnKey(): void {
    this.worldLazy = { ...this.world, key: 'k_sim_mine', label: 'Your own key (invented)', payer: 'own_key', foreign: false }
  }
  /** SIM: the maker's model or the payer changed after a card was shown (model_drift / payer_mismatch at admission) */
  changeWorld(change: { model?: string; payer?: 'own_key' | 'hive_key'; key?: string; label?: string; foreign?: boolean }): void {
    this.worldLazy = { ...this.world, ...change }
  }
  /**
   * host R7 POST /api/studio/setup (sim): the person's own maker on their own key. With no own key: 402 own_key_needed
   * (scope studio_maker) and nothing is shown. The answer: {maker, request (full, with the host's consent_digest),
   * consent, consent_digest, maker_name, key_label}; the sim adds the Ask turn it invents (operation_id). The sim keeps
   * the maker's Studio home in the page's swarm, so the invented frame opens (R7's is a private Studio space).
   */
  /** SIM (host R7 setup {}): the person's own maker; its Studio space is the sim's s_lyra (it owns studio-source canvases) */
  makerAnswer(): Json {
    const w = this.world
    if (w.foreign) refuse(402, 'own_key_needed', "Add your own key in Keys, then try again.", { scope: 'studio_maker', pays: 'own-key', provider: 'invented' })
    return { maker: { id: 'a_bell10', name: 'Bellows', swarm_id: STUDIO_SPACE, kind: 'omega', model: w.model, key_id: w.key, key_label: w.label, own_key: w.payer === 'own_key', status: 'asleep', program_id: 'omegadesign', created: false } }
  }
  setupProposal(programId: string, swarmId: string, prep?: { operation_id: string; title: string; detail: string; scene_id: string; source_ref: Json; studio_swarm: string; max_steps: number; window_minutes: number }): Json {
    const w = this.world
    if (w.foreign) refuse(402, 'own_key_needed', "Add your own key in Keys, then try again.", { scope: 'studio_maker', pays: 'own-key', provider: 'invented' })
    // r1.13: with the person's pick, the piece is that exact saved canvas, in their Studio space (the sim has no Ask turn
    // of its own: the invented title stays when the pick carries none)
    const request = {
      swarm_id: prep?.studio_swarm ?? swarmId, program_id: programId, app_pin: { id: programId, version: '0.4.17-sim' }, maker_id: 'a_bell10',
      title: prep?.title && prep.operation_id ? prep.title : 'Spring picnic poster', detail: prep?.detail && prep.operation_id ? prep.detail : 'A poster for the Elm Street spring picnic (invented)',
      piece: prep ? { scene_id: prep.scene_id, source_ref: prep.source_ref } : { scene_id: 'sim-poster', source_ref: null }, key_id: w.key, model: w.model,
      // ?studiorole=1 (Kimi K5): an effective role and tools readback (invented), so the card's array path is exercised
      role_id: this.d.flags.role ? 'designer' : null, tools: this.d.flags.role ? ['image-search', 'palette'] : [],
      cap_usd: 2, step_cap_usd: 0.25, coordinator_exclusive: false, max_steps: 12, window_minutes: 60,
    }
    const consent = this.consentPayload(request)
    const digest = `sha256:${hex(canonical(consent))}`
    this.issuedPayer.set(digest, w.payer)
    return {
      maker: { id: request.maker_id, name: 'Bellows', swarm_id: request.swarm_id, kind: 'omega', model: w.model, key_id: w.key, key_label: w.label, own_key: w.payer === 'own_key', role_id: request.role_id, tools: request.tools, status: 'asleep', program_id: programId, attachment_id: 'pa_sim_1', created: false },
      operation_id: `ask_simstudio_${++this.seq}`, request: { ...request, consent_digest: digest }, consent, consent_digest: digest,
      maker_name: 'Bellows', key_label: w.label, audience: 'only you and the minds in this swarm (invented)',
      month_left_micros: this.d.flags.monthlyMissing ? null : (MONTH_LIMIT * 1_000_000) - Math.round(MONTH_SPENT_BEFORE * 1_000_000),
    }
  }
  /** SIM: the host's consent payload shape (omega-studio-consent-1; host R2.2), money as integer micros */
  private consentPayload(r: Json): Json {
    const micros = (v: unknown) => Math.round(Number(v) * 1_000_000)
    return {
      schema: 'omega-studio-consent-1', swarm_id: r.swarm_id, program_id: r.program_id, app_pin: r.app_pin, maker_id: r.maker_id, model: r.model, key_id: r.key_id,
      role_id: r.role_id, tools: r.tools, payer: this.world.payer, monthly: { kind: 'own_key_limit', limit_micros: this.d.flags.monthlyMissing ? null : MONTH_LIMIT * 1_000_000 },
      cap_micros: micros(r.cap_usd), step_cap_micros: micros(r.step_cap_usd), step_window_s: 180, max_steps: r.max_steps, window_minutes: r.window_minutes,
      piece: r.piece, coordinator_exclusive: r.coordinator_exclusive, title: r.title, detail: r.detail,
      disclosures: ['maker_restarts_between_steps', 'maker_reads_unsaved_piece_while_live'],
    }
  }

  // ---- G1
  recordIntent(op: string, body: Json): Json {
    if (body.kind !== 'studio.session' || !body.request || typeof body.request !== 'object') refuse(400, 'invalid', 'kind studio.session with a request')
    const r = body.request as Json
    if (!Object.keys(r).every((k) => REQUEST_KEYS.includes(k)) || REQUEST_KEYS.some((k) => !(k in r))) refuse(400, 'invalid', 'the request has exactly the plan’s keys')
    if (!ID.test(String(r.maker_id))) refuse(400, 'invalid', 'maker_id is an exact id')
    const digest = hex(canon(body))
    const found = [...this.intents.values()].find((i) => i.op === op)
    if (found) {
      if (found.digest !== digest) refuse(409, 'operation_conflict', 'another request is recorded for this turn')
      return this.intentView(found)
    }
    const it: Intent = { id: `ai_studio${++this.seq}`, op, principal: this.d.principal(), digest, request: r, state: 'pending', answer: null }
    this.intents.set(it.id, it)
    return this.intentView(it)
  }
  private intentView(i: Intent): Json {
    return { intent_id: i.id, turn_id: i.op, kind: 'studio.session', state: i.state, receiving_goal: (i.answer?.goal_id as string) ?? null }
  }

  submitIntent(id: string): Json {
    const it = this.intents.get(id)
    if (!it || it.principal !== this.d.principal()) refuse(404, 'not_available', 'no such request')
    if (it!.answer) return it!.answer
    const r = it!.request
    // the person's one total monthly limit must exist before anything is reserved or created (contract :170)
    if (this.d.flags.monthlyMissing) refuse(402, 'spend_limit', 'a total monthly limit is required', { limit: { kind: 'own_key_limit', limit: null, spent: null, held: null }, detail: { reason: 'monthly_total_required' } })
    // OI-13 (sim, ?studiokey=none): the maker would run on someone else's key: 402 before anything is reserved or created
    const w = this.world
    if (w.foreign) refuse(402, 'own_key_needed', "This mind would run on someone else's key. Add your own key in Keys, then try again.", { scope: 'use', pays: 'own-key' })
    // host admit order (studio_sessions.admit): model, the resolved paying key (key_drift BEFORE consent), the payer
    if (r.model !== w.model) refuse(409, 'model_drift', "The maker's model changed since you confirmed; confirm again.")
    if (r.key_id !== w.key) refuse(409, 'key_drift', 'The key paying for the maker changed since you confirmed; confirm again.')
    const shownPayer = this.issuedPayer.get(String(r.consent_digest))
    if (shownPayer && shownPayer !== w.payer) refuse(409, 'payer_mismatch', "That maker's calls wouldn't be billed to you; choose your own key.")
    const payload = this.consentPayload(r)
    const digest = `sha256:${hex(canonical(payload))}`
    if (digest !== r.consent_digest) refuse(409, 'consent_mismatch', 'What you confirmed no longer matches; confirm again.', { consent_digest: digest, consent: payload })
    const cap = Number(r.cap_usd)
    if (!(cap > 0) || cap > MONTH_LIMIT - MONTH_SPENT_BEFORE || !(Number(r.step_cap_usd) > 0) || Number(r.step_cap_usd) > cap) refuse(402, 'budget_exhausted', 'the cap is over the monthly headroom')
    // host R5 admission (studio_sessions.admit): a maker another session still owns; a fenced current run; a person's live one
    if ([...this.sessions.values()].some((s) => s.maker_id === r.maker_id && (s.state === 'held' || s.state === 'stopping' || (s.state === 'stopped' && !s.makerReleased)))) refuse(409, 'maker_busy', 'That maker is still held by another Studio session; stop it first.', { reason: 'studio_owned' })
    // host R6 (OI-11): only a hub-channel (omega) maker takes Studio steps; ?studiomaker=iter plays the refusal
    if (this.d.flags.makerKind && this.d.flags.makerKind !== 'omega') refuse(409, 'maker_kind_unsupported', "That maker can't take Studio steps yet; choose an Omega mind.", { kind: this.d.flags.makerKind })
    // host _source (studio_sessions.py 448): a saved canvas that isn't the person's studio source in the session's swarm
    // (or that another live session binds); ?studiosource=unbindable plays it
    const piece = r.piece as Json | undefined
    if (piece && piece.source_ref && this.d.flags.unbindable) refuse(409, 'source_not_bindable', "That piece's saved source can't be bound to this Studio session.")
    if (this.d.flags.fenced) refuse(409, 'execution_fenced', "That maker's current run has ended for Studio; start it again first.")
    if ([...this.sessions.values()].some((s) => s.principal === it!.principal && (s.state === 'active' || s.state === 'paused' || s.state === 'stopping'))) refuse(409, 'person_session_live', 'You already have a live Studio session; finish it first.')
    const sid = `ss_sim${++this.seq}`
    const s: Session = {
      id: sid, stream_id: `as_${hex(`fixture-stream:${sid}`).slice(0, 24)}`, principal: it!.principal, intent_id: it!.id, ask_turn_id: it!.op, goal_id: `g_simstudio${this.seq}`, proposal_artifact_id: `ar_simprop${this.seq}`,
      maker_id: String(r.maker_id), swarm_id: String(r.swarm_id), program_id: String(r.program_id), scene_id: String((r.piece as Json)?.scene_id ?? 'sim-poster'), source_ref: ((r.piece as Json)?.source_ref as Json | null) ?? null,
      payer: 'you (own key)', model: String(r.model), state: 'active', reason: null, cap, step_cap: Number(r.step_cap_usd), steps: [], directions: [], next_dir: 1,
      revisions: [], piece: null, controls: new Map(), stop: { fenced_at: null, unknown_usd: 0, cancel_ack: null, in_flight: 0 }, script: 0, period: '2026-10', receiverGen: 0, mount: { epoch: 0, token: null, gen: 0, until: 0 }, attempts: new Map(), makerReleased: false, pieceGen: null, opIds: new Set(), stopFailed: false, finishCount: 0, windowEnded: false, consentDrift: !!this.d.flags.consentDrift,
    }
    this.sessions.set(sid, s)
    this.byArtifact.set(s.proposal_artifact_id, sid)
    it!.state = 'linked'
    it!.answer = { session_id: sid, stream_id: s.stream_id, goal_id: s.goal_id, proposal_artifact_id: s.proposal_artifact_id, state: 'active', maker_id: s.maker_id, payer: s.payer, cap_usd: s.cap, step_cap_usd: s.step_cap, app_pin: r.app_pin as Json }
    this.event(s)
    // host plan r1.1 S4.4: step 1 is admitted only when the first acknowledged upload from the current mount arrives
    return it!.answer
  }

  // ---- the ledger
  private own(sid: string): Session {
    const s = this.sessions.get(sid)
    if (!s || s.principal !== this.d.principal()) refuse(404, 'not_available', 'no such session')
    return s!
  }
  private spent(s: Session) { return s.steps.reduce((a, x) => a + (x.inflight ? 0 : x.spent_usd), 0) }
  private held(s: Session) { return s.steps.filter((x) => x.inflight).reduce((a, x) => a + x.spent_usd, 0) }
  ledger(sid: string): Json {
    const s = this.own(sid)
    const spent = this.spent(s)
    const held = this.held(s)
    const r2 = (n: number) => Math.round(n * 100) / 100
    // host R3 ledger shape (studio_sessions.ledger + studio_steps views)
    const fresh = !s.piece ? 'missing' : !s.mount.token || Date.now() >= s.mount.until ? 'revoked' : Date.now() - s.piece.lastAt > 30_000 ? 'stale' : 'current'
    return {
      session_id: s.id, kind: 'studio.session', stream_id: s.stream_id, state: s.state, state_reason: s.reason, ask_turn_id: s.ask_turn_id, goal_id: s.goal_id, proposal_artifact_id: s.proposal_artifact_id,
      maker_id: s.maker_id, swarm_id: s.swarm_id, program_id: s.program_id, model: s.model, step_window_s: 180, max_steps: 12,
      piece: { scene_id: s.scene_id, source_ref: s.source_ref },   // host ledger: the session's admitted piece, as recorded
      steps: s.steps.map((x) => ({ n: x.n, state: x.state, proposal_revision: x.proposal_n, proposal_digest: x.proposal_digest, outcome: x.outcome, outcome_reason: x.reason, piece_upload: x.upload, piece_read: x.piece_read, receiver_generation: x.receiver_generation, mount_epoch: x.upload ? s.mount.epoch : null, direction_seqs: x.direction_seqs, op_ids: x.op_ids, spend: { scope: `studiostep:${s.id}:${x.n}`, spent: x.inflight ? 0 : r2(x.spent_usd), held: x.inflight ? r2(x.spent_usd) : 0 } })),
      directions: s.directions.map((x) => ({ seq: x.seq, steer_id: x.steer_id, state: x.state })),
      piece_custody: {
        latest: s.piece ? { seq: s.piece.seq, body_sha256: `sha256:${s.piece.body_sha256}`, scene_ref: s.piece.scene_ref, edit_generation: s.pieceGen, acknowledged_at: s.piece.at, refresh: false } : null,
        piece_state: fresh, mount: { mount_epoch: s.mount.epoch || null, receiver_generation: s.mount.gen || null, lease_expires_at: s.mount.until ? new Date(s.mount.until).toISOString() : null },
      },
      budget: {
        scope: `studio:${s.id}`, cap: s.cap, spent: r2(spent), held: r2(held), unknown: r2(s.stop.unknown_usd), step_cap: s.step_cap, step_spent: null,
        monthly: [{ scope: 'your monthly limit (all keys)', limit: MONTH_LIMIT, spent: r2(MONTH_SPENT_BEFORE + spent), held: r2(held + s.stop.unknown_usd), unknown: r2(s.stop.unknown_usd), period: s.period }],
      },
      // host R5 stop_view: + in_flight (reserved/dispatched under the label), unknown_usd (the label's unknown hold, as
      // budget.unknown), cancel_ack (the goal's cancel ack), fenced_at; message and finish_stopping for a parked Stop
      stop: {
        state: s.state === 'stopping' ? 'stopping' : s.state === 'stopped' ? 'stopped' : null, fenced_at: s.stop.fenced_at,
        in_flight: s.steps.filter((x) => x.inflight).length, unknown_usd: r2(s.stop.unknown_usd), cancel_ack: s.stop.cancel_ack,
        stop_verified: s.state === 'stopped', stop_failed: s.stopFailed, release_stale: false, release_phase: null, maker_released: s.makerReleased,
        stopping_deadline: null, settle_deadline: null,
        message: s.stopFailed ? `Studio's mind couldn't be stopped.${s.finishCount > 0 ? ' An administrator must stop the process.' : ''}` : null,
        finish_stopping: s.state === 'stopping' && s.stopFailed,
      },
    }
  }

  // ---- the mount (E3, sim): compare-and-swap on expected_epoch, a fixture token, a 60 s lease
  mountSession(sid: string, body: Json): Json {
    const s = this.own(sid)
    // host R3: the body is exactly {expected_epoch, receiver_generation, stream_id, mount_id, attempt_id}; attempts replay
    const keys = ['expected_epoch', 'receiver_generation', 'stream_id', 'mount_id', 'attempt_id']
    if (Object.keys(body).length !== keys.length || !keys.every((k) => k in body)) refuse(400, 'bad_request', 'the body is exactly {expected_epoch, receiver_generation, stream_id, mount_id, attempt_id}')
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(body.mount_id)) || !/^[A-Za-z0-9_.:-]{8,80}$/.test(String(body.attempt_id))) refuse(400, 'bad_request', 'mount_id / attempt_id are 8-80 characters')
    const digest = hex(canon(body))
    const seen = s.attempts.get(String(body.attempt_id))
    if (seen) {
      if (seen.digest !== digest) refuse(409, 'operation_conflict', 'that mount attempt id was used with another body')
      if (seen.outcome !== 'mounted') refuse(409, 'mount_conflict', 'another frame mounted first', { mount_epoch: seen.epoch })
      return seen.answer
    }
    if (body.stream_id !== s.stream_id) refuse(409, 'stream_mismatch', 'not this session’s stream')
    if (s.state !== 'active' && s.state !== 'paused') refuse(409, 'session_closed', 'that Studio session has ended', { state: s.state })
    const cur = s.mount.epoch || 0
    if (((body.expected_epoch as number | null) ?? 0) !== cur) {
      s.attempts.set(String(body.attempt_id), { digest, outcome: 'mount_conflict', epoch: cur, answer: { mount_epoch: cur } })
      refuse(409, 'mount_conflict', 'another mount is current', { mount_epoch: cur })
    }
    s.mount = { epoch: cur + 1, token: `mt_${hex(`fixture-mount:${sid}:${cur + 1}:${Date.now()}`).slice(0, 24)}`, gen: Number(body.receiver_generation), until: Date.now() + 60_000 }
    const answer = { session_id: s.id, stream_id: s.stream_id, mount_epoch: s.mount.epoch, mount_token: s.mount.token, receiver_generation: s.mount.gen, lease_expires_at: new Date(s.mount.until).toISOString(), goal_id: s.goal_id, proposal_artifact_id: s.proposal_artifact_id, scene_id: s.scene_id }
    s.attempts.set(String(body.attempt_id), { digest, outcome: 'mounted', epoch: s.mount.epoch, answer })
    return answer
  }
  /** host R3 GET …/mount?attempt_id=: the token only if that attempt won and is still the current mount */
  mountReadback(sid: string, attemptId: string): Json {
    const s = this.own(sid)
    const seen = s.attempts.get(attemptId)
    const attempt = seen ? { attempt_id: attemptId, outcome: seen.outcome, mount_epoch: seen.epoch, ...(seen.outcome === 'mounted' && seen.epoch === s.mount.epoch && s.mount.token ? { mount_token: s.mount.token } : {}) } : null
    return { session_id: s.id, current_mount_epoch: s.mount.epoch || null, lease_expires_at: s.mount.until ? new Date(s.mount.until).toISOString() : null, attempt }
  }
  private mountCheck(s: Session, body: Json) {
    if (!s.mount.token || body.mount_token !== s.mount.token || body.mount_epoch !== s.mount.epoch || body.receiver_generation !== s.mount.gen) refuse(409, 'stale_mount', 'this mount is not the current one')
    if (Date.now() >= s.mount.until) refuse(409, 'stale_mount', 'the mount lease lapsed')
  }
  heartbeat(sid: string, body: Json): Json {
    const s = this.own(sid)
    this.mountCheck(s, body)
    s.mount.until = Date.now() + 60_000
    return { lease_expires_at: new Date(s.mount.until).toISOString() }
  }
  unmount(sid: string, body: Json): Json {
    const s = this.own(sid)
    if (body.mount_token === s.mount.token) s.mount.token = null
    return {}
  }

  // ---- the piece
  piece(sid: string, body: Json): Json {
    const s = this.own(sid)
    if (s.state === 'stopping' || s.state === 'stopped') refuse(409, 'session_closed', 'the session has stopped')
    if (typeof body.body !== 'string' || typeof body.seq !== 'number' || !body.scene_ref || typeof body.edit_generation !== 'number') refuse(400, 'bad_request', '{seq, body, scene_ref, edit_generation, mount fields}')
    if (new TextEncoder().encode(body.body as string).length > 256 * 1024) refuse(413, 'piece_too_large', 'at most 256 KB')
    this.mountCheck(s, body)
    if ((body.scene_ref as Json).scene_id !== s.scene_id) refuse(409, 'scene_mismatch', 'that frame holds another piece')
    const cur = s.piece?.seq ?? 0
    const sha = hex(body.body as string)
    const ackView = (refresh: boolean) => ({ seq: s.piece!.seq, body_sha256: `sha256:${s.piece!.body_sha256}`, scene_ref: s.piece!.scene_ref, edit_generation: s.pieceGen, acknowledged_at: s.piece!.at, refresh })
    if (s.piece && body.seq === cur) {   // host R3: a lost answer replays the same tuple
      if (s.piece.body_sha256 === sha && s.pieceGen === body.edit_generation) return ackView(false)
      refuse(409, 'stale_piece', 'that upload number is taken', { seq: cur })
    }
    if (body.seq !== cur + 1) refuse(409, 'stale_piece', 'send the next upload number', { seq: cur })
    let refresh = false
    if (s.piece && s.pieceGen !== null) {
      const same = s.piece.body_sha256 === sha && canon(s.piece.scene_ref) === canon(body.scene_ref)
      if ((body.edit_generation as number) < s.pieceGen) refuse(409, 'stale_generation', 'older than the shared one', { edit_generation: s.pieceGen })
      if (body.edit_generation === s.pieceGen) { if (!same) refuse(409, 'generation_reused', 'same generation, other bytes'); refresh = true }
      else if (same) refuse(409, 'generation_without_change', 'a higher generation needs changed art')
    }
    const nowMs = Date.now()
    if (s.piece && nowMs - s.piece.lastAt < 1000) refuse(429, 'rate_limited', 'one piece upload a second', { retry_after_ms: 1000 })
    s.pieceGen = body.edit_generation as number
    const first = !s.piece
    s.piece = { seq: body.seq as number, body: body.body as string, body_sha256: hex(body.body as string), scene_ref: body.scene_ref as Json, at: this.d.now(), lastAt: nowMs }
    if (first && !s.steps.length && s.state === 'active') this.d.later(300, () => this.admit(s))
    return ackView(refresh)
  }

  /** host R6.2 (sim): a second publish by the SAME execution (a redelivered step) answers the existing proposal: no new
   *  revision, no new artifact.revision event, nothing for the frame to draw again. Another step's is still refused. */
  republish(sid: string, n: number): Json {
    const s = this.own(sid)
    const st = s.steps.find((x) => x.n === n)
    if (!st || st.proposal_n === null) refuse(409, 'step_closed', 'No Studio step is open for a proposal.')
    this.event(s, st)   // a redelivery may re-announce the step: the person's page only reads the ledger again
    return { revision: st!.proposal_n, digest: st!.proposal_digest, op_ids: st!.op_ids, already_published: true }
  }

  /** host R4 L6 (studio_gateway `_op_ids` + `op_ids_check` + `op_ids_record`): 1-16 distinct well-formed ids, none
   *  declared before in this session (any step, mount or segment); refused with nothing recorded. */
  declareOpIds(sid: string, n: number, ids: unknown): string[] {
    const s = this.own(sid)
    const st = s.steps.find((x) => x.n === n)
    if (!st) refuse(404, 'not_available', 'no such step')
    const ops = opIdsOf(ids)
    if (!ops) refuse(400, 'bad_request', "op_ids is the proposal's 1-16 distinct operation ids, as in its items")
    const used = ops!.filter((x) => s.opIds.has(x)).sort()
    if (used.length) refuse(409, 'op_id_reused', 'Those operation ids were already used in this Studio session; a new proposal needs new ones.', { op_ids: used })
    for (const x of ops!) s.opIds.add(x)
    st!.op_ids = ops
    return ops!
  }

  // ---- outcomes
  outcome(sid: string, n: number, body: Json): Json {
    const s = this.own(sid)
    const st = s.steps.find((x) => x.n === n)
    if (!st) refuse(404, 'not_available', 'no such step')
    const p = body.proposal as Json | undefined
    const opIds = body.op_ids === undefined || body.op_ids === null ? null : opIdsOf(body.op_ids)
    if (opIds === null && body.op_ids != null) refuse(400, 'bad_request', "op_ids is the proposal's 1-16 distinct operation ids, as in its items")
    if (!p || p.artifact_id !== s.proposal_artifact_id || p.revision !== st!.proposal_n || String(p.digest).replace(/^sha256:/, '') !== String(st!.proposal_digest).replace(/^sha256:/, '')) refuse(409, 'wrong_proposal', 'that is not the revision bound to this step')
    this.mountCheck(s, body)
    // host R4 L6 (op_ids_outcome): required for a validated outcome; exactly the declared SET, else held (never skipped)
    if (!st!.outcome_digest) {
      if (opIds === null && ['applied', 'refused', 'accepted-no-source-change'].includes(String(body.outcome))) refuse(400, 'bad_request', 'op_ids is required for an applied, refused or accepted-no-source-change outcome: the operation ids the receiver read')
      if (opIds !== null && (!st!.op_ids || [...opIds].sort().join('\u0000') !== [...st!.op_ids].sort().join('\u0000'))) refuse(409, 'op_ids_mismatch', "Those aren't the operation ids this step's proposal declared; hold, do not skip.", { op_ids: st!.op_ids })
    }
    if (!body.piece_upload || typeof body.piece_upload !== 'object') refuse(400, 'invalid', 'the acknowledged piece_upload binding is required')
    const u = body.piece_upload as Json
    // custody: the binding must name an upload the host acknowledged (this sim keeps only the latest; older = its own seq ≤)
    // host R3: the tuple must be EXACTLY an acknowledged upload (its `sha256:` digest included) of the current mount
    if (!s.piece || typeof u.seq !== 'number' || u.seq > s.piece.seq || (u.seq === s.piece.seq && u.body_sha256 !== `sha256:${s.piece.body_sha256}`) || (st!.piece_read && u.seq < Number((st!.piece_read as Json).seq))) refuse(409, 'piece_custody_missing', 'share the piece that shows this outcome first')
    const digest = hex(canon(body))
    if (st!.outcome_digest) {
      if (st!.outcome_digest !== digest) refuse(409, 'operation_conflict', 'a different outcome is recorded for this step')
      return st!.answer as Json
    }
    if (typeof body.receiver_generation === 'number' && body.receiver_generation < s.receiverGen) refuse(409, 'stale_receiver', 'a newer canvas reported already')
    s.receiverGen = Math.max(s.receiverGen, Number(body.receiver_generation) || 0)
    st!.late = st!.state === 'timed_out' || st!.state === 'stopped' || st!.state === 'interrupted'
    st!.outcome = String(body.outcome)
    st!.reason = typeof body.reason === 'string' ? body.reason : null
    st!.piece_before = body.piece_before as Json
    st!.piece_after = body.piece_after as Json
    st!.receiver_generation = Number(body.receiver_generation)
    st!.upload = u
    st!.outcome_digest = digest
    st!.answer = { session_id: s.id, stream_id: s.stream_id, step: n, proposal: p, outcome: st!.outcome, reason: st!.reason, op_ids: opIds, piece_upload: u, mount_epoch: s.mount.epoch, receiver_generation: s.mount.gen, frame_reported: true, recorded_at: this.d.now() }
    this.stepEvent(s, st!, 'outcome')
    this.d.later(400, () => this.admit(s))
    return st!.answer as Json
  }

  // ---- controls
  control(sid: string, body: Json): Json {
    const s = this.own(sid)
    const cid = String(body.control_id ?? '')
    const action = String(body.action ?? '')
    if (!ID.test(cid) || !['pause', 'resume', 'stop', 'finish_stopping'].includes(action)) refuse(400, 'invalid', '{control_id, action}')
    const digest = hex(canon(body))
    const known = s.controls.get(cid)
    if (known) {
      if (known.digest !== digest) refuse(409, 'operation_conflict', 'That control id was used for another control.')
      return known.result
    }
    const stamp = this.d.now()
    let result: Json
    if (action === 'pause') {
      // host R5 _pause: idempotent on paused; only from active (an open step runs on; nothing new is admitted)
      if (s.state !== 'paused') {
        if (s.state !== 'active') refuse(409, 'not_active', 'Only a running Studio session can be paused.', { state: s.state })
        s.state = 'paused'; s.reason = 'paused_by_person'
      }
      result = { session_id: s.id, control_id: cid, action, state: 'paused', state_reason: 'paused_by_person', at: stamp }
    } else if (action === 'resume') {
      // host R5 _resume order: state, window, binding/payer, budget, consent payload; any refusal leaves it paused
      if (s.state !== 'active') {
        if (s.state === 'stopping') refuse(409, 'studio_stopping', 'That Studio session is stopping.', { state: s.state })
        if (s.state === 'held') refuse(409, 'not_paused', 'That Studio session is held; retry or stop it.', { state: s.state, state_reason: s.reason })
        if (s.state !== 'paused') refuse(409, 'session_closed', 'That Studio session has ended.', { state: s.state })
        if (s.windowEnded) refuse(409, 'window_ended', "That Studio session's time is up; start a new one.")
        if (s.consentDrift) refuse(409, 'consent_mismatch', 'What you confirmed no longer matches; confirm a new Studio session.')
        s.state = 'active'; s.reason = null
        this.d.later(200, () => this.admit(s))
      }
      result = { session_id: s.id, control_id: cid, action, state: 'active', at: stamp }
    } else if (action === 'stop') {
      if (s.state !== 'stopping' && s.state !== 'stopped') {
        // the fence: no new step, revision or dispatch from here on; the goal is cancelled; undelivered directions cancelled
        s.state = 'stopping'; s.reason = 'stopped'
        s.stop.fenced_at = stamp
        s.stop.cancel_ack = 'pending'
        for (const d of s.directions) if (d.state === 'queued') d.state = 'cancelled'
        const open = s.steps.find((x) => x.state === 'admitted')
        if (open) open.state = 'stopped'
        s.stop.in_flight = s.steps.filter((x) => x.inflight).length
        if (this.d.flags.stopFail) s.stopFailed = true                     // sim: a parked Stop (stop_failed)
        else if (s.stop.in_flight === 0) this.finishStop(s)
        // a held in-flight call ends after the fence: its cost is unknown (settled by makerStep's stopping path)
        if (this.d.flags.hold) for (const x of s.steps) if (x.inflight) this.d.later(1500, () => this.makerStep(s, x))
        this.d.later(2600, () => { s.stop.cancel_ack = 'acknowledged'; this.event(s) })
      }
      const l = this.ledger(s.id)
      result = { session_id: s.id, control_id: cid, action, state: l.state, stop: l.stop, at: stamp }
    } else {
      // finish_stopping (host §5.3): only a parked Stop; ?studiostopfail=2 parks it once more (then the admin words)
      if (s.state !== 'stopping' || !s.stopFailed) refuse(409, 'not_stopping', 'Nothing is waiting to finish stopping.', { state: s.state })
      s.finishCount++
      if ((this.d.flags.stopFail ?? 0) < 2) { s.stopFailed = false; if (!s.steps.some((x) => x.inflight)) this.finishStop(s) }
      result = { session_id: s.id, control_id: cid, action, state: 'stopping', at: stamp }
    }
    s.controls.set(cid, { digest, result })
    this.event(s)
    return result
  }
  /** SIM test hooks (host R5 refusals that need time or a changed card): the window ends; the consent drifts */
  simulate(sid: string, what: 'window-ended' | 'consent-drift' | 'held'): void {
    const s = this.own(sid)
    if (what === 'window-ended') s.windowEnded = true
    else if (what === 'consent-drift') s.consentDrift = true
    else { s.state = 'held'; s.reason = 'maker_unresponsive' }
    this.event(s)
  }
  private finishStop(s: Session) {
    s.makerReleased = true   // host R3: `stopped` (the spec's ended) only once every dispatched call settled or went unknown and the maker is released
    s.state = 'stopped'
    if (this.d.flags.rollover) this.d.later(1200, () => { s.period = '2026-11'; this.event(s) })
  }

  // ---- directions (O1)
  steer(op: string, body: Json): Json | null {
    // host R5 studio_steer: the session bound to this turn, whatever its state; stopping/stopped refuse (nothing written),
    // paused and held queue and say so
    const s = [...this.sessions.values()].reverse().find((x) => x.ask_turn_id === op && x.principal === this.d.principal())
    if (!s) return null
    const steer_id = String(body.steer_id ?? '')
    const text = String(body.text ?? '')
    if (!ID.test(steer_id) || !text.trim() || text.length > 4000) refuse(400, 'invalid', '{steer_id, text}')
    const digest = hex(canon({ steer_id, text }))
    const known = s.directions.find((d) => d.steer_id === steer_id)
    if (known) {
      if (known.digest !== digest) refuse(409, 'operation_conflict', 'that steer id has other words')
      return this.steerAnswer(s, known, op)
    }
    if (s.state === 'stopping' || s.state === 'stopped') refuse(409, 'studio_session_closed', 'That Studio session has ended; your words were not sent.', { session_id: s.id, state: s.state })
    if (s.directions.filter((d) => d.state === 'queued' || d.state === 'delivered').length >= 20) refuse(429, 'rate_limited', 'twenty directions are waiting', { limit_steers: 20 })
    const d: Direction = { seq: s.next_dir++, steer_id, text, state: 'queued', digest }
    s.directions.push(d)
    this.event(s)
    if (s.state === 'active' && !s.steps.some((x) => x.state === 'admitted' || (x.proposal_n !== null && !x.outcome))) this.d.later(300, () => this.admit(s))
    return this.steerAnswer(s, d, op)
  }
  private steerAnswer(s: Session, d: Direction, op: string): Json {
    // host R5: the recorded answer, replayed byte for byte (state queued as recorded; session_state at recording)
    d.answer ??= { steer_id: d.steer_id, operation_id: op, turn_id: op, new_turn: false, studio: { session_id: s.id, seq: d.seq, state: 'queued', session_state: s.state } }
    return d.answer
  }

  // ---- the frame's exact proposal read and subscription (sim host's artifact plane)
  hasArtifact(artifactId: string): boolean {
    const sid = this.byArtifact.get(artifactId)
    return !!sid && this.sessions.get(sid)?.principal === this.d.principal()
  }
  readProposal(params: Json): Json {
    const sid = this.byArtifact.get(String(params.artifact_id))
    const s = sid ? this.sessions.get(sid) : undefined
    if (!s || s.principal !== this.d.principal()) refuse(404, 'not_available', 'no such proposal')
    const rev = s!.revisions[Number(params.revision) - 1]
    if (!rev || String(params.digest).replace(/^sha256:/, '') !== rev.digest) refuse(404, 'not_available', 'no such revision')
    return { result: { artifact_id: s!.proposal_artifact_id, revision: Number(params.revision), digest: `sha256:${rev.digest}`, body: rev.body, execution_admitted: false } }
  }

  // ---- the session runner and the scripted maker
  /** host R3 studio.step notice: ids, step, phase, proposal revision and outcome; never a body */
  private stepEvent(s: Session, step: Step, phase: string) {
    this.d.emit({ type: 'studio.step', at: this.d.now(), session_id: s.id, stream_id: s.stream_id, goal_id: s.goal_id, step: step.n, phase, step_state: step.state, proposal_artifact_id: s.proposal_artifact_id, proposal_revision: step.proposal_n, outcome: step.outcome, session_state: s.state, updated_at: this.d.now() })
  }
  private event(s: Session, step?: Step) {
    const last = step ?? s.steps.at(-1)
    this.d.emit({ type: 'studio.session', at: this.d.now(), session_id: s.id, stream_id: s.stream_id, state: s.state, ...(last ? { step: last.n, ...(last.proposal_n ? { rev: last.proposal_n } : {}), ...(last.outcome ? { outcome: last.outcome } : {}) } : {}) })
  }

  private admit(s: Session) {
    if (s.state !== 'active') return
    const prev = s.steps.at(-1)
    if (prev && (prev.state === 'admitted' || (prev.proposal_n !== null && !prev.outcome))) return   // a published revision with no outcome blocks
    const queued = s.directions.filter((d) => d.state === 'queued')
    const rebase = prev?.outcome === 'refused'
    if (!queued.length && s.script >= SCRIPT.length && !rebase) return
    if (this.spent(s) + this.held(s) + s.step_cap > s.cap) { s.state = 'paused'; s.reason = 'budget_exhausted'; this.event(s); return }
    const n = s.steps.length + 1
    const step: Step = { n, state: 'admitted', proposal_n: null, proposal_digest: null, outcome: null, reason: null, piece_before: null, piece_after: null, receiver_generation: null, direction_seqs: queued.map((d) => d.seq), late: false, upload: null, summary: null, spent_usd: 0.04 + (n % 3) * 0.015, outcome_digest: null, piece_read: null, op_ids: null, more: false, inflight: true }
    for (const d of queued) d.state = 'delivered'
    s.steps.push(step)
    this.event(s, step)
    // the maker's paid call runs, then it reads its context and publishes one revision (?studiohold=1: step 3's call
    // stays in flight until Stop, so the fence meets a dispatched call; nothing is charged that was not reserved)
    if (this.d.flags.hold && n === 3) return
    this.d.later(3200 / this.d.flags.speed, () => this.makerStep(s, step))
  }

  /** INVENTED maker: read context (piece + directions), publish one P2a proposal, settle its call, say done. */
  private makerStep(s: Session, step: Step) {
    step.inflight = false
    if (s.state === 'stopping') {
      // the call was already sent when Stop fenced it: its cost is not known (sim). Exactly what was held for it moves to
      // unknown (spent + held + unknown is conserved; nothing is invented or refunded)
      s.stop.unknown_usd += step.spent_usd
      step.spent_usd = 0
      s.stop.in_flight = Math.max(0, s.stop.in_flight - 1)
      if (s.stop.in_flight === 0 && !s.stopFailed) this.finishStop(s)
      this.event(s, step)
      return
    }
    if (s.state !== 'active' || step.state !== 'admitted') return
    for (const d of s.directions) if (step.direction_seqs.includes(d.seq)) d.state = 'read'
    // r1.14d: as the host records it (studio_steps upload: body_sha256 = "sha256:<hex>"), never the bare form
    if (s.piece) step.piece_read = { seq: s.piece.seq, body_sha256: `sha256:${s.piece.body_sha256}`, scene_ref: s.piece.scene_ref, edit_generation: s.pieceGen }
    const piece = this.currentScene(s)
    let items: Json[] = []
    let summary = ''
    const dirs = s.directions.filter((d) => step.direction_seqs.includes(d.seq)).map((d) => d.text.toLowerCase())
    const head = piece?.elements.find((e) => e.id === `ask_${s.stream_id}_headline`)
    const bg = piece?.elements.find((e) => e.id === `ask_${s.stream_id}_bg`)
    for (const t of dirs) {
      if (/bigger|larger/.test(t) && head) { items.push({ op_id: `big-${step.n}`, op: 'set-element', args: { id: 'headline', prior: { fontSize: head.fontSize }, value: { fontSize: Math.min(80, Number(head.fontSize) + 10) } } }); summary = 'bigger headline' }
      else if (/warm/.test(t) && bg) { items.push({ op_id: `warm-${step.n}`, op: 'set-element', args: { id: 'bg', prior: { fill: bg.fill }, value: { fill: '#fbe0c4' } } }); summary = 'warmer background' }
    }
    if (!items.length && dirs.length) { items = [{ op_id: `note-${step.n}`, op: 'cursor', args: { x: 0.5, y: 0.5, caption: `Noted: ${dirs[0].slice(0, 40)}` } }]; summary = 'noted a direction' }
    // after a terminal refusal the maker reads the person's current piece and proposes the step again with fresh priors
    const prev = s.steps[s.steps.length - 2]
    const rebase = prev?.outcome === 'refused' && s.script > 0
    if (rebase && !items.length) s.script--
    if (!items.length && s.script < SCRIPT.length) {
      const entry = SCRIPT[s.script++]
      items = entry.items(s.id)
      summary = rebase ? `${entry.summary} (again, from your edited piece)` : entry.summary
      // INVENTED race: step 4's maker assumes the headline it drew; after a hand edit that prior is stale and the canvas refuses
      // r1.13 (Design 012749Z): a VALID set-element (0.4.20 p2a projection: prior and value carry exactly the same keys);
      // its prior names the headline as drawn, so a hand edit before it lands is a precondition refusal, never overwritten
      if (!rebase && entry.summary === 'details' && head) items.push({ op_id: 'headline-tone', op: 'set-element', args: { id: 'headline', prior: { text: 'Elm Street spring picnic', color: '#24352a' }, value: { text: 'Elm Street spring picnic', color: '#2f6b3a' } } })
    }
    if (!items.length) { step.state = 'finished'; step.more = false; this.event(s, step); return }
    items = items.map((i) => ({ ...i, op_id: `${String(i.op_id)}-s${step.n}` }))   // every step's op ids are new (rebase included)
    // host R4 L6: the maker DECLARES its op ids beside the proposal; a reused one refuses the publication (409 op_id_reused)
    try {
      this.declareOpIds(s.id, step.n, items.map((i) => String(i.op_id)))
    } catch {
      step.state = 'finished'; step.more = false; this.event(s, step); return   // nothing published for this step
    }
    const body = canon({ schema: 'omega-maker-revision-2', goal_id: s.goal_id, scene_id: s.scene_id, base: s.piece?.scene_ref ?? { scene_id: s.scene_id, revision: 1, digest: `sha256:${'0'.repeat(64)}` }, items })
    const digest = hex(body)
    s.revisions.push({ body, digest, created_at: this.d.now() })
    step.proposal_n = s.revisions.length
    step.proposal_digest = `sha256:${digest}`
    step.summary = summary
    step.state = 'finished'
    step.more = s.script < SCRIPT.length
    this.d.emit({ type: 'artifact.revision', at: this.d.now(), swarm_id: s.swarm_id, artifact_id: s.proposal_artifact_id, revision: step.proposal_n, digest: step.proposal_digest, created_at: this.d.now() })
    this.event(s, step)
  }

  private currentScene(s: Session): { elements: Json[] } | null {
    if (!s.piece) return null
    try {
      const env = JSON.parse(s.piece.body) as Json
      const scene = env.scene as { elements?: Json[] } | undefined
      return scene && Array.isArray(scene.elements) ? { elements: scene.elements } : null
    } catch {
      return null
    }
  }
}
