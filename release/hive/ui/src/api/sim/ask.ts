/**
 * SIM ONLY. The universal Ask's host side, played in the browser with an invented answering mind (Surface universal
 * Ask phase 1). It follows UNIVERSAL_ASK_HOST_CONTRACT_DRAFT_20261005 and the owner's ruling: the swarm's orchestrator
 * (coordinator) answers: the addressed mind's swarm, else the page's swarm, else the person's default swarm, else
 * `no_orchestrator`. Every word it says is invented here; nothing reaches a model or a provider.
 *
 * It plays every event phase so the page can be proved against them: accepted, thinking (one frame is deliberately
 * dropped every third turn, so gap recovery through GET /api/ask/{op} is exercised), answer, proposal (navigate, ui),
 * ui-change (after the person keeps a proposed look), action-needs-confirm, presence (incl. sketch), done, refused.
 * "lose a step" plays a lost frame whose recovery read also fails (Review B2): a navigation after it must be held.
 */
import { plural } from '../../lib/plural'
import { AskRefusal } from '../ask'
import type { ActResult, AskAccepted, AskCapabilities, AskBody, AskSettingsPut, AskEvent, AskSettings, AskSteerBody, AskSteerResult, AskThread, AskTurnState, AskWho } from '../ask'
import type { Agent, Goal, Room, Swarm, WorkSession } from '../types'
import { href } from '../../lib/router'
import { designStarter } from './omegadesign'
import { simBankedDemo } from './omegaTools'
import { guidedIntent } from '../../features/guided/match'
import { dwellMs } from '../../features/guided/machine'
import { bankedScript, readBankedDemo } from '../../features/guided/banked'
import type { GuideScript } from '../../features/guided/types'

export interface SimAskDeps {
  emit: (e: AskEvent) => void
  later: (ms: number, fn: () => void) => void
  agents: () => Agent[]
  swarms: () => Swarm[]
  goals: () => Goal[]
  principal: () => string
}

interface Turn {
  op: string
  turnId: string
  canon: string
  thread: AskThread
  events: AskEvent[]
  state: 'open' | 'done' | 'refused'
  /** Platform P2 (fixture): the person's own mind answers for them */
  actingAs?: { mind_id: string; name: string }
  principal: string
  /** a ui proposal waiting for the person's Keep */
  uiProposal?: string
  /** proposals by id, with the digest the page must echo */
  proposals: Map<string, string>
  /** the person took over the page: the mind's navigation is paused for the rest of the turn */
  tookOver?: boolean
  /** ended by the host takeover route: the recovery view reads refused/takeover; later act results 409 turn_closed */
  takenOver?: boolean
  /** what the person said mid-turn (steers), so the answer can take them in */
  heard: string[]
  /** a steer asked the mind to stop moving the page */
  stay?: boolean
  /** the request as asked, so a steer to a closed turn can become a fresh request */
  body: AskBody
  /** SIM: the recovery read fails for this turn (the lost frame can never be read back) */
  unreadable?: boolean
  /** when the hive admitted it (ask_turns.created_at) */
  createdAt?: string
  closedAt?: string | null
  /** the thread was deleted: the row stays for the audit, its words are removed (ask.py delete_thread) */
  deleted?: boolean
  /** conductor acts emitted in this turn, and the results the page posted for them (each accepted once) */
  acts: Set<string>
  results: Map<string, ActResult>
  /** a guided demo this turn's conductor is driving: one tour.step at a time, the next after the page's result */
  tour?: { script: string; total: number; dwell: number[]; step: number; act: string; finish: (text: string) => void; title: string }
  /** the ids of this turn's memory notes: the only ids a revise may name (host conductor.note_ids) */
  noteIds: Set<string>
}

/**
 * SIM: the steps a guided demo has, as the page will play them (a banked one reads the invented catalogue stand-in,
 * exactly as the page reads the hive's Tools app). Null when there is nothing to drive.
 */
function simTour(base: GuideScript): GuideScript | null {
  if (!base.banked) return base
  const d = readBankedDemo(simBankedDemo(base.banked), base.banked)
  return bankedScript(base, d && d !== 'unavailable' ? { demo: d } : { missing: d === 'unavailable' ? 'unavailable' : 'unreadable' })
}

// the built host's exact keys (platform/ask-p1 at 6100794, hive/API.md "Universal Ask, phase 1")
const ALLOWED = ['operation_id', 'text', 'context', 'thread', 'via', 'memory_notes']
/** The host's check of memory_notes (conductor.check_notes): ≤ 20 strings or {id, text} with distinct ids, ≤ 8 KB. */
const notesOk = (notes: unknown): boolean => {
  if (!Array.isArray(notes) || notes.length > 20) return false
  const ids = new Set<string>()
  let size = 0
  const enc = new TextEncoder()
  for (const n of notes) {
    let text: unknown = n
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>
      if (Object.keys(o).sort().join() !== 'id,text' || typeof o.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(o.id) || ids.has(o.id)) return false
      ids.add(o.id)
      size += enc.encode(o.id).length
      text = o.text
    }
    if (typeof text !== 'string' || !text.trim()) return false
    size += enc.encode(text).length
  }
  return size <= 8192
}
const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/
/** The host's limits on view fields and regions (Platform r2 Q1): what does not conform is refused, never repaired. */
const viewNamesOk = (v: { fields?: unknown; regions?: unknown } | undefined): boolean => {
  if (!v) return true
  const fields = v.fields ?? []
  const regions = v.regions ?? []
  if (!Array.isArray(fields) || fields.length > 32 || !Array.isArray(regions) || regions.length > 32) return false
  const fieldOk = (f: unknown) => {
    const o = f as Record<string, unknown>
    return !!o && typeof o === 'object' && Object.keys(o).every((k) => ['id', 'label', 'kind'].includes(k)) && typeof o.id === 'string' && NAME.test(o.id) && typeof o.label === 'string' && o.label.length >= 1 && o.label.length <= 80 && !CONTROL.test(o.label) && ['text', 'search', 'prompt'].includes(o.kind as string)
  }
  return fields.every(fieldOk) && regions.every((r) => typeof r === 'string' && NAME.test(r))
}
const CONTEXT_KEYS = ['route', 'experience', 'program', 'swarm_id', 'mind', 'selection', 'view', 'private']
const VIEW_KEYS = ['refs', 'acts', 'summary', 'fields', 'regions']
const ACT_REASONS = ['invalid', 'not_declared', 'act_cap', 'private', 'blocked', 'stale_origin', 'reduced_motion_skipped']
const FORBIDDEN = /^(principal|actor|agent_id|member_id|model|provider|budget_usd|to|coordinator_id)$|_key$|token/
/** The page context of a request (a private one names nothing: all its page keys read as absent). */
const ctxOf = (b: AskBody): Partial<import('../ask').PageAskContext> | undefined => b.context as Partial<import('../ask').PageAskContext> | undefined
const refuse = (status: number, reason: string, message: string, details?: import('../ask').AskRefusalDetails) => new AskRefusal(status, reason, message, details)
/** SIM: the simulated hive's conductor answers every turn and its memory is on (HIVE_ASK_MEMORY=on). */
const SIM_CONDUCTOR = { model: 'sim/conductor' }
const digestOf = (s: string) => {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return `sim:${(h >>> 0).toString(16)}`
}

