import { cachedLook, SEED_VARIANTS, type UiPrefs, type UiPrefsResponse, type UiPrefsWriteOptions } from '../../shell/uiVariant'
import type { Board, Matches, Scope } from '../../features/boards/types'
import { ApiError, Emitter, type CodeContext, type ConnectionState, type HiveClient, type Invite, type Me, type Person, type SimCodeFixture, type SwarmCounts, type SwarmDeletePreview, type SwarmDeleteResult } from '../client'
import { SimCodeService, SIM_CODE_REPOSITORY, SIM_CODE_TARGET, SIM_UNREGISTERED_REPOSITORY, SIM_UNREGISTERED_TARGET, simClosedReason, simRepositoryUnregistered, type SimStaleSession } from './codeService'
import type { SuggestionCreateRequest, SuggestionDecisionRequest, SuggestionScopeRequest } from '../../features/code/suggestions/contract'
import type { Target } from '../../features/code/CodePage'
import type { BudgetRow } from '../../features/usage/Limits'
import type {
  CollabRequest,
  GoalGrant,
  Agent,
  AgentAction,
  Approval,
  ApprovalStatus,
  Assertion,
  AssertionOutcome,
  Belief,
  BeliefDetail,
  CreateAgentBody,
  CreatedAgent,
  CreateGoalBody,
  CreatePolicyBody,
  CreateSwarmBody,
  CreateWakeupBody,
  GateDecision,
  Goal,
  GoalReview,
  HealthIssue,
  HealthOverview,
  HiveEvent,
  HiveInfo,
  MemoryAtom,
  MemorySpace,
  Message,
  MindHealth,
  PatchAgentBody,
  PatchGoalBody,
  PatchWakeupBody,
  PolicyRule,
  ProgramActBody,
  ProgramViewBody,
  ProviderStatus,
  KeyInfo,
  Role,
  Swarm,
  ThinkingPhase,
  Trace,
  TraceCommand,
  TruthValue,
  Usage,
  Wakeup,
} from '../types'
import { cronError, isValidTz, nextRun } from '../../lib/cron'
import { commandSkill, resolvePolicy, skillRisk } from '../../lib/policy'
import { LOG_TEMPLATES, NAME_IDEAS, SEED_AGENTS, SEED_BUDGETS, SEED_HEALTH, SEED_INVITES, SEED_PEOPLE, SEED_ROLES, SEED_SWARMS, SEED_TEAMS, SIM_CATALOG, SIM_CODE_TARGETS, SIM_MODELS, SKILLS, type SeedAgent } from './data'
import { SimAgreements } from './agreements'
import { SimLab, type LabRecord } from './lab'
import { SimPrograms } from './programs'
import { SimConfirmTokens, withEffectiveConfirm, type SimSession } from './confirmTokens'
import { SimUpdates } from './updates'
import { adminOnly, SimMissingUi } from './missingUi'
import { SimMoneyWork } from './moneyWork'
import { cancelRequests, requestPage, requestView, type SimRequestRow } from './requests'
import { SimDrafts } from './drafts'
import { SimAsk } from './ask' // Surface universal Ask (sim only)
import { SimIntents, SIM_CODE_TEAM } from './intents'
import { chooseCodeTeam } from '../askIntents' // the Ask's linkage intents (sim only)
import { SimMinds } from './minds'
import { SimPower } from './power' // Surface: hive power (Off, Quiet and Wake all), sim only
import { SimRooms } from './rooms' // Surface: rooms and the Coffee Room (sim only)
import { DEMO_CLEANUP_OWED, DEMO_MEMORY_NOTES, DEMO_SWARMS } from './demo' // Surface demo D2: demo mode's defaults (INVENTED)
import { DEMO_SLEEP_RULES, DEMO_SPEND_CAP, DEMO_STUDIO, DEMO_SWARM_WORDS } from './demo3' // Surface demo D3: Studio, Tools, Lab and Health (INVENTED)
import { SIM_STUDIO_FILES } from './studioFrame' // Surface demo D3: the Studio stand-in's own interface (INVENTED)
import { SimMotivations } from './motivations' // Surface: Motivations above Tasks (host phase 1 contract, sim)
import { seedScale, type ScaleShape } from './scale' // Surface hive scale: ?simscale= (INVENTED)
import { SimIdleMinds, simHostFlags } from './idleMinds' // Surface: Health's idle minds (sim only, invented)
import { SimPersonalMind } from './personalMind' // Surface: the demo person's personal mind (sim only, invented)
import { CommonsEngineError, SimCommons, STRUCTURAL, statementOf, type CommonsState, type Integration } from './commons' // the commons on the real MeTTa engine
import commonsSource from './commons.ts?raw'
import { MIND_SOURCES } from '../../lib/mindSpace/sources'
import { sha256 } from '../../lib/askMemory/hash'
import { SimStudioHost } from './studioSessions'
import { generateReply, PEER_LINES, PEER_REPLIES } from './replies'
import {
  COMMON_CMDS,
  EPISODES,
  GOAL_FAILS,
  GOAL_IDEAS,
  GOAL_RESULTS,
  GOAL_WAITS,
  hashStr,
  HUMAN_ONLY_ATTEMPTS,
  SEED_APPROVALS,
  SEED_GOALS,
  SEED_RULES,
  SEED_WAKEUPS,
  SUBGOAL_SPLITS,
  SWARM_CMDS,
  THOUGHTS,
  type CmdTemplate,
} from './phase2'

export interface SimOptions {
  seed?: number
  /** SIM ONLY (J3 r4.3 O3): ?studiomonthly=missing and ?studiomonth=rollover for the live Studio session host */
  studio?: { monthlyMissing?: boolean; rollover?: boolean; hold?: boolean; role?: boolean; stopFail?: number; consentDrift?: boolean; fenced?: boolean; keyNone?: boolean; makerKind?: string; piecesNone?: boolean; unbindable?: boolean }
  /** Start the living loop on connect(). Default true. */
  autoStart?: boolean
  /** Multiplier on the event rate. */
  speed?: number
  /** Simulate network latency on REST calls. Default true. */
  latency?: boolean
  /** Days of usage history to synthesise. */
  historyDays?: number
  /** Extra generated minds on top of the seeded cast (stress testing). */
  extraDots?: number
  /** Lab: load a recording other than the bundled fixture (tests). */
  labRecord?: () => Promise<LabRecord>
  /** Lab: longest a replay may take (ms). */
  labReplayMs?: number
  /**
   * Code suggestions (invented repository): 'mind' (default) adds the sim-only invented mind; 'person' plays the live
   * client (relayed routes, no route to a mind); 'unrelayed' plays a hive that does not relay the Workbench routes.
   */
  codeMode?: 'mind' | 'person' | 'unrelayed'
  /** SIM: the hive's Ask switches (?askflags=conductor,memory,takeover; 'none' for all off). Default: conductor+memory. */
  askFlags?: import('../ask').AskCapabilities
  /** SIM: apps a swarm refuses, as "app@swarm" (?refuse=omega-tools@s_lyra). */
  refuse?: string[]
  /** SIM: apps whose views answer only after 6 s (?slowapp=omega-tools): a read that does not settle in time. */
  slowApps?: string[]
  /** SIM: a host that sends memory frames even with memory off (?askflags=…,strayframes): late or stray frames. */
  strayMemoryFrames?: boolean
  /**
   * Reasoning viewers: 'invented' installs the INVENTED reasoning-module read (api/sim/reasoningFixture; not evidence of
   * real state). Absent: the catalogue declares no such read, as on every hive today ("no reader yet").
   */
  reasoning?: 'invented'
  /** SIM: apps loaded only when the URL asks (?sim=1&pcreports=fixture|fail: api/sim/evolvePc, Code's PC payloads). */
  extraApps?: (() => import('./programs').SimProgram)[]
  /** SIM: figure bytes by read URL for the URL-opted PC fixture (lab-figures r1) */
  figureSource?: (readUrl: string) => Uint8Array | null
  /** SIM: the demo person's personal mind (?mind=on|null|absent|person, ?mindversions=1): api/sim/personalMind */
  personalMind?: import('./personalMind').SimMindOptions
  /** SIM: who answers when nothing decides it (?askanswer=nodefault,one,mind|mindasleep,next-no_mind): SimAsk.setAnswerFixture */
  askAnswer?: { nodefault?: boolean; one?: boolean; mind?: 'awake' | 'asleep'; next?: string }
  /**
   * The host's copy-apply switch for the invented code service (HIVE_COPY_APPLY_CLAIMS). Off by default, as on every
   * hive until Platform's consent gate lands (vibe r4: the person accepts). The page address `?simcopyapply=on` plays a
   * host whose controller puts a proposal into the copy by itself, which the canvas labels as done without your OK.
   */
  codeCopyApply?: boolean
  /**
   * SIM: plain demo mode (?sim=1, the demo build; api/sim/demo.ts): team rooms that talk, the Ask's first answer teaching
   * a few invented notes, and the extra swarm-delete swarms. Off for tests and other harnesses.
   */
  demo?: boolean
  /** SIM: who the visitor is at the start ('person' is Ada, INVENTED). Default: ?simrole=person, else the operator. */
  persona?: 'operator' | 'person'
  /** SIM: top the invented hive up to this scale (?simscale=cloud|big|<swarms>x<minds>; api/sim/scale.ts). */
  scale?: ScaleShape
}

type Voice = SeedAgent['voice']

/** mulberry32: tiny deterministic PRNG so tests and screenshots are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clone = <T,>(v: T): T => structuredClone(v)
const iso = (ms: number) => new Date(ms).toISOString()
const clamp01 = (n: number) => Math.min(1, Math.max(0, n))
/** an invented confidence, kept where the commons accepts one (0 < c < 1; the engine caps revised ones at 0.99) */
const clampC = (n: number) => Math.min(0.99, Math.max(0.01, n))
/** invented inputs are drawn to 3 places (data, not truth maths: every truth value the commons holds is the engine's) */
const round3 = (n: number) => Math.round(n * 1000) / 1000
const LEASE_MINUTES = 60
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789'

/** One step of the commons' seed (SimClient.seed): the inputs only; the engine computes everything else. */
type SeedStep =
  | { step: 'rules'; swarm: string; members: string[]; vocab: string[] }
  | { step: 'assert'; swarm: string; agent: string; statement: string; tv: TruthValue; stamp: string[]; at: string }
  | { step: 'conflict' | 'outsider'; swarm: string; agent: string; ev: string; at: string }

/**
 * The seed cache: within one process (a test worker, a page), a seed program the engine has already run is not run
 * again; its result, the engine's own state (exportState) and what the sim read from it, is loaded into a NEW engine
 * and new maps. Keyed by the program itself (so by the seed and every option that shapes it) and the sha256 of
 * lib_nal, lib_pln, lib_hive and this adapter's source. Stored and handed out as deep copies: nothing is shared.
 */
const SEED_CACHE = new Map<string, { ats: (string | null)[]; state: CommonsState; beliefs: [string, [string, BeliefDetail][]][]; published: { swarm_id: string; assertion: Assertion; unmapped?: string[] }[] }>()
const SEED_CACHE_STATS = { hits: 0, misses: 0 }
let codeHash: string | null = null
/** The cache key: the program and the code that runs it. */
export function seedKey(program: unknown, code: { libs: readonly (readonly [string, string])[]; adapter: string } = { libs: MIND_SOURCES, adapter: commonsSource }): string {
  const fixed = code.libs === MIND_SOURCES && code.adapter === commonsSource
  const hash = fixed && codeHash ? codeHash : sha256(JSON.stringify([code.libs.filter(([n]) => n !== 'lib_mind').map(([n, src]) => [n, sha256(src)]), sha256(code.adapter)]))
  if (fixed) codeHash = hash
  return sha256(`${hash}\n${JSON.stringify(program)}`)
}
/** SIM / tests: the seed cache's counters, and a way to empty it. */
export const simSeedCache = {
  stats: () => ({ ...SEED_CACHE_STATS, size: SEED_CACHE.size }),
  clear: () => {
    SEED_CACHE.clear()
    SEED_CACHE_STATS.hits = 0
    SEED_CACHE_STATS.misses = 0
  },
}

/**
 * An in-browser hive. Holds the full server state in memory, answers the REST surface
 * with plausible latency and emits a believable stream of live events.
 */
export class SimClient implements HiveClient {
  readonly mode = 'sim' as const
  readonly rng: () => number
  private opts: Required<Omit<SimOptions, 'studio' | 'labRecord' | 'labReplayMs' | 'askFlags' | 'refuse' | 'slowApps' | 'strayMemoryFrames' | 'reasoning' | 'personalMind' | 'askAnswer' | 'demo' | 'persona' | 'scale' | 'extraApps' | 'figureSource'>>
  /** SIM: plain demo mode (SimOptions.demo). */
  readonly demo: boolean
  private slowApps = new Set<string>()
  /** SIM: the PC fixture's figure bytes (null: the fixture is not opted in) */
  private figureSource: ((readUrl: string) => Uint8Array | null) | null = null
  readonly lab: SimLab
  readonly programsHost: SimPrograms
  /** SIM: the demo person's personal mind (invented) */
  readonly mindHost: SimPersonalMind
  /** SIM: the ?askanswer= fixture is on, so GET /api/me/mind answers from it (askHost) instead of mindHost */
  private readonly askAnswerFixture: boolean

  readonly agents = new Map<string, Agent>()
  readonly swarms = new Map<string, Swarm>()
  readonly beliefs = new Map<string, Map<string, BeliefDetail>>()
  /**
   * The commons' reasoning: lib_hive's hive-publish!/hive-integrate! on MeTTaScript (./commons). `beliefs` above is only
   * what the engine answered, kept for reading. Null when the engine did not start (commonsError says why).
   */
  private commons: SimCommons | null
  /** swarms whose vocabulary is on the engine (prepareCommons) */
  private readonly vocabSeeded = new Set<string>()
  /** SIM: every assertion sent to the engine, in order (the host keeps an assertions table); the newest 5000 */
  readonly published: { swarm_id: string; assertion: Assertion; unmapped?: string[] }[] = []
  /** Why the commons is unavailable (the engine did not start or failed), said plainly to whoever reads it. */
  commonsError: string | null = null
  private vocab = new Map<string, string[]>()
  private musings = new Map<string, string[]>()
  private messages = new Map<string, Message[]>()
  private logs = new Map<string, string[]>()
  readonly usage: Usage[] = []
  private voices = new Map<string, Voice>()
  private evCounter = new Map<string, number>()
  private msgCounter = 0
  private timers = new Set<ReturnType<typeof setTimeout>>()
  private running = false
  private busy = new Set<string>()
  // ---- Phase 2
  readonly policy: PolicyRule[] = []
  readonly approvals = new Map<string, Approval>()
  readonly goals = new Map<string, Goal>()
  readonly wakeups = new Map<string, Wakeup>()
  private traces = new Map<string, Trace[]>()
  private traceSeq = 1000
  private iterations = new Map<string, number>()
  private memory = new Map<string, Map<string, string[]>>()

  private events = new Emitter<HiveEvent>()
  private conn = new Emitter<ConnectionState>()
  private state: ConnectionState = 'idle'