export class SimAsk {
  private settings: AskSettings = { swarm_id: 's_lyra', thread_budget_usd: 0.25 }
  private threads = new Map<string, AskThread>()
  private turns = new Map<string, Turn>()
  private count = 0
  /** SIM fixture: the next request finds the coordinator answering another person (coordinator_busy). */
  private busyNext = false
  /** SIM: the host's switches (HIVE_ASK_CONDUCTOR, HIVE_ASK_MEMORY). ?askflags= */
  private flags: AskCapabilities = { conductor: true, memory: true }
  constructor(private d: SimAskDeps) {}

  /** SIM ONLY fixture: memory frames are sent even with memory off (a host's late or stray frames). */
  private stray = false
  strayFrames(): void {
    this.stray = true
  }

  /** SIM ONLY, demo mode (api/sim/demo.ts): INVENTED notes the first answer to each person teaches, once per session. */
  private seedNotes: { statement: string; kind: string; confidence: number }[] = []
  private taught = new Set<string>()
  demoNotes(notes: { statement: string; kind: string; confidence: number }[]): void {
    this.seedNotes = notes.slice(0, 8)
  }

  /** SIM ONLY fixture: play a hive with these switches (memory needs the conductor, as core/ask.py memory_on). */
  setFlags(f: AskCapabilities): void {
    this.flags = { conductor: f.conductor, memory: f.conductor && f.memory }
  }

  coordinatorBusyNext(): void {
    this.busyNext = true
  }

  /**
   * SIM ONLY fixture (?askanswer=): who answers when nothing decides it. `nodefault`: no default Ask swarm; `one`: only
   * one swarm offered; `mind` / `mindasleep`: a host with Platform P1/P2 (GET /api/me/mind, the person's own mind
   * answers with acting_as; asleep: mind_asleep); `next-<reason>`: the next request is refused once with that reason.
   */
  private answer: { one?: boolean; mind?: string; next?: string } = {}
  setAnswerFixture(f: { nodefault?: boolean; one?: boolean; mind?: 'awake' | 'asleep'; next?: string }): void {
    if (f.nodefault) this.settings = { ...this.settings, swarm_id: null }
    this.answer = { one: f.one, mind: f.mind === 'asleep' ? 'a_altr03' : f.mind === 'awake' ? 'a_deneb2' : undefined, next: f.next }
  }
  /** GET /api/me/mind: {mind} on a P1/P2 host (fixture), else 404 as a host without the route. */
  myMind(): { mind: { id: string; name: string; swarm_id: string | null; status: string } | null } {
    if (!this.answer.mind) throw refuse(404, 'not_found', 'not found')
    const a = this.d.agents().find((x) => x.id === this.answer.mind)
    return { mind: a ? { id: a.id, name: a.name, swarm_id: a.swarm_id ?? null, status: a.status } : null }
  }

  private choice(id: string | null) {
    const sw = id ? this.d.swarms().find((s) => s.id === id) : undefined
    if (!sw) return null
    const c = sw.coordinator_id ? this.d.agents().find((a) => a.id === sw.coordinator_id) : undefined
    return { id: sw.id, name: sw.name, orchestrator: c ? { id: c.id, name: c.name, status: c.status } : null }
  }
  getSettings(): AskSettings {
    const all = this.d.swarms().filter((s) => !s.archived_at && s.coordinator_id).map((s) => this.choice(s.id)!)
    const eligible = this.answer.one ? all.filter((s) => s.id === 's_lyra') : all
    return { swarm_id: this.settings.swarm_id, swarm: this.choice(this.settings.swarm_id), thread_budget_usd: this.settings.thread_budget_usd, max_thread_budget_usd: 5, eligible, capabilities: { ...this.flags } }
  }
  setSettings(b: AskSettingsPut): AskSettings {
    const keys = Object.keys(b ?? {})
    if (keys.some((k) => !['swarm_id', 'mind_id', 'thread_budget_usd'].includes(k))) throw refuse(400, 'invalid', 'unexpected field')
    let swarm = b.swarm_id
    if (b.mind_id) swarm = this.d.agents().find((a) => a.id === b.mind_id)?.swarm_id ?? undefined
    if (swarm !== undefined && swarm !== null && !this.d.swarms().some((s) => s.id === swarm)) throw refuse(400, 'invalid', 'unknown swarm')
    if (b.thread_budget_usd !== undefined && (typeof b.thread_budget_usd !== 'number' || b.thread_budget_usd <= 0 || b.thread_budget_usd > 5)) throw refuse(400, 'invalid', 'budget out of range')
    this.settings = { swarm_id: swarm === undefined ? this.settings.swarm_id : swarm, thread_budget_usd: b.thread_budget_usd ?? this.settings.thread_budget_usd }
    return this.getSettings()
  }

  /** Delete a thread and every turn in it (the person's own records). */
  deleteThread(id: string): { deleted: string } {
    this.endThread(id)
    // as the host (ask.py delete_thread): the turn rows stay for the audit with their text and every frame's text blanked
    for (const t of this.turns.values()) {
      if (t.thread.id !== id) continue
      t.deleted = true
      t.body = { ...t.body, text: '', context: { route: '', experience: '' } }
      t.events = t.events.map((e) => ('text' in e ? ({ ...e, text: '' } as AskEvent) : e))
    }
    return { deleted: id }
  }