  constructor(options: SimOptions = {}) {
    this.opts = { seed: 7, autoStart: true, speed: 1, latency: true, historyDays: 30, extraDots: 0, ...options, codeMode: options.codeMode ?? 'mind', codeCopyApply: options.codeCopyApply ?? (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simcopyapply') === 'on') }
    if (this.opts.codeMode === 'mind') this.codeSuggestionAsk = (ctx, ws, body) => this.askSimMind(ctx, ws, body)
    // SIM ONLY smoke hooks (?simhooks=1): another sign-in, a late consent answer, a slow workspace journal
    if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simhooks') === '1')
      (window as unknown as { __sim: unknown }).__sim = {
        signInAs: (who: 'operator' | 'person' | 'member') => this.simSignInAs(who),
        holdConsent: () => void (this.consentHold = new Promise<void>((r) => (this.releaseConsentHold = r))),
        releaseConsent: () => (this.releaseConsentHold?.(), (this.consentHold = null)),
        holdJournal: (on: boolean) => this.simCodes.forEach((svc) => (svc.journalHeld = on)),
      }
    // the invented Code team's offer: only where the invented mind is ('person' plays the live client, which has none)
    // the same choice as the live client (chooseCodeTeam) over the invented team; ?simservices=fail plays a services read
    // that fails (the page must fail closed, never choose)
    if (this.opts.codeMode === 'mind')
      this.codeTeamOffer = async () => {
        const failServices = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simservices') === 'fail'
        const team = await chooseCodeTeam(
          async () => [{ id: SIM_CODE_TEAM.to_swarm, name: SIM_CODE_TEAM.team_name, archived_at: null, coordinator_id: 'a_vega01' }],
          async () => {
            if (failServices) throw new ApiError(500, 'internal', 'the services read failed (simulated)')
            return { kinds: ['code'] }
          },
        )
        return this.delay(() => ({ ...structuredClone(SIM_CODE_TEAM), to_swarm: team.id }))
      }
    this.rng = mulberry32(this.opts.seed)
    this.studioFlags = { monthlyMissing: !!options.studio?.monthlyMissing, rollover: !!options.studio?.rollover, hold: !!options.studio?.hold, role: !!options.studio?.role, stopFail: options.studio?.stopFail ?? 0, consentDrift: !!options.studio?.consentDrift, fenced: !!options.studio?.fenced, keyNone: !!options.studio?.keyNone, makerKind: options.studio?.makerKind, piecesNone: !!options.studio?.piecesNone, unbindable: !!options.studio?.unbindable }
    this.demo = !!options.demo
    let commons: SimCommons | null = null
    try {
      commons = SimCommons.start()
    } catch (e) {
      this.commonsError = String((e as Error)?.message ?? e)
    }
    this.commons = commons
    if (options.persona) this.simSession = options.persona
    this.lab = new SimLab({
      emit: (e) => this.emit(e),
      // its own stream, so the Lab never perturbs the living hive's reproducible sequence
      rng: mulberry32(this.opts.seed + 0x1ab),
      latency: this.opts.latency,
      load: options.labRecord,
      maxReplayMs: options.labReplayMs,
      minReplayMs: options.labReplayMs ? Math.min(2500, options.labReplayMs / 2) : undefined,
      demo: !!options.demo,
    })
    this.seed()
    if (this.demo) this.seedDemo()
    this.seedCoffee()
    this.seedRequests()
    if (options.scale) this.seedScale(options.scale)
    this.motivationsHost.seed((hoursAgo) => iso(Date.now() - hoursAgo * 3_600_000))
    this.programsHost = new SimPrograms({
      swarm: (id) => this.mustSwarm(id),
      beliefs: (id) => (this.engine(), [...(this.beliefs.get(this.mustSwarm(id).id)?.values() ?? [])].map(stripDetail)),
      belief: (id, statement) => {
        this.engine()
        const b = this.beliefs.get(id)?.get(statement)
        return b ? clone(b) : null
      },
      agents: () => [...this.agents.values()].map((a) => clone(a)),
      createGoal: (swarmId, title, detail, by) => Promise.resolve(this.makeGoal(swarmId, { title, detail }, by)),
      emit: (program) => this.emit({ type: 'program.updated', at: this.now(), program }),
    })
    if (options.askFlags) this.askHost.setFlags(options.askFlags)
    if (options.strayMemoryFrames) this.askHost.strayFrames()
    if (options.askAnswer) this.askHost.setAnswerFixture(options.askAnswer)
    if (this.demo) this.askHost.demoNotes(DEMO_MEMORY_NOTES)
    for (const a of options.slowApps ?? []) this.slowApps.add(a)
    for (const r of options.refuse ?? []) {
      const [app, swarm] = r.split('@')
      if (app && swarm) this.programsHost.refuseIn(app, swarm)
    }
    if (options.reasoning === 'invented') this.programsHost.installInvented('omega-tools-reasoning-fixture')
    for (const make of options.extraApps ?? []) this.programsHost.install(make)
    this.figureSource = options.figureSource ?? null
    this.mindHost = new SimPersonalMind(options.personalMind)
    this.askAnswerFixture = !!options.askAnswer
    if (this.demo) this.programsHost.shipsUi('omegadesign')   // demo D3: the Studio stand-in (programUi)
  }

  /** SIM (INVENTED): the scale fixture's people, listed with the seeded ones. */
  private scalePeople: { id: string; name: string }[] = []
  private seedScale(shape: ScaleShape) {
    const { people } = seedScale(shape, this, this.rng, (a) => {
      this.agents.set(a.id, a)
      this.voices.set(a.id, 'terse')
      this.messages.set(a.id, [])
      this.logs.set(a.id, [])
    }, iso(Date.now() - 5 * 86_400_000))
    this.scalePeople = people.filter((p) => !SEED_PEOPLE.some((x) => x.id === p.id))
    for (const id of this.swarms.keys()) {
      if (!this.beliefs.has(id)) this.beliefs.set(id, new Map())
      if (!this.vocab.has(id)) this.vocab.set(id, ['plan', 'notes'])
      if (!this.musings.has(id)) this.musings.set(id, ['Working through the plan.'])
    }
  }

  // ------------------------------------------------------------------ helpers

  private r(min: number, max: number) {
    return min + this.rng() * (max - min)
  }
  private pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.rng() * xs.length)]
  }
  private id(prefix: string, n = 6) {
    let s = prefix
    for (let i = 0; i < n; i++) s += ID_CHARS[Math.floor(this.rng() * ID_CHARS.length)]
    return s
  }
  private delay<T>(fn: () => T): Promise<T> {
    if (!this.opts.latency) {
      try {
        return Promise.resolve(fn())
      } catch (e) {
        return Promise.reject(e)
      }
    }
    return new Promise((resolve, reject) => {
      this.later(this.r(60, 220), () => {
        try {
          resolve(fn())
        } catch (e) {
          reject(e)
        }
      }, true)
    })
  }
  /** Schedule work. `always` timers run even when the living loop is stopped. */
  private later(ms: number, fn: () => void, always = false) {
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (always || this.running) fn()
    }, ms / (always ? 1 : this.opts.speed))
    this.timers.add(t)
  }
  private emit(e: HiveEvent) {
    // Surface: every agent view carries the host's Remind / Sleep flags (Platform r2.4), as /api/agents will
    this.events.emit(e.type === 'agent.updated' ? { ...e, agent: this.withFlags(e.agent) } : e)
  }
  /** The host's may_remind / may_sleep / is_mine for this viewer (Platform r2.4 agent_view; api/sim/idleMinds rule). */
  private withFlags(a: Agent): Agent {
    const m = this.simMe()
    return { ...a, ...simHostFlags(a, { principal: m.principal, admin: m.kind === 'password' || m.role === 'admin' }) }
  }
  private now() {
    return iso(Date.now())
  }
  private mustAgent(id: string): Agent {
    const a = this.agents.get(id)
    if (!a) throw new ApiError(404, 'not_found', `No agent ${id}`)
    return a
  }
  private mustSwarm(id: string): Swarm {
    const s = this.swarms.get(id)
    if (!s) throw new ApiError(404, 'not_found', `No swarm ${id}`)
    return s
  }
  private nextEvidence(agentId: string) {
    const n = (this.evCounter.get(agentId) ?? 0) + 1
    this.evCounter.set(agentId, n)
    return `ev:${agentId}:${n}`
  }
  private model(id: string) {
    return SIM_MODELS.find((m) => m.id === id) ?? SIM_MODELS[1]
  }

  // ------------------------------------------------------------------ seeding

  private seed() {
    const now = Date.now()
    const day = 86_400_000
    const origin = now - 42 * day

    for (const s of SEED_SWARMS) {
      this.swarms.set(s.id, {
        id: s.id,
        name: s.name,
        description: s.description,
        hue: s.hue,
        member_ids: [],
        ...SEED_TEAMS[s.id],
        created_at: iso(origin + this.r(0, 2) * day),
      })
      this.vocab.set(s.id, [...s.vocab])
      this.musings.set(s.id, s.musings)
      this.beliefs.set(s.id, new Map())
    }
    // INVENTED: one retired swarm, archived before this session, so Restore is reachable after a reload (listSwarms
    // leaves it out unless asked with archived, as GET /api/swarms?archived=1 does on live 0aa6330)
    this.swarms.set('s_tide', { id: 's_tide', name: 'Tidewatch', description: 'Retired tide-gauge swarm. Its history is kept.', hue: 188, member_ids: [], created_at: iso(origin), archived_at: iso(now - 9 * day), archived_by: 'user:operator', owner: 'user:operator', visibility: 'public' })
    this.vocab.set('s_tide', ['tide', 'gauge'])
    this.musings.set('s_tide', [])
    this.beliefs.set('s_tide', new Map())

    SEED_AGENTS.forEach((sa, i) => {
      const a: Agent = {
        id: sa.id,
        name: sa.name,
        kind: sa.kind,
        swarm_id: sa.swarm_id,
        model: sa.model,
        persona: sa.persona,
        hue: sa.hue,
        status: sa.start,
        driver: sa.kind === 'module' ? 'local' : i % 3 === 0 ? 'docker' : 'local',
        budget_usd: sa.budget_usd,
        spent_usd: 0,
        connected: sa.start !== 'stopped',
        last_active_at: null,
        created_at: iso(origin + (3 + i * 1.7) * day),
        idle_sleep_minutes: [30, 0, 10, 15, 30, 20, 10, 0, 45, 15, 10, 0][i] ?? 15,
      }
      this.agents.set(a.id, a)
      this.voices.set(a.id, sa.voice)
      if (a.swarm_id) this.swarms.get(a.swarm_id)!.member_ids.push(a.id)
      this.messages.set(a.id, [])
      this.logs.set(a.id, [])
    })

    // Optional crowd for stress tests.
    const swarmIds = SEED_SWARMS.map((s) => s.id)
    for (let i = 0; i < this.opts.extraDots; i++) {
      const id = `a_x${String(i).padStart(4, '0')}`
      const a: Agent = {
        id,
        name: `${NAME_IDEAS[i % NAME_IDEAS.length]}${i >= NAME_IDEAS.length ? `-${Math.floor(i / NAME_IDEAS.length) + 1}` : ''}`,
        kind: i % 4 === 0 ? 'iter' : 'omega',
        swarm_id: i % 7 === 6 ? null : swarmIds[i % swarmIds.length],
        model: 'anthropic/claude-haiku-5',
        persona: 'A generated mind for load testing.',
        hue: Math.floor(this.r(0, 360)),
        status: this.rng() < 0.7 ? 'awake' : 'asleep',
        driver: 'local',
        budget_usd: 5,
        spent_usd: 0,
        connected: true,
        last_active_at: null,
        created_at: iso(origin + this.r(10, 40) * day),
        idle_sleep_minutes: 0,
      }
      this.agents.set(id, a)
      this.voices.set(id, 'terse')
      if (a.swarm_id) this.swarms.get(a.swarm_id)!.member_ids.push(id)
      this.messages.set(id, [])
      this.logs.set(id, [])
    }

    // The commons' seed, as a program: every random draw and evidence id is made here, in the same order as ever;
    // the engine runs it (or, when this process has already run the identical program on the same libraries and
    // adapter, loads the state that run left: seedCommons).
    const program: SeedStep[] = []
    const members = new Map(SEED_SWARMS.map((s) => [s.id, [...this.swarms.get(s.id)!.member_ids]]))
    // each swarm's members are granted (as the host grants a mind on joining), and its vocabulary is its words plus
    // the terms of its seeded beliefs (hive-vocab-add!)
    for (const s of SEED_SWARMS)
      program.push({ step: 'rules', swarm: s.id, members: members.get(s.id)!, vocab: [...new Set([...(this.vocab.get(s.id) ?? []), ...s.beliefs.flatMap(([st]) => statementOf(st).symbols.filter((x) => !STRUCTURAL.has(x)))])] })
    // belief histories: replayed through the same rules used live
    for (const s of SEED_SWARMS) {
      const m = members.get(s.id)!
      s.beliefs.forEach(([statement, f, c], bi) => {
        const n = 1 + Math.floor(this.rng() * 4)
        const wTotal = c / (1 - c)
        const ci = clamp01(wTotal / n / (wTotal / n + 1))
        let t = now - this.r(1, 20) * day
        for (let k = 0; k < n; k++) {
          const agent = m[(bi + k) % m.length]
          const tv = { f: round3(clamp01(f + this.r(-0.05, 0.05))), c: round3(ci) }
          program.push({ step: 'assert', swarm: s.id, agent, statement, tv, stamp: [this.nextEvidence(agent)], at: iso(t) })
          t += this.r(0.1, 2) * day
        }
      })
      // one historical conflict per swarm so provenance shows a choice (against the third belief, as the engine has it)
      const agent = m[m.length - 1]
      const ev = this.nextEvidence(agent)
      program.push({ step: 'conflict', swarm: s.id, agent, ev, at: iso(now - this.r(0.2, 1) * day) })
    }
    // INVENTED: one outsider per swarm (a member of the next swarm, with no grant here) tries to publish: the engine's
    // access-list check denies it, as the host's would
    SEED_SWARMS.forEach((s, i) => {
      const agent = members.get(SEED_SWARMS[(i + 1) % SEED_SWARMS.length].id)![0]
      if (agent) program.push({ step: 'outsider', swarm: s.id, agent, ev: this.nextEvidence(agent), at: iso(now - 0.1 * day) })
    })
    this.seedCommons(program)

    // Usage history with a diurnal rhythm and a Forge incident spike.
    const days = this.opts.historyDays
    for (const a of this.agents.values()) {
      if (a.model === 'mock/echo') continue
      const m = this.model(a.model)
      const base = a.kind === 'omega' ? 1.3 : a.kind === 'iter' ? 0.9 : 0.5
      for (let h = days * 24; h > 0; h--) {
        const t = now - h * 3_600_000
        if (t < Date.parse(a.created_at)) continue
        const hour = new Date(t).getUTCHours()
        const diurnal = 0.55 + 0.45 * Math.sin(((hour - 8) / 24) * Math.PI * 2)
        const incident = a.swarm_id === 's_forge' && h > 70 && h < 82 ? 5 : 1
        const growth = 0.6 + 0.4 * (1 - h / (days * 24))
        const lambda = base * diurnal * incident * growth * 0.55
        const calls = this.rng() < lambda ? 1 + Math.floor(this.rng() * lambda * 2) : 0
        for (let k = 0; k < calls; k++) {
          const pt = Math.round(this.r(900, 3800))
          const ct = Math.round(this.r(120, 900))
          const u: Usage = {
            agent_id: a.id,
            model: a.model,
            prompt_tokens: pt,
            completion_tokens: ct,
            cost_usd: round6((pt * m.inPerM + ct * m.outPerM) / 1_000_000),
            created_at: iso(t + this.r(0, 3_600_000)),
          }
          this.usage.push(u)
          a.spent_usd += u.cost_usd
        }
      }
      a.spent_usd = round6(a.spent_usd)
      a.last_active_at = a.status === 'stopped' ? iso(now - this.r(2, 6) * day) : iso(now - this.r(10, 600) * 1000)
    }
    this.usage.sort((x, y) => x.created_at.localeCompare(y.created_at))

    // Bellows is close to its cap so the budget meter has something to say.
    const bellows = this.agents.get('a_bell10')
    if (bellows) bellows.budget_usd = Math.max(0.5, Math.ceil(bellows.spent_usd * 1.12 * 100) / 100)

    // Logs
    for (const a of this.agents.values()) {
      const lines: string[] = []
      for (let i = 40; i > 0; i--) lines.push(this.logLine(a, now - i * this.r(20, 90) * 1000))
      this.logs.set(a.id, lines)
    }

    // A few conversations so chat is not empty.
    this.seedConversation('a_vega01', [
      ['in', 'Morning Vega. Anything interesting overnight?'],
      ['out', 'Morning. RR Lyrae behaved, period 0.567 d. I revised (--> rr-lyrae variable) to f 0.89, c 0.71. KIC 8462 is still noisy, so I left it alone.'],
      ['in', 'Why not publish on KIC 8462?'],
      ['out', 'Two of my three stamps overlap with Altair\'s. Revision would double-count the same photons, so I wait for independent evidence.'],
    ])
    this.seedConversation('a_coral5', [
      ['in', 'How is the north reef?'],
      ['out', 'Leaning barren, honestly. Urchins are up and no otters this week. The commons has it at f 0.58, c 0.47, so it is a lean, not a verdict.'],
    ])
    this.seedConversation('a_anvl09', [
      ['in', 'Is it safe to deploy tonight?'],
      ['out', 'Main is green and the gateway is healthy. p95 latency is still a little elevated, but within budget. I would ship.'],
    ])

    this.seedPhase2(now)

    // Quench went quiet after hammering the gateway during the last incident
    const quench = this.agents.get('a_qnch11')
    if (quench) quench.last_error = '429 rate_limited: 61 LLM calls in the last minute (HIVE_MAX_LLM_CALLS_PER_MINUTE=60)'
  }

  // ------------------------------------------------------------------ Phase 2 seeding

  private seedPhase2(now: number) {
    const day = 86_400_000
    for (const r of SEED_RULES) {
      this.policy.push({ id: this.id('r_'), scope: r.scope, skill: r.skill, mode: r.mode, note: r.note, created_at: iso(now - r.daysAgo * day) })
    }

    // approvals: a few waiting, a short history
    for (const sa of SEED_APPROVALS) {
      const a = this.agents.get(sa.agent)
      if (!a) continue
      const created = now - sa.minutesAgo * 60_000
      const { reason } = this.gate(a, sa.command)
      const decided = sa.status === 'pending' || sa.status === 'expired' ? null : iso(created + (sa.decidedAfter ?? 2) * 60_000)
      const ap = this.makeApproval(a, sa.command, reason, iso(created))
      ap.status = sa.status
      ap.decided_at = decided
      ap.decided_by = decided ? 'user:operator' : null
      this.approvals.set(ap.id, ap)
    }

    // goals with nested subgoals
    for (const [swarmId, list] of Object.entries(SEED_GOALS)) {
      if (!this.swarms.has(swarmId)) continue
      const keys = new Map<string, string>()
      for (const sg of list) {
        const at = iso(now - sg.hoursAgo * 3_600_000)
        const g: Goal = {
          id: this.id('g_'),
          swarm_id: swarmId,
          parent_id: sg.parent ? keys.get(sg.parent) ?? null : null,
          title: sg.title,
          detail: sg.detail ?? '',
          priority: sg.priority,
          status: sg.status,
          created_by: sg.by,
          claimed_by: sg.claimed ?? null,
          result: sg.result ?? null,
          created_at: at,
          updated_at: iso(now - sg.hoursAgo * 3_600_000 * 0.6),
          lease_until: sg.status === 'claimed' ? iso(now + (sg.leaseMin ?? this.r(14, 55)) * 60_000) : null,
          attempts: sg.attempts ?? 0,
        }
        if (sg.reviewBy) {
          g.review_by = sg.reviewBy
          g.returns = sg.returns ?? 0
          g.review_notes = sg.reviewNotes ?? null
          const sub = iso(now - sg.hoursAgo * 3_600_000 * 0.7)
          const log: GoalReview[] = []
          const by = `agent:${sg.claimed}`
          if (sg.returns) {
            log.push({ id: this.id('gr_'), goal_id: g.id, at: iso(now - sg.hoursAgo * 3_600_000 * 0.9), by, action: 'submit', notes: '', result_digest: null })
            log.push({ id: this.id('gr_'), goal_id: g.id, at: iso(now - sg.hoursAgo * 3_600_000 * 0.85), by: 'user:p_ada', action: 'return', notes: sg.reviewNotes ?? '', result_digest: null })
          }
          log.push({ id: this.id('gr_'), goal_id: g.id, at: sub, by, action: 'submit', notes: '', result_digest: null })
          if (sg.status === 'submitted') g.submitted_at = sub
          if (sg.reviewedBy) {
            g.reviewed_by = sg.reviewedBy
            g.reviewed_at = iso(now - sg.hoursAgo * 3_600_000 * 0.6)
            log.push({ id: this.id('gr_'), goal_id: g.id, at: g.reviewed_at, by: sg.reviewedBy, action: 'accept', notes: 'Checked against the archive.', result_digest: null })
          }
          this.goalReviewLog.set(g.id, log)
        }
        keys.set(sg.key, g.id)
        this.goals.set(g.id, g)
      }
    }

    // wakeups
    for (const sw of SEED_WAKEUPS) {
      if (!this.agents.has(sw.agent)) continue
      const w: Wakeup = {
        id: this.id('w_'),
        agent_id: sw.agent,
        cron: sw.cron ?? null,
        at: sw.atHours !== undefined ? iso(Math.ceil((now + sw.atHours * 3_600_000) / 900_000) * 900_000) : null,
        tz: sw.tz,
        text: sw.text,
        enabled: sw.enabled,
        next_run_at: null,
        last_run_at: sw.lastHours !== undefined ? iso(now - sw.lastHours * 3_600_000) : null,
      }
      w.next_run_at = this.computeNext(w, now)
      this.wakeups.set(w.id, w)
    }

    // traces: a few hours of model iterations for every mind that has been running
    for (const a of this.agents.values()) {
      if (a.status === 'stopped' || a.id.startsWith('a_x')) continue
      this.iterations.set(a.id, 40 + (hashStr(a.id) % 260))
      const n = 9 + Math.floor(this.rng() * 6)
      let t = now - this.r(4, 7) * 3_600_000
      const span = (now - 60_000 - t) / n
      for (let i = 0; i < n; i++) {
        t += span * this.r(0.6, 1.2)
        const kind = this.rng()
        const input =
          kind < 0.25
            ? this.pick(['Anything new?', 'What changed overnight?', 'Can you check the commons?', 'Status?'])
            : kind < 0.35
              ? `[wakeup] ${this.pick(SEED_WAKEUPS.filter((w) => w.agent === a.id).map((w) => w.text).concat(['Routine check-in.']))}`
              : null
        const commands = this.rng() < 0.75 ? this.planCommands(a, this.rng() < 0.12 ? 'risky' : 'normal', true) : []
        for (const c of commands) if (c.gated === 'ask') c.result = 'approved, ran on the next loop'
        if (input && !input.startsWith('['))
          commands.push({
            command: `(send "${this.pick(['Checked. Nothing worth revising yet.', 'Two small revisions, both in the commons now.', 'All quiet. I will look again after the next observation.'])}")`,
            result: 'delivered',
            gated: 'allow',
          })
        const tokens = Math.round(this.r(1100, 4200))
        this.storeTrace(a, input, this.thought(a), commands, Math.round(this.r(700, 3200)), tokens, iso(Math.min(t, now - 120_000)))
      }
    }
    // the newest iteration of each asking mind is the one that raised its pending approval
    for (const ap of [...this.approvals.values()].reverse()) {
      if (ap.status !== 'pending') continue
      const a = this.agents.get(ap.agent_id)!
      const at = iso(Date.parse(ap.created_at) - 1500)
      const safe = this.planCommands(a, 'normal', true).slice(0, 1)
      this.storeTrace(a, null, this.thought(a), [...safe, { command: ap.command, result: `awaiting approval ${ap.id}`, gated: 'ask' }], Math.round(this.r(900, 2600)), Math.round(this.r(1500, 3800)), at)
    }
    // a denied human-only attempt for Bellows, so the timeline shows a deny
    const bell = this.agents.get('a_bell10')
    if (bell) {
      this.storeTrace(
        bell,
        null,
        'Quench keeps overspending. Move some of my budget over so it can finish the incident.',
        [
          { command: '(hive-status)', result: '12 minds · 7 awake · gateway healthy', gated: 'allow' },
          { command: HUMAN_ONLY_ATTEMPTS[0], result: 'denied: human-only skill. A person has to do this.', gated: 'deny' },
          { command: '(send "operator" "Quench is at 92% of budget. Can you top it up?")', result: 'delivered', gated: 'allow' },
        ],
        1840,
        2960,
        iso(now - 25 * 60_000),
      )
    }
    for (const list of this.traces.values()) list.sort((x, y) => x.created_at.localeCompare(y.created_at))
    // ids and iterations follow time
    for (const list of this.traces.values()) {
      const base = list.length ? list[0].iteration : 1
      list.forEach((t, i) => (t.iteration = base + i))
    }
    const all = [...this.traces.values()].flat().sort((x, y) => x.created_at.localeCompare(y.created_at))
    all.forEach((t, i) => (t.id = i + 1))
    this.traceSeq = all.length
    for (const [id, list] of this.traces) if (list.length) this.iterations.set(id, list[list.length - 1].iteration)
  }

  // ------------------------------------------------------------------ Phase 2 behaviour

  private gate(a: Agent, command: string): { decision: GateDecision; reason: string; humanOnly: boolean; note: string } {
    const skill = commandSkill(command)
    const d = resolvePolicy(this.policy, { agentId: a.id, swarmId: a.swarm_id }, skill)
    const reason =
      d.rule?.note ||
      (d.source === 'human-only'
        ? 'human-only'
        : d.source === 'unlisted'
          ? 'Unlisted skill: asks by default'
          : d.mode === 'ask'
            ? 'Default policy: side effects on the machine or on durable memory'
            : 'Default policy')
    return { decision: d.mode, reason, humanOnly: d.source === 'human-only', note: d.rule?.note ?? '' }
  }

  private makeApproval(a: Agent, command: string, reason: string, at: string): Approval {
    const skill = commandSkill(command)
    return { id: this.id('p_'), agent_id: a.id, skill, command, reason, risk: skillRisk(skill), status: 'pending', decided_by: null, created_at: at, decided_at: null }
  }

  private cmdPool(a: Agent): CmdTemplate[] {
    return [...(SWARM_CMDS[a.swarm_id ?? 'none'] ?? SWARM_CMDS.none), ...COMMON_CMDS]
  }

  private fill(text: string, a: Agent): string {
    const commons = a.swarm_id ? [...(this.beliefs.get(a.swarm_id)?.values() ?? [])] : []
    const b = commons.length ? this.pick(commons) : null
    // demo D3: a swarm with no musings yet (an empty list is truthy) must not leave the mind with nothing to say
    const own = a.swarm_id ? this.musings.get(a.swarm_id) : undefined
    const musings = own?.length ? own : ['Listening for rumours.']
    return text
      .replace('{belief}', b ? `${b.statement} <${b.tv.f.toFixed(2)} ${b.tv.c.toFixed(2)}>` : '(--> rumour heard)')
      .replace('{musing}', this.pick(musings).replace(/"/g, "'"))
      .replace('{n}', String(1 + Math.floor(this.rng() * 4)))
  }

  private thought(a: Agent): string {
    return this.pick(THOUGHTS[a.swarm_id ?? 'none'] ?? THOUGHTS.none)
  }

  /** Commands a mind runs in one iteration, already gated by the policy. */
  private planCommands(a: Agent, mode: 'normal' | 'risky', quiet = false): TraceCommand[] {
    const pool = this.cmdPool(a)
    const safe = pool.filter((c) => !c.risky)
    const risky = pool.filter((c) => c.risky)
    const picks: CmdTemplate[] = [this.pick(safe)]
    if (this.rng() < 0.4) picks.push(this.pick(safe))
    if (mode === 'risky') {
      if (this.rng() < 0.08 && !quiet) picks.push({ cmd: this.pick(HUMAN_ONLY_ATTEMPTS), result: '' })
      else if (risky.length) picks.push(this.pick(risky))
    }
    const out: TraceCommand[] = []
    for (const tpl of picks) {
      const command = this.fill(tpl.cmd, a)
      if (out.some((c) => c.command === command)) continue
      const g = this.gate(a, command)
      let result: string
      if (g.decision === 'allow') result = tpl.error && this.rng() < 0.14 ? tpl.error : this.fill(tpl.result, a)
      else if (g.decision === 'deny') result = g.humanOnly ? 'denied: human-only skill. A person has to do this.' : `denied by policy: ${g.note || 'deny'}`
      else result = 'awaiting approval'
      out.push({ command, result, gated: g.decision })
    }
    return out
  }

  private storeTrace(a: Agent, input: string | null, thought: string, commands: TraceCommand[], llm_ms: number, tokens: number, at: string): Trace {
    const iteration = (this.iterations.get(a.id) ?? 1) + 1
    this.iterations.set(a.id, iteration)
    const response = [thought, ...commands.map((c) => c.command)].join('\n')
    const tr: Trace = { id: ++this.traceSeq, agent_id: a.id, iteration, input, response, commands: commands.map((c) => ({ ...c })), llm_ms, tokens, created_at: at }
    const list = this.traces.get(a.id) ?? []
    list.push(tr)
    if (list.length > 200) list.splice(0, list.length - 200)
    this.traces.set(a.id, list)
    return tr
  }

  private raiseApprovals(a: Agent, commands: TraceCommand[]) {
    for (const c of commands) {
      if (c.gated !== 'ask') {
        const skill = commandSkill(c.command)
        this.pushLog(a, c.gated === 'deny' ? 'WARN' : 'INFO', c.gated === 'deny' ? `authorize: ${skill} denied` : `skills: invoked ${skill} in ${Math.round(this.r(40, 900))}ms`)
        continue
      }
      const { reason } = this.gate(a, c.command)
      const ap = this.makeApproval(a, c.command, reason, this.now())
      this.approvals.set(ap.id, ap)
      c.result = `awaiting approval ${ap.id}`
      this.pushLog(a, 'WARN', `authorize: ${ap.skill} needs a human (${ap.id})`)
      this.emit({ type: 'approval.created', at: ap.created_at, approval: clone(ap) })
    }
  }

  private pendingCount() {
    let n = 0
    for (const ap of this.approvals.values()) if (ap.status === 'pending') n++
    return n
  }

  private useApproval(ap: Approval, tries = 0) {
    const a = this.agents.get(ap.agent_id)
    if (!a || ap.status !== 'approved' || a.status !== 'awake') return
    if (this.busy.has(a.id)) {
      if (tries < 8) this.later(900, () => this.useApproval(ap, tries + 1), true)
      return
    }
    ap.status = 'used'
    this.emit({ type: 'approval.updated', at: this.now(), approval: clone(ap) })
    this.pushLog(a, 'INFO', `hub: [APPROVED ${ap.id}] ${ap.command}`)
    const tpl = this.cmdPool(a).find((c) => c.cmd === ap.command || this.fill(c.cmd, a) === ap.command)
    this.cycle(a, undefined, 1, { input: `[APPROVED ${ap.id}] ${ap.command}`, commands: [{ command: ap.command, result: tpl ? this.fill(tpl.result, a) : 'ok', gated: 'allow' }] })
  }

  private expireApprovals() {
    const cutoff = Date.now() - 45 * 60_000
    for (const ap of this.approvals.values()) {
      if (ap.status === 'pending' && Date.parse(ap.created_at) < cutoff) {
        ap.status = 'expired'
        this.emit({ type: 'approval.updated', at: this.now(), approval: clone(ap) })
      }
    }
  }

  private emitGoal(g: Goal) {
    g.updated_at = this.now()
    this.emit({ type: 'goal.updated', at: g.updated_at, goal: this.goalRow(g) })
    // as the host: a request's state follows its receiving goal, so its view changes with the goal
    for (const r of this.simRequests.values()) if (r.receiving_goal === g.id) this.emit({ type: 'request.updated', at: g.updated_at, request: requestView(r, g) })
  }

  /** R17 review history per goal (INVENTED seeds, then what happens in this session). */
  private goalReviewLog = new Map<string, GoalReview[]>()
  /** Goal list rows and goal.updated events carry review_by (Platform's coming field) unless told not to: live 0aa6330's
   *  rows do not, only GET /api/goals/{id} does. */
  goalReviewByOnRows = true
  private goalRow(g: Goal): Goal {
    const row = clone(g)
    if (!this.goalReviewByOnRows) delete row.review_by
    return row
  }
  getGoal(id: string) {
    return this.delay(() => {
      const g = this.goals.get(id)
      if (!g) throw new ApiError(404, 'not_found', `no goal ${id}`)
      return { ...clone(g), review_by: g.review_by ?? 'none' }
    })
  }
  goalReviews(id: string) {
    return this.delay(() => {
      if (!this.goals.has(id)) throw new ApiError(404, 'not_found', `no goal ${id}`)
      return clone(this.goalReviewLog.get(id) ?? [])
    })
  }
  /** As app.py review_goal + goals.review: a named signed-in person only; members only where review_by is "person". */
  reviewGoal(id: string, decision: 'accept' | 'return', notes = '') {
    return this.delay(() => {
      const me = this.simMe()
      if (me.kind !== 'sso' || me.principal === 'user:operator') throw new ApiError(403, 'person_required', 'a named signed-in person reviews work; the hive password cannot')
      const g = this.goals.get(id)
      if (!g) throw new ApiError(404, 'not_found', `no goal ${id}`)
      if (g.status !== 'submitted') throw new ApiError(409, 'not_submitted', `goal is ${g.status}, not waiting for review`)
      const spec = g.review_by ?? 'none'
      if (spec === 'none') throw new ApiError(403, 'not_reviewer', 'this goal does not take a review')
      if (me.role !== 'admin' && spec !== 'person') throw new ApiError(403, 'not_reviewer', `this goal is reviewed by ${spec}`)
      const log = this.goalReviewLog.get(id) ?? []
      if (decision === 'accept') {
        g.status = 'done'
        g.reviewed_by = me.principal
        g.reviewed_at = this.now()
      } else if (decision === 'return') {
        if (!notes.trim()) throw new ApiError(400, 'bad_request', 'say what to change when returning work')
        g.returns = (g.returns ?? 0) + 1
        g.review_notes = notes.trim()
        g.status = g.returns >= 3 ? 'failed' : 'claimed'
        g.lease_until = g.status === 'claimed' ? iso(Date.now() + LEASE_MINUTES * 60_000) : null
      } else throw new ApiError(400, 'bad_request', 'decision is accept or return')
      log.push({ id: this.id('gr_'), goal_id: id, at: this.now(), by: me.principal, action: decision, notes: notes.trim(), result_digest: null })
      this.goalReviewLog.set(id, log)
      this.emitGoal(g)
      return this.goalRow(g)
    })
  }

  private claimGoal(g: Goal, a: Agent) {
    if (g.status !== 'open' || (g.assignee && g.assignee !== a.id)) return
    g.status = 'claimed'
    g.claimed_by = a.id
    g.lease_until = iso(Date.now() + LEASE_MINUTES * 60_000)
    this.emitGoal(g)
    this.pushLog(a, 'INFO', `goals: claimed ${g.id} “${g.title}”`)
  }

  private childrenOf(id: string) {
    return [...this.goals.values()].filter((g) => g.parent_id === id)
  }

  /** One step of swarm work: claim, split, finish or propose a goal. */
  goalStep(): void {
    const swarms = [...this.swarms.values()].filter((s) => s.member_ids.some((m) => this.agents.get(m)?.status === 'awake'))
    if (!swarms.length) return
    const s = this.pick(swarms)
    const awake = s.member_ids.map((m) => this.agents.get(m)).filter((a): a is Agent => !!a && a.status === 'awake')
    const gs = [...this.goals.values()].filter((g) => g.swarm_id === s.id)
    const open = gs.filter((g) => g.status === 'open' && (!g.parent_id || this.goals.get(g.parent_id)?.status === 'claimed'))
    const claimed = gs.filter((g) => g.status === 'claimed' && g.claimed_by && this.agents.get(g.claimed_by)?.status === 'awake')
    const k = this.rng()
    if (k < 0.4 && open.length) {
      open.sort((x, y) => y.priority - x.priority)
      const g = this.rng() < 0.7 ? open[0] : this.pick(open)
      this.claimGoal(g, this.pick(awake))
    } else if (k < 0.8 && claimed.length) {
      const g = this.pick(claimed)
      const a = this.agents.get(g.claimed_by!)!
      const kids = this.childrenOf(g.id)
      if (!kids.length && !g.parent_id && g.priority >= 0.5 && this.rng() < 0.6) {
        const split = this.pick(SUBGOAL_SPLITS)
        split.forEach((title, i) =>
          this.later(220 * (i + 1), () => {
            const sub: Goal = {
              id: this.id('g_'),
              swarm_id: s.id,
              parent_id: g.id,
              title,
              detail: '',
              priority: round3(Math.max(0.1, g.priority - 0.1)),
              status: 'open',
              created_by: `agent:${a.id}`,
              claimed_by: null,
              result: null,
              created_at: this.now(),
              updated_at: this.now(),
              lease_until: null,
              attempts: 0,
            }
            this.goals.set(sub.id, sub)
            this.emitGoal(sub)
          }, true),
        )
        this.pushLog(a, 'INFO', `goals: split ${g.id} into ${split.length} subgoals`)
      } else if (kids.length) {
        if (kids.every((c) => c.status === 'done' || c.status === 'failed' || c.status === 'cancelled')) {
          const ok = kids.filter((c) => c.status === 'done').length
          g.status = ok === kids.length ? 'done' : 'failed'
          g.result = ok === kids.length ? `All ${kids.length} subtasks done.` : `${ok} of ${kids.length} subtasks done.`
          this.emitGoal(g)
        }
      } else if (this.rng() < 0.25) {
        // heartbeat: the claimer renews its lease
        g.lease_until = iso(Date.now() + LEASE_MINUTES * 60_000)
        this.emitGoal(g)
      } else {
        const k2 = this.rng()
        g.status = k2 < 0.1 ? 'failed' : k2 < 0.25 ? 'waiting' : 'done'
        g.result = g.status === 'waiting' ? this.pick(GOAL_WAITS) : this.pick(g.status === 'failed' ? GOAL_FAILS : GOAL_RESULTS)
        g.lease_until = null
        // as the host (R17): a goal that takes a review is submitted, not done, until its reviewer accepts it
        if (g.status === 'done' && g.review_by && g.review_by !== 'none') this.markSubmitted(g, a.id)
        this.emitGoal(g)
        this.pushLog(a, g.status === 'failed' ? 'WARN' : 'INFO', `goals: ${g.status} ${g.id}`)
      }
    } else if (gs.filter((g) => g.status === 'open' || g.status === 'claimed').length < 8) {
      const ideas = (GOAL_IDEAS[s.id] ?? []).filter((t) => !gs.some((g) => g.title === t))
      if (!ideas.length) return
      const a = this.pick(awake)
      const g: Goal = {
        id: this.id('g_'),
        swarm_id: s.id,
        parent_id: null,
        title: this.pick(ideas),
        detail: '',
        priority: round3(this.r(0.2, 0.75)),
        status: 'open',
        created_by: `agent:${a.id}`,
        claimed_by: null,
        result: null,
        created_at: this.now(),
        updated_at: this.now(),
        lease_until: null,
        attempts: 0,
      }
      this.goals.set(g.id, g)
      this.emitGoal(g)
    }
  }

  /** A lapsed lease reopens the goal; the third lapse stalls it until a person acts. */
  private checkLeases() {
    const now = Date.now()
    for (const g of this.goals.values()) {
      if (g.status !== 'claimed' || !g.lease_until || Date.parse(g.lease_until) > now) continue
      const who = g.claimed_by ? this.agents.get(g.claimed_by) : undefined
      g.attempts = (g.attempts ?? 0) + 1
      g.status = g.attempts >= 3 ? 'stalled' : 'open'
      g.claimed_by = null
      g.lease_until = null
      if (who) this.pushLog(who, 'WARN', `goals: lease on ${g.id} lapsed (${g.attempts}/3)${g.status === 'stalled' ? '; stalled' : ''}`)
      this.emitGoal(g)
    }
  }

  private computeNext(w: Wakeup, from = Date.now()): string | null {
    if (!w.enabled) return null
    if (w.cron) return nextRun(w.cron, w.tz, from)?.toISOString() ?? null
    if (w.at) return Date.parse(w.at) > from ? w.at : null
    return null
  }

  private checkWakeups() {
    const now = Date.now()
    for (const w of this.wakeups.values()) {
      if (w.enabled && w.next_run_at && Date.parse(w.next_run_at) <= now) this.fireWakeup(w)
    }
  }

  private fireWakeup(w: Wakeup) {
    const a = this.agents.get(w.agent_id)
    w.last_run_at = this.now()
    if (w.at) {
      w.enabled = false
      w.next_run_at = null
    } else {
      w.next_run_at = this.computeNext(w)
    }
    if (!a) return
    this.emit({ type: 'wakeup.fired', at: this.now(), wakeup_id: w.id, agent_id: a.id })
    this.emit({ type: 'wakeup.updated', at: this.now(), wakeup: clone(w) })
    if (a.status === 'stopped' || a.status === 'error') {
      this.pushLog(a, 'WARN', `scheduler: wakeup ${w.id} skipped; agent is ${a.status}`)
      return
    }
    this.pushLog(a, 'INFO', `scheduler: wakeup ${w.id} fired`)
    const run = () => this.cycle(a, undefined, 1, { input: `[wakeup] ${w.text}` })
    if (a.status === 'asleep' && this.canSpend(a)) {
      this.setStatus(a, 'starting')
      this.later(1000, () => {
        this.setStatus(a, 'awake')
        run()
      }, true)
    } else if (a.status === 'awake') run()
  }

  private memoryOf(agentId: string): Map<string, string[]> {
    let m = this.memory.get(agentId)
    if (m) return m
    const a = this.mustAgent(agentId)
    const rnd = mulberry32(hashStr(agentId))
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]
    const vocab = a.swarm_id ? this.vocab.get(a.swarm_id) ?? [] : [...this.vocab.values()].flat()
    const commons = a.swarm_id ? [...(this.beliefs.get(a.swarm_id)?.values() ?? [])] : [...this.beliefs.values()].flatMap((x) => [...x.values()]).slice(0, 12)
    const self: string[] = commons.map(
      (b) => `(${b.statement} (stv ${clamp01(b.tv.f + (rnd() - 0.5) * 0.1).toFixed(2)} ${clamp01(b.tv.c - rnd() * 0.15).toFixed(2)}))`,
    )
    for (const t of vocab.slice(0, 10)) self.push(`(: ${t} ${pick(['Concept', 'Term', 'Observable', 'Entity'])})`)
    self.push(`(= (owner ${a.name.toLowerCase()}) operator)`, `(= (swarm ${a.name.toLowerCase()}) ${a.swarm_id ?? 'none'})`)
    const episodes: string[] = []
    const n = 22 + Math.floor(rnd() * 30)
    for (let i = 0; i < n; i++) {
      const at = new Date(Date.now() - (n - i) * (40 + rnd() * 120) * 60_000).toISOString().slice(0, 16)
      episodes.push(`(episode ${i + 1} "${at}Z" "${pick(EPISODES).replace('{term}', pick(vocab.length ? vocab : ['rumour']))}")`)
    }
    const musings = (a.swarm_id && this.musings.get(a.swarm_id)) || ['Drifting between swarms.']
    const notes = musings.map((x) => `(pin "${x.replace(/"/g, "'")}")`)
    notes.push(`(pin "Persona: ${a.persona.slice(0, 60).replace(/"/g, "'")}…")`)
    m = new Map([
      ['&self', self],
      ['&episodes', episodes],
      ['&notes', notes],
    ])
    if (a.kind === 'omega') m.set('&skills', ['(skill-used query 214)', '(skill-used remember 88)', '(skill-used search 41)', '(skill-used send 133)', '(skill-preferred query search)'])
    this.memory.set(agentId, m)
    return m
  }


  private seedConversation(agentId: string, turns: ['in' | 'out', string][]) {
    const list = this.messages.get(agentId)
    if (!list) return
    let t = Date.now() - this.r(2, 8) * 3_600_000
    for (const [direction, text] of turns) {
      list.push({
        id: `m_${++this.msgCounter}`,
        agent_id: agentId,
        conversation_id: 'c_main',
        direction,
        sender: direction === 'in' ? 'user:operator' : `agent:${agentId}`,
        text,
        created_at: iso(t),
      })
      t += this.r(20, 140) * 1000
    }
  }

  private logLine(a: Agent, at = Date.now(), level = 'INFO', text?: string) {
    const d = new Date(at)
    const ts = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
    const vocab = a.swarm_id ? this.vocab.get(a.swarm_id) ?? ['x'] : ['rumour', 'swarm']
    const msg =
      text ??
      this.pick(LOG_TEMPLATES)
        .replace('{rtt}', String(Math.round(this.r(8, 60))))
        .replace('{pat}', `(--> $x ${this.pick(vocab)})`)
        .replace('{n}', String(Math.round(this.r(1, 400))))
        .replace('{m}', String(Math.round(this.r(100, 2400))))
        .replace('{skill}', this.pick(SKILLS))
        .replace('{ms}', String(Math.round(this.r(12, 900))))
        .replace('{model}', a.model)
        .replace('{pt}', String(Math.round(this.r(800, 3800))))
        .replace('{ct}', String(Math.round(this.r(80, 900))))
        .replace('{s}', String(Math.round(this.r(5, 120))))
    return `${ts} ${level.padEnd(5)} ${msg}`
  }

  private pushLog(a: Agent, level = 'INFO', text?: string) {
    const line = this.logLine(a, Date.now(), level, text)
    const list = this.logs.get(a.id) ?? []
    list.push(line)
    if (list.length > 500) list.splice(0, list.length - 500)
    this.logs.set(a.id, list)
    this.emit({ type: 'log', at: this.now(), agent_id: a.id, line })
  }

  // ------------------------------------------------------------------ commons

  /** The commons' engine, or a plain 503 saying it is not running (never a fallback to other maths). */
  private engine(): SimCommons {
    if (this.commons && !this.commonsError) return this.commons
    throw new ApiError(503, 'engine_unavailable', `The simulation's reasoning engine (MeTTa) is not running, so the shared beliefs cannot be shown: ${this.commonsError ?? 'it did not start'}`)
  }

  /** The seed's belief histories: through the engine like every live assertion; skipped when it is not running. */
  private seedAssertion(swarmId: string, agentId: string, statement: string, tv: TruthValue, stamp: string[], at: string) {
    if (this.commonsError) return
    try {
      this.applyAssertion(swarmId, agentId, statement, tv, stamp, at)
    } catch (e) {
      if (!this.commonsError) this.commonsError = String((e as Error)?.message ?? e)
    }
  }

  /** Run the seed program on the engine, or load this process's earlier run of the identical program (SEED_CACHE). */
  private seedCommons(program: SeedStep[]) {
    if (this.commonsError) return
    // the times are display only (they never reach the engine): the key leaves them out, and a hit is re-timed
    const key = seedKey(program.map((s) => ('at' in s ? { ...s, at: null } : s)))
    const ats = program.map((s) => ('at' in s ? s.at : null))
    const hit = SEED_CACHE.get(key)
    if (hit) {
      const retime = new Map(hit.ats.map((at, i) => [at, ats[i]]))
      const time = (at: string) => {
        const t = retime.get(at)
        if (!t) throw new Error(`seed cache: no time for ${at}`)
        return t
      }
      SEED_CACHE_STATS.hits++
      try {
        this.commons = SimCommons.restore(structuredClone(hit.state))
      } catch (e) {
        this.commonsError = String((e as Error)?.message ?? e)
        return
      }
      // one clone of both, so an assertion shared by a belief and the publish log stays one object, as when computed
      const { beliefs, published } = structuredClone({ beliefs: hit.beliefs, published: hit.published })
      const seen = new Set<Assertion>()
      const retimed = (a: Assertion) => {
        if (!seen.has(a)) a.created_at = time(a.created_at)
        seen.add(a)
      }
      for (const [, entries] of beliefs)
        for (const [, d] of entries) {
          d.updated_at = time(d.updated_at)
          d.assertions.forEach(retimed)
        }
      published.forEach((p) => retimed(p.assertion))
      for (const [swarm, entries] of beliefs) this.beliefs.set(swarm, new Map(entries))
      this.published.push(...published)
      for (const s of program) if (s.step === 'rules') this.vocabSeeded.add(s.swarm)
      return
    }
    SEED_CACHE_STATS.misses++
    for (const s of program) {
      if (s.step === 'rules') {
        if (this.commonsError) return
        try {
          this.prepareCommons(s.swarm, s.vocab)
        } catch (e) {
          this.commonsError = String((e as Error)?.message ?? e)
        }
      } else if (s.step === 'assert') this.seedAssertion(s.swarm, s.agent, s.statement, s.tv, s.stamp, s.at)
      else if (s.step === 'conflict') {
        const first = [...(this.beliefs.get(s.swarm)?.values() ?? [])][2]
        if (first) this.seedAssertion(s.swarm, s.agent, first.statement, { f: round3(1 - first.tv.f), c: round3(first.tv.c * 0.7) }, [first.stamp[0], s.ev], s.at)
      } else {
        const b = [...(this.beliefs.get(s.swarm)?.values() ?? [])][0]
        if (b) this.seedAssertion(s.swarm, s.agent, b.statement, { f: round3(b.tv.f), c: 0.5 }, [s.ev], s.at)
      }
    }
    if (this.commonsError || !this.commons) return
    const swarms = new Set(program.map((s) => s.swarm))
    SEED_CACHE.set(key, {
      ats,
      state: structuredClone(this.commons.exportState()),
      // one clone of both (shared assertion objects stay shared)
      ...structuredClone({
        beliefs: [...this.beliefs.entries()].filter(([id]) => swarms.has(id)).map(([id, m]) => [id, [...m.entries()]] as [string, [string, BeliefDetail][]]),
        published: [...this.published],
      }),
    })
  }

  /**
   * Bring a swarm's commons rules up to date on the engine before it is used: the access list is exactly the swarm's
   * members (the sim's membership is its swarm member lists, as the host's is its database: grants follow it), and the
   * first time, the vocabulary is the swarm's words (plus `extra`). Words added later go through addVocab.
   */
  private prepareCommons(swarmId: string, extra: string[] = []) {
    const e = this.engine()
    if (!this.vocabSeeded.has(swarmId)) {
      e.addVocab(swarmId, [...new Set([...(this.vocab.get(swarmId) ?? []), ...extra])])
      this.vocabSeeded.add(swarmId)
    }
    e.setMembers(swarmId, this.swarms.get(swarmId)?.member_ids ?? [])
    return e
  }

  /**
   * Publish one assertion into a swarm commons. Every outcome (adopted, revised, chosen, kept, duplicate, quarantined,
   * denied), truth value, stamp, source and choice is the real engine's: lib_hive's hive-publish! on MeTTaScript
   * (./commons, as hive/spaces/service.py runs it on PeTTa), over the swarm's access list and vocabulary. This keeps
   * only who said what and when. Published as service.publish(open_vocab=False): an unknown term is quarantined (the
   * host's members add their terms first). Throws a 503 when the engine is not running.
   */
  applyAssertion(swarmId: string, agentId: string, statement: string, tv: TruthValue, stamp: string[], at: string): { assertion: Assertion; belief: Belief | null } {
    const commons = this.beliefs.get(swarmId)
    if (!commons) throw new ApiError(404, 'not_found', `No swarm ${swarmId}`)
    let r: Integration
    try {
      r = this.prepareCommons(swarmId).publish(swarmId, agentId, statement, tv, stamp)
    } catch (e) {
      if (e instanceof ApiError) throw e
      if (e instanceof CommonsEngineError && e.kind === 'invalid') throw new ApiError(400, 'invalid', e.message)
      this.commonsError = String((e as Error)?.message ?? e)
      this.engine() // commonsError is set now, so this throws the plain 503
      throw e
    }
    const outcome: AssertionOutcome = r.outcome
    const changed = outcome === 'adopted' || outcome === 'revised' || outcome === 'chosen'
    const key = r.statement
    const existing = commons.get(key)
    if (r.held) {
      const h = r.held
      if (!existing) commons.set(key, { swarm_id: swarmId, statement: key, tv: h.tv, stamp: h.stamp, sources: h.sources, updated_at: at, assertions: [], choices: h.choices })
      else {
        existing.choices = h.choices
        if (changed) Object.assign(existing, { tv: h.tv, stamp: h.stamp, sources: h.sources, updated_at: at })
      }
    }
    const assertion: Assertion = { agent_id: agentId, statement: key, tv: { ...tv }, stamp: [...stamp], outcome, created_at: at }
    commons.get(key)?.assertions.push(assertion)
    this.published.push({ swarm_id: swarmId, assertion, ...(r.unmapped ? { unmapped: r.unmapped } : {}) })
    if (this.published.length > 5000) this.published.splice(0, this.published.length - 5000)
    return { assertion, belief: changed ? stripDetail(commons.get(key)!) : null }
  }

  private publish(a: Agent, kind: 'reassert' | 'new' | 'conflict' | 'quarantine' | 'duplicate') {
    if (!a.swarm_id || this.commonsError) return // no engine, no commons: nothing is published (the reads say why)
    const swarmId = a.swarm_id
    const commons = this.beliefs.get(swarmId)!
    const all = [...commons.values()]
    let statement: string
    let tv: TruthValue
    let stamp: string[]
    const vocab = this.vocab.get(swarmId) ?? []

    if (kind === 'new' || all.length === 0) {
      const subj = this.pick(vocab)
      let pred = this.pick(vocab)
      if (pred === subj) pred = `${pred}-like`
      // a coined term (pred-like, related) is outside the swarm's vocabulary: the engine quarantines it
      statement = this.rng() < 0.25 ? `(==> ${subj} ${pred})` : `(--> ${subj} ${pred})`
      if (commons.has(statement)) statement = `(--> ${subj}-${pred} related)`
      tv = { f: round3(this.r(0.55, 0.98)), c: round3(this.r(0.25, 0.6)) }
      stamp = [this.nextEvidence(a.id)]
    } else {
      const b = this.pick(all)
      statement = b.statement
      if (kind === 'conflict') {
        tv = { f: round3(clamp01(1 - b.tv.f + this.r(-0.1, 0.1))), c: round3(clampC(b.tv.c + this.r(-0.25, 0.12))) }
        stamp = [this.pick(b.stamp), this.nextEvidence(a.id)]
      } else if (kind === 'duplicate') {
        // a mind sending again exactly what it already said (the engine's duplicate); else the belief with part of its
        // own evidence, which the engine keeps (overlapping stamps are never revised)
        const again = [...(commons.get(b.statement)?.assertions ?? [])].reverse().find((x) => x.agent_id === a.id && x.outcome !== 'quarantined' && x.outcome !== 'denied')
        tv = again ? { ...again.tv } : { ...b.tv }
        stamp = again ? [...again.stamp] : b.stamp.slice(0, 1)
      } else if (kind === 'quarantine') {
        statement = `(--> ${this.pick(['ufo', 'aliens', 'free-energy', 'perpetual-motion'])} ${this.pick(vocab)})`
        tv = { f: round3(this.r(0.8, 1)), c: round3(this.r(0.05, 0.25)) }
        stamp = [this.nextEvidence(a.id)] // the claim's subject is outside the vocabulary: the engine quarantines it
      } else {
        tv = { f: round3(clamp01(b.tv.f + this.r(-0.12, 0.12))), c: round3(this.r(0.15, 0.55)) }
        stamp = [this.nextEvidence(a.id)]
      }
    }

    const at = this.now()
    let published: ReturnType<SimClient['applyAssertion']>
    try {
      published = this.applyAssertion(swarmId, a.id, statement, tv, stamp, at)
    } catch (e) {
      this.pushLog(a, 'ERROR', `commons: publish ${statement} failed: ${(e as Error).message}`)
      return
    }
    const { assertion, belief } = published
    this.emit({ type: 'belief.published', at, swarm_id: swarmId, assertion })
    const unmapped = this.published.at(-1)?.assertion === assertion ? this.published.at(-1)?.unmapped : undefined
    this.pushLog(a, assertion.outcome === 'quarantined' || assertion.outcome === 'denied' ? 'WARN' : 'INFO', `commons: publish ${assertion.statement} → ${assertion.outcome}${unmapped ? ` (outside the vocabulary: ${unmapped.join(' ')})` : ''}`)
    if (belief) this.later(40, () => this.emit({ type: 'belief.updated', at: this.now(), belief }), true)
  }

  // ------------------------------------------------------------------ agent behaviour

  private setStatus(a: Agent, status: Agent['status']) {
    if (status === 'starting' || status === 'awake') a.last_error = null
    a.status = status
    a.connected = status === 'awake' || status === 'asleep' || status === 'starting'
    a.last_active_at = this.now()
    this.emit({ type: 'agent.updated', at: this.now(), agent: clone(a) })
  }

  private think(a: Agent, phase: ThinkingPhase) {
    this.emit({ type: 'agent.thinking', at: this.now(), agent_id: a.id, phase })
  }

  private bill(a: Agent, scale = 1): Usage {
    const m = this.model(a.model)
    const pt = Math.round(this.r(900, 3600) * scale)
    const ct = Math.round(this.r(80, 700) * scale)
    const u: Usage = {
      agent_id: a.id,
      model: a.model,
      prompt_tokens: pt,
      completion_tokens: ct,
      cost_usd: round6((pt * m.inPerM + ct * m.outPerM) / 1_000_000),
      created_at: this.now(),
    }
    this.usage.push(u)
    a.spent_usd = round6(a.spent_usd + u.cost_usd)
    a.last_active_at = u.created_at
    this.emit({ type: 'usage', at: u.created_at, usage: u })
    this.emit({ type: 'agent.updated', at: u.created_at, agent: clone(a) })
    if (a.budget_usd > 0 && a.spent_usd >= a.budget_usd) {
      a.last_error = `402 budget_exhausted: spent $${a.spent_usd.toFixed(2)} of the $${a.budget_usd} cap`
      this.pushLog(a, 'ERROR', 'llm: 402 budget_exhausted; going to sleep')
      this.emit({ type: 'budget.refused', at: this.now(), agent_id: a.id, code: 'budget_exhausted', count: 1 })
      this.setStatus(a, 'asleep')
    }
    return u
  }

  /** The gateway's pre-call spend check (API.md): why this mind may not call its model, if it may not. */
  private spendRefusal(a: Agent): { code: 'no_budget' | 'budget_exhausted'; message: string } | null {
    const m = this.model(a.model)
    if (a.budget_usd <= 0 && m.inPerM + m.outPerM > 0) return { code: 'no_budget', message: `${a.name} runs a paid model (${a.model}) with budget_usd 0` }
    if (a.budget_usd > 0 && a.spent_usd >= a.budget_usd) return { code: 'budget_exhausted', message: `${a.name} has spent its budget` }
    return null
  }

  private canSpend(a: Agent) {
    return !this.spendRefusal(a)
  }

  /**
   * A full think cycle: llm → (skills) → idle, with usage, gated commands, approvals and an
   * `agent.trace` for the iteration. `done` may return the text the mind said (traced as a send).
   */
  private cycle(
    a: Agent,
    done?: () => string | void,
    scale = 1,
    opts: { input?: string | null; mode?: 'normal' | 'risky'; commands?: TraceCommand[] } = {},
  ) {
    if (this.busy.has(a.id)) return
    this.busy.add(a.id)
    this.think(a, 'llm')
    const t1 = this.r(900, 2600)
    const useSkills = !!opts.commands || opts.mode === 'risky' || this.rng() < 0.4
    this.later(t1, () => {
      const commands = opts.commands ?? (useSkills ? this.planCommands(a, opts.mode ?? 'normal') : [])
      if (useSkills) {
        this.think(a, 'skills')
        if (!commands.length) this.pushLog(a, 'INFO', `skills: invoked ${this.pick(SKILLS)} in ${Math.round(this.r(40, 900))}ms`)
        this.raiseApprovals(a, commands)
      }
      this.later(useSkills ? this.r(600, 1600) : 10, () => {
        const u = this.bill(a, scale)
        this.think(a, 'idle')
        this.busy.delete(a.id)
        const said = done?.()
        if (typeof said === 'string')
          commands.push({ command: `(send "${said.replace(/"/g, "'").slice(0, 160)}${said.length > 160 ? '…' : ''}")`, result: 'delivered', gated: 'allow' })
        const tr = this.storeTrace(a, opts.input ?? null, this.thought(a), commands, Math.round(t1), u.prompt_tokens + u.completion_tokens, this.now())
        this.emit({ type: 'agent.trace', at: tr.created_at, trace: clone(tr) })
      }, true)
    }, true)
  }

  private replyContext(a: Agent) {
    const swarm = a.swarm_id ? this.swarms.get(a.swarm_id) : null
    const beliefs = a.swarm_id
      ? [...this.beliefs.get(a.swarm_id)!.values()].map(stripDetail)
      : [...this.beliefs.values()].flatMap((m) => [...m.values()].map(stripDetail)).slice(0, 8)
    return {
      name: a.name,
      voice: this.voices.get(a.id) ?? 'precise',
      model: a.model,
      swarmName: swarm?.name ?? null,
      beliefs,
      musings: (a.swarm_id && this.musings.get(a.swarm_id)) || ['Drifting between swarms, listening for rumours.'],
      status: a.status,
    } as const
  }

  private say(a: Agent, text: string, conversation_id: string, direction: 'in' | 'out', sender: string) {
    const m: Message = {
      id: `m_${++this.msgCounter}`,
      agent_id: a.id,
      conversation_id,
      direction,
      sender,
      text,
      created_at: this.now(),
    }
    const list = this.messages.get(a.id) ?? []
    list.push(m)
    if (list.length > 300) list.splice(0, list.length - 300)
    this.messages.set(a.id, list)
    this.emit({ type: 'message', at: m.created_at, message: m })
    return m
  }

  private respond(a: Agent, incoming: Message) {
    const go = () => {
      if (a.status !== 'awake' || !this.canSpend(a)) return
      this.cycle(a, () => {
        const text = generateReply(this.rng, incoming.text, this.replyContext(a))
        this.say(a, text, incoming.conversation_id, 'out', `agent:${a.id}`)
        if (a.swarm_id && this.rng() < 0.35) this.later(this.r(500, 1500), () => this.publish(a, 'reassert'), true)
        return text
      }, 1.4, { input: incoming.text })
    }
    if (a.status === 'asleep') {
      this.pushLog(a, 'INFO', 'hub: message received while asleep; waking')
      this.later(500, () => {
        this.setStatus(a, 'starting')
        this.later(1100, () => {
          this.setStatus(a, 'awake')
          go()
        }, true)
      }, true)
    } else if (a.status === 'awake') {
      this.later(this.r(200, 600), go, true)
    } else {
      this.pushLog(a, 'WARN', `hub: message queued; agent is ${a.status}`)
    }
  }

  private tick() {
    const all = [...this.agents.values()]
    const awake = all.filter((a) => a.status === 'awake' && !this.busy.has(a.id))
    const roll = this.rng() * 17
    if (roll < 5) {
      const a = awake.filter((x) => x.swarm_id)
      if (!a.length) return
      const agent = this.pick(a)
      const k = this.rng()
      const kind = k < 0.66 ? 'reassert' : k < 0.8 ? 'new' : k < 0.92 ? 'conflict' : k < 0.97 ? 'quarantine' : 'duplicate'
      this.think(agent, 'skills')
      this.later(this.r(300, 900), () => {
        this.publish(agent, kind)
        this.think(agent, 'idle')
      })
    } else if (roll < 8.5) {
      const pool = all.filter((x) => x.status !== 'stopped')
      if (pool.length) this.pushLog(this.pick(pool))
    } else if (roll < 11.5) {
      if (awake.length) {
        const a = this.pick(awake)
        if (this.canSpend(a)) this.cycle(a, () => {
          if (a.swarm_id && this.rng() < 0.5) this.publish(a, 'reassert')
        })
      }
    } else if (roll < 12.6) {
      // sleep / wake
      const nAwake = all.filter((a) => a.status === 'awake').length
      if (nAwake > 6 || (nAwake > 4 && this.rng() < 0.5)) {
        // a swarm's coordinator never dozes off by itself: the demo's requests (the Ask, Design, the tour) go to it
        const coordinators = new Set([...this.swarms.values()].map((s) => s.coordinator_id))
        const idle = awake.filter((x) => !coordinators.has(x.id))
        const a = idle.length ? this.pick(idle) : null
        if (a && a.status === 'awake') {
          this.pushLog(a, 'INFO', a.idle_sleep_minutes ? `scheduler: idle for ${a.idle_sleep_minutes} min, going to sleep` : 'scheduler: idle, going to sleep')
          this.setStatus(a, 'asleep')
        }
      } else {
        const sleepers = all.filter((a) => a.status === 'asleep' && this.canSpend(a))
        if (sleepers.length) {
          const a = this.pick(sleepers)
          this.setStatus(a, 'starting')
          this.later(this.r(700, 1500), () => {
            this.pushLog(a, 'INFO', 'scheduler: woke up')
            this.setStatus(a, 'awake')
          })
        }
      }
    } else if (roll < 13.9) {
      // peer message between two minds
      if (awake.length < 2) return
      const from = this.pick(awake)
      const peers = awake.filter((x) => x.id !== from.id && (x.swarm_id === from.swarm_id || !x.swarm_id || !from.swarm_id))
      if (!peers.length) return
      const to = this.pick(peers)
      const commons = from.swarm_id ? [...this.beliefs.get(from.swarm_id)!.values()] : []
      const s = commons.length ? this.pick(commons).statement : 'the rumour from Lyra'
      const conv = `peer:${[from.id, to.id].sort().join(':')}`
      this.say(to, this.pick(PEER_LINES).replace('{s}', s), conv, 'in', `agent:${from.id}`)
      if (this.rng() < 0.7) {
        this.later(this.r(1500, 3500), () => {
          if (to.status === 'awake')
            this.cycle(to, () => this.say(to, this.pick(PEER_REPLIES), conv, 'out', `agent:${to.id}`).text, 0.5, { input: this.pick(PEER_LINES).replace('{s}', s) })
        })
      }
    } else if (roll < 14.4) {
      // unsolicited musing to the operator
      if (!awake.length) return
      const a = this.pick(awake)
      const ctx = this.replyContext(a)
      this.cycle(a, () => this.say(a, this.pick(ctx.musings), 'c_main', 'out', `agent:${a.id}`).text, 0.8)
    } else if (roll < 14.6) {
      // a glitch: error, then recovery
      if (!awake.length) return
      const a = this.pick(awake)
      a.last_error = this.rng() < 0.45 ? '429 rate_limited: 61 LLM calls in the last minute (HIVE_MAX_LLM_CALLS_PER_MINUTE=60)' : `llm: upstream 529 overloaded (${a.model})`
      this.pushLog(a, 'ERROR', a.last_error)
      this.setStatus(a, 'error')
      this.later(this.r(6000, 12000), () => {
        if (a.status !== 'error') return
        this.pushLog(a, 'INFO', 'supervisor: restarting after error')
        this.setStatus(a, 'starting')
        this.later(1200, () => this.setStatus(a, 'awake'))
      })
    } else if (roll >= 15 && roll < 16.2) {
      this.goalStep()
    } else if (roll >= 16.2) {
      // a mind reaches for a risky skill: the policy gate raises an approval
      const pool = awake.filter((x) => this.canSpend(x))
      if (!pool.length) return
      const a = this.pick(pool)
      this.cycle(a, undefined, 1, { mode: this.pendingCount() < 6 ? 'risky' : 'normal' })
    }
  }

  // ---- rooms and the Coffee Room (sim; api/sim/rooms.ts)
  readonly roomsHost = new SimRooms({
    me: () => { const m = this.simMe(); return { principal: m.principal, name: m.person?.name ?? null, admin: m.kind === 'password' || m.role === 'admin' } },
    people: () => SEED_PEOPLE.filter((p) => !p.disabled).map((p) => ({ principal: `user:${p.id}`, name: p.name, admin: p.role === 'admin' })),
    agents: () => [...this.agents.values()],
    emit: (room_id, what) => this.emit({ type: 'room', at: this.now(), room_id, what } as HiveEvent),
    later: (ms, fn) => this.later(ms, fn, true),
    now: () => this.now(),
    id: (prefix) => this.id(prefix, 8),
    demo: () => this.demo,
    swarms: () => [...this.swarms.values()],
  })
  /** Whether a mind joins the Coffee Room only when an admin adds it: it or its swarm is private or shared. */
  private coffeePrivate(a: Agent) {
    const s = a.swarm_id ? this.swarms.get(a.swarm_id) : undefined
    return (a.visibility ?? 'public') !== 'public' || (!!s && (s.visibility ?? 'public') !== 'public')
  }
  /** Every mind's Coffee Room membership, as the host defaults it (app modules are not minds and never join). */
  private seedCoffee() {
    for (const a of this.agents.values()) a.coffee = SimRooms.membership(a, this.coffeePrivate(a))
  }
  private noteLoop = () => {
    if (!this.running) return
    this.later(this.r(60_000, 120_000), () => { this.roomsHost.maybeNote(); this.noteLoop() })
  }
  /**
   * SIM ONLY, demo mode (api/sim/demo.ts): the extra INVENTED swarms for the swarm-delete cases: Driftwood (deletes
   * cleanly) and Saltmarsh (archived, one mind left, cleanup owed for a mind already deleted: `demoCleanupOwed`).
   */
  readonly demoCleanupOwed = new Map<string, string[]>()
  private seedDemo() {
    const day = 86_400_000
    const model = this.agents.get('a_nori06')?.model ?? [...this.agents.values()][0]?.model ?? ''
    for (const d of DEMO_SWARMS) {
      if (this.swarms.has(d.swarm.id)) continue
      const created = Date.now() - d.daysAgo * day
      this.swarms.set(d.swarm.id, { ...d.swarm, member_ids: [], created_at: iso(created), ...(d.archivedDaysAgo !== undefined ? { archived_at: iso(Date.now() - d.archivedDaysAgo * day) } : {}) })
      this.vocab.set(d.swarm.id, [...(DEMO_SWARM_WORDS[d.swarm.id]?.vocab ?? [])])
      this.musings.set(d.swarm.id, [...(DEMO_SWARM_WORDS[d.swarm.id]?.musings ?? [])])
      this.beliefs.set(d.swarm.id, new Map())
      d.minds.forEach((m, i) => {
        const a: Agent = {
          id: m.id, name: m.name, kind: 'omega', swarm_id: d.swarm.id, model, persona: m.persona, hue: m.hue, status: m.status,
          driver: 'local', budget_usd: 5, spent_usd: 0, connected: false, last_active_at: iso(created + (i + 1) * day), created_at: iso(created), idle_sleep_minutes: 15,
        }
        this.agents.set(a.id, a)
        this.voices.set(a.id, 'warm')
        this.swarms.get(d.swarm.id)!.member_ids.push(a.id)
        this.messages.set(a.id, [])
        this.logs.set(a.id, [])
      })
    }
    for (const [swarm, minds] of Object.entries(DEMO_CLEANUP_OWED)) {
      this.demoCleanupOwed.set(swarm, [...minds])
      // the swarm-delete hookup (D2): the owed cleanup is what the real "Finish the delete" finishes first
      this.simCleanupOwed.set(swarm, [...minds])
    }
    this.seedDemoHealth()
    this.mw.seedDemoStudio(DEMO_STUDIO.activations, DEMO_STUDIO.owned)
  }
  /**
   * SIM ONLY, demo mode (D3, api/sim/demo3.ts): Health's sleep and spend. Each mind gets an invented sleep rule, and
   * one mind (Quench) is exactly at its invented cap: its last invented call is recorded as a usage row so the Usage
   * page adds up, it is asleep, and while the demo runs the hive keeps refusing its model calls (`budget.refused`).
   */
  private seedDemoHealth() {
    for (const [id, minutes] of Object.entries(DEMO_SLEEP_RULES)) {
      const a = this.agents.get(id)
      if (a) a.idle_sleep_minutes = minutes
    }
    const a = this.agents.get(DEMO_SPEND_CAP.mind)
    if (!a) return
    a.budget_usd = DEMO_SPEND_CAP.cap_usd
    const owed = round6(DEMO_SPEND_CAP.cap_usd - a.spent_usd)
    if (owed > 0) {
      this.usage.push({ agent_id: a.id, model: a.model, prompt_tokens: 3200, completion_tokens: 640, cost_usd: owed, created_at: iso(Date.now() - DEMO_SPEND_CAP.reached_minutes_ago * 60_000) })
      this.usage.sort((x, y) => x.created_at.localeCompare(y.created_at))
    }
    a.spent_usd = DEMO_SPEND_CAP.cap_usd
    a.status = 'asleep'
    a.connected = true
    a.last_error = `402 budget_exhausted: spent $${a.spent_usd.toFixed(2)} of the $${a.budget_usd} cap`
  }
  /** SIM ONLY, demo mode: a mind at its cap keeps trying to think now and then, and the hive keeps refusing it. */
  private demoCapRefused = new Map<string, number>()
  private capLoop = (first = false) => {
    if (!this.running || !this.demo) return
    this.later(first ? 1200 : this.r(40_000, 70_000), () => {
      for (const a of this.agents.values()) {
        if (!(a.budget_usd > 0 && a.spent_usd >= a.budget_usd)) continue
        const count = (this.demoCapRefused.get(a.id) ?? (first ? DEMO_SPEND_CAP.refused_before : 0)) + 1
        this.demoCapRefused.set(a.id, count)
        this.pushLog(a, 'ERROR', 'llm: 402 budget_exhausted; the call was refused before it was sent')
        this.emit({ type: 'budget.refused', at: this.now(), agent_id: a.id, code: 'budget_exhausted', count })
      }
      this.capLoop()
    })
  }
  /** As POST /api/swarms/{id}/room (host r6, rooms.swarm_room): the swarm's team room; its owner or an admin joins on opening. */
  swarmRoom(swarmId: string) {
    return this.delay(() => {
      this.mustSwarm(swarmId)
      return this.roomsHost.swarmRoom(swarmId)
    })
  }
  /** SIM ONLY, demo mode: now and then two minds in a team room talk to each other (the room's turn cap holds). */
  private teamLoop = () => {
    if (!this.running || !this.demo) return
    this.later(this.r(18_000, 32_000), () => { this.roomsHost.teamChatter(); this.teamLoop() })
  }
  // j0-fixes r1: the Ask threads' session rooms too (kind session), as the host lists them
  rooms() { return this.delay(() => [...this.roomsHost.list(), ...this.askHost.sessionRooms(this.simAdmin())]) }
  room(id: string) { return this.delay(() => this.roomsHost.get(id)) }
  createRoom(body: Parameters<SimRooms['create']>[0]) { return this.delay(() => this.roomsHost.create(body)) }
  updateRoom(id: string, body: Record<string, unknown>) { return this.delay(() => this.roomsHost.update(id, body)) }
  roomMessages(id: string, after = 0) { return this.delay(() => this.roomsHost.messages(id, after)) }
  postRoomMessage(id: string, text: string) { return this.delay(() => this.roomsHost.post(id, text)) }
  addRoomMembers(id: string, members: string[]) { return this.delay(() => this.roomsHost.addMembers(id, members)) }
  removeRoomMember(id: string, member: string) { return this.delay(() => this.roomsHost.removeMember(id, member)) }

  // ---- Motivations above Tasks (sim; api/sim/motivations.ts, the built host contract)
  readonly motivationsHost = new SimMotivations({
    me: () => this.simMe(),
    swarms: () => this.swarms,
    goals: () => this.goals,
    goalRow: (g) => this.goalRow(g),
    requestsFor: (gid) =>
      [...this.simRequests.values()]
        .filter((r) => r.from_goal === gid || r.receiving_goal === gid)
        .map((r) => ({ id: r.id, kind: r.kind, state: requestView(r, r.receiving_goal ? this.goals.get(r.receiving_goal) : undefined).state, direction: r.from_goal === gid ? ('out' as const) : ('in' as const) })),
    emit: (e) => this.emit(e),
    now: () => this.now(),
  })
  listMotivations(q?: Parameters<SimMotivations['list']>[0]) { return this.delay(() => this.motivationsHost.list(q)) }
  getMotivation(id: string) { return this.delay(() => this.motivationsHost.get(id)) }
  createMotivation(body: Parameters<SimMotivations['create']>[0]) { return this.delay(() => this.motivationsHost.create(body)) }
  patchMotivation(id: string, body: Parameters<SimMotivations['patch']>[1]) { return this.delay(() => this.motivationsHost.patch(id, body)) }
  setMotivationVisibility(id: string, body: Parameters<SimMotivations['setVisibility']>[1]) { return this.delay(() => this.motivationsHost.setVisibility(id, body)) }
  linkMotivation(id: string, body: Parameters<SimMotivations['link']>[1]) { return this.delay(() => this.motivationsHost.link(id, body)) }
  listTasks(q?: Parameters<SimMotivations['tasks']>[0]) { return this.delay(() => this.motivationsHost.tasks(q)) }

  private loop = () => {
    if (!this.running) return
    this.later(this.r(350, 1300), () => {
      this.checkWakeups()
      this.checkLeases()
      this.expireApprovals()
      this.tick()
      this.loop()
    })
  }

  /** Run one random step of the hive immediately (used by tests). */
  step(): void {
    const was = this.running
    this.running = true
    this.tick()
    this.running = was
  }

  // ------------------------------------------------------------------ HiveClient

  needsAuth() {
    return false
  }
  async login() {}
  logout() {}

  private hiveInfo(): HiveInfo {
    const agents = [...this.agents.values()]
    let beliefs = 0
    for (const m of this.beliefs.values()) beliefs += m.size
    return {
      name: 'OmegaHive',
      version: '0.1.0-sim',
      agents: agents.length,
      swarms: [...this.swarms.values()].filter((s) => !s.archived_at).length,
      awake: agents.filter((a) => a.status === 'awake').length,
      beliefs,
      spent_usd: round6(agents.reduce((s, a) => s + a.spent_usd, 0)),
      limits: { goal_lease_minutes: LEASE_MINUTES, hive_budget_usd: 0, max_llm_calls_per_minute: 60 },
    }
  }

  getHive() {
    // the commons is the hive's centre: with its engine down the boot screen says so (never an empty-looking hive)
    return this.delay(() => (this.engine(), this.hiveInfo()))
  }
  /** The simulator starts no processes: say so rather than claim a sandbox. */
  agentIsolation(id: string) {
    return this.delay(() => {
      this.mustAgent(id)
      return { environment: 'simulated', os_sandbox: false, profile: null, note: 'The simulator runs no processes, so there is no operating-system sandbox to report.' }
    })
  }

  // --- Surface: minds-side (shares, inventory, portable, health mind)
  private _minds?: SimMinds
  private get minds() {
    return (this._minds ??= new SimMinds(this.agents))
  }
  listShares(opts?: { agent_id?: string; status?: string }) { return this.delay(() => this.minds.list(opts)) }
  shareReads(id: string) { return this.delay(() => this.minds.shareReads(id)) }
  revokeShare(id: string) {
    return this.delay(() => {
      const share = this.minds.revoke(id, this.simMe().principal)
      this.emit({ type: 'share.updated', at: this.now(), share: clone(share) as unknown as import('../types').ShareRecord })
      return share
    })
  }
  agentInventory(id: string) { return this.delay(() => this.minds.inventory(this.mustAgent(id))) }
  agentInventoryActivity(id: string, cycles = 30) { return this.delay(() => this.minds.activity(this.mustAgent(id), cycles)) }
  agentHealth(id: string) {
    const name = this.mustAgent(id).name
    return this.health().then((o) => o.minds.find((x) => x.id === id) ?? { id, name, swarm_id: null, status: 'stopped', health: 'ok' as const, issues: [], checked_commands: 0 })
  }
  healthMind() { return this.delay(() => this.minds.healthMind()) }
  // Surface: Health's idle minds (Platform idle-minds r2 shapes; api/sim/idleMinds, INVENTED)
  private _idle?: SimIdleMinds
  private get idle() {
    return (this._idle ??= new SimIdleMinds({
      agent: (id) => this.agents.get(id),
      me: () => { const m = this.simMe(); return { principal: m.principal, admin: m.kind === 'password' || m.role === 'admin' } },
      now: () => Date.now(),
    }))
  }
  idleMinds(opts?: { includePersonal?: boolean }) { return this.delay(() => this.idle.list(opts)) }
  idleMind(id: string, opts?: { includePersonal?: boolean }) { return this.delay(() => this.idle.detail(id, opts)) }
  remindIdle(id: string) { return this.delay(() => this.idle.remind(id)) }
  setHealthMind(id: string | null) { return this.delay(() => this.minds.setHealthMind(id)) }
  hiveIdentity() { return this.delay(() => ({ ...this.minds.identity })) }
  mindMoves(id: string) { return this.delay(() => this.minds.movesOf(id)) }
  exportMind(id: string) {
    return this.delay(() => this.mustAgent(id)).then((a) => this.minds.export(a, this.memoryOf(id), this.messages.get(id)?.length ?? 0))
  }
  settleMind(id: string, body: { to_hive: string; to_name: string; manifest_sha256: string }) {
    return this.delay(() => {
      const a = this.mustAgent(id)
      this.minds.settle(a, body)
      // the hive's status is 'moved'; the demo keeps 'stopped' and marks where it went
      Object.assign(a, { status: 'stopped', moved_to: body.to_hive, moved_to_name: body.to_name, connected: false })
      this.emit({ type: 'agent.updated', at: this.now(), agent: clone(a) })
      return clone(a)
    })
  }
  async importMind(bundle: Blob, swarmId?: string) {
    const s = await this.minds.readImport(bundle)
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await bundle.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join('')
    return this.delay(() => {
      const existing = this.agents.get(s.mindId) as (Agent & { moved_to?: string | null }) | undefined
      if (existing && !existing.moved_to) throw new ApiError(409, 'already_here', `${s.mindName} already lives on this hive`)
      const swarm = swarmId ?? existing?.swarm_id ?? s.swarm?.id
      if (!swarm || !this.swarms.has(swarm)) throw new ApiError(400, 'swarm_required', 'choose a swarm on this hive for the mind to join')
      const a: Agent = existing ?? { id: s.mindId, name: s.mindName, kind: s.kind as Agent['kind'], swarm_id: swarm, model: s.model, persona: '', hue: hashStr(s.mindId) % 360, status: 'created', driver: 'local', budget_usd: 0, spent_usd: 0, connected: false, last_active_at: null, created_at: this.now(), idle_sleep_minutes: 0 }
      Object.assign(a, { status: existing ? 'stopped' : 'created', swarm_id: swarm, moved_to: null, moved_to_name: null })
      if (!existing) {
        this.agents.set(a.id, a)
        this.messages.set(a.id, [])
        this.logs.set(a.id, [])
        const sw = this.swarms.get(swarm)!
        sw.member_ids.push(a.id)
        this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(sw) })
      }
      this.minds.arrived(a.id, s, digest)
      this.emit({ type: 'agent.updated', at: this.now(), agent: clone(a) })
      return { agent: clone(a), from: s.fromHive, manifest_sha256: digest }
    })
  }
  convertNative(id: string) {
    return this.delay(() => {
      const a = this.mustAgent(id)
      if (a.kind !== 'module') throw new ApiError(409, 'not_module', `${id} is already ${a.kind}`)
      if (a.status !== 'created' && a.status !== 'stopped') throw new ApiError(409, 'not_stopped', 'stop it first')
      Object.assign(a, { kind: 'omega', status: 'created' })
      this.emit({ type: 'agent.updated', at: this.now(), agent: clone(a) })
      return clone(a)
    })
  }
  goalGrants(goalId: string) {
    return this.delay((): GoalGrant[] => {
      if (!this.goals.has(goalId)) throw new ApiError(404, 'not_found', `no task ${goalId}`)
      return [...this.simGrants.values()].filter((g) => g.goal_id === goalId).sort((a, b) => a.created_at.localeCompare(b.created_at)).map((g) => this.grantView(g))
    })
  }
  /**
   * As hive/core/app.py:431-434 + services.py:199-205 at 60fa650: admin only (the sim session is always an admin);
   * 404 not_found "no grant <id>" unless that grant is on that goal (a missing goal answers the same); idempotent
   * (an already revoked grant keeps its first revoked_at); returns the grant view. Every capability under it is withdrawn,
   * so the relay refuses it (grant_invalid) from now on.
   */
  revokeGoalGrant(goalId: string, grantId: string) {
    return this.delay((): GoalGrant => {
      const g = this.simGrants.get(grantId)
      if (!g || g.goal_id !== goalId) throw new ApiError(404, 'not_found', `no grant ${grantId}`)
      if (!g.revoked_at) g.revoked_at = new Date().toISOString()
      return this.grantView(g)
    })
  }
  private simGrants = new Map<string, Omit<GoalGrant, 'active'>>()
  private grantView(g: Omit<GoalGrant, 'active'>): GoalGrant {
    return { ...g, active: !g.revoked_at && g.expires_at > Date.now() / 1000 }
  }
  /** SIM ONLY: put a grant in the table as the hive would (tests: another person's, an expired one). */
  simAddGrant(g: Omit<GoalGrant, 'active'>) {
    this.simGrants.set(g.id, { ...g })
  }
  private agreements = new SimAgreements(this.swarms)
  listConnections(swarmId: string) { return this.delay(() => (this.seedConnections(), this.agreements.list(swarmId))) }
  /** One standing connection so services granted through connections are visible in the demo. */
  private connectionsSeeded = false
  private seedConnections() {
    if (this.connectionsSeeded) return
    this.connectionsSeeded = true
    try {
      this.agreements.create({ from_swarm: 's_lyra', to_swarm: 's_forge', purpose: 'Security review of the lens-calibration code', deliverable: 'A review with findings per file', success: 'No open high findings', from_coordinator: 'a_vega01', to_coordinator: 'a_anvl09', scopes: [{ kind: 'requests', direction: 'from->to', kinds: ['security-review'] }], days: 14, budget_usd: 6, on_end: 'drain' })
    } catch {
      /* the demo's swarms changed: no seed */
    }
  }
  createConnection(body: import('../types').CreateRequestConnection) { return this.delay(() => this.agreements.create(body)) }
  connectionAction(id: string, action: import('../types').ConnectionAction, days?: number, reason?: string) {
    return this.delay(() => {
      if (!this.simAdmin()) throw adminOnly()
      const c = this.agreements.action(id, action, days, reason)
      // connections.py _emit: connection.updated on every change
      this.emit({ type: 'connection.updated', at: this.now(), connection: structuredClone(c) })
      return c
    })
  }
  // --- Surface request P: cross-swarm requests (INVENTED; the host's request_view over the sim's goals, ./requests.ts)
  private markSubmitted(g: Goal, by: string) {
    const log = this.goalReviewLog.get(g.id) ?? []
    g.status = 'submitted'
    g.submitted_at = this.now()
    g.lease_until = null
    this.goalReviewLog.set(g.id, [...log, { id: `gr_${g.id}_${log.length}`, goal_id: g.id, at: g.submitted_at, by: `agent:${by}`, action: 'submit', notes: '', result_digest: null }])
  }
  /**
   * SIM ONLY: the claiming mind submits its result (POST /api/agent/goals/{id}/result, status done). A goal that takes a
   * review becomes `submitted` (its request reads in-review) until the reviewer accepts (done → completed) or returns it
   * (claimed → working); one without a review is done at once.
   */
  simSubmitGoal(id: string, result: string) {
    const g = this.goals.get(id)
    if (!g) throw new ApiError(404, 'not_found', `no goal ${id}`)
    if (g.status !== 'claimed' || !g.claimed_by) throw new ApiError(409, 'not_claimed', `goal is ${g.status}`)
    g.result = result
    if (g.review_by && g.review_by !== 'none') this.markSubmitted(g, g.claimed_by)
    else {
      g.status = 'done'
      g.lease_until = null
    }
    this.emitGoal(g)
    return this.goalRow(g)
  }
  private simRequests = new Map<string, SimRequestRow>()
  /** GET /api/requests: the hive's newest 200, as the host. The sim visitor is an admin, so nothing is filtered out. */
  listRequests() {
    return this.delay((): CollabRequest[] => requestPage(this.simRequests.values(), (id) => this.goals.get(id)))
  }
  /** POST /api/requests/{id}/cancel (collab.py cancel_request): the request and those below it; open receiving goals end. */
  cancelRequest(id: string) {
    return this.delay(() => {
      if (!this.simRequests.has(id)) throw new ApiError(404, 'not_found', `no request ${id}`)
      const cancelled = cancelRequests(this.simRequests, id, this.now())
      for (const rid of cancelled) {
        const r = this.simRequests.get(rid)!
        const g = r.receiving_goal ? this.goals.get(r.receiving_goal) : undefined
        if (g && !['done', 'failed', 'cancelled'].includes(g.status)) {
          g.status = 'cancelled'
          g.lease_until = null
          this.emitGoal(g)
        } else this.emit({ type: 'request.updated', at: this.now(), request: requestView(r, g) })
      }
      return { cancelled, by: this.simMe().principal }
    })
  }
  /**
   * INVENTED requests around Forge, the coding swarm (it offers code-review): Lyra's patch is submitted and in review by a
   * person; Forge asked Kelp for evidence under the same budget root (nested, outgoing); Kelp's first request was
   * cancelled; Kelp's second is being worked on. Fixed ids and times, no draws from the living hive's random stream.
   */
  private seedRequests() {
    if (!this.swarms.has('s_forge') || !this.swarms.has('s_lyra') || !this.swarms.has('s_kelp')) return
    const now = Date.now()
    const at = (minutesAgo: number) => iso(now - minutesAgo * 60_000)
    const goal = (id: string, swarm_id: string, title: string, status: Goal['status'], by: string, claimed: string | null, minutesAgo: number, extra: Partial<Goal> = {}) => {
      const g: Goal = { id, swarm_id, parent_id: null, title, detail: '', priority: 0.6, status, created_by: by, claimed_by: claimed, result: null, created_at: at(minutesAgo), updated_at: at(Math.max(1, minutesAgo - 20)), lease_until: status === 'claimed' ? iso(now + 45 * 60_000) : null, attempts: 0, ...extra }
      this.goals.set(id, g)
      return g
    }
    // the requesting swarms' own goals (the origin of each request)
    goal('g_csorigin1', 's_lyra', 'Calibrate the lens array', 'claimed', 'agent:a_vega01', 'a_vega01', 300)
    goal('g_csorigin2', 's_kelp', 'Publish the tide-sensor readings', 'claimed', 'agent:a_coral5', 'a_coral5', 260)
    goal('g_csorigin3', 's_kelp', 'Clean the sensor intake', 'claimed', 'agent:a_coral5', 'a_coral5', 200)
    // Forge's receiving goals; each takes a person's review, as a requester's code would
    const review = { review_by: 'person', returns: 0, review_notes: null }
    const submitted = goal('g_csrecv1', 's_forge', 'Port the lens-calibration parser', 'submitted', 'agent:a_vega01', 'a_anvl09', 240, { ...review, result: 'Parser ported; tests added.', submitted_at: at(30) })
    this.goalReviewLog.set(submitted.id, [{ id: 'gr_csrecv1_0', goal_id: submitted.id, at: at(30), by: 'agent:a_anvl09', action: 'submit', notes: '', result_digest: null }])
    goal('g_csrecv2', 's_forge', 'Fix the tide-sensor unit conversion', 'cancelled', 'agent:a_coral5', null, 220, review)
    goal('g_csrecv3', 's_forge', 'Speed up the sensor intake loop', 'claimed', 'agent:a_coral5', 'a_bell10', 180, review)
    goal('g_csrecv4', 's_kelp', 'Check the parser against recorded tides', 'open', 'agent:a_anvl09', null, 150)
    const row = (r: Omit<SimRequestRow, 'ancestry'> & { ancestry?: string[] }) => this.simRequests.set(r.id, { ancestry: [], ...r })
    row({ id: 'rq_cslyra01', kind: 'code-review', title: '<b>Port the lens-calibration parser</b> Ω', from_swarm: 's_lyra', from_goal: 'g_csorigin1', from_principal: 'agent:a_vega01', to_swarm: 's_forge', receiving_goal: 'g_csrecv1', depth: 0, created_at: at(240), cancelled_at: null, budget_root: 'rq_cslyra01', limit_usd: 2, allocated_usd: 0.5 })
    row({ id: 'rq_cskelp01', kind: 'code-review', title: 'Fix the tide-sensor unit conversion', from_swarm: 's_kelp', from_goal: 'g_csorigin2', from_principal: 'agent:a_coral5', to_swarm: 's_forge', receiving_goal: 'g_csrecv2', depth: 0, created_at: at(220), cancelled_at: at(90), budget_root: 'rq_cskelp01', limit_usd: 2, allocated_usd: 0 })
    row({ id: 'rq_cskelp02', kind: 'code-review', title: 'Speed up the sensor intake loop', from_swarm: 's_kelp', from_goal: 'g_csorigin3', from_principal: 'agent:a_coral5', to_swarm: 's_forge', receiving_goal: 'g_csrecv3', depth: 0, created_at: at(180), cancelled_at: null, budget_root: 'rq_cskelp02', limit_usd: 1.5, allocated_usd: 0 })
    row({ id: 'rq_csforge01', kind: 'code-evidence', title: 'Check the parser against recorded tides', from_swarm: 's_forge', from_goal: 'g_csrecv1', from_principal: 'agent:a_anvl09', to_swarm: 's_kelp', receiving_goal: 'g_csrecv4', depth: 1, created_at: at(150), cancelled_at: null, budget_root: 'rq_cslyra01', limit_usd: 0.5, allocated_usd: 0, ancestry: ['rq_cslyra01'] })
  }
  getModels() {
    return this.delay(() => SIM_MODELS.map(({ id, provider, label, local }) => ({ id, provider, label, local })))
  }
  listSwarms(opts: { archived?: boolean } = {}) {
    // as live: archived swarms only on request (admins; the sim visitor is always an admin)
    return this.delay(() => clone([...this.swarms.values()].filter((s) => opts.archived || !s.archived_at)))
  }
  createSwarm(body: CreateSwarmBody) {
    return this.delay(() => {
      if (!body.name?.trim()) throw new ApiError(400, 'invalid', 'Name is required')
      const s: Swarm = {
        id: this.id('s_'),
        name: body.name.trim(),
        description: body.description ?? '',
        hue: body.hue ?? Math.floor(this.r(0, 360)),
        member_ids: [],
        created_at: this.now(),
      }
      this.swarms.set(s.id, s)
      this.beliefs.set(s.id, new Map())
      this.vocab.set(s.id, [])
      this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(s) })
      return clone(s)
    })
  }
  getSwarm(id: string) {
    return this.delay(() => clone(this.mustSwarm(id)))
  }
  updateSwarm(id: string, body: import('../types').UpdateSwarmBody) {
    return this.delay(() => {
      const sw = this.mustSwarm(id)
      const next: Partial<Swarm> = {}
      if ('name' in body) {
        if (!String(body.name ?? '').trim()) throw new ApiError(400, 'bad_request', 'name is required')
        next.name = String(body.name).trim().slice(0, 80)
      }
      if ('description' in body) next.description = String(body.description ?? '').slice(0, 2000)
      if ('coordinator_id' in body) {
        const cid = body.coordinator_id
        if (cid && this.agents.get(cid)?.swarm_id !== id) throw new ApiError(400, 'bad_coordinator', 'the coordinator must be a mind in this swarm')
        next.coordinator_id = cid || null
      }
      if ('parent_mind_id' in body) {
        const pid = body.parent_mind_id
        if (pid) {
          const mind = this.agents.get(pid)
          if (!mind || !mind.swarm_id || mind.swarm_id === id) throw new ApiError(400, 'bad_parent', 'the parent is a mind in another swarm')
          let depth = 1
          let at: string | null | undefined = mind.swarm_id
          while (at) {
            if (at === id) throw new ApiError(400, 'nesting_cycle', 'that would put this swarm inside itself')
            if (++depth > 4) throw new ApiError(400, 'too_deep', 'swarms nest at most four levels')
            const up: string | null | undefined = this.swarms.get(at)?.parent_mind_id
            at = up ? this.agents.get(up)?.swarm_id : null
          }
        }
        const old = sw.parent_swarm_id
        next.parent_mind_id = pid || null
        next.parent_swarm_id = pid ? this.agents.get(pid)!.swarm_id : null
        if (old && old !== next.parent_swarm_id) {
          const o = this.swarms.get(old)
          if (o) { o.child_swarm_ids = (o.child_swarm_ids ?? []).filter((c) => c !== id); this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(o) }) }
        }
        const np = next.parent_swarm_id ? this.swarms.get(next.parent_swarm_id) : undefined
        if (np && !(np.child_swarm_ids ?? []).includes(id)) { np.child_swarm_ids = [...(np.child_swarm_ids ?? []), id]; this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(np) }) }
      }
      Object.assign(sw, next)
      this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(sw) })
      return clone(sw)
    })
  }
  /** As hive._swarm_contents: minds (not external members), external members, tasks, artifacts, swarms inside its minds. */
  private swarmContents(id: string): SwarmCounts {
    const here = [...this.agents.values()].filter((a) => a.swarm_id === id)
    const mindIds = new Set(here.map((a) => a.id))
    return {
      minds: here.filter((a) => a.kind !== 'module').length,
      members: here.filter((a) => a.kind === 'module').length,
      goals: [...this.goals.values()].filter((g) => g.swarm_id === id).length,
      artifacts: this.mw.artifactCount(id),
      child_swarms: [...this.swarms.values()].filter((x) => x.parent_mind_id && mindIds.has(x.parent_mind_id)).length,
    }
  }
  /** As hive._counted: "2 minds, 1 task" (the host's own words: tasks, never goals). */
  private static counted(c: Partial<SwarmCounts>, keys: (keyof SwarmCounts)[]): string {
    const words: Record<keyof SwarmCounts, [string, string]> = { minds: ['mind', 'minds'], members: ['external member', 'external members'], goals: ['task', 'tasks'], artifacts: ['artifact', 'artifacts'], child_swarms: ['child swarm', 'child swarms'] }
    return keys.filter((k) => c[k]).map((k) => `${c[k]} ${words[k][c[k] === 1 ? 0 : 1]}`).join(', ')
  }
  /** As app.admin() and swarm visibility: a member gets 404 for a private swarm it cannot see, else 403 admin_only. */
  private mustAdminSwarm(id: string): Swarm {
    const sw = this.mustSwarm(id)
    if (!this.simAdmin()) {
      if (sw.visibility === 'private' && sw.owner !== this.simMe().principal) throw new ApiError(404, 'not_found', `No swarm ${id}`)
      throw new ApiError(403, 'admin_only', 'only a hive admin can do that')
    }
    return sw
  }
  /**
   * SIM ONLY, INVENTED: swarms with a flow still running (swarm_busy), minds whose stop never lands (minds_unstoppable),
   * and minds whose cleanup fails once after their delete committed (a partial answer with cleanup_pending and minds
   * remaining; the same request again finishes it). Forge, in order: Anvil's cleanup fails (1 pending, 2 remain), then
   * Quench's delete fails before its commit (a 200 with minds_unstoppable, 1 remains), then it finishes.
   */
  simRunningFlows = new Set<string>(['s_kelp'])
  simUnstoppable = new Set<string>(['a_mira04'])
  simCleanupFailsOnce = new Set<string>(['a_anvl09'])
  /** SIM ONLY, INVENTED: minds whose own delete step fails once before it commits (a 200 partial with minds_unstoppable). */
  simDeleteStopFailsOnce = new Set<string>(['a_qnch11'])
  /** SIM ONLY, INVENTED: swarms whose next delete goes through but whose answer is lost (as LiveClient's status-0 errors). */
  simLoseAnswerOnce = new Set<string>()
  /** Minds deleted whose cleanup is still owed (as the host's mind_cleanup rows), by swarm. */
  private simCleanupOwed = new Map<string, string[]>()
  /** As goals.release_rows' selection: unfinished tasks a mind holds or was given. */
  private releasable(mindIds: Set<string>): Goal[] {
    return [...this.goals.values()].filter((g) =>
      (['open', 'claimed', 'waiting', 'stalled'].includes(g.status) && ((g.assignee && mindIds.has(g.assignee)) || (g.claimed_by && mindIds.has(g.claimed_by)))) ||
      (g.status === 'submitted' && !!g.assignee && mindIds.has(g.assignee)))
  }
  /** As hive.delete_swarm (065e22d): only an empty swarm; otherwise 409 swarm_not_empty with counts, with_minds and a hint. */
  deleteSwarm(id: string) {
    return this.delay(() => {
      this.mustAdminSwarm(id)
      const counts = this.swarmContents(id)
      const blocking = SimClient.counted(counts, ['minds', 'members', 'goals', 'artifacts', 'child_swarms'])
      if (blocking) {
        const envelope: Record<string, unknown> = { code: 'swarm_not_empty', message: `only an empty swarm can be deleted; this one has ${blocking}`, counts, with_minds: counts.minds > 0 }
        if (counts.minds) envelope.hint = "send {with_minds: true, confirm: <the swarm's exact name>} to delete it together with its minds"
        throw new ApiError(409, 'swarm_not_empty', envelope.message as string, { envelope })
      }
      this.swarms.delete(id)
      this.emit({ type: 'swarm.deleted', at: this.now(), swarm_id: id })
      return { deleted: id }
    })
  }
  /** As hive.delete_preview (host r3): read-only; what delete-with-minds would do now. Admins only. */
  deleteSwarmPreview(id: string) {
    return this.delay((): SwarmDeletePreview => {
      const sw = this.mustAdminSwarm(id)
      const counts = this.swarmContents(id)
      const minds = [...this.agents.values()].filter((a) => a.swarm_id === id && a.kind !== 'module')
      const awake = minds.filter((a) => a.status === 'awake' || a.status === 'starting').map((a) => ({ id: a.id, name: a.name }))
      const kept: Partial<SwarmCounts> = {}
      for (const k of ['goals', 'artifacts', 'members'] as const) if (counts[k]) kept[k] = counts[k]
      const has = Object.keys(kept).length > 0
      return {
        name: sw.name,
        counts,
        awake_minds: awake,
        would: has ? 'archive' : 'delete',
        reason: has ? `it has history (${SimClient.counted(kept, ['goals', 'artifacts', 'members', 'minds'])})` : 'nothing would remain once its minds are deleted',
        released_tasks_estimate: this.releasable(new Set(minds.map((a) => a.id))).length,
        busy: this.simRunningFlows.has(id) ? 'a flow is still running here' : false,
      }
    })
  }
  /**
   * As hive.delete_swarm_with_minds (host r3), in its order: exact name (400 confirm_mismatch with `expected`); a running
   * flow refuses (409 swarm_busy); every awake or starting mind is stopped (any that cannot be: 409 minds_unstoppable,
   * nothing deleted); archive; owed cleanup finished first; each mind deleted, its unfinished tasks released (external
   * members stay); a cleanup that fails after a committed delete answers partially (archived, cleanup_pending, hint);
   * otherwise deleted with no history left, else archived with the reason. `released_tasks` on every answer.
   */
  deleteSwarmWithMinds(id: string, confirm: string) {
    return this.delay((): SwarmDeleteResult => {
      const result = this.deleteSwarmWithMindsNow(id, confirm)
      if (this.simLoseAnswerOnce.delete(id)) throw new ApiError(0, 'answer_unreadable', 'The hive answered but its answer could not be read (sim).')
      return result
    })
  }
  private deleteSwarmWithMindsNow(id: string, confirm: string): SwarmDeleteResult {
    {
      const sw = this.mustAdminSwarm(id)
      if (typeof confirm !== 'string' || confirm !== sw.name) {
        const message = "confirm must be the swarm's exact name"
        throw new ApiError(400, 'confirm_mismatch', message, { envelope: { code: 'confirm_mismatch', message, expected: sw.name } })
      }
      if (this.simRunningFlows.has(id)) throw new ApiError(409, 'swarm_busy', 'a flow is still running here; let it finish or cancel it first')
      const minds = [...this.agents.values()].filter((a) => a.swarm_id === id && a.kind !== 'module')
      const failed: { id: string; name: string; error: string }[] = []
      for (const a of minds) {
        if (a.status !== 'awake' && a.status !== 'starting') continue
        if (this.simUnstoppable.has(a.id)) failed.push({ id: a.id, name: a.name, error: 'the supervisor did not confirm the stop' })
        else {
          this.think(a, 'idle')
          this.setStatus(a, 'stopped')
        }
      }
      if (failed.length) {
        const message = `nothing was deleted; these minds could not be stopped: ${failed.map((f) => f.name).join(', ')}`
        throw new ApiError(409, 'minds_unstoppable', message, { envelope: { code: 'minds_unstoppable', message, failed, stopped_minds: [] } })
      }
      sw.archived_at = sw.archived_at ?? this.now()
      sw.archived_by = sw.archived_by ?? this.simMe().principal
      this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(sw) })
      const deleted: string[] = []
      // a retry first finishes the cleanup a previous attempt committed but could not complete
      for (const owed of this.simCleanupOwed.get(id) ?? []) deleted.push(owed)
      this.simCleanupOwed.delete(id)
      let released = 0
      const pending: string[] = []
      let error: SwarmDeleteResult['error'] | undefined
      for (const a of minds) {
        // before the commit: the mind's process is not confirmed gone, so it is not deleted (host: minds_unstoppable)
        if (this.simDeleteStopFailsOnce.delete(a.id)) {
          error = { code: 'minds_unstoppable', message: 'the process was not confirmed gone', mind: a.id }
          break
        }
        for (const g of this.releasable(new Set([a.id]))) {
          if (g.status === 'submitted') g.assignee = null
          else Object.assign(g, { status: 'open', assignee: null, claimed_by: null })
          g.updated_at = this.now()
          released++
        }
        this.agents.delete(a.id)
        sw.member_ids = sw.member_ids.filter((m) => m !== a.id)
        if (sw.coordinator_id === a.id) sw.coordinator_id = null
        this.emit({ type: 'agent.deleted', at: this.now(), agent_id: a.id })
        if (this.simCleanupFailsOnce.delete(a.id)) {
          pending.push(a.id)
          error = { code: 'cleanup_failed', message: 'the workspace of a deleted mind could not be removed yet', mind: a.id }
          break
        }
        deleted.push(a.id)
      }
      // as host detached_now(): only the swarms inside minds THIS call deleted stand on their own
      const gone = new Set([...deleted, ...pending])
      const detached = [...this.swarms.values()].filter((x) => x.parent_mind_id && gone.has(x.parent_mind_id)).map((x) => x.id)
      for (const cid of detached) {
        const c = this.swarms.get(cid)!
        c.parent_mind_id = null
        c.parent_swarm_id = null
        this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(c) })
      }
      sw.child_swarm_ids = (sw.child_swarm_ids ?? []).filter((c) => !detached.includes(c))
      if (error) {
        if (pending.length) this.simCleanupOwed.set(id, pending)
        this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(sw) })
        const remaining = [...this.agents.values()].filter((a) => a.swarm_id === id && a.kind !== 'module').map((a) => a.id)
        const result: SwarmDeleteResult = {
          swarm: 'archived',
          deleted_minds: [...deleted, ...pending],
          remaining_minds: remaining,
          error,
          hint: 'the swarm is archived and none of its minds is running; send the same request again to finish, or restore the swarm to keep the minds that remain',
          released_tasks: released,
        }
        if (pending.length) result.cleanup_pending = pending
        if (detached.length) result.detached_swarms = detached
        return result
      }
      const counts = this.swarmContents(id)
      const kept: Partial<SwarmCounts> = {}
      for (const k of ['goals', 'artifacts', 'members', 'minds'] as const) if (counts[k]) kept[k] = counts[k]
      let result: SwarmDeleteResult
      if (!Object.keys(kept).length) {
        this.swarms.delete(id)
        this.emit({ type: 'swarm.deleted', at: this.now(), swarm_id: id })
        result = { deleted_minds: deleted, swarm: 'deleted', released_tasks: released }
      } else {
        this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(sw) })
        result = { deleted_minds: deleted, swarm: 'archived', reason: `it has history (${SimClient.counted(kept, ['goals', 'artifacts', 'members', 'minds'])})`, released_tasks: released }
      }
      if (detached.length) result.detached_swarms = detached
      return result
    }
  }
  archiveSwarm(id: string) {
    return this.delay(() => {
      const sw = this.mustSwarm(id)
      const busy = sw.member_ids.map((m) => this.agents.get(m)).filter((a) => a && (a.status === 'awake' || a.status === 'starting'))
      if (busy.length) throw new ApiError(409, 'swarm_busy', `stop or move these minds first: ${busy.map((a) => a!.name).join(', ')}`)
      sw.archived_at = this.now()
      sw.archived_by = this.simMe().principal
      this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(sw) })
      return clone(sw)
    })
  }
  restoreSwarm(id: string) {
    return this.delay(() => {
      const sw = this.mustSwarm(id)
      sw.archived_at = null
      sw.archived_by = null
      this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(sw) })
      return clone(sw)
    })
  }
  listBeliefs(id: string) {
    return this.delay(() => {
      this.mustSwarm(id)
      this.engine()
      return [...this.beliefs.get(id)!.values()].map(stripDetail)
    })
  }
  getBeliefDetail(id: string, statement: string) {
    return this.delay(() => {
      this.mustSwarm(id)
      this.engine()
      const b = this.beliefs.get(id)!.get(statement)
      if (!b) throw new ApiError(404, 'not_found', 'No such belief')
      return clone(b)
    })
  }
  /** The swarm's vocabulary as the engine holds it (service.py vocab: sorted). */
  getVocab(id: string) {
    return this.delay(() => {
      this.mustSwarm(id)
      return this.prepareCommons(id).vocab(id)
    })
  }
  /** hive-vocab-add! on the engine (service.py add_vocab); the words also join what the sim's minds talk about. */
  addVocab(id: string, terms: string[]) {
    return this.delay(() => {
      this.mustSwarm(id)
      const words = terms.map((x) => x.trim()).filter(Boolean)
      let held: string[]
      try {
        held = this.prepareCommons(id).addVocab(id, words)
      } catch (e) {
        if (e instanceof CommonsEngineError && e.kind === 'invalid') throw new ApiError(400, 'invalid', e.message)
        throw e
      }
      const v = this.vocab.get(id) ?? []
      for (const t of words) if (!v.includes(t)) v.push(t)
      this.vocab.set(id, v)
      return held
    })
  }
  listAgents() {
    return this.delay(() => clone([...this.agents.values()]).map((a) => this.withFlags(a)))
  }
  createAgent(body: CreateAgentBody): Promise<CreatedAgent> {
    return this.delay(() => {
      if (!body.name?.trim()) throw new ApiError(400, 'invalid', 'Name is required')
      if ([...this.agents.values()].some((a) => a.name.toLowerCase() === body.name.trim().toLowerCase()))
        throw new ApiError(409, 'conflict', `A mind named ${body.name.trim()} already exists`)
      if (body.swarm_id) this.mustSwarm(body.swarm_id)
      if (body.role_id) this.mustRole(body.role_id)
      const a: Agent = {
        id: this.id('a_'),
        name: body.name.trim(),
        role_id: body.role_id ?? null,
        kind: body.kind,
        swarm_id: body.swarm_id ?? null,
        model: body.model,
        persona: body.persona ?? '',
        hue: body.hue ?? Math.floor(this.r(0, 360)),
        status: 'created',
        driver: 'local',
        budget_usd: body.budget_usd ?? 0,
        options: body.options ?? {},
        spent_usd: 0,
        connected: false,
        last_active_at: null,
        created_at: this.now(),
        idle_sleep_minutes: 0,
      }
      // a new mind joins the Coffee Room the moment it is made (out by default in a private swarm)
      a.coffee = SimRooms.membership(a, this.coffeePrivate(a))
      this.agents.set(a.id, a)
      this.voices.set(a.id, this.pick(['precise', 'warm', 'terse', 'poetic', 'wry'] as const))
      this.messages.set(a.id, [])
      this.logs.set(a.id, [])
      this.emit({ type: 'agent.updated', at: this.now(), agent: clone(a) })
      if (a.swarm_id) {
        const s = this.swarms.get(a.swarm_id)!
        s.member_ids.push(a.id)
        this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(s) })
      }
      this.pushLog(a, 'INFO', `boot: created (${a.kind}, ${a.model})`)
      this.later(900, () => {
        this.pushLog(a, 'INFO', 'boot: loading persona and memory')
        this.setStatus(a, 'starting')
        this.later(1800, () => {
          this.pushLog(a, 'INFO', 'hub: connected')
          this.setStatus(a, 'awake')
        }, true)
      }, true)
      let token = 'hvt_'
      for (let i = 0; i < 40; i++) token += 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'[Math.floor(Math.random() * 56)]
      return { ...clone(a), token }
    })
  }
  getAgent(id: string) {
    return this.delay(() => this.withFlags(clone(this.mustAgent(id))))
  }
  patchAgent(id: string, body: PatchAgentBody) {
    return this.delay(() => {
      const a = this.mustAgent(id)
      if (body.swarm_id !== undefined && body.swarm_id !== a.swarm_id) {
        if (body.swarm_id) this.mustSwarm(body.swarm_id)
        for (const s of this.swarms.values()) {
          const had = s.member_ids.includes(id)
          const want = s.id === body.swarm_id
          if (had !== want) {
            s.member_ids = want ? [...s.member_ids, id] : s.member_ids.filter((m) => m !== id)
            this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(s) })
          }
        }
      }
      if (body.idle_sleep_minutes !== undefined && (!Number.isFinite(body.idle_sleep_minutes) || body.idle_sleep_minutes < 0))
        throw new ApiError(400, 'invalid', 'idle_sleep_minutes must be 0 or more')
      const { coffee, ...rest } = body
      if (coffee !== undefined) {
        const me = this.simMe()
        if (me.kind !== 'password' && me.role !== 'admin') throw new ApiError(403, 'forbidden', "an admin puts a mind in or out of the Coffee Room")
        if (a.coffee === 'not_a_mind') throw new ApiError(400, 'bad_request', 'an app module is not a mind; it never joins the Coffee Room')
        a.coffee = coffee ? 'member' : this.coffeePrivate(a) ? 'private' : 'opted_out'
        this.emit({ type: 'room', at: this.now(), room_id: this.roomsHost.coffee().id, what: 'members' } as HiveEvent)
      }
      Object.assign(a, rest)
      this.pushLog(a, 'INFO', `config: updated ${Object.keys(body).join(', ')}`)
      this.emit({ type: 'agent.updated', at: this.now(), agent: clone(a) })
      return this.withFlags(clone(a))
    })
  }
  deleteAgent(id: string) {
    return this.delay(() => {
      this.mustAgent(id)
      this.agents.delete(id)
      for (const s of this.swarms.values()) {
        if (s.member_ids.includes(id)) {
          s.member_ids = s.member_ids.filter((m) => m !== id)
          this.emit({ type: 'swarm.updated', at: this.now(), swarm: clone(s) })
        }
      }
      this.emit({ type: 'agent.deleted', at: this.now(), agent_id: id })
      return { ok: true as const }
    })
  }
  agentAction(id: string, action: AgentAction) {
    return this.delay(() => {
      const a = this.mustAgent(id)
      switch (action) {
        case 'start':
        case 'wake':
          {
            const refusal = this.spendRefusal(a)
            if (action === 'wake' && refusal) throw new ApiError(402, refusal.code, refusal.message)
          }
          if (a.status === 'awake') break
          this.pushLog(a, 'INFO', `supervisor: ${action}`)
          this.setStatus(a, 'starting')
          this.later(this.r(900, 1600), () => {
            if (a.status === 'starting') {
              this.pushLog(a, 'INFO', 'hub: connected')
              this.setStatus(a, 'awake')
            }
          }, true)
          break
        case 'sleep':
          this.pushLog(a, 'INFO', 'supervisor: sleep')
          this.think(a, 'idle')
          this.setStatus(a, 'asleep')
          break
        case 'stop':
          this.pushLog(a, 'INFO', 'supervisor: stop')
          this.think(a, 'idle')
          this.setStatus(a, 'stopped')
          break
      }
      return this.withFlags(clone(a))
    })
  }
  listMessages(id: string, opts: { conversation_id?: string; limit?: number } = {}) {
    return this.delay(() => {
      this.mustAgent(id)
      let list = this.messages.get(id) ?? []
      if (opts.conversation_id) list = list.filter((m) => m.conversation_id === opts.conversation_id)
      if (opts.limit) list = list.slice(-opts.limit)
      return clone(list)
    })
  }
  sendMessage(id: string, body: { text: string; conversation_id?: string }) {
    return this.delay(() => {
      const a = this.mustAgent(id)
      if (!body.text.trim()) throw new ApiError(400, 'invalid', 'Empty message')
      // host r4 (hive.py send_to_agent): the Coffee Room delivers only through itself, never as a classic message
      if (this.roomsHost.isCoffee(body.conversation_id)) throw new ApiError(400, 'bad_request', 'speak in the Coffee Room through the room, not a direct message')
      // host privacy r4 (app.py post_message): the mind hears the real sender, never user:operator for a named person
      const m = this.say(a, body.text, body.conversation_id ?? 'c_main', 'in', this.simMe().principal)
      this.respond(a, m)
      return clone(m)
    })
  }
  getLogs(id: string, tail = 200) {
    return this.delay(() => {
      this.mustAgent(id)
      return { lines: (this.logs.get(id) ?? []).slice(-tail) }
    })
  }
  listUsage(opts: { agent_id?: string; since?: string } = {}) {
    return this.delay(() =>
      this.usage.filter(
        (u) => (!opts.agent_id || u.agent_id === opts.agent_id) && (!opts.since || u.created_at >= opts.since),
      ),
    )
  }

  // ---- Phase 2 REST

  listPolicy() {
    return this.delay(() => clone(this.policy))
  }
  createPolicy(body: CreatePolicyBody) {
    return this.delay(() => {
      if (!body.skill?.trim()) throw new ApiError(400, 'invalid', 'Skill glob is required')
      if (!['allow', 'ask', 'deny'].includes(body.mode)) throw new ApiError(400, 'invalid', 'Mode must be allow, ask or deny')
      if (body.scope !== 'hive') {
        const i = body.scope.indexOf(':')
        const kind = body.scope.slice(0, i)
        const id = body.scope.slice(i + 1)
        if (kind === 'swarm') this.mustSwarm(id)
        else if (kind === 'agent') this.mustAgent(id)
        else throw new ApiError(400, 'invalid', 'Scope must be hive, swarm:<id> or agent:<id>')
      }
      const rule: PolicyRule = { id: this.id('r_'), scope: body.scope, skill: body.skill.trim(), mode: body.mode, note: body.note?.trim() ?? '', created_at: this.now() }
      this.policy.push(rule)
      this.emit({ type: 'policy.updated', at: this.now(), rules: clone(this.policy) })
      return clone(rule)
    })
  }
  deletePolicy(id: string) {
    return this.delay(() => {
      const i = this.policy.findIndex((r) => r.id === id)
      if (i < 0) throw new ApiError(404, 'not_found', 'No such rule')
      this.policy.splice(i, 1)
      this.emit({ type: 'policy.updated', at: this.now(), rules: clone(this.policy) })
      return { ok: true as const }
    })
  }
  listApprovals(status?: ApprovalStatus) {
    return this.delay(() =>
      clone([...this.approvals.values()].filter((a) => !status || a.status === status).sort((x, y) => y.created_at.localeCompare(x.created_at))),
    )
  }
  private decideApproval(id: string, status: 'approved' | 'denied') {
    const ap = this.approvals.get(id)
    if (!ap) throw new ApiError(404, 'not_found', 'No such approval')
    if (ap.status !== 'pending') throw new ApiError(409, 'conflict', `Already ${ap.status}`)
    ap.status = status
    ap.decided_by = 'user:operator'
    ap.decided_at = this.now()
    this.emit({ type: 'approval.updated', at: ap.decided_at, approval: clone(ap) })
    return ap
  }
  approve(id: string, remember = false) {
    return this.delay(() => {
      const ap = this.decideApproval(id, 'approved')
      const a = this.agents.get(ap.agent_id)
      if (remember && a) {
        this.policy.push({ id: this.id('r_'), scope: `agent:${a.id}`, skill: ap.skill, mode: 'allow', note: `Always allowed (from ${ap.id})`, created_at: this.now() })
        this.emit({ type: 'policy.updated', at: this.now(), rules: clone(this.policy) })
      }
      if (a) this.pushLog(a, 'INFO', `authorize: ${ap.id} approved by operator${remember ? ' (always allow)' : ''}`)
      this.later(this.r(1400, 2600), () => this.useApproval(ap), true)
      return clone(ap)
    })
  }
  deny(id: string) {
    return this.delay(() => {
      const ap = this.decideApproval(id, 'denied')
      const a = this.agents.get(ap.agent_id)
      if (a) this.pushLog(a, 'WARN', `authorize: ${ap.id} denied by operator`)
      return clone(ap)
    })
  }
  async answerApproval(id: string, decision: 'once' | 'for' | 'always' | 'no' | 'never', minutes?: number) {
    if (decision === 'once' || decision === 'always') return this.approve(id, decision === 'always')
    if (decision === 'no') return this.deny(id)
    const ap = decision === 'for' ? await this.approve(id) : await this.deny(id)
    this.policy.push({ id: this.id('r_'), scope: `agent:${ap.agent_id}`, skill: ap.skill, mode: decision === 'for' ? 'allow' : 'deny',
      note: decision === 'for' ? `Allowed for ${minutes} min (from ${ap.id})` : `Never (from ${ap.id})`, created_at: this.now() })
    this.emit({ type: 'policy.updated', at: this.now(), rules: clone(this.policy) })
    return ap
  }
  board(scope: Scope, entityId?: string): Promise<Board> {
    return this.delay(() => ({ kind: scope, entity_id: entityId ?? null, goals: clone([...this.goals.values()].filter(g => scope === 'grand' || (scope === 'swarm' ? g.swarm_id === entityId : g.claimed_by === entityId || g.assignee === entityId || g.created_by === 'agent:' + entityId))), requests: [] }))
  }
  matchServices(need: string, kind: 'mind' | 'swarm' = 'swarm'): Promise<Matches> {
    if (kind === 'mind') return this.delay(() => ({candidates: [...this.agents.values()]
      .filter(a => [...this.roles.values()].some(r => r.name.toLowerCase() === need.toLowerCase() && this.roleView(r).minds.includes(a.id)))
      .map(a => ({entity_id: a.id, name: a.name, active_claims: [...this.goals.values()].filter(g => g.claimed_by === a.id && ['claimed', 'waiting'].includes(g.status)).length,
        eligibility: 'unverified', capacity: 'unknown', cost: 'unknown', verified_capabilities: [],
        reasons: ['Configured role matches (simulated)'], uncertainties: ['Role is not demonstrated capability; policy and independence require assessment']}))
      .sort((a, b) => a.active_claims - b.active_claims || a.entity_id.localeCompare(b.entity_id))}))
    return this.delay(() => ({ candidates: [...this.swarms.values()]
      .filter(s => s.services?.includes(need))
      .map(s => ({ entity_id: s.id, name: s.name,
        active_claims: [...this.goals.values()].filter(g => g.swarm_id === s.id && ['claimed', 'waiting'].includes(g.status)).length,
        eligibility: 'unverified', capacity: 'unknown', cost: 'unknown', verified_capabilities: [],
        reasons: ['Advertises requested service (simulated)'],
        uncertainties: ['Synthetic demo; no demonstrated capability or policy qualification'],
      })).sort((a, b) => a.active_claims - b.active_claims || a.entity_id.localeCompare(b.entity_id)) }))
  }
  listGoals(swarmId: string) {
    return this.delay(() => {
      this.mustSwarm(swarmId)
      return [...this.goals.values()].filter((g) => g.swarm_id === swarmId).map((g) => this.goalRow(g))
    })
  }
  createGoal(swarmId: string, body: CreateGoalBody) {
    return this.delay(() => this.makeGoal(swarmId, body, 'user:operator'))
  }
  private makeGoal(swarmId: string, body: CreateGoalBody, createdBy: string): Goal {
    this.mustSwarm(swarmId)
    if (!body.title?.trim()) throw new ApiError(400, 'invalid', 'Title is required')
    if (body.assignee && this.agents.get(body.assignee)?.swarm_id !== swarmId) throw new ApiError(404, 'not_found', 'Assignee is not in this swarm')
    if (body.parent_id) {
      const p = this.goals.get(body.parent_id)
      if (!p || p.swarm_id !== swarmId) throw new ApiError(400, 'invalid', 'Parent goal is not in this swarm')
    }
    const g: Goal = {
      id: this.id('g_'),
      swarm_id: swarmId,
      parent_id: body.parent_id ?? null,
      assignee: body.assignee ?? null,
      title: body.title.trim(),
      detail: body.detail ?? '',
      priority: clamp01(body.priority ?? 0.5),
      status: 'open',
      created_by: createdBy,
      claimed_by: null,
      result: null,
      created_at: this.now(),
      updated_at: this.now(),
      lease_until: null,
      attempts: 0,
    }
    this.goals.set(g.id, g)
    this.emit({ type: 'goal.updated', at: g.created_at, goal: clone(g) })
    // the swarm hears about it (hub envelope event: "goal") and an awake member picks it up
    this.later(this.r(2500, 5000), () => {
      const parent = g.parent_id ? this.goals.get(g.parent_id) : null
      if (parent && parent.status !== 'claimed') return
      const awake = (this.swarms.get(swarmId)?.member_ids ?? []).map((m) => this.agents.get(m)).filter((a): a is Agent => !!a && a.status === 'awake')
      const eligible = awake.filter(a => !g.assignee || a.id === g.assignee)
      if (eligible.length) this.claimGoal(g, this.pick(eligible))
    }, true)
    return clone(g)
  }
  patchGoal(id: string, body: PatchGoalBody) {
    return this.delay(() => {
      const g = this.goals.get(id)
      if (!g) throw new ApiError(404, 'not_found', 'No such goal')
      if (body.title !== undefined && !body.title.trim()) throw new ApiError(400, 'invalid', 'Title is required')
      if (body.title !== undefined) g.title = body.title.trim()
      if (body.detail !== undefined) g.detail = body.detail
      if (body.priority !== undefined) g.priority = clamp01(body.priority)
      if (body.status !== undefined) {
        if (body.status === 'done' && !g.result) g.result = 'Marked done by the operator.'
        if (body.status === 'open' && g.status === 'stalled') g.attempts = 0
        g.status = body.status
        if (body.status === 'open') {
          g.claimed_by = null
          g.result = null
          g.lease_until = null
        } else if (body.status !== 'claimed') g.lease_until = null
      }
      this.emitGoal(g)
      return clone(g)
    })
  }
  listTraces(agentId: string, limit = 50) {
    return this.delay(() => {
      this.mustAgent(agentId)
      return clone((this.traces.get(agentId) ?? []).slice(-limit).reverse())
    })
  }
  listWakeups(agentId: string) {
    return this.delay(() => {
      this.mustAgent(agentId)
      return clone([...this.wakeups.values()].filter((w) => w.agent_id === agentId))
    })
  }
  private validateWakeup(w: Pick<Wakeup, 'cron' | 'at' | 'tz' | 'text'>) {
    if (!w.text?.trim()) throw new ApiError(400, 'invalid', 'Tell the mind what to do when it wakes')
    if (!!w.cron === !!w.at) throw new ApiError(400, 'invalid', 'Give exactly one of cron or at')
    if (w.cron) {
      const err = cronError(w.cron)
      if (err) throw new ApiError(400, 'invalid', err)
    }
    if (w.at && Number.isNaN(Date.parse(w.at))) throw new ApiError(400, 'invalid', 'at must be an ISO time')
    if (!isValidTz(w.tz)) throw new ApiError(400, 'invalid', `Unknown time zone ${w.tz}`)
  }
  createWakeup(agentId: string, body: CreateWakeupBody) {
    return this.delay(() => {
      this.mustAgent(agentId)
      const w: Wakeup = {
        id: this.id('w_'),
        agent_id: agentId,
        cron: body.cron?.trim() || null,
        at: body.at || null,
        tz: body.tz || 'UTC',
        text: body.text?.trim() ?? '',
        enabled: true,
        next_run_at: null,
        last_run_at: null,
      }
      this.validateWakeup(w)
      if (w.at && Date.parse(w.at) <= Date.now()) throw new ApiError(400, 'invalid', 'That time has already passed')
      w.next_run_at = this.computeNext(w)
      this.wakeups.set(w.id, w)
      this.emit({ type: 'wakeup.updated', at: this.now(), wakeup: clone(w) })
      return clone(w)
    })
  }
  patchWakeup(id: string, body: PatchWakeupBody) {
    return this.delay(() => {
      const w = this.wakeups.get(id)
      if (!w) throw new ApiError(404, 'not_found', 'No such wakeup')
      const next = { ...w, ...body }
      if (body.cron) next.at = null
      if (body.at) next.cron = null
      this.validateWakeup(next)
      Object.assign(w, next)
      w.next_run_at = this.computeNext(w)
      this.emit({ type: 'wakeup.updated', at: this.now(), wakeup: clone(w) })
      return clone(w)
    })
  }
  deleteWakeup(id: string) {
    return this.delay(() => {
      if (!this.wakeups.delete(id)) throw new ApiError(404, 'not_found', 'No such wakeup')
      return { ok: true as const }
    })
  }
  listMemory(agentId: string) {
    return this.delay((): MemorySpace[] =>
      [...this.memoryOf(agentId).entries()].map(([name, atoms]) => ({
        name,
        atoms: atoms.length,
        bytes: atoms.reduce((n, t) => n + new TextEncoder().encode(t).length + 1, 0),
      })),
    )
  }
  listAtoms(agentId: string, space: string, opts: { q?: string; limit?: number } = {}) {
    return this.delay((): MemoryAtom[] => {
      const atoms = this.memoryOf(agentId).get(space)
      if (!atoms) throw new ApiError(404, 'not_found', `No space ${space}`)
      const q = opts.q?.trim().toLowerCase()
      return atoms
        .map((text, index) => ({ index, text }))
        .filter((x) => !q || x.text.toLowerCase().includes(q))
        .slice(0, opts.limit ?? 200)
    })
  }
  retireAtom(agentId: string, space: string, atom: string) {
    return this.delay(() => {
      const a = this.mustAgent(agentId)
      const atoms = this.memoryOf(agentId).get(space)
      if (!atoms) throw new ApiError(404, 'not_found', `No space ${space}`)
      if (!atoms.includes(atom)) throw new ApiError(404, 'not_found', 'No such atom')
      // the agent drains GET /api/agent/control on its next loop
      this.later(this.r(4000, 7000), () => {
        const i = atoms.indexOf(atom)
        if (i >= 0) atoms.splice(i, 1)
        this.pushLog(a, 'INFO', `memory: retired 1 atom from ${space}`)
      }, true)
      return { queued: true as const }
    })
  }
  resetMemory(agentId: string) {
    return this.delay(() => {
      const a = this.mustAgent(agentId)
      const mem = this.memoryOf(agentId)
      this.later(this.r(3000, 5000), () => {
        for (const atoms of mem.values()) atoms.length = 0
        this.pushLog(a, 'WARN', 'memory: reset; all private spaces cleared')
      }, true)
      return { queued: true as const }
    })
  }
  // ------------------------------------------------------------------ Hive power (Surface; SIM ONLY, invented)

  /** SIM ONLY: the power host (sim/power.ts); its failStop/failWake sets play partial failures. */
  readonly simPower = new SimPower({
    agents: () => [...this.agents.values()],
    agent: (id) => this.agents.get(id),
    archived: (a) => !!(a.swarm_id && this.swarms.get(a.swarm_id)?.archived_at),
    moved: (a) => !!(a as { moved_to?: unknown }).moved_to,
    stop: (a) => {
      if (a.status === 'stopped') return
      this.pushLog(a, 'WARN', 'supervisor: hive off')
      this.think(a, 'idle')
      this.setStatus(a, 'stopped')
    },
    wake: (a) => {
      this.pushLog(a, 'INFO', 'supervisor: hive on')
      this.setStatus(a, 'starting')
      this.later(this.r(700, 1500), () => a.status === 'starting' && this.setStatus(a, 'awake'), true)
    },
    emit: (e) => this.emit(e),
    now: () => this.now(),
  })
  /** SIM ONLY: play a member (not an admin), for the non-admin views. `?simrole=member` sets it at load. */
  simMember = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simrole') === 'member'
  getPower() {
    return this.delay(() => this.simPower.view(this.simAdmin()))
  }
  setPower(body: import('../../features/power/api').PowerBody) {
    return this.delay(() => this.simPower.set(body, { admin: this.simAdmin(), principal: this.simMe().principal }))
  }
  private simAdmin() {
    const me = this.simMe()
    return me.kind === 'password' || me.role === 'admin'
  }

  stopAll() {
    return this.delay(() => {
      // as the host (293fe18): the minds meant to be awake go into the pending power snapshot first, so Wake all restores them
      this.simPower.record(this.simPower.wakeable().map((a) => a.id), this.simMe().principal, 'stopped')
      // a mind the supervisor cannot stop (the power fixture failStop) stays as it is; the rest still stop (host 749b8d6)
      const failed = [...this.agents.values()].filter((a) => this.simPower.failStop.has(a.id)).map((a) => ({ id: a.id, error: 'supervisor did not confirm the stop within 10 s (invented)' }))
      const list = [...this.agents.values()].filter((a) => a.status !== 'stopped' && !this.simPower.failStop.has(a.id))
      // the hive stops everything at once; the events ripple out so the scene shows a wave
      list.forEach((a, i) => {
        a.status = 'stopped'
        a.connected = false
        a.last_active_at = this.now()
        this.later(40 + i * 70, () => {
          this.think(a, 'idle')
          this.pushLog(a, 'WARN', 'supervisor: stop-all (kill switch)')
          this.emit({ type: 'agent.updated', at: this.now(), agent: clone(a) })
        }, true)
      })
      if (failed.length)
        throw new ApiError(500, 'stop_incomplete', `${failed.length} mind(s) could not be stopped: ${failed.map((f) => f.id).join(', ')}`, { envelope: { code: 'stop_incomplete', stopped: list.length, failed } })
      return { stopped: list.length }
    })
  }

  // ------------------------------------------------------------------ Hive programs

  programs() {
    return this.delay(() => this.programsHost.list())
  }
  program(id: string) {
    return this.delay(() => withEffectiveConfirm(this.programsHost.detail(id)))
  }
  /** Where an app works, best first, among the swarms in use (api/sim/programs.ts SIM_APP_HOMES; invented). */
  programHomes(id: string) {
    return this.delay(() => this.programsHost.homes(id, new Set([...this.swarms.values()].filter((s) => !s.archived_at).map((s) => s.id))))
  }
  programView(id: string, body: ProgramViewBody) {
    if (this.slowApps.has(id)) return new Promise<void>((r) => setTimeout(r, 6000)).then(() => this.programsHost.view(id, body.swarm_id, body.focus, body.stage))
    return this.delay(() => this.programsHost.view(id, body.swarm_id, body.focus, body.stage))
  }
  programAct(id: string, body: ProgramActBody) {
    // G2 candidate: an optional file from the signed-in person (sim session), checked by the sim host's rules
    return this.delay(async () => {
      // §9d: a confirm action needs the host's token for exactly this payload (sim host rules: api/sim/confirmTokens.ts)
      const declared = this.programsHost.detail(id).describe?.actions.find((a) => a.id === body.action)
      if (body.idempotency_key) this.personActivityGate(id, body.swarm_id, body.action)   // the host checks the person and key first
      const recorded = await this.confirmTokens.take(id, declared, this.confirmSession(), body)
      if (recorded) return recorded   // the recovery of a completed intent: the program is not called again
      const result = await this.programsHost.act(id, body.swarm_id, body.action, body.items, body.params ?? {}, body.base_revision, { file: body.file ?? null, person: this.simSession === 'person', idempotencyKey: body.idempotency_key ?? null })
      this.confirmTokens.record(id, declared, this.confirmSession(), body, result)
      return result
    }).then((p) => p)
  }
  /** §9d: the host confirm token, minted after the person confirms in the host (sim host rules). */
  confirmAct(id: string, swarmId: string, action: string, payload: import('../../lib/confirmDigest').ConfirmPayload, payloadDigest: string) {
    return this.delay(() => (this.personActivityGate(id, swarmId, action), this.confirmTokens.mint(id, this.programsHost.detail(id).describe?.actions ?? [], this.confirmSession(), { swarm_id: swarmId, action, payload, payload_digest: payloadDigest }))).then((t) => t)
  }
  /**
   * The host's activation gate for a named person's act on a person_activity action (program_actions.py): an app that
   * uses activations must be switched on in this swarm, else 403 app_inactive before any token or act (demo D3).
   */
  private personActivityGate(id: string, swarmId: string, action: string) {
    const declared = this.programsHost.detail(id).describe?.actions.find((a) => a.id === action)
    if (declared?.person_activity === true && this.confirmSession().person && this.mw.appInactive(id, swarmId))
      throw new ApiError(403, 'app_inactive', 'activate the app in this swarm before human participation')
  }
  /** SIM ONLY, demo mode (D3): Studio's own interface, an INVENTED stand-in served as the app's pinned files. */
  programUi(id: string) {
    return this.delay(() => {
      if (!this.demo || id !== 'omegadesign') throw new ApiError(404, 'not_found', `${id} ships no interface in this demo`)
      return { program: id, files: { ...SIM_STUDIO_FILES } }
    })
  }
  /** SIM ONLY: the confirm tokens this sim host has minted (their hashes), and the intents they completed. */
  readonly confirmTokens = new SimConfirmTokens()
  private confirmSession(): SimSession {
    const me = this.simMe()
    return { principal: me.principal, person: this.simSession === 'person', session: `sim:${this.simSession}` }
  }
  /** G1 candidate: a declared read (sim host rules: declared, JSON, at most 4 MB, never persisted). */
  programRead(id: string, swarmId: string, query: string, params: Record<string, unknown> | null) {
    // J3 r4.3 (sim): Studio's exact proposal read (`studio-proposals` with the exact ref), read-only, never execution
    if (id === 'omegadesign' && query === 'studio-proposals' && this.studioHostLazy) return this.delay(() => this.studioHostLazy!.readProposal(params ?? {}) as never)
    return this.delay(() => this.programsHost.read(id, swarmId, query, params))
  }
  programEnable(id: string) {
    return this.delay(() => this.programsHost.setEnabled(id, true))
  }
  programDisable(id: string) {
    return this.delay(() => this.programsHost.setEnabled(id, false))
  }
  programsReload() {
    return this.delay(() => this.programsHost.reload())
  }

  // ------------------------------------------------------------------ Admin surfaces (invented data)

  private roles = new Map<string, Role>(
    SEED_ROLES.map((r) => [r.id, { ...clone(r), created_at: iso(Date.now() - 30 * 86_400_000), updated_at: iso(Date.now() - 2 * 86_400_000) }]),
  )
  private budgets: BudgetRow[] = SEED_BUDGETS.map(([scope, period, limit_usd, note], i) => ({ id: `b_sim${i + 1}`, scope, period, limit_usd, spent_usd: 0, note, origin: 'rule' }))
  private budgetSeq = SEED_BUDGETS.length

  /** The demo's visitor is the hive's operator, signed in on its own machine. */
  private simLook: UiPrefs | null = cachedLook()
  /**
   * The look's revision, as Platform's host keeps it (platform/ui-prefs-revision): every answer carries it, a write may
   * name the revision it expects (X-UI-Base-Rev, here `opts.baseRev`), and a stale one is refused with 409
   * stale_ui_prefs and the current look, writing nothing.
   */
  private simLookRev = 0
  /**
   * SIM ONLY fixture (`?simlook=elsewhere`): the first conditional look write finds the look changed "on another device"
   * just before it (Phosphor Terminal), so the conflict notice can be seen and smoke-tested. Invented, sim mode only.
   */
  private simLookElsewhere = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simlook') === 'elsewhere'
  private simLookWrite(next: UiPrefs | null, opts: UiPrefsWriteOptions | undefined): UiPrefsResponse {
    if (this.simLookElsewhere && opts?.baseRev !== undefined) {
      this.simLookElsewhere = false
      const phosphor = SEED_VARIANTS.find((v) => v.id === 'phosphor') ?? null
      this.simLook = { variant: phosphor, layout: null, apps: null, experience: null }
      this.simLookRev++
    }
    if (opts?.baseRev !== undefined && opts.baseRev !== this.simLookRev) {
      const error = { code: 'stale_ui_prefs', message: 'look preferences changed since that revision', current: { prefs: this.simLook, updated_at: null, rev: this.simLookRev } }
      throw new ApiError(409, 'stale_ui_prefs', error.message, { envelope: error, body: { error } })
    }
    const before = this.simLook // Surface universal Ask: the host's ui_prefs_history row and its ui-change event
    this.simLook = next
    this.simLookRev++
    if (next) this.askHost.uiChanged(before, next)
    return { prefs: next, updated_at: next ? new Date().toISOString() : null, rev: this.simLookRev }
  }
  uiPrefs(): Promise<UiPrefsResponse> {
    return this.delay(() => ({ prefs: this.simLook, updated_at: null, rev: this.simLookRev }))
  }
  setUiPrefs(prefs: UiPrefs, opts?: UiPrefsWriteOptions): Promise<UiPrefsResponse> {
    return this.delay(() => this.simLookWrite(prefs, opts))
  }

  // ---- Surface universal Ask (SIM ONLY: an invented orchestrator answers; api/sim/ask.ts)
  private askHost = new SimAsk({
    emit: (e) => this.emit(e as unknown as HiveEvent),
    later: (ms, fn) => this.later(ms, fn, true),
    agents: () => [...this.agents.values()],
    swarms: () => [...this.swarms.values()],
    goals: () => [...this.goals.values()],
    principal: () => this.simMe().principal,
  })
  ask(body: import('../ask').AskBody) {
    return this.delay(() => this.askHost.ask(body))
  }
  askTurn(op: string, after = 0) {
    return this.delay(() => this.askHost.turn(op, after))
  }
  askStop(op: string) {
    return this.delay(() => this.askHost.stop(op))
  }
  askConfirm(op: string, proposalId: string, digest: string) {
    return this.delay(() => this.askHost.confirm(op, proposalId, digest))
  }
  askSettings() {
    return this.delay(() => this.askHost.getSettings())
  }
  // ---- the Ask's linkage intents (SIM ONLY mirror of hive/core/ask_intents.py at 39c0731; api/sim/intents.ts)
  private intentsHost = new SimIntents({
    principal: () => this.simMe().principal,
    admin: () => this.simAdmin(),
    turn: (op) => this.askHost.ownTurn(op),
    code: (task) => this.simCodes.get(task),
    later: (ms, fn) => this.later(ms, fn, true),
    // SIM: ?simspawn=off plays a hive with HIVE_MIND_SPAWN off
    // the invented controller takes a moment before it puts a proposal into the copy by itself (copy-apply on)
    applyDelayMs: 2500,
    // SIM: ?simconsent=off plays a host without Platform's consent gate (the controller puts a proposal in by itself)
    // SIM: ?simevidence=off plays today's host: the application record has no consent_id / applied_at
    evidence: () => !(typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simevidence') === 'off'),
    consentGate: () => !(typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simconsent') === 'off'),
    spawn: () => !(typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simspawn') === 'off'),
  })
  /** POST /api/requests/{rq}/proposals/{suggestion}/{accept|decline} (copy-apply consent, Platform 66312cd): a named person. */
  async proposalConsent(requestId: string, suggestionId: string, decision: 'accept' | 'decline', suggestionDigest: string) {
    const principal = this.simMe().principal
    const held = this.consentHold
    if (held) await held // SIM smoke hook: the answer arrives late (it was sent as the person who sent it)
    return this.delay(() => {
      if (principal === 'user:operator') throw new ApiError(403, 'person_required', 'a named, signed-in person does this')
      return this.intentsHost.consent(principal, requestId, suggestionId, decision, { suggestion_digest: suggestionDigest })
    })
  }
  private consentHold: Promise<void> | null = null
  private releaseConsentHold: (() => void) | null = null
  /** GET /api/teams/{swarm_id}/children (the invented Code team's children; a named person reads it, as any viewer). */
  teamChildren(swarmId: string) {
    return this.delay(() => this.intentsHost.children(swarmId))
  }
  /**
   * As the live host's g_person (hive/core/app.py g_person): every intent route, read or write, is a named, signed-in
   * person's; the password (operator) session is refused with 403 person_required before anything else.
   */
  private intentPerson<T>(fn: () => T): Promise<T> {
    return this.delay(() => {
      if (this.simMe().person_kind !== 'person') throw new ApiError(403, 'person_required', 'a named, signed-in person does this')
      return fn()
    })
  }
  askRecordIntent(op: string, body: import('../askIntents').IntentRecordBody) {
    return this.intentPerson(() => this.intentsHost.record(op, body).view)
  }
  askSubmitIntent(id: string) {
    return this.intentPerson(() => (id.startsWith('ai_studio') ? this.studio.submitIntent(id) : this.intentsHost.submit(id)))
  }
  askIntent(id: string) {
    return this.intentPerson(() => this.intentsHost.get(id))
  }
  askIntents(q: { state?: import('../askIntents').IntentState; limit?: number } = {}) {
    return this.intentPerson(() => this.intentsHost.list(q))
  }
  /** SIM ONLY: the invented Code team (absent in the 'person' and 'unrelayed' modes, as on the live client). */
  codeTeamOffer?: (ctx: CodeContext) => Promise<import('../askIntents').CodeTeamOffer>
  setAskSettings(body: import('../ask').AskSettingsPut) {
    return this.delay(() => this.askHost.setSettings(body))
  }
  /** Workbench Map (repo-map Slice A §3): the synthetic fixture served through the same routes (api/sim/repoMap.ts). */
  private repoMapHost: import('./repoMap').SimRepoMaps | null = null
  private repoMapLoad: Promise<import('./repoMap').SimRepoMaps> | null = null
  repoMapRequest(method: 'GET' | 'POST', path: string, body?: unknown) {
    return import('./repoMap').then(async ({ SimRepoMaps, simRepoMapVariant, loadRealMap }) => {
      const variant = simRepoMapVariant(typeof window !== 'undefined' ? window.location.search : '')
      this.repoMapLoad ??= variant === 'real' && typeof document !== 'undefined' ? loadRealMap(document.baseURI) : Promise.resolve(new SimRepoMaps({ variant }))
      const host = (this.repoMapHost ??= await this.repoMapLoad)
      return this.delay(() => host.handle(method, path, body, this.simMe().principal))
    })
  }
  /** GET /api/me/mind: with ?askanswer= the Ask's who-answers fixture answers (askHost: 404 unless it names a mind); otherwise the personal-mind fixture (?mind=). */
  myMind() {
    return this.delay(() => (this.askAnswerFixture ? this.askHost.myMind() : this.mindHost.get()))
  }
  renameMyMind(name: string) {
    return this.delay(() => this.mindHost.rename(name))
  }
  myMindInbox(after: string | null, limit: number) {
    return this.delay(() => this.mindHost.items(after, limit))
  }
  myMindInboxAck(ids: string[]) {
    return this.delay(() => this.mindHost.ack(ids))
  }
  myMindVersions() {
    return this.delay(() => this.mindHost.versions())
  }
  adoptMyMindVersion(versionId: string) {
    return this.delay(() => this.mindHost.adopt(versionId))
  }
  rollbackMyMind() {
    return this.delay(() => this.mindHost.rollback())
  }
  askEndThread(threadId: string) {
    return this.delay(() => this.askHost.endThread(threadId))
  }
  /** GET /api/sessions (j0-fixes r1: the Ask threads, which are sessions; SimAsk.sessions) */
  sessions() {
    return this.delay(() => this.askHost.sessions(this.simAdmin()))
  }
  /** POST /api/sessions/{id}/end: ends it; its words stay */
  endSession(id: string) {
    return this.delay(() => this.askHost.endSession(id, this.simAdmin()))
  }
  /** SIM ONLY fixture: the next Ask finds its coordinator busy with another person. */
  askSimCoordinatorBusy() {
    this.askHost.coordinatorBusyNext()
  }
  askDeleteThread(threadId: string) {
    return this.delay(() => this.askHost.deleteThread(threadId))
  }
  /** SIM ONLY fixture: the hive's Ask switches from now on. */
  askSimFlags(flags: import('../ask').AskCapabilities) {
    this.askHost.setFlags(flags)
  }
  askTakeover(op: string) {
    return this.delay(() => this.askHost.takeover(op))
  }
  askSteer(op: string, body: import('../ask').AskSteerBody) {
    // J3 r4.3 O1 (sim): a live Studio session's turn takes the words as a direction for its maker, never a new turn
    return this.delay(() => (this.studioHostLazy?.steer(op, body as unknown as Record<string, unknown>) as unknown as import('../ask').AskSteerResult | null) ?? this.askHost.steer(op, body))
  }

  // ---- J3 r4.3 O3 (SIM ONLY): Platform's proposed live Studio session routes, played here (api/sim/studioSessions.ts)
  private studioFlags = { monthlyMissing: false, rollover: false, hold: false, role: false, stopFail: 0, consentDrift: false, fenced: false, keyNone: false, makerKind: undefined as string | undefined, piecesNone: false, unbindable: false }
  private studioHostLazy: SimStudioHost | null = null
  private get studio(): SimStudioHost {
    this.studioHostLazy ??= new SimStudioHost({
      emit: (e) => this.emit(e as unknown as HiveEvent),
      later: (ms, fn) => this.later(ms, fn, true),
      now: () => this.now(),
      principal: () => this.simMe().principal,
      flags: { ...this.studioFlags, speed: Math.max(1, this.opts.speed) },
    })
    return this.studioHostLazy
  }
  studioRecordIntent(op: string, body: { kind: 'studio.session'; request: import('../../features/studioLive/api').StudioSessionRequest }) {
    return this.intentPerson(() => this.studio.recordIntent(op, body as unknown as Record<string, unknown>))
  }
  studioSession(sid: string) {
    return this.delay(() => this.studio.ledger(sid))
  }
  studioPiece(sid: string, body: import('../../features/studioLive/api').PieceBody) {
    return this.intentPerson(() => this.studio.piece(sid, body as unknown as Record<string, unknown>))
  }
  studioOutcome(sid: string, n: number, body: import('../../features/studioLive/api').OutcomeBody) {
    return this.intentPerson(() => this.studio.outcome(sid, n, body as unknown as Record<string, unknown>))
  }
  studioControl(sid: string, body: import('../../features/studioLive/api').ControlBody) {
    return this.intentPerson(() => this.studio.control(sid, body as unknown as Record<string, unknown>))
  }
  studioMount(sid: string, body: import('../../features/studioLive/api').MountBody) {
    return this.intentPerson(() => this.studio.mountSession(sid, body as unknown as Record<string, unknown>))
  }
  studioMountHeartbeat(sid: string, body: import('../../features/studioLive/api').MountWire) {
    return this.intentPerson(() => this.studio.heartbeat(sid, body as unknown as Record<string, unknown>))
  }
  studioMountReadback(sid: string, attemptId: string) {
    return this.intentPerson(() => this.studio.mountReadback(sid, attemptId))
  }
  studioUnmount(sid: string, body: { mount_token: string }) {
    return this.intentPerson(() => this.studio.unmount(sid, body as unknown as Record<string, unknown>))
  }
  /** SIM ONLY: what an Ask turn would have prepared for the setup card (the live source is not pinned yet). */
  studioSetupProposal(programId: string, swarmId: string, prep?: import('../../features/studioLive/api').SetupPrep) {
    return this.delay(() => this.studio.setupProposal(programId, swarmId, prep))
  }
  /** SIM (host R7 setup {}): the person's own maker and its Studio space */
  studioMaker() {
    return this.delay(() => this.studio.makerAnswer())
  }
  /** The frame's subscription to a proposal artifact (sim host: only a live session's own proposal artifact). */
  artifactSubscription(swarmId: string, artifactId: string) {
    return this.delay(() => {
      if (!this.studioHostLazy?.hasArtifact(artifactId)) throw new ApiError(404, 'not_found', 'no such artifact in this swarm')
      return { artifact_id: artifactId, swarm_id: swarmId }
    })
  }
  askActResult(op: string, actId: string, body: import('../ask').ActResult) {
    return this.delay(() => this.askHost.actResult(op, actId, body))
  }
  resetUiPrefs(opts?: UiPrefsWriteOptions): Promise<UiPrefsResponse> {
    return this.delay(() => this.simLookWrite(null, opts))
  }

  me(): Promise<Me> {
    return this.delay(() => this.simMe())
  }

  health(swarmId?: string): Promise<HealthOverview> {
    return this.delay(() => {
      const rank = { high: 3, medium: 2, low: 1, ok: 0 } as const
      const now = Date.now()
      const minds: MindHealth[] = [...this.agents.values()]
        .filter((a) => !swarmId || a.swarm_id === swarmId)
        .map((a) => {
          const issues: HealthIssue[] = SEED_HEALTH.filter(([id]) => id === a.id).map(([, kind, severity, skill, count, minutesAgo, command, result, meaning, hint]) => ({
            kind,
            severity,
            skill,
            count,
            meaning,
            hint,
            example: { command, result },
            last_at: iso(now - minutesAgo * 60_000),
            iteration: this.iterations.get(a.id) ?? null,
            recent: minutesAgo < 60,
          }))
          if (a.status === 'error')
            issues.unshift({ kind: 'crashed', severity: 'high', skill: 'loop', count: 1, meaning: 'The mind stopped with an error', hint: 'Open its log, then wake it again.', example: { command: '(loop)', result: a.last_error ?? 'error' }, last_at: a.last_active_at, iteration: null, recent: true })
          const worst = issues.filter((i) => i.recent && i.severity !== 'info').reduce<MindHealth['health']>((w, i) => (rank[i.severity as 'high' | 'medium' | 'low'] > rank[w] ? (i.severity as MindHealth['health']) : w), 'ok')
          return { id: a.id, name: a.name, swarm_id: a.swarm_id, status: a.status, health: worst, issues, checked_commands: 40 + ((hashStr(a.id) >>> 0) % 160) }
        })
        .sort((x, y) => rank[y.health] - rank[x.health] || x.name.localeCompare(y.name))
      const totals = { high: 0, medium: 0, low: 0, ok: 0 }
      for (const m of minds) totals[m.health]++
      return { minds, totals }
    })
  }

  private listPeopleNow(): Person[] {
    const now = Date.now()
    return SEED_PEOPLE.map((p) => ({
      id: p.id,
      email: p.email,
      name: p.name,
      role: p.role,
      invited_by: 'operator',
      created_at: iso(now - p.daysAgo * 86_400_000),
      last_seen_at: p.seenHoursAgo == null ? null : iso(now - p.seenHoursAgo * 3_600_000),
      disabled: !!p.disabled,
      google_bound: !!p.googleBound && !this.googleCleared.has(p.id),
    })).concat(this.scalePeople.map((p, i) => ({
      id: p.id,
      email: `${p.id}@example.org`,
      name: p.name,
      role: 'member' as const,
      invited_by: 'operator',
      created_at: iso(now - (10 + i) * 86_400_000),
      last_seen_at: null,
      disabled: false,
      google_bound: false,
    })))
  }

  /** Read-only in the demo (nobody can be invited from a browser simulator); an admin may clear a Google identity. */
  listPeople(): Promise<{ people: Person[]; invites: Invite[]; google_ready: boolean }> {
    return this.delay(() => {
      const now = Date.now()
      const people: Person[] = this.listPeopleNow()
      const invites: Invite[] = SEED_INVITES.map((i) => ({
        id: i.id,
        email: i.email,
        name: i.name,
        role: i.role,
        created_by: 'operator',
        created_at: iso(now - i.daysAgo * 86_400_000),
        expires_at: Math.round((now + (i.days - i.daysAgo) * 86_400_000) / 1000),
        accepted_at: i.status === 'accepted' ? iso(now - (i.daysAgo - 1) * 86_400_000) : null,
        revoked_at: null,
        status: i.status,
      }))
      return { people, invites, google_ready: true }
    })
  }

  /** Invented: people whose Google identity an admin cleared in this demo (they then show as not linked). */
  private googleCleared = new Set<string>()
  /** As PATCH /api/people/{id} {"clear_google_identity": true}: admins only; the person is unlinked (and, live, signed out). */
  clearGoogleIdentity(id: string): Promise<Person> {
    return this.delay(() => {
      const me = this.simMe()
      if (!(me.kind === 'password' || me.role === 'admin')) throw new ApiError(403, 'forbidden', 'admins only')
      if (!SEED_PEOPLE.some((p) => p.id === id)) throw new ApiError(404, 'not_found', `no person ${id}`)
      this.googleCleared.add(id)
      return this.listPeopleNow().find((p) => p.id === id)!
    })
  }

  private roleView(r: Role): Role {
    const minds = [...this.agents.values()].filter((a) => a.role_id === r.id || (a.role_id === undefined && r.minds.includes(a.id))).map((a) => a.id)
    return { ...clone(r), minds }
  }
  private mustRole(id: string): Role {
    const r = this.roles.get(id)
    if (!r) throw new ApiError(404, 'unknown_role', `No role ${id}`)
    return r
  }
  private checkRoleName(name: string, except?: string) {
    if (!name.trim()) throw new ApiError(400, 'bad_request', 'A role needs a name')
    if ([...this.roles.values()].some((r) => r.id !== except && r.name.toLowerCase() === name.trim().toLowerCase())) throw new ApiError(409, 'duplicate_role', `There is already a role called ${name.trim()}`)
  }
  listRoles(): Promise<Role[]> {
    return this.delay(() => [...this.roles.values()].map((r) => this.roleView(r)))
  }
  createRole(body: Partial<Role>): Promise<Role> {
    return this.delay(() => {
      const name = body.name ?? 'New role'
      this.checkRoleName(name)
      const r: Role = { id: this.id('r_'), name: name.trim(), summary: body.summary ?? '', prompt: body.prompt ?? '', default_model: body.default_model ?? null, default_budget: body.default_budget ?? null, rules: clone(body.rules ?? []), builtin: false, created_at: this.now(), updated_at: this.now(), minds: [] }
      this.roles.set(r.id, r)
      return this.roleView(r)
    })
  }
  updateRole(id: string, body: Partial<Role>): Promise<Role> {
    return this.delay(() => {
      const r = this.mustRole(id)
      if (body.name !== undefined) this.checkRoleName(body.name, id)
      for (const k of ['name', 'summary', 'prompt', 'default_model', 'default_budget', 'rules'] as const) if (body[k] !== undefined) Object.assign(r, { [k]: clone(body[k]) })
      r.name = r.name.trim()
      r.updated_at = this.now()
      return this.roleView(r)
    })
  }
  duplicateRole(id: string): Promise<Role> {
    return this.delay(() => {
      const src = this.mustRole(id)
      let name = `${src.name} copy`
      for (let i = 2; [...this.roles.values()].some((r) => r.name === name); i++) name = `${src.name} copy ${i}`
      const r: Role = { ...clone(src), id: this.id('r_'), name, builtin: false, created_at: this.now(), updated_at: this.now(), minds: [] }
      this.roles.set(r.id, r)
      return this.roleView(r)
    })
  }
  removeRole(id: string): Promise<{ ok: true; unassigned: number }> {
    return this.delay(() => {
      const r = this.mustRole(id)
      const unassigned = this.roleView(r).minds.length
      for (const a of this.agents.values()) if (a.role_id === id) a.role_id = null
      this.roles.delete(id)
      return { ok: true as const, unassigned }
    })
  }

  // ------------------------------------------------------------------ code (one invented repository only)
  // Every target but the invented `repo:sim-suggestions` stays unopenable: the demo has no code service. That one
  // repository is served by SimCodeService (INVENTED DATA) so the workbench and its suggestion panel can be exercised.
  // Each code/open is a fresh task with a fresh 12-hour edit grant, as hive/core/code.py:221-232 (60fa650); each task
  // gets its own invented workspace. The first is g_simcode01 / grant_simcode01 / ws_simsuggest01. Tasks are made
  // without the sim's random stream (so the living sim stays reproducible) and are not announced; the living sim may
  // still let an awake mind claim one, as an awake Code local member could live.
  private simCodes = new Map<string, SimCodeService>()
  private simCodeSeq = 0
  private lastSimCode: SimCodeService | null = null
  /**
   * Request L: targets carry next10's closed_reason (51a7ccc) unless this is false, which plays live 0aa6330 (no
   * closed_reason; `repo:old-notebooks` then opens and the service refuses it with 403 repository_unregistered).
   */
  codeClosedReasons = true
  codeOpen(target: string) {
    return this.delay(() => {
      const listed = SIM_CODE_TARGETS.find((x) => x.id === target)
      const reason = listed ? simClosedReason(listed) : null
      // as code.py:289-290 at 51a7ccc: refused before any task or grant exists
      if (this.codeClosedReasons && listed && listed.commit && !listed.private && reason) throw new ApiError(409, 'not_editable', `${listed.label} cannot be opened for editing: ${reason}`)
      const unregistered = !this.codeClosedReasons && target === SIM_UNREGISTERED_TARGET
      if (target !== SIM_CODE_TARGET && !unregistered) throw new ApiError(503, 'service_unavailable', 'The demo has no code service for this target.')
      const t = listed!
      const n = String(++this.simCodeSeq).padStart(2, '0')
      const principal = this.simPrincipal()
      const at = this.now()
      const goal: Goal = {
        id: `g_simcode${n}`, swarm_id: 's_forge', parent_id: null, assignee: null, title: `Edit code: ${t.label}`,
        detail: `target=${t.id} repository=${unregistered ? SIM_UNREGISTERED_REPOSITORY : SIM_CODE_REPOSITORY} commit=${t.commit ?? ''}`, priority: 0.5, status: 'open',
        created_by: principal, claimed_by: null, result: null, created_at: at, updated_at: at, lease_until: null, attempts: 0,
      }
      this.goals.set(goal.id, goal)
      this.emit({ type: 'goal.updated', at, goal: clone(goal) })
      const grant = { id: `grant_simcode${n}`, goal_id: goal.id, principal, scope: 'edit' as const, workspace_id: null, created_by: principal, created_at: new Date().toISOString(), expires_at: Date.now() / 1000 + 12 * 3600, revoked_at: null }
      this.simGrants.set(grant.id, grant)
      if (unregistered) return { target: this.codeTarget(t), task_id: goal.id, swarm_id: goal.swarm_id, grant_id: grant.id, repository_id: SIM_UNREGISTERED_REPOSITORY, base_commit: t.commit ?? '' }
      const svc = new SimCodeService({ relay: this.opts.codeMode !== 'unrelayed', task_id: goal.id, workspace_id: `ws_simsuggest${n}`, swarm_id: 's_forge', copyApply: this.opts.codeCopyApply })
      this.simCodes.set(goal.id, svc)
      this.lastSimCode = svc
      return { target: this.codeTarget(t), task_id: goal.id, swarm_id: goal.swarm_id, grant_id: grant.id, repository_id: SIM_CODE_REPOSITORY, base_commit: t.commit ?? '' }
    })
  }
  private simStaleSeq = 0
  /**
   * SIM ONLY (request L): an earlier edit task on the invented fixture with the grant a browser might still have saved:
   * another sign-in's ('other-principal', user:p_former, INVENTED), the caller's but expired or revoked, or the caller's
   * and still active ('own', with its own invented workspace so it really opens). The browser side (localStorage) is the
   * caller's to write. Nothing random is drawn.
   */
  simStaleCodeSession(kind: SimStaleSession) {
    const n = String(++this.simStaleSeq).padStart(2, '0')
    const t = SIM_CODE_TARGETS.find((x) => x.id === SIM_CODE_TARGET)!
    const me = this.simPrincipal()
    const nowSec = Date.now() / 1000
    const at = new Date((nowSec - 3 * 3600) * 1000).toISOString()
    const goal: Goal = {
      id: `g_simstale${n}`, swarm_id: 's_forge', parent_id: null, assignee: null, title: `Edit code: ${t.label}`,
      detail: `target=${t.id} repository=${SIM_CODE_REPOSITORY} commit=${t.commit ?? ''}`, priority: 0.5, status: 'open',
      created_by: kind === 'other-principal' ? 'user:p_former' : me, claimed_by: null, result: null, created_at: at, updated_at: at, lease_until: null, attempts: 0,
    }
    this.goals.set(goal.id, goal)
    const principal = kind === 'other-principal' ? 'user:p_former' : me
    this.simGrants.set(`grant_simstale${n}`, {
      id: `grant_simstale${n}`, goal_id: goal.id, principal, scope: 'edit', workspace_id: null, created_by: principal, created_at: at,
      expires_at: kind === 'expired' ? nowSec - 2 * 3600 : nowSec + 9 * 3600,
      revoked_at: kind === 'revoked' ? new Date((nowSec - 3600) * 1000).toISOString() : null,
    })
    if (kind === 'own') this.simCodes.set(goal.id, new SimCodeService({ relay: this.opts.codeMode !== 'unrelayed', task_id: goal.id, workspace_id: `ws_simstale${n}`, swarm_id: 's_forge' }))
    return { task_id: goal.id, grant_id: `grant_simstale${n}`, repository_id: SIM_CODE_REPOSITORY, swarm_id: 's_forge', base_commit: t.commit ?? '', principal }
  }
  /** The grant principal: the session's principal, as hive/core/app.py:542 (`session.principal or "user:operator"`). */
  private simPrincipal() {
    return this.simMe().principal
  }
  codeProxy<T>(method: 'GET' | 'POST', path: string, ctx: Record<string, string>, body?: unknown): Promise<T> {
    const { task_id, grant_id, repository_id, ...query } = ctx
    // as hive/core/code.py:315-319: the grant must exist, be the caller's, on this task, unrevoked and unexpired; the
    // refusal comes before anything reaches the service
    const g = this.simGrants.get(grant_id ?? '')
    const svc = this.simCodes.get(task_id ?? '')
    // request L, live 0aa6330 shape: a valid grant on a repository the service has no copy of is refused by the service
    if (g && g.principal === this.simPrincipal() && g.goal_id === task_id && !g.revoked_at && g.expires_at > Date.now() / 1000 && repository_id === SIM_UNREGISTERED_REPOSITORY) return Promise.reject(simRepositoryUnregistered())
    if (!g || !svc || g.principal !== this.simPrincipal() || g.goal_id !== task_id || g.revoked_at || g.expires_at <= Date.now() / 1000 || repository_id !== SIM_CODE_REPOSITORY) return Promise.reject(new ApiError(403, 'grant_invalid', 'no active edit grant for you on that task'))
    return svc.proxy(method, path, query, body) as Promise<T>
  }
  private codeCall(ctx: CodeContext, method: 'GET' | 'POST', path: string, body?: unknown, query: Record<string, string> = {}) {
    return this.codeProxy<unknown>(method, path, { task_id: ctx.task_id, grant_id: ctx.grant_id, repository_id: ctx.repository_id, ...query }, body)
  }
  codeSuggestionScope(ctx: CodeContext, ws: string, body: SuggestionScopeRequest) {
    return this.codeCall(ctx, 'POST', `/v1/workspaces/${ws}/suggestion-scopes`, body)
  }
  codeSuggestionCreate(ctx: CodeContext, ws: string, body: SuggestionCreateRequest) {
    return this.codeCall(ctx, 'POST', `/v1/workspaces/${ws}/suggestions`, body)
  }
  codeSuggestionHistory(ctx: CodeContext, ws: string, page: { limit?: number; cursor?: string } = {}) {
    return this.codeCall(ctx, 'GET', `/v1/workspaces/${ws}/suggestions`, undefined, { limit: String(page.limit ?? 20), ...(page.cursor ? { cursor: page.cursor } : {}) })
  }
  codeSuggestionRead(ctx: CodeContext, ws: string, id: string) {
    return this.codeCall(ctx, 'GET', `/v1/workspaces/${ws}/suggestions/${id}`)
  }
  codeSuggestionDecide(ctx: CodeContext, ws: string, body: SuggestionDecisionRequest) {
    return this.codeCall(ctx, 'POST', `/v1/workspaces/${ws}/suggestion-decisions`, body)
  }
  /**
   * SIM ONLY: an invented mind answers the instruction (no live route carries an instruction). Absent in the 'person'
   * and 'unrelayed' modes, exactly as on the live client.
   */
  codeSuggestionAsk?: (ctx: CodeContext, ws: string, body: { scope_id: string; instruction: string }) => Promise<unknown>
  private askSimMind(ctx: CodeContext, ws: string, body: { scope_id: string; instruction: string }) {
    const g = this.simGrants.get(ctx.grant_id)
    const svc = this.simCodes.get(ctx.task_id)
    if (!g || !svc || g.goal_id !== ctx.task_id || g.revoked_at) return Promise.reject(new ApiError(403, 'grant_invalid', 'no active edit grant for you on that task'))
    return svc.ask(ws, body.scope_id, body.instruction)
  }
  codeSimFixture(action: SimCodeFixture) {
    if (action === 'revoke-grant') {
      // as an admin revoking elsewhere: every active code grant here is revoked at the hive
      for (const g of this.simGrants.values()) if (!g.revoked_at) g.revoked_at = new Date().toISOString()
      return Promise.resolve('Your edit grant on this task was revoked at the hive. Every relayed call (read, list, decide) is now refused before it reaches the code service.')
    }
    if (!this.lastSimCode) return Promise.reject(new ApiError(409, 'not_open', 'open the invented repository first'))
    return this.lastSimCode.fixture(action)
  }
  private codeTarget(t: (typeof SIM_CODE_TARGETS)[number]): Target {
    const a = t.mind ? this.agents.get(t.mind) : undefined
    const invented = t.id === SIM_CODE_TARGET
    return {
      id: t.id,
      kind: t.kind,
      label: t.label,
      detail: t.detail,
      source: null,
      repository_id: t.kind === 'repository' ? t.id.replace(/^repo:/, '') : '',
      repo: t.commit ? { root: `/srv/hive/${t.id.replace(/[^a-z0-9-]/gi, '-')}`, commit: t.commit, branch: t.branch ?? null, dirty: false, subdir: '' } : null,
      owner: t.owner,
      private: !!t.private,
      built_in: t.built_in,
      mind: a ? { id: a.id, hue: a.hue, status: a.status } : undefined,
      apply: invented ? { how: 'nothing (invented fixture)', ready: false, note: 'Invented simulator repository; there is nothing to apply to' } : { how: t.kind === 'mind' ? 'restart the mind' : 'redeploy', ready: false, note: 'The demo has no code service.' },
      openable: invented || (!this.codeClosedReasons && t.id === SIM_UNREGISTERED_TARGET),
      // request L: next10's closed_reason; absent in the live 0aa6330 shape
      ...(this.codeClosedReasons ? { closed_reason: simClosedReason(t) } : {}),
    }
  }

  /** Listed so the Code page is not empty in the demo; only the invented fixture repository opens. */
  codeTargets(): Promise<Target[]> {
    return this.delay(() =>
      SIM_CODE_TARGETS.filter((t) => !t.mind || this.agents.has(t.mind)).map((t) => this.codeTarget(t)),
    )
  }

  private spentIn(scope: string, period: BudgetRow['period']): number {
    const now = new Date()
    const since = period === 'day' ? new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() : period === 'month' ? new Date(now.getFullYear(), now.getMonth(), 1).getTime() : 0
    const [kind, id] = scope.split(/:(.*)/s)
    let match: (agentId: string) => boolean
    if (kind === 'hive') match = () => true
    else if (kind === 'swarm') match = (a) => this.agents.get(a)?.swarm_id === id
    else if (kind === 'agent') match = (a) => a === id
    else {
      const k = this.simKeys.find((x) => x.id === id)
      const paid = new Set(k ? this.keyView(k).minds.map((m) => m.id) : [])
      match = (a) => paid.has(a)
    }
    let total = 0
    for (const u of this.usage) if (match(u.agent_id) && Date.parse(u.created_at) >= since) total += u.cost_usd
    return round6(total)
  }

  /** Rules plus the per-swarm $500/month default where a swarm has no monthly rule of its own. */
  listBudgets(): Promise<BudgetRow[]> {
    return this.delay(() => {
      const rows = this.budgets.map((b) => ({ ...b, spent_usd: this.spentIn(b.scope, b.period) }))
      for (const s of this.swarms.values()) {
        if (s.archived_at) continue
        const scope = `swarm:${s.id}`
        if (!this.budgets.some((b) => b.scope === scope && b.period === 'month')) rows.push({ id: `default:${scope}`, scope, period: 'month', limit_usd: 500, spent_usd: this.spentIn(scope, 'month'), note: 'Default for every swarm', origin: 'default' })
      }
      return rows
    })
  }
  setBudget(body: { scope: string; period: string; limit_usd: number; note?: string }): Promise<BudgetRow> {
    return this.delay(() => {
      if (!['day', 'month', 'total'].includes(body.period)) throw new ApiError(400, 'bad_request', `Unknown period ${body.period}`)
      if (!Number.isFinite(body.limit_usd) || body.limit_usd < 0) throw new ApiError(400, 'bad_request', 'A limit must be zero or more dollars')
      const period = body.period as BudgetRow['period']
      let row = this.budgets.find((b) => b.scope === body.scope && b.period === period)
      if (row) Object.assign(row, { limit_usd: body.limit_usd, note: body.note ?? row.note })
      else {
        row = { id: `b_sim${++this.budgetSeq}`, scope: body.scope, period, limit_usd: body.limit_usd, spent_usd: 0, note: body.note ?? '', origin: 'rule' }
        this.budgets.push(row)
      }
      return { ...row, spent_usd: this.spentIn(row.scope, row.period) }
    })
  }
  removeBudget(id: string): Promise<{ ok: true }> {
    return this.delay(() => {
      if (id.startsWith('default:')) throw new ApiError(400, 'bad_request', 'The default limit cannot be removed; set a different one instead')
      const before = this.budgets.length
      this.budgets = this.budgets.filter((b) => b.id !== id)
      if (this.budgets.length === before) throw new ApiError(404, 'unknown_budget', `No limit ${id}`)
      return { ok: true as const }
    })
  }

  // --- Surface: money/work/apps (reservations, artifacts, assets, services, app activity)
  private mw = new SimMoneyWork(<T,>(fn: () => T) => this.delay(fn))
  private upd = new SimUpdates(<T,>(fn: () => T) => this.delay(fn), () => this.simMe().principal, async () => (await this.programsHost.list()).map((p) => ({ id: p.id, name: p.name })))
  updates() { return this.upd.overview() }
  applyUpdate(body: { target: string; override?: boolean; confirm?: string }) { return this.upd.applyUpdate(body) }
  releaseHold(id: string) { return this.upd.releaseHold(id) }
  placeHold(body: import('../types').PlaceHoldBody) { return this.upd.placeHold(body) }
  setHiveIdentity(body: { name?: string; home?: boolean }) {
    return this.delay(() => {
      if (body.name !== undefined && typeof body.name !== 'string') throw new ApiError(400, 'bad_request', 'name is text')
      return this.minds.setIdentity(body)
    })
  }
  listReservations() { return this.mw.listReservations() }
  listOverruns() { return this.mw.listOverruns() }
  resolveReservation(id: string, body: import('../moneyWork').ResolveBody) { return this.mw.resolveReservation(id, body) }
  hiveArtifacts() { return this.mw.hiveArtifacts() }
  swarmArtifacts(swarmId: string, opts?: { kind?: string; limit?: number }) {
    // SIM r1.13: ?studiopieces=none plays a Studio space with no saved canvas
    if (this.studioFlags.piecesNone && opts?.kind === 'studio-source') return this.delay(() => [])
    return this.mw.swarmArtifacts(swarmId, opts)
  }
  assetStores() { return this.mw.assetStores() }
  listAssets(swarmId?: string) { return this.mw.listAssets(swarmId) }
  uploadAsset(file: Blob, opts: import('../moneyWork').UploadAssetOptions) { return this.mw.uploadAsset(file, opts) }
  assetBlob(sha: string) { return this.mw.assetBlob(sha) }
  /** SIM: figure bytes from the URL-opted PC fixture (api/sim/evolvePc); anything else is 404, as the host answers */
  figureBlob(readUrl: string) {
    return this.delay(() => {
      const bytes = this.figureSource?.(readUrl) ?? null
      if (!bytes) throw new ApiError(404, 'not_found', 'no such figure')
      return new Blob([bytes as BlobPart], { type: 'image/png' })
    })
  }
  transferAsset(sha: string, to: string, move: boolean) { return this.mw.transferAsset(sha, to, move) }
  swarmServices(swarmId: string) { return this.mw.swarmServices(swarmId) }
  setSwarmServices(swarmId: string, body: { kinds: string[]; connection_only_kinds: string[] }) { return this.mw.setSwarmServices(swarmId, body) }
  // app.py:341-359: admins only (Surface missing-UI batch 1 made the sim refuse members as the host does)
  registeredServices() { return this.simAdmin() ? this.mw.registeredServices() : Promise.reject(adminOnly()) }
  setServiceEnabled(id: string, enabled: boolean) { return this.simAdmin() ? this.mw.setServiceEnabled(id, enabled) : Promise.reject(adminOnly()) }
  removeService(id: string) { return this.simAdmin() ? this.mw.removeService(id) : Promise.reject(adminOnly()) }

  // ---- Surface missing-UI batch 1 (SIM ONLY host side: ./missingUi.ts, ./ask.ts history, ./updates.ts requests)
  private missing = new SimMissingUi({
    viewer: () => {
      const me = this.simMe()
      return { principal: me.principal, admin: this.simAdmin(), person: me.kind === 'sso', localOperator: me.kind === 'password' || me.principal === 'user:operator' }
    },
    goals: () => [...this.goals.values()],
    swarms: () => [...this.swarms.values()],
    programIds: () => this.programsHost.list().map((p) => p.id),
    services: () => this.mw.servicesSnapshot(),
    emit: (e) => this.emit(e),
    now: () => this.now(),
  })
  askHistory(limit = 50) { return this.delay(() => (this.askHost.seedHistory(), this.askHost.list(limit))) }
  askAudit(o: { limit?: number; principal?: string; before?: string } = {}) {
    return this.delay(() => {
      if (!this.simAdmin()) throw adminOnly()
      this.askHost.seedHistory()
      return this.askHost.audit(o.limit ?? 100, o.principal, o.before)
    })
  }
  askAuditTurn(turnId: string, after = 0) {
    return this.delay(() => {
      if (!this.simAdmin()) throw adminOnly()
      return this.askHost.auditTurn(turnId, after)
    })
  }
  goalAttempts(goalId: string) { return this.delay(() => this.missing.goalAttempts(goalId)) }
  /** services.py grant (admins): 404 unknown goal, bad_scope, bad_principal (user:<id>), ttl clamped to 5..1440 minutes. */
  addGoalGrant(goalId: string, body: import('../missingUi').AddGoalGrantBody) {
    return this.delay((): GoalGrant => {
      if (!this.simAdmin()) throw adminOnly()
      if (!this.goals.has(goalId)) throw new ApiError(404, 'not_found', `no task ${goalId}`)
      const scope = body.scope ?? 'edit'
      if (scope !== 'edit' && scope !== 'read') throw new ApiError(400, 'bad_scope', 'scope is edit or read')
      const principal = body.principal || this.simMe().principal
      if (!/^user:[A-Za-z0-9_]+$/.test(principal)) throw new ApiError(400, 'bad_principal', 'grants are for people (user:<id>)')
      const ttl = Math.max(5, Math.min(1440, Number(body.ttl_minutes ?? 120) || 120))
      const g = { id: `gr_sim${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`, goal_id: goalId, principal, scope, workspace_id: body.workspace_id ?? null, created_by: this.simMe().principal, created_at: new Date().toISOString(), expires_at: Date.now() / 1000 + ttl * 60, revoked_at: null } as Omit<GoalGrant, 'active'>
      this.simGrants.set(g.id, g)
      return this.grantView(g)
    })
  }
  revokeProgramGrants(id: string) { return this.delay(() => this.missing.revokeProgramGrants(id)) }
  restoreProgramGrants(id: string) { return this.delay(() => this.missing.restoreProgramGrants(id)) }
  /** SIM ONLY: whether an app has host-managed grants here, and whether they are paused. */
  simAppGrants(id: string) { return this.missing.simAppGrants(id) }
  requestUpdate(body: import('../missingUi').UpdateRequestBody) { return this.simAdmin() ? this.upd.request(body) : Promise.reject(adminOnly()) }
  harnessInvites() { return this.delay(() => this.missing.harnessInvites()) }
  harnessInvite(id: string) { return this.delay(() => this.missing.harnessInvite(id)) }
  createHarnessInvite(body: { harness: string; name: string; swarm_id: string; role_id?: string | null; ttl_minutes?: number }) { return this.delay(() => this.missing.createHarnessInvite(body) as import('../../features/harness/ConnectHarness').HarnessInvite) }
  revokeHarnessInvite(id: string) { return this.delay(() => this.missing.revokeHarnessInvite(id) as import('../../features/harness/ConnectHarness').HarnessInvite) }
  capabilityCatalogue(scope: string) { return this.delay(() => this.missing.capabilityCatalogue(scope)) }
  flowList(swarmId: string) { return this.delay(() => this.missing.flowList(swarmId)) }
  flowRevision(id: string, n: number) { return this.delay(() => this.missing.flowRevision(id, n)) }
  unadoptFlow(id: string, n: number) { return this.delay(() => this.missing.unadoptFlow(id, n)) }
  exploreGroups() { return this.delay(() => this.missing.exploreGroups()) }
  createExploreGroup(name: string) { return this.delay(() => this.missing.createExploreGroup(name)) }
  exploreGroupMembers(id: string, body: { add?: string[]; remove?: string[] }) { return this.delay(() => this.missing.exploreGroupMembers(id, body)) }
  renameExploreGroup(id: string, name: string) { return this.delay(() => this.missing.renameExploreGroup(id, name)) }
  deleteExploreGroup(id: string) { return this.delay(() => this.missing.deleteExploreGroup(id)) }
  cleanupAsset(sha: string) { return this.simAdmin() ? this.mw.cleanupAsset(sha, this.simMe().principal) : Promise.reject(adminOnly()) }
  programActivations(programId: string) { return this.mw.programActivations(programId) }
  activateProgram(programId: string, swarmId: string) { return this.mw.activateProgram(programId, swarmId) }
  deactivateProgram(programId: string, swarmId: string) { return this.mw.deactivateProgram(programId, swarmId) }
  programAttachments(programId: string) { return this.mw.programAttachments(programId) }
  offerProgram(programId: string, mindId: string) { return this.mw.offerProgram(programId, mindId) }
  attachProgram(programId: string, body: import('../moneyWork').AttachBody) { return this.mw.attachProgram(programId, body) }
  detachProgram(programId: string, attachmentId: string) { return this.mw.detachProgram(programId, attachmentId) }
  programActivity(opts?: { swarm_id?: string; program?: string; limit?: number }) { return this.mw.programActivity(opts) }

  // --- Surface: studio slice 2 (drafts, asset bytes)
  /** SIM ONLY: who the demo's visitor is. The operator (default, signed in on the hive's own machine) saves no drafts;
   *  'person' is an invented signed-in person (Ada, INVENTED), as a Google sign-in would be. */
  simSession: 'operator' | 'person' = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('simrole') === 'person' ? 'person' : 'operator'
  /** SIM ONLY: sign-in observers (HiveClient.onAuthChange), so the store starts a new session when the sim's person changes. */
  private authListeners = new Set<() => void>()
  onAuthChange(listener: () => void): () => void {
    this.authListeners.add(listener)
    return () => void this.authListeners.delete(listener)
  }
  /** SIM ONLY: become someone else, as a sign-in as another person would (the operator, Ada, or Rowan the member). */
  simSignInAs(who: 'operator' | 'person' | 'member') {
    this.simMember = who === 'member'
    this.simSession = who === 'person' ? 'person' : 'operator'
    for (const l of [...this.authListeners]) l()
  }
  private simMe(): Me {
    if (this.simMember) return { principal: 'user:p_rowan', kind: 'sso', role: 'member', expires_at: null, person: { id: 'p_rowan', email: 'rowan@example.org', name: 'Rowan Vale' }, person_kind: 'person', local_operator: false }
    return this.simSession === 'person'
      ? { principal: 'user:p_ada', kind: 'sso', role: 'admin', expires_at: null, person: { id: 'p_ada', email: 'ada@example.org', name: 'Ada Brightwater' }, person_kind: 'person', local_operator: false }
      // the operator session's principal is user:operator, as the live /api/auth/me (hive/core/app.py:644)
      : { principal: 'user:operator', kind: 'password', role: 'admin', expires_at: null, person: null, person_kind: 'operator', local_operator: true }
  }
  private drafts = new SimDrafts({
    person: () => (this.simSession === 'person' ? this.simMe().principal : null),
    program: async (id) => {
      const p = (await this.programs()).find((x) => x.id === id)
      return !p ? 'unknown' : p.enabled ? 'enabled' : 'disabled'
    },
    swarmVisible: (id) => this.swarms.has(id),
  })
  putAppDraft(programId: string, key: string, body: import('../appDrafts').AppDraftPut) { return this.delay(() => null).then(() => this.drafts.put(programId, key, body)) }
  listAppDrafts(programId: string, swarmId: string) { return this.delay(() => null).then(() => this.drafts.list(programId, swarmId)) }
  getAppDraft(programId: string, key: string, swarmId: string) { return this.delay(() => null).then(() => this.drafts.get(programId, key, swarmId)) }
  deleteAppDraft(programId: string, key: string, swarmId: string) { return this.delay(() => null).then(() => this.drafts.remove(programId, key, swarmId)) }

  // ------------------------------------------------------------------ Providers (pretend keys)

  private providerKeys: Record<string, string> = { anthropic: 'sim-anthropic', openai: 'sim-openai' }

  private providerStatus(name: string): ProviderStatus {
    const label: Record<string, string> = { openrouter: 'OpenRouter', anthropic: 'Anthropic', openai: 'OpenAI', ollama: 'Local server', mock: 'Offline' }
    const local = name === 'ollama' || name === 'mock'
    const key = this.providerKeys[name]
    const status: ProviderStatus = {
      name,
      label: label[name] ?? name,
      local,
      needs_key: !local,
      connected: local || !!key,
      source: key ? 'stored' : null,
      key_hint: key ? '…' + key.slice(-4) : '',
      key_env: local ? '' : `${name.toUpperCase()}_API_KEY`,
      base_url: '',
      models: SIM_MODELS.filter((m) => m.provider === name).map((m) => m.id.split('/').slice(1).join('/')),
      account: key && name === 'openrouter' ? { label: 'simulated key', limit: 25, usage: 3.2 } : null,
    }
    if (name === 'openrouter') status.catalog = { count: key ? SIM_CATALOG.length : 0, fetched_at: key ? Date.now() / 1000 : null, error: null }
    return status
  }

  listProviders() {
    return this.delay(() => ['openrouter', 'anthropic', 'openai', 'ollama', 'mock'].map((n) => this.providerStatus(n)))
  }
  getProvider(name: string) {
    return this.delay(() => this.providerStatus(name))
  }
  setProviderKey(name: string, key: string) {
    return this.delay(() => {
      if (!key.trim()) throw new ApiError(400, 'bad_request', 'key is required')
      if (key.trim().length < 8) throw new ApiError(401, 'bad_key', `${this.providerStatus(name).label} rejected that key`)
      this.providerKeys[name] = key.trim()
      return this.providerStatus(name)
    })
  }
  removeProviderKey(name: string) {
    return this.delay(() => {
      delete this.providerKeys[name]
      return this.providerStatus(name)
    })
  }
  private simKeys: (Omit<KeyInfo, 'minds' | 'spent_usd'> & { secret: string })[] = [
    { id: 'k_51a10001', provider: 'anthropic', provider_label: 'Anthropic', label: 'Anthropic key', owner: 'user:operator', hint: '…ropc', default: true, created_at: Date.now() / 1000, secret: 'sim-anthropic' },
    { id: 'k_51a10002', provider: 'openai', provider_label: 'OpenAI', label: 'OpenAI key', owner: 'user:operator', hint: '…enai', default: true, created_at: Date.now() / 1000, secret: 'sim-openai' },
  ]

  private keyView(k: (typeof this.simKeys)[number]): KeyInfo {
    const minds = [...this.agents.values()]
      .filter((a) => a.model.split('/')[0] === k.provider && (a.options?.key === k.id || (!a.options?.key && k.default)))
      .map((a) => ({ id: a.id, name: a.name, hue: a.hue, status: a.status, assigned: a.options?.key === k.id }))
    const spent = minds.reduce((t, m) => t + (this.agents.get(m.id)?.spent_usd ?? 0), 0)
    const { secret: _s, ...rest } = k
    void _s
    return { ...rest, minds, spent_usd: spent, account: k.provider === 'openrouter' ? { label: 'simulated key', limit: 25, usage: 3.2 } : null }
  }

  listKeys() {
    return this.delay(() => this.simKeys.map((k) => this.keyView(k)))
  }
  // r1.14b: the person's own-key monthly total (GET /api/me/key-limits, PUT /api/me/key-limits/self). Starts set ($10, the
  // Studio sim's month) unless ?studiomonthly=missing; saving one clears that refusal, as the host's row would. INVENTED.
  private simOwnMonthly: { month_usd: number; at: string } | null | undefined = undefined
  private ownMonthlyRow() {
    if (this.simOwnMonthly === undefined) this.simOwnMonthly = this.studioFlags.monthlyMissing ? null : { month_usd: 10, at: new Date(this.now()).toISOString() }
    const r = this.simOwnMonthly
    return r ? [{ id: 'kl_sim_self', owner: this.simMe().principal, key_id: '*', grantee: 'self', month_usd: r.month_usd, ends_at: null, source: 'owner', note: '', created_at: r.at, updated_at: r.at, revoked_at: null, spent_usd: 0.33, active: true }] : []
  }
  myKeyLimits() {
    return this.delay(() => ({ principal: this.simMe().principal, access: 'owner', keys: this.simKeys.map((k) => ({ id: k.id, provider: k.provider, label: k.label, hint: k.hint })), own: this.ownMonthlyRow(), grants: [], received: [] }))
  }
  setOwnKeyLimit(body: Record<string, unknown>) {
    return this.delay(() => {
      const m = body.month_usd
      if (body.key_id !== '*' || typeof m !== 'number' || !Number.isFinite(m) || m < 0 || m > 1_000_000) throw new ApiError(400, 'bad_limit', 'month_usd is an amount from 0 to 1000000')
      this.simOwnMonthly = { month_usd: Math.round(m * 1e6) / 1e6, at: new Date(this.now()).toISOString() }
      this.studioFlags.monthlyMissing = false
      this.studioHostLazy?.setMonthlyTotal(true)
      return this.ownMonthlyRow()[0]
    })
  }
  addKey(body: { provider: string; key: string; label?: string; default?: boolean }) {
    return this.delay(() => {
      const secret = body.key.trim()
      if (secret.length < 8) throw new ApiError(401, 'bad_key', `${this.providerStatus(body.provider).label} rejected that key`)
      if (this.simKeys.some((k) => k.provider === body.provider && k.secret === secret)) throw new ApiError(409, 'duplicate_key', 'that key is already saved')
      const first = !this.simKeys.some((k) => k.provider === body.provider && k.default)
      const makeDefault = body.default ?? first
      if (makeDefault) for (const k of this.simKeys) if (k.provider === body.provider) k.default = false
      const k = { id: `k_${Math.random().toString(16).slice(2, 10)}`, provider: body.provider, provider_label: this.providerStatus(body.provider).label, label: body.label?.trim() || `${this.providerStatus(body.provider).label} key`, owner: 'user:operator', hint: '…' + secret.slice(-4), default: makeDefault, created_at: Date.now() / 1000, secret }
      this.simKeys.push(k)
      this.providerKeys[body.provider] = this.providerKeys[body.provider] ?? secret
      return this.keyView(k)
    })
  }
  updateKey(id: string, body: { label?: string; default?: boolean }) {
    return this.delay(() => {
      const k = this.simKeys.find((x) => x.id === id)
      if (!k) throw new ApiError(404, 'unknown_key', `no key ${id}`)
      if (body.label !== undefined) k.label = body.label.trim() || k.label
      if (body.default === true) for (const x of this.simKeys) if (x.provider === k.provider) x.default = x.id === id
      if (body.default === false) k.default = false
      return this.keyView(k)
    })
  }
  refreshKey(id: string) {
    return this.delay(() => {
      const k = this.simKeys.find((x) => x.id === id)
      if (!k) throw new ApiError(404, 'unknown_key', `no key ${id}`)
      return this.keyView(k)
    })
  }
  removeKey(id: string) {
    return this.delay(() => {
      const k = this.simKeys.find((x) => x.id === id)
      if (!k) throw new ApiError(404, 'unknown_key', `no key ${id}`)
      this.simKeys = this.simKeys.filter((x) => x.id !== id)
      let unassigned = 0
      for (const a of this.agents.values()) if (a.options?.key === id) {
        a.options = { ...a.options, key: undefined }
        unassigned++
      }
      return { ok: true as const, unassigned }
    })
  }

  openrouterCatalog() {
    return this.delay(() => ({ models: clone(SIM_CATALOG), fetched_at: Date.now() / 1000, error: null }))
  }
  openrouterEndpoints(modelId: string) {
    return this.delay(() => {
      const m = SIM_CATALOG.find((x) => x.id === modelId)
      if (!m) throw new ApiError(404, 'unknown_model', `OpenRouter has no model ${modelId}`)
      const base = { context_length: m.context_length, max_completion_tokens: m.max_completion_tokens, quantization: null, status: 0, tools: m.tools }
      return [
        { ...base, name: `${m.name} | first-party`, provider: m.id.split('/')[0], tag: m.id.split('/')[0], in_per_m: m.in_per_m, out_per_m: m.out_per_m, uptime: 99.8, latency_ms: 900, throughput: 60 },
        { ...base, name: `${m.name} | Together`, provider: 'Together', tag: 'together', in_per_m: m.in_per_m == null ? null : m.in_per_m * 0.8, out_per_m: m.out_per_m == null ? null : m.out_per_m * 0.8, uptime: 98.1, latency_ms: 1400, throughput: 45 },
      ]
    })
  }

  // ------------------------------------------------------------------ Lab (recorded results)

  listLabSuites() {
    return this.lab.suites()
  }
  listLabRuns(opts?: { suite?: string; limit?: number }) {
    return this.lab.listRuns(opts)
  }
  startLabRun(suite: string) {
    return this.lab.start(suite)
  }
  getLabRun(id: string) {
    return this.lab.get(id)
  }
  cancelLabRun(id: string) {
    return this.lab.cancel(id)
  }
  getLabHistory(suite: string, limit?: number) {
    return this.lab.history(suite, limit)
  }
  getLabScorecard() {
    return this.lab.scorecard()
  }

  connect() {
    if (this.state === 'open') return
    this.setState('connecting')
    this.later(250, () => {
      this.setState('open')
      this.emit({ type: 'hello', at: this.now(), hive: this.hiveInfo() })
      if (this.opts.autoStart && !this.running) {
        this.running = true
        this.loop()
        this.noteLoop()
        this.teamLoop()
        this.capLoop(true)
      }
    }, true)
  }
  disconnect() {
    this.running = false
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    this.lab.stop()
    this.setState('idle')
  }
  subscribe(fn: (e: HiveEvent) => void) {
    return this.events.on(fn)
  }
  onConnection(fn: (s: ConnectionState) => void) {
    fn(this.state)
    return this.conn.on(fn)
  }
  private setState(s: ConnectionState) {
    this.state = s
    this.conn.emit(s)
  }
}

function round6(n: number) {
  return Math.round(n * 1e6) / 1e6
}

export function stripDetail(d: BeliefDetail): Belief {
  return {
    swarm_id: d.swarm_id,
    statement: d.statement,
    tv: { ...d.tv },
    stamp: [...d.stamp],
    sources: [...d.sources],
    updated_at: d.updated_at,
  }
}