  /** ask.py view: the turn as the hive keeps it (a deleted thread's turn has text "" and context {}). */
  private record(t: Turn): import('../missingUi').AskTurnRecord {
    const state = t.takenOver ? 'refused' : t.state === 'open' ? (t.events.some((e) => e.phase === 'thinking') ? 'thinking' : 'accepted') : t.state
    const refused = t.takenOver ? { reason: 'takeover' } : (t.events.find((e) => e.phase === 'refused') as { reason?: string } | undefined)
    const done = [...t.events].reverse().find((e) => e.phase === 'done' || e.phase === 'refused') as { turn_spent_usd?: number } | undefined
    return {
      operation_id: t.op, turn_id: t.turnId, state, reason: refused?.reason ?? null,
      thread: { id: t.thread.id, mind: { ...t.thread.mind }, budget_usd: t.thread.budget_usd, spent_usd: t.thread.spent_usd, addressed: t.thread.about ?? null },
      text: t.deleted ? '' : t.body.text, via: t.body.via, context: t.deleted ? {} : { ...t.body.context }, addressed: t.thread.about ?? null,
      answer_message_id: null, created_at: t.createdAt ?? '', closed_at: t.state === 'open' ? null : (t.closedAt ?? t.events.at(-1)?.at ?? null), turn_spent_usd: done?.turn_spent_usd ?? null,
    }
  }
  /** The caller's own, undeleted turn (the intents routes' turn check, ask_intents.py _turn), or null. */
  ownTurn(op: string): { turnId: string; createdAt: string } | null {
    const t = this.turns.get(`${this.d.principal()}|${op}`)
    return t && !t.deleted ? { turnId: t.turnId, createdAt: t.createdAt ?? new Date().toISOString() } : null
  }
  /** GET /api/ask: the caller's own turns, newest first, limit clamped to 1..200, no cursor (ask.py list). */
  list(limit = 50): import('../missingUi').AskTurnRecord[] {
    const n = Math.max(1, Math.min(200, Math.floor(limit)))
    const me = this.d.principal()
    return [...this.turns.values()].filter((t) => t.principal === me).sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '')).slice(0, n).map((t) => this.record(t))
  }
  /** GET /api/ask/audit (the caller's admin check is the client's): every person's turns, newest first, `before` strict. */
  audit(limit = 100, principal?: string, before?: string): import('../missingUi').AskAuditRow[] {
    const n = Math.max(1, Math.min(200, Math.floor(limit)))
    return [...this.turns.values()]
      .filter((t) => (!principal || t.principal === principal) && (!before || (t.createdAt ?? '') < before))
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .slice(0, n)
      .map((t) => ({ ...this.record(t), principal: t.principal, mind_id: t.thread.mind.id, swarm_id: t.thread.swarm?.id ?? null }))
  }
  /** GET /api/ask/audit/{turn}: 404 not_available for an unknown turn (ask.py audit_turn). */
  auditTurn(turnId: string, after = 0, limit = 100): import('../missingUi').AskAuditTurn {
    const t = [...this.turns.values()].find((x) => x.turnId === turnId)
    if (!t) throw refuse(404, 'not_available', "That isn't available.")
    const rest = t.events.filter((e) => e.seq > after)
    const page = rest.slice(0, Math.max(1, Math.min(100, limit)))
    return { ...this.record(t), principal: t.principal, mind_id: t.thread.mind.id, swarm_id: t.thread.swarm?.id ?? null, events: page.map((e) => ({ ...e })), next_after: page.length ? page[page.length - 1].seq : after, more: rest.length > page.length }
  }
  /** SIM ONLY: invented earlier turns (another person's too) so the history and the audit have something to show. */
  seedHistory(): void {
    if ([...this.turns.values()].some((t) => t.turnId.startsWith('turn_simold'))) return
    const sw = this.d.swarms().find((x) => x.coordinator_id)
    const mind = sw ? this.d.agents().find((a) => a.id === sw.coordinator_id) : undefined
    if (!sw || !mind) return
    const thread: AskThread = { id: 'ses_asksimold', mind: { id: mind.id, name: mind.name }, swarm: { id: sw.id, name: sw.name }, budget_usd: 0.25, spent_usd: 0.031 }
    const old = (n: number, principal: string, text: string, hoursAgo: number, deleted = false, th: AskThread = thread) => {
      const at = new Date(Date.now() - hoursAgo * 3_600_000).toISOString()
      const turn: Turn = {
        op: `op_simold_${n}_xx`, turnId: `turn_simold${n}`, canon: '', thread: th, state: 'done', principal, proposals: new Map(), heard: [], acts: new Set(), results: new Map(), noteIds: new Set(), createdAt: at, closedAt: at, deleted,
        body: { operation_id: `op_simold_${n}_xx`, text: deleted ? '' : text, context: deleted ? { route: '', experience: '' } : { route: '#/tasks', experience: 'classic' }, via: 'typed' },
        events: [
          { type: 'ask', operation_id: `op_simold_${n}_xx`, turn_id: `turn_simold${n}`, principal, seq: 1, at, phase: 'accepted' } as unknown as AskEvent,
          { type: 'ask', operation_id: `op_simold_${n}_xx`, turn_id: `turn_simold${n}`, principal, seq: 2, at, phase: 'answer', text: deleted ? '' : 'Invented answer: two tasks are waiting for review.', message_id: `m_simold${n}` } as unknown as AskEvent,
          { type: 'ask', operation_id: `op_simold_${n}_xx`, turn_id: `turn_simold${n}`, principal, seq: 3, at, phase: 'done', spent_usd: 0.031, turn_spent_usd: 0.004, outcome: 'answered' } as unknown as AskEvent,
        ],
      }
      this.turns.set(`${principal}|${turn.op}`, turn)
    }
    const me = this.d.principal()
    old(1, me, 'Invented: which tasks are waiting on me?', 30)
    old(2, me, '', 52, true, { ...thread, id: 'ses_asksimgone' })
    old(3, 'user:p_rowan', 'Invented: what did the forge swarm finish this week?', 8)
  }

  endThread(id: string): { ended: string } {
    for (const [k, t] of this.threads) if (t.id === id) this.threads.delete(k)
    const se = this.sessionLog.get(id)
    if (se && !se.ended_at) se.ended_at = new Date().toISOString()
    return { ended: id }
  }

  /**
   * SIM ONLY (j0-fixes r1): every Ask thread is a work session with its own room (core/sessions.py, purpose 'ask'), so
   * GET /api/sessions lists them and POST /api/sessions/{id}/end ends one (its words stay). `?simaskthreads=1` seeds
   * INVENTED open threads (two of the person's on one mind, one ended, one of another person's) to show and end.
   */
  private sessionLog = new Map<string, { thread: AskThread; owner: string; created_at: string; ended_at: string | null }>()
  private seededSessions = false
  private seedSessions(): void {
    if (this.seededSessions) return
    this.seededSessions = true
    if (typeof window === 'undefined' || new URLSearchParams(window.location.search).get('simaskthreads') !== '1') return
    const sw = this.d.swarms().find((x) => x.coordinator_id)
    const mind = sw ? this.d.agents().find((a) => a.id === sw.coordinator_id) : undefined
    if (!sw || !mind) return
    const me = this.d.principal()
    const at = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()
    const seed = (id: string, owner: string, hoursAgo: number, spent: number, ended = false) =>
      this.sessionLog.set(id, { thread: { id, mind: { id: mind.id, name: mind.name }, swarm: { id: sw.id, name: sw.name }, budget_usd: 5, spent_usd: spent }, owner, created_at: at(hoursAgo), ended_at: ended ? at(hoursAgo - 0.5) : null })
    seed('ses_asksimopen1', me, 3, 0.06)
    seed('ses_asksimopen2', me, 26, 0)
    seed('ses_asksimdone1', me, 50, 0.12, true)
    seed('ses_asksimothers', 'user:p_rowan', 2, 0.01)
  }
  private sessionOf(id: string): WorkSession | null {
    const se = this.sessionLog.get(id)
    if (!se) return null
    const t = se.thread
    return {
      id, room_id: `r_${id}`, agent_id: t.mind.id, goal_id: null, owner: se.owner, title: 'Ask thread', status: se.ended_at ? 'ended' : 'active',
      budget_usd: t.budget_usd, spent_usd: t.spent_usd, created_at: se.created_at, ended_at: se.ended_at, workspace: null,
      mind: { id: t.mind.id, name: t.mind.name }, goal: null, purpose: 'ask',
    }
  }
  /** GET /api/sessions: the person's own (an admin's list carries everyone's, as on the host). */
  sessions(admin: boolean): WorkSession[] {
    this.seedSessions()
    const me = this.d.principal()
    return [...this.sessionLog.entries()].filter(([, se]) => admin || se.owner === me).map(([id]) => this.sessionOf(id)!)
  }
  /** POST /api/sessions/{id}/end: the owner (or an admin) ends it; its words stay. */
  endSession(id: string, admin: boolean): WorkSession {
    this.seedSessions()
    const se = this.sessionLog.get(id)
    if (!se || (!admin && se.owner !== this.d.principal())) throw refuse(404, 'not_found', 'not found')
    this.endThread(id)
    return this.sessionOf(id)!
  }
  /** The Ask threads' session rooms, as the host lists them in GET /api/rooms (kind session, the host's fixed name). */
  sessionRooms(admin: boolean): Room[] {
    const me = this.d.principal()
    return this.sessions(admin).map((s) => ({
      id: s.room_id, kind: 'session' as const, name: 'Ask thread', topic: `Session with ${s.mind.name}`, owner: s.owner, visibility: 'private' as const, shared_with: [], swarm_id: null,
      seq: 0, created_at: s.created_at, updated_at: s.ended_at ?? s.created_at, settings: { minds_follow: true, turn_cap: 0 },
      members: [{ member: s.owner, role: 'owner', name: s.owner === me ? 'You' : 'Another person (invented)' }, { member: `agent:${s.agent_id}`, role: 'member', name: s.mind.name }], joined: s.owner === me, unread: 0,
    }))
  }

  /** Who answers (the owner's ruling): the coordinator of the addressed mind's swarm, the page's swarm, or the default swarm. */
  private orchestrator(body: AskBody): { mind: Agent; swarm: Swarm; about: Agent | null; actingAs?: { mind_id: string; name: string } } {
    const agents = this.d.agents()
    const swarms = this.d.swarms()
    const addressed = ctxOf(body)?.mind
    const about = addressed ? agents.find((a) => a.id === addressed) ?? null : null
    const swarmId = about ? about.swarm_id : ctxOf(body)?.swarm_id ?? this.settings.swarm_id
    // Platform P2: nothing else decides, so the person's own mind answers (an explicit default still wins)
    const own = !swarmId && this.answer.mind ? agents.find((a) => a.id === this.answer.mind) : undefined
    if (own) {
      const ownSwarm = swarms.find((s) => s.id === own.swarm_id)
      if (ownSwarm) return { mind: own, swarm: ownSwarm, about: null, actingAs: { mind_id: own.id, name: own.name } }
    }
    if (!swarmId) throw refuse(409, 'no_mind', 'no_mind')
    const swarm = swarms.find((s) => s.id === swarmId)
    const mind = swarm?.coordinator_id ? agents.find((a) => a.id === swarm.coordinator_id) : undefined
    if (!swarm || !mind) throw refuse(409, 'no_orchestrator', 'no orchestrator')
    return { mind, swarm, about }
  }

  ask(body: AskBody): AskAccepted {
    const keys = Object.keys(body ?? {})
    if ('kind' in (body ?? {})) throw refuse(400, 'wrong_route', 'requests to admins go to /api/asks')
    if (keys.some((k) => FORBIDDEN.test(k))) throw refuse(400, 'not_allowed', 'authority field')
    if (keys.some((k) => !ALLOWED.includes(k))) throw refuse(400, 'invalid', 'unexpected field')
    // a private app's page (Platform r2 Q6): the context is exactly { private: true }
    const priv = !!body.context && 'private' in body.context
    if (priv && (Object.keys(body.context).length !== 1 || (body.context as { private?: unknown }).private !== true)) throw refuse(400, 'invalid', 'a private context is exactly { private: true }')
    const ctxKeys = Object.keys(body.context ?? {})
    if (ctxKeys.some((k) => FORBIDDEN.test(k))) throw refuse(400, 'not_allowed', 'authority field')
    if (ctxKeys.some((k) => !CONTEXT_KEYS.includes(k)) || Object.keys(ctxOf(body)?.view ?? {}).some((k) => !VIEW_KEYS.includes(k))) throw refuse(400, 'invalid', 'unexpected context field')
    const view = priv ? undefined : ctxOf(body)?.view
    if (!viewNamesOk(view)) throw refuse(400, 'invalid', 'view fields or regions')
    if ((view?.refs ?? []).some((r) => Object.keys(r).some((k) => k !== 'kind' && k !== 'ref'))) throw refuse(400, 'invalid', 'unexpected ref field')
    if (new TextEncoder().encode(JSON.stringify(ctxOf(body)?.view ?? {})).length > 2048) throw refuse(413, 'too_large', 'view')
    if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) throw refuse(400, body.text?.length > 4000 ? 'too_large' : 'invalid', 'text')
    if (!/^[A-Za-z0-9_.:-]{8,120}$/.test(body.operation_id)) throw refuse(400, 'invalid', 'operation_id')
    if (body.memory_notes !== undefined && !notesOk(body.memory_notes)) throw refuse(400, 'invalid', 'memory_notes')
    const canon = JSON.stringify(body)
    const principal = this.d.principal()
    const prior = this.turns.get(`${principal}|${body.operation_id}`)
    if (prior) {
      if (prior.canon !== canon) throw refuse(409, 'operation_conflict', 'operation_conflict')
      return { operation_id: prior.op, turn_id: prior.turnId, thread: { ...prior.thread }, state: 'accepted', ...(this.flags.conductor ? { conductor: SIM_CONDUCTOR } : {}) }
    }
    if (this.answer.next) {
      const reason = this.answer.next
      this.answer = { ...this.answer, next: undefined }
      throw refuse(409, reason, reason)
    }
    const { mind, swarm, about, actingAs } = this.orchestrator(body)
    if (mind.status !== 'awake' && mind.status !== 'starting') throw refuse(409, 'mind_asleep', 'asleep', { mind: { id: mind.id, name: mind.name } })
    // one person's open turn at a time per coordinator (c63a53f); another person's open turn makes it busy
    const othersOpen = [...this.turns.values()].some((x) => x.state === 'open' && x.principal !== principal && x.thread.mind.id === mind.id)
    if (othersOpen || this.busyNext) {
      this.busyNext = false
      throw refuse(409, 'coordinator_busy', 'coordinator_busy')
    }
    const key = `${principal}|${mind.id}`
    let thread = this.threads.get(key)
    if (!thread) {
      thread = { id: `ses_ask${(++this.count).toString(36)}${mind.id.slice(-3)}`, mind: { id: mind.id, name: mind.name }, swarm: { id: swarm.id, name: swarm.name }, budget_usd: this.settings.thread_budget_usd, spent_usd: 0 }
      this.threads.set(key, thread)
      this.sessionLog.set(thread.id, { thread, owner: principal, created_at: new Date().toISOString(), ended_at: null })
    }
    thread.about = about ? { id: about.id, name: about.name } : null
    if (thread.spent_usd >= thread.budget_usd) throw refuse(402, 'spend_limit', 'spend_limit')
    for (const t of this.turns.values()) if (t.thread.id === thread.id && t.state === 'open') throw refuse(409, 'ask_busy', 'ask_busy', { operation_id: t.op })
    const turn: Turn = { op: body.operation_id, turnId: `turn_${Date.now().toString(36)}${this.count++}`, canon, thread, events: [], state: 'open', principal, proposals: new Map(), heard: [], body, acts: new Set(), results: new Map(), noteIds: new Set((body.memory_notes ?? []).flatMap((n) => (typeof n === 'string' ? [] : [n.id]))), createdAt: new Date().toISOString() }
    this.turns.set(`${principal}|${body.operation_id}`, turn)
    turn.actingAs = actingAs
    this.play(turn, body, mind, swarm, about)
    return { operation_id: turn.op, turn_id: turn.turnId, thread: { ...thread }, state: 'accepted', ...(this.flags.conductor ? { conductor: SIM_CONDUCTOR } : {}), ...(actingAs ? { acting_as: actingAs } : {}) }
  }

  /** The recovery read: the turn view and its frames after `after`, at most `limit`, with next_after and more. */
  turn(op: string, after = 0, limit = 100): AskTurnState {
    const t = this.turns.get(`${this.d.principal()}|${op}`)
    if (!t) throw refuse(404, 'not_available', 'no such turn')
    if (t.unreadable) throw refuse(503, 'not_available', 'recovery unavailable (sim)')
    const rest = t.events.filter((e) => e.seq > after)
    const page = rest.slice(0, limit)
    // a taken-over turn reads as the host's recovery view does: refused, reason takeover
    const state = t.takenOver ? 'refused' : t.state === 'open' ? (t.events.some((e) => e.phase === 'thinking') ? 'thinking' : 'accepted') : t.state
    return { operation_id: t.op, turn_id: t.turnId, state, ...(t.takenOver ? { reason: 'takeover' as const } : {}), thread: { ...t.thread }, text: t.body.text, via: t.body.via, events: page.map((e) => ({ ...e })), next_after: page.length ? page[page.length - 1].seq : after, more: rest.length > page.length }
  }

  stop(op: string): { stopped: boolean } {
    const t = this.turns.get(`${this.d.principal()}|${op}`)
    if (!t) throw refuse(404, 'not_available', 'no such turn')
    if (t.state !== 'open') return { stopped: false }
    this.push(t, { phase: 'refused', reason: 'stopped' })
    return { stopped: true }
  }

  /**
   * Words mid-turn. Bound to the turn and its person; at most 20. A closed turn: the words start a fresh request
   * (never dropped). The invented mind visibly adjusts: "back"/"not that" reverts its last move; "stay" stops moves.
   */
  steer(op: string, b: AskSteerBody): AskSteerResult {
    const t = this.turns.get(`${this.d.principal()}|${op}`)
    if (!t) throw refuse(404, 'not_available', 'no such turn')
    if (!/^[A-Za-z0-9_.:-]{4,120}$/.test(b.steer_id) || typeof b.text !== 'string' || !b.text.trim() || b.text.length > 4000 || (b.via !== undefined && b.via !== 'typed' && b.via !== 'voice')) throw refuse(400, 'invalid', 'steer')
    if (t.state !== 'open') {
      // the fresh request is recorded as the steer's words were made (Kimi r3 #1)
      const fresh = this.ask({ ...t.body, operation_id: `${op.slice(0, 80)}:s${b.steer_id.slice(-6)}`, text: b.text, via: b.via ?? 'typed' })
      return { steer_id: b.steer_id, operation_id: fresh.operation_id, turn_id: fresh.turn_id, new_turn: true, thread: fresh.thread }
    }
    if (t.heard.length >= 20) throw refuse(429, 'rate_limited', 'steers')
    t.heard.push(b.text)
    t.tookOver = false // a steer gives the page back to the mind
    this.push(t, { phase: 'steer', steer_id: b.steer_id, text: b.text, at_seq: b.at_seq, via: b.via ?? 'typed' })
    const said = b.text.toLowerCase()
    this.d.later(350, () => this.push(t, { phase: 'thinking', step: `taking in “${b.text.slice(0, 60)}”` }))
    if (/\b(back|not that|undo|wrong|no,? not|go back)\b/.test(said)) {
      const lastMove = [...t.events].reverse().find((e) => e.phase === 'proposal' && (e as { proposal: { kind: string } }).proposal.kind === 'navigate') as { proposal: { id: string; label?: string } } | undefined
      if (lastMove) this.d.later(700, () => this.push(t, { phase: 'revert', target_id: lastMove.proposal.id }))
      this.d.later(900, () => this.push(t, { phase: 'thinking', step: lastMove ? `undid ${lastMove.proposal.label ?? 'that move'}; carrying on` : 'nothing to undo; carrying on' }))
    } else if (/\b(stay|stop moving|don'?t move|hold still)\b/.test(said)) {
      t.stay = true
      this.d.later(700, () => this.push(t, { phase: 'thinking', step: 'staying on this page' }))
    }
    return { steer_id: b.steer_id, operation_id: t.op, turn_id: t.turnId }
  }

  /**
   * A conductor act's result (vocabulary v1 §2, Platform's terms): the turn's owner only (404 otherwise, as for an
   * unknown turn), an act this turn emitted (404 otherwise), once (409 act_result_recorded on a repeat), ≤ 8 KB.
   */
  actResult(op: string, actId: string, b: ActResult): { recorded: true } {
    const t = this.turns.get(`${this.d.principal()}|${op}`)
    if (!t || !t.acts.has(actId)) throw refuse(404, 'not_available', 'no such act')
    if (t.results.has(actId)) throw refuse(409, 'act_result_recorded', 'act_result_recorded')
    if (t.takenOver) throw refuse(409, 'turn_closed', 'turn_closed')
    if (new TextEncoder().encode(JSON.stringify(b ?? {})).length > 8192) throw refuse(413, 'too_large', 'result')
    const keys = Object.keys(b ?? {})
    if (keys.some((k) => !['ok', 'reason', 'view', 'route', 'experience'].includes(k)) || typeof b.ok !== 'boolean' || (b.reason !== undefined && !ACT_REASONS.includes(b.reason)) || !b.view || typeof b.view !== 'object' || Object.keys(b.view).some((k) => !VIEW_KEYS.includes(k)) || typeof b.route !== 'string' || typeof b.experience !== 'string')
      throw refuse(400, 'invalid', 'result')
    t.results.set(actId, b)
    this.tourNext(t, actId, b)
    return { recorded: true }
  }

  /** SIM ONLY (tests): the results the page posted for a turn's acts. */
  actResults(op: string): Map<string, ActResult> {
    return this.turns.get(`${this.d.principal()}|${op}`)?.results ?? new Map()
  }

  /**
   * As the host's takeover route (Platform 07bf554): the owner's conductor turn only (404 not_available otherwise,
   * and for every turn while the conductor is off). An open turn ends: one done frame {outcome: cancelled,
   * taken_over: true}, and later act results are 409 turn_closed. A turn already ended answers its own state.
   */
  takeover(op: string): import('../ask').AskTakeover {
    const t = this.turns.get(`${this.d.principal()}|${op}`)
    if (!t || !this.flags.conductor) throw refuse(404, 'not_available', 'no such turn')
    t.tookOver = true
    if (t.state === 'open') {
      t.takenOver = true
      t.closedAt = new Date().toISOString()
      this.push(t, { phase: 'done', outcome: 'cancelled', taken_over: true, spent_usd: t.thread.spent_usd, turn_spent_usd: 0 })
    }
    return { operation_id: t.op, turn_id: t.turnId, state: (t.takenOver ? 'taken_over' : t.state) as import('../ask').AskTakeover['state'], ended_at: t.closedAt ?? t.events.at(-1)?.at ?? '' }
  }

  confirm(op: string, pid: string, digest: string): { ok: boolean; outcome?: string } {
    const t = this.turns.get(`${this.d.principal()}|${op}`)
    const want = t?.proposals.get(pid)
    if (!t || !want) throw refuse(404, 'not_available', 'no such proposal')
    if (want !== digest) throw refuse(409, 'invalid', 'digest')
    t.proposals.delete(pid)
    return { ok: true, outcome: 'Saved in Design (simulated).' }
  }

  /** The person kept a look: the host writes ui_prefs_history and says so on the turn that proposed it. */
  uiChanged(before: unknown, after: unknown): void {
    const principal = this.d.principal()
    const t = [...this.turns.values()].reverse().find((x) => x.principal === principal && x.uiProposal)
    if (!t) return
    t.uiProposal = undefined
    this.push(t, { phase: 'ui-change', prefs_before: before, prefs_after: after, undo: { history_id: `uih_${Date.now().toString(36)}` } }, true)
  }

  // ---------------------------------------------------------------- the invented mind

  private push(t: Turn, f: Record<string, unknown>, afterClose = false, drop = false) {
    if (t.state !== 'open' && !afterClose) return
    // after the person took over, the host sends no more moves of the page
    if ((t.tookOver || t.stay) && ((f.phase === 'proposal' && (f.proposal as { kind?: string }).kind === 'navigate') || (f.phase === 'presence' && f.verb === 'go'))) return
    if (f.phase === 'act') t.acts.add((f.act as { act_id: string }).act_id)
    const e = { type: 'ask', operation_id: t.op, turn_id: t.turnId, principal: t.principal, seq: t.events.length + 1, at: new Date().toISOString(), ...f } as unknown as AskEvent
    // a memory frame's stored copy carries only its op and digest (the host's live-only rule): the item is never read back
    t.events.push(f.phase === 'memory' ? ({ ...e, item: undefined, target_id: undefined } as AskEvent) : e)
    if (f.phase === 'done') t.state = 'done'
    if (f.phase === 'refused') t.state = 'refused'
    if (!drop) this.d.emit(e)
  }

  /** The conductor's result loop for a guided demo: the next tour.step only after the page showed this one. */
  private tourNext(t: Turn, actId: string, b: ActResult) {
    const tour = t.tour
    if (!tour || tour.act !== actId || t.state !== 'open') return
    const stop = (why: string) => {
      t.tour = undefined
      tour.finish(`I stopped guiding ${tour.title} at step ${tour.step + 1} of ${tour.total}: ${why}. Ask me to carry on whenever you like.`)
    }
    if (!b.ok) return stop(b.reason === 'stale_origin' ? 'you took over' : b.reason === 'not_declared' ? 'that step is not on this hive' : 'the page could not show it')
    if (tour.step + 1 >= tour.total) {
      t.tour = undefined
      return tour.finish(`That was ${tour.title}, in ${plural(tour.total, 'step')}. Ask me about any of them, or say “show me how … works” for another.`)
    }
    this.d.later(Math.min(7000, tour.dwell[tour.step]), () => {
      if (t.tour !== tour || t.state !== 'open') return
      if (t.tookOver) return stop('you took over')
      tour.step += 1
      tour.act = `act_${t.turnId.slice(-5)}_tour${tour.step}`
      this.push(t, { phase: 'act', act: { act_id: tour.act, kind: 'tour.step', script: tour.script, step: tour.step } })
    })
  }

  /** SIM: what the invented conductor would remember from these words (each a live frame; "lose a memory" drops it). */
  private memories(t: Turn, body: AskBody): [Record<string, unknown>, boolean][] {
    const said = body.text
    const lose = /\blose a memory\b/i.test(said)
    const out: [Record<string, unknown>, boolean][] = []
    const frame = (statement: string, kind: string, confidence: number, revises?: string) => {
      const item = { statement: statement.replace(/\s+/g, ' ').trim().slice(0, 500), kind, truth: { frequency: 1, confidence } }
      const target = revises && t.noteIds.has(revises) ? revises : null
      out.push([{ phase: 'memory', op: target ? 'revise' : 'remember', item, target_id: target, digest: digestOf(JSON.stringify({ ...item, target_id: target })) }, lose])
    }
    const name = /\bcall me ([\p{L}][\p{L}'-]{0,40})/iu.exec(said)
    if (name) frame(`Call them ${name[1]}`, 'name', 0.9)
    const pref = /\bi (?:prefer|like|want) ([^.!?]{2,120})/i.exec(said)
    if (pref) frame(`Prefers ${pref[1].trim()}`, 'preference', 0.8)
    const meant = /\bno,? i meant ([^.!?]{2,120})/i.exec(said)
    if (meant) {
      // a correction revises the note it corrects when this turn carried one about the same thing
      const words = new Set(meant[1].toLowerCase().match(/[a-z0-9]+/g) ?? [])
      const hit = (body.memory_notes ?? []).find((n) => typeof n !== 'string' && (n.text.toLowerCase().match(/[a-z0-9]+/g) ?? []).some((w) => w.length > 3 && words.has(w)))
      frame(`Meant ${meant[1].trim()}`, 'correction', 0.85, hit && typeof hit !== 'string' ? hit.id : undefined)
    }
    return out.slice(0, 8)
  }

  private play(t: Turn, body: AskBody, mind: Agent, swarm: Swarm, about: Agent | null) {
    const text = body.text.toLowerCase()
    const actor: AskWho = { id: mind.id, name: mind.name }
    const steps: [number, Record<string, unknown>, boolean?][] = []
    const place = ctxOf(body)?.view?.summary?.split(':')[0] || ctxOf(body)?.route || 'the hive'
    const lose = /\blose a step\b/.test(text)
    if (lose) t.unreadable = true
    const dropOne = lose || this.count % 3 === 0
    steps.push([90, { phase: 'accepted', thread: { ...t.thread }, ...(t.actingAs ? { acting_as: t.actingAs } : {}) }])
    steps.push([380, { phase: 'thinking', step: `reading ${place}` }])
    steps.push([520, { phase: 'thinking', step: about ? `asking ${about.name}` : `checking ${swarm.name}` }, dropOne])

    const goals = this.d.goals().filter((g) => g.swarm_id === swarm.id && g.status !== 'done')
    const awake = this.d.agents().filter((a) => a.swarm_id === swarm.id && a.status === 'awake').length
    let answer: string
    const extra: [number, Record<string, unknown>][] = []
    // "show me how attention works": a ready guided demo the conductor drives with tour.step acts
    const gi = guidedIntent(body.text)
    const guided = !lose && gi?.kind === 'script' && gi.script.status === 'ready' ? simTour(gi.script) : null

    if (lose) {
      // a move right after the lost step: the page must hold it, not apply it
      const id = `p_lose${t.turnId.slice(-4)}`
      const digest = digestOf(`${id}|usage`)
      t.proposals.set(id, digest)
      extra.push([300, { phase: 'proposal', proposal: { id, kind: 'navigate', route: '#/usage', digest, label: 'Usage' } }])
      answer = 'A step of this answer was lost on the way and cannot be read back; I meant to open Usage.'
    } else if (ctxOf(body)?.program === 'omegadesign' && !ctxOf(body)?.view?.refs?.length && /\b(make|poster|card|invitation|announcement|flyer|design)\b/.test(text)) {
      // Surface, Design living canvas (sim only): asked to make something on an empty canvas, it opens a first draft
      const id = `p_design${t.turnId.slice(-4)}`
      const route = href({ name: 'program', id: 'omegadesign', swarm: swarm.id, source: designStarter() })
      const digest = digestOf(`${id}|${route}`)
      t.proposals.set(id, digest)
      extra.push([400, { phase: 'presence', actor, verb: 'look', target: { region: 'page' }, caption: 'Starting a first draft' }])
      extra.push([500, { phase: 'proposal', proposal: { id, kind: 'navigate', route, digest, label: 'First draft' } }])
      answer = 'Here is a first draft to start from: a lantern-walk poster with three directions to compare. Point at anything to change it, or tell me what to change. (Simulated: drawing it live arrives with the next piece.)'
    } else if (ctxOf(body)?.view?.fields?.some((f) => f.id === 'lab.pc.question') && (/\br\s?\d+\b/.test(text) || /\b(fail\w*|negative\w*|went wrong|didn.?t work)\b/.test(text))) {
      // SIM ONLY, Surface lab-pc-band: a stand-in for the live conductor. Only a real report intent (a report id like
      // "R10", or fail/negative phrasing) fills the Lab's declared field, with the words as written; the page decides
      // what they mean (it opens a report or says why not). Nothing is run or sent.
      extra.push([350, { phase: 'act', act: { act_id: `act_${t.turnId.slice(-5)}_pc`, kind: 'fill', field: 'lab.pc.question', text: body.text.slice(0, 200) } }])
      answer = '(Simulated conductor.) I put your words into the research reports on this page; it opens the report you named, as reported.'
    } else if (guided) {
      // Surface, guided demos through the conductor (sim only): one tour.step per step, each after the page's result
      const first = `act_${t.turnId.slice(-5)}_tour0`
      t.tour = { script: guided.id, total: guided.steps.length, dwell: guided.steps.map((s) => dwellMs(s.say)), step: 0, act: first, title: guided.title, finish: () => undefined }
      extra.push([300, { phase: 'answer', delta: true, text: `I’ll guide you through ${guided.title}, step by step. ` }])
      extra.push([350, { phase: 'act', act: { act_id: first, kind: 'tour.step', script: guided.id, step: 0 } }])
      answer = ''
    } else if (/\bshow me around motivations\b/.test(text)) {
      // Surface, the conductor's demo (sim only): open search, mark it, type the words (nothing runs), say so.
      // TODO(conductor: declare-motivations-field): once surface/motivations merges, open the Motivations page,
      // highlight where a new motivation starts and fill its declared field instead of search.
      const act = (n: number, a: Record<string, unknown>) => ({ phase: 'act', act: { act_id: `act_${t.turnId.slice(-5)}_${n}`, ...a } })
      extra.push([350, act(1, { kind: 'open', feature: 'hive.search', label: 'Search' })])
      extra.push([900, act(2, { kind: 'highlight', target: { region: 'search' }, caption: 'Search starts here' })])
      extra.push([1100, act(3, { kind: 'fill', field: 'palette.search', text: 'motivations' })])
      answer = 'Motivations are why the work exists; the tasks under them are the work. I opened search and typed “motivations” for you. Nothing opens until you pick a result.'
      // the words stream in pieces before the whole answer arrives
      extra.push([500, { phase: 'answer', delta: true, text: 'Motivations are why the work exists; ' }])
      extra.push([180, { phase: 'answer', delta: true, text: 'the tasks under them are the work. ' }])
      extra.push([180, { phase: 'answer', delta: true, text: 'I opened search…' }])
    } else if (/\b(drive the page for me|take the wheel)\b/.test(text)) {
      // Surface demo D2 (sim only): the conductor's acts one by one, slowly enough to take over part way:
      // navigate, point, open, highlight and fill (nothing is sent; the person decides)
      const act = (n: number, a: Record<string, unknown>) => ({ phase: 'act', act: { act_id: `act_${t.turnId.slice(-5)}_d${n}`, ...a } })
      extra.push([400, { phase: 'answer', delta: true, text: 'Watch the page: I will move it step by step. ' }])
      extra.push([500, act(1, { kind: 'navigate', route: '#/swarms', label: 'Swarms' })])
      extra.push([1600, act(2, { kind: 'point', target: { region: 'page' }, caption: 'Your swarms live here' })])
      extra.push([1700, act(3, { kind: 'open', feature: 'hive.search', label: 'Search' })])
      extra.push([1300, act(4, { kind: 'fill', field: 'palette.search', text: 'Kelp' })])
      extra.push([1100, act(5, { kind: 'highlight', target: { region: 'search' }, caption: 'Search starts here' })])
      extra.push([900, { phase: 'answer', delta: true, text: 'Opened Swarms, pointed at them, opened search and typed “Kelp”. ' }])
      answer = 'That was the conductor: I opened Swarms, pointed at them, opened search, typed “Kelp” and marked where search starts. Nothing runs until you choose a result. Click or scroll the page while I work and you take over.'
    } else if (/\bopen (?:omega )?tools (?:here|in [\p{L}][\p{L} -]{0,40})\b/u.test(text)) {
      // Surface, conductor-live (sim only): a move into an app this swarm may refuse (?refuse=omega-tools@<swarm>);
      // demo D2: "open tools in Kelp" names the swarm (demo mode refuses Omega Tools in Kelp)
      const named = /\bopen (?:omega )?tools in ([\p{L}][\p{L} -]{0,40})/u.exec(text)?.[1]?.trim()
      const where = (named ? this.d.swarms().find((x) => !x.archived_at && (x.name.toLowerCase() === named || x.name.toLowerCase().startsWith(`${named} `))) : undefined) ?? swarm
      extra.push([350, { phase: 'act', act: { act_id: `act_${t.turnId.slice(-5)}_app`, kind: 'navigate', route: href({ name: 'program', id: 'omega-tools', swarm: where.id }), label: 'Omega Tools' } }])
      answer = where.id === swarm.id ? 'I tried to open Omega Tools here.' : `I tried to open Omega Tools in ${where.name}.`
    } else if (/\bhand (this|it) to code\b/.test(text)) {
      extra.push([400, { phase: 'dispatched', intent_id: `int_${t.turnId.slice(-6)}`, intent_kind: 'code.task', to: { kind: 'service', ref: 'svc_code', name: 'Code' }, label: body.text.slice(0, 120).replace(/[<>]/g, '') }])
      answer = 'I handed it to Code. Its progress shows on the task.'
    } else if (/\b(tour|show me around|walk me through)\b/.test(text)) {
      // five moves, alternating instant and animated (the owner, 2026-10-05: as often as it chooses, animated if it wants)
      const stops: [string, string, string][] = [['#/goals', 'Tasks', 'work.goals'], ['#/usage', 'Usage', 'money.usage'], ['#/swarms', 'Swarms', 'swarms.see'], ['#/approvals', 'Decisions', 'decide.approvals'], ['#/health', 'Health', 'watch.health']]
      const animated = /\banimat|fancy|smooth/.test(text)
      stops.forEach(([route, label, feature], i) => {
        const id = `p_tour${i}${t.turnId.slice(-4)}`
        const digest = digestOf(`${id}|${route}`)
        t.proposals.set(id, digest)
        extra.push([i ? 1100 : 400, { phase: 'proposal', proposal: { id, kind: 'navigate', route, digest, label, animate: animated && i % 2 === 0 } }])
        extra.push([250, { phase: 'presence', actor, verb: 'point', target: { feature }, caption: `${label}: stop ${i + 1} of 5` }])
      })
      answer = `That was the tour: Tasks, Usage, Swarms, Decisions and Health. ${swarm.name} has ${goals.length} open task${goals.length === 1 ? '' : 's'}; ask me about any stop.`
    } else if (/\b(warmer|cosier|cozier|different look|new look|redesign|nicer look|change the colou?rs?)\b/.test(text)) {
      const id = `p_ui${t.turnId.slice(-4)}`
      const digest = digestOf(`${id}|ember-forge`)
      t.proposals.set(id, digest)
      t.uiProposal = id
      extra.push([500, { phase: 'proposal', proposal: { id, kind: 'ui', prefs: { variant: 'ember-forge' }, digest, label: 'Ember Forge' } }])
      answer = 'Try Ember Forge: warm charcoal and amber, with navigation across the top. It is showing now as a preview; keep it if you like it.'
    } else if (/\b(cost|costs|spend|spent|spending|money|budget)\b/.test(text)) {
      const id = `p_nav${t.turnId.slice(-4)}`
      const digest = digestOf(`${id}|usage`)
      t.proposals.set(id, digest)
      extra.push([420, { phase: 'presence', actor, verb: 'go', target: { feature: 'money.usage' }, caption: 'Opening Usage' }])
      extra.push([300, { phase: 'proposal', proposal: { id, kind: 'navigate', route: '#/usage', digest, label: 'Usage' } }])
      extra.push([700, { phase: 'presence', actor, verb: 'sketch', target: { region: 'page' }, caption: 'This month so far', ink: { shape: 'underline' } }])
      answer = `${swarm.name} spends mostly on its awake minds; Usage shows it by day and by mind. I opened it for you.`
    } else if (/\b(note|save this|remember this)\b/.test(text)) {
      const id = `p_act${t.turnId.slice(-4)}`
      const params = { text: body.text.replace(/^.*?\b(note|save this|remember this)\b[:\s]*/i, '').slice(0, 200) || body.text.slice(0, 200) }
      const digest = digestOf(`${id}|omegadesign|save_note|${JSON.stringify(params)}`)
      t.proposals.set(id, digest)
      extra.push([600, { phase: 'action-needs-confirm', proposal: { id, kind: 'app_act', program: 'omegadesign', action: 'save_note', items: [], params, digest, label: 'Save a note in Design' } }])
      answer = 'I can save that as a note in Design. It needs your yes first; nothing is saved until you confirm.'
    } else if (/\b(point|where is|where are|which one|show me where)\b/.test(text)) {
      const feature = /approval|decision/.test(text) ? 'decide.approvals' : 'work.goals'
      extra.push([400, { phase: 'presence', actor, verb: 'point', target: { feature }, caption: feature === 'work.goals' ? 'Tasks live here' : 'Decisions wait here' }])
      extra.push([600, { phase: 'presence', actor, verb: 'sketch', target: { feature }, caption: 'Here', ink: { shape: 'circle' } }])
      answer = feature === 'work.goals' ? `Tasks are one click away: the circled item. ${swarm.name} has ${goals.length} open.` : 'Decisions waiting on you are in the circled item.'
    } else {
      if (about) extra.push([350, { phase: 'presence', actor, verb: 'look', target: { entity: { kind: 'mind', ref: about.id } }, caption: `Looking at ${about.name}` }])
      answer = about
        ? `${about.name} is ${about.status} in ${swarm.name}. As its coordinator I can pass that on; ${goals.length ? `it shares ${goals.length} open task${goals.length === 1 ? '' : 's'} with the swarm` : 'the swarm has no open tasks right now'}.`
        : `I coordinate ${swarm.name}: ${awake} mind${awake === 1 ? ' is' : 's are'} awake and ${goals.length} task${goals.length === 1 ? ' is' : 's are'} open. You asked from ${place}; tell me what you want changed and I will propose it.`
    }
    // SIM: the conductor's `remember` (memory kept by the person's browser): "call me …", "I prefer …", "no, I meant …"
    // a hive without memory (or without the conductor) sends no memory frames
    const memories = this.flags.memory || this.stray ? this.memories(t, body) : []
    // demo mode: the first answer to a person whose browser sent no notes teaches the INVENTED notes (once a session)
    if (this.flags.memory && this.seedNotes.length && !this.taught.has(t.principal) && !(body.memory_notes ?? []).length) {
      this.taught.add(t.principal)
      for (const n of this.seedNotes) {
        const item = { statement: n.statement, kind: n.kind, truth: { frequency: 1, confidence: n.confidence } }
        memories.push([{ phase: 'memory', op: 'remember', item, target_id: null, digest: digestOf(JSON.stringify({ ...item, target_id: null })) }, false])
      }
    }
    if (memories.length) {
      for (const [m, lose] of memories) steps.push([260, m, lose])
      answer = `${answer} I will remember that${memories.length > 1 ? ' too' : ''}; it is kept in your browser, not on the hive.`
    }
    // SIM (spend-stop r1): "hit the spending limit" ends the turn at the thread's limit, as the host's spend_cap does
    // ($0.23 of $0.25: the next call would not fit), so the stop's New thread and raise can be tried
    // j0-fixes r1: the done frame names the limit, as ask-limits r1's host does (done.limit); "hit the mind limit" plays
    // the mind's own limit instead, and ?simlimit=absent plays today's host (no `limit` on the frame)
    const capHit = /\b(hit|reach) the (mind |swarm )?(spending )?limit\b/.test(text)
    const capKind = /\bthe mind (spending )?limit\b/.test(text) ? 'mind_total' : /\bthe swarm (spending )?limit\b/.test(text) ? 'swarm' : 'thread'
    const limitAbsent = typeof window !== 'undefined' && new URLSearchParams(window.location?.search ?? '').get('simlimit') === 'absent'
    const spend = capHit && capKind !== 'thread' ? 0 : capHit ? Math.max(0, Math.round((t.thread.budget_usd - 0.02 - t.thread.spent_usd) * 1000) / 1000) : Math.round((0.008 + (body.text.length % 7) * 0.002) * 1000) / 1000
    if (capHit) answer = 'I started on that, then stopped before the next step.'
    let at = 0
    const ending: [number, Record<string, unknown>][] = [[650, { phase: 'answer', text: answer, message_id: `m_ask${t.turnId.slice(-5)}` }], [220, { phase: 'done', spent_usd: 0, turn_spent_usd: spend, outcome: capHit ? 'spend_cap' : 'complete', ...(capHit && !limitAbsent ? { limit: capKind === 'thread' ? { kind: 'thread', current_usd: Math.round((t.thread.spent_usd + spend) * 1000) / 1000, limit_usd: t.thread.budget_usd, estimate_usd: 0.03 } : { kind: capKind, current_usd: capKind === 'swarm' ? 45.66 : 3.89, limit_usd: capKind === 'swarm' ? 45.66 : 3.92, estimate_usd: 0.25 } } : {}) }]]
    const send = (f: Record<string, unknown>, drop?: boolean) => {
      let frame = f
      if (frame.phase === 'answer' && t.heard.length) frame = { ...frame, text: `${String(frame.text)} You told me: “${t.heard.join('”, then “')}”; I took that in as I went.` }
      if (frame.phase === 'done') {
        t.thread.spent_usd = Math.round((t.thread.spent_usd + spend) * 1000) / 1000
        frame = { ...frame, spent_usd: t.thread.spent_usd }
      }
      this.push(t, frame, false, drop)
    }
    // a guided demo's answer and done wait for its last step (the result loop calls finish)
    if (t.tour) {
      t.tour.finish = (text: string) => {
        let after = 0
        for (const [ms, f] of ending) {
          after += ms
          this.d.later(after, () => send(f.phase === 'answer' ? { ...f, text } : f))
        }
      }
    }
    // a hive whose conductor is off sends no acts (and so no guided demo waits on them)
    if (!this.flags.conductor && t.tour) t.tour = undefined
    const playable = this.flags.conductor ? extra : extra.filter(([, f]) => f.phase !== 'act')
    const all: [number, Record<string, unknown>, boolean?][] = [...steps, ...playable, ...(t.tour ? [] : ending)]
    for (const [ms, f, drop] of all) {
      at += ms
      this.d.later(at, () => send(f, drop))
    }
  }
}
