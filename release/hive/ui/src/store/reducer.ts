import type {
  Agent,
  Approval,
  AssertionOutcome,
  Belief,
  BudgetLine,
  BudgetRefusal,
  CollabRequest,
  Goal,
  HarnessConnection,
  HealthAlert,
  HiveEvent,
  HiveInfo,
  Motivation,
  MotivationRef,
  LabCase,
  LabHistory,
  LabRunSummary,
  LabScorecardEntry,
  LabSuite,
  Message,
  PolicyRule,
  Program,
  ProgramActionRecord,
  ShareRecord,
  Swarm,
  ThinkingPhase,
  Trace,
  Usage,
  Wakeup,
} from '../api/types'
import { keepHostFlags } from '../api/idleMinds'   // Surface: Health idle r1.3, the host's flags survive an event

export const LOG_CAP = 400
export const USAGE_CAP = 20_000
export const ACTIVITY_CAP = 40
export const MESSAGE_CAP = 300
export const TRACE_CAP = 120
export const APPROVAL_CAP = 300
export const LAB_LOG_CAP = 300
export const PROGRAM_ACTION_CAP = 100
export const REQUEST_CAP = 200

export type ActivityKind = 'belief' | 'message' | 'status' | 'error' | 'birth' | 'approval' | 'goal' | 'wakeup'

export interface Activity {
  id: number
  at: string
  kind: ActivityKind
  agent_id: string | null
  swarm_id: string | null
  text: string
  statement?: string
  outcome?: AssertionOutcome
}

/** The pure, serialisable part of the app state that live events act upon. */
export interface HiveData {
  hive: HiveInfo | null
  agents: Record<string, Agent>
  swarms: Record<string, Swarm>
  thinking: Record<string, ThinkingPhase>
  /** Messages per agent, oldest first, deduplicated by id. */
  messages: Record<string, Message[]>
  /**
   * When this person last sent a mind a message from this client, per mind (ISO time; mind-chat r1 Recent
   * conversations). Per identity by construction: an init starts it empty.
   */
  chattedAt: Record<string, string>
  /** Beliefs per swarm, keyed by statement. */
  beliefs: Record<string, Record<string, Belief>>
  /** Swarms whose belief list has been loaded from REST. */
  beliefsLoaded: Record<string, true>
  /** Last-updated time per statement, for "recently changed" highlights. */
  beliefPulse: Record<string, number>
  usage: Usage[]
  logs: Record<string, string[]>
  activity: Activity[]
  activitySeq: number
  // ---- Phase 2
  approvals: Record<string, Approval>
  /** null until the rules have been fetched. */
  policy: PolicyRule[] | null
  /** Every goal of every loaded swarm, by id. */
  goals: Record<string, Goal>
  goalsLoaded: Record<string, true>
  /** Model iterations per agent, oldest first, unique by id. */
  traces: Record<string, Trace[]>
  wakeups: Record<string, Wakeup>
  /** Last time each wakeup fired (ms), for a pulse in the schedule. */
  wakeFired: Record<string, number>
  // ---- Lab
  /** null until the suites have been fetched (or on a server without the Lab). */
  labSuites: LabSuite[] | null
  /** Every run summary seen, by id. */
  labRuns: Record<string, LabRunSummary>
  /** Cases per run, in arrival order, unique by case id. */
  labCases: Record<string, LabCase[]>
  /** Live log lines per run (lab.log). */
  labLogs: Record<string, string[]>
  /** Per-suite history (oldest first), kept current as runs finish. */
  labHistory: Record<string, LabHistory>
  /** Per-dimension health (GET /api/lab/scorecard); null until fetched or on older servers. */
  labScorecard: LabScorecardEntry[] | null
  // ---- Hive programs
  /** null until GET /api/programs answered (or on a hive without programs). */
  programs: Program[] | null
  // ---- Live operational state (events the hive publishes beyond the core model)
  /** Minds whose model calls are being refused for spending (budget.refused), by agent id. Cleared when a call is billed again. */
  refusals: Record<string, BudgetRefusal>
  /** Health alerts not yet looked at, keyed agentId + kind (one per pattern; a repeat replaces it). */
  healthAlerts: Record<string, { alert: HealthAlert; at: string }>
  /** Spending limits as last pushed (budgets.updated); null until one arrives. */
  budgets: BudgetLine[] | null
  /** Cross-swarm requests by id (GET /api/requests and request.updated). */
  requests: Record<string, CollabRequest>
  /** Recent app actions, newest first (program.action). */
  programActions: ProgramActionRecord[]
  /** Outside agents that joined in this session, by invitation id (harness.connected). */
  harnessConnected: Record<string, HarnessConnection>
  /** Memory shares by id (share.updated). */
  shares: Record<string, ShareRecord>
  // ---- Motivations above Tasks (host phase 1; lib/motivations.ts loads them)
  /** The motivations this viewer can read, by id (GET /api/motivations, motivation.updated). */
  motivations: Record<string, Motivation>
  motivationsLoaded: boolean
  /** The last read stopped at the paging guard: the list may be missing some (nothing was purged on it). */
  motivationsPartial: boolean
  /** Each task's readable links (GET /api/tasks `motivations`, motivation.links): a hidden link and no link look the same. */
  taskLinks: Record<string, MotivationRef[]>
  taskLinksLoaded: boolean
  /** The last read stopped at the paging guard: tasks it did not reach have no entry (never counted Unsorted). */
  taskLinksPartial: boolean
  /** Bumped on every motivation.links event, so a view showing one motivation's tasks reads them again. */
  linksSeq: number
}

export const emptyData = (): HiveData => ({
  hive: null,
  agents: {},
  swarms: {},
  thinking: {},
  messages: {},
  chattedAt: {},
  beliefs: {},
  beliefsLoaded: {},
  beliefPulse: {},
  usage: [],
  logs: {},
  activity: [],
  activitySeq: 0,
  approvals: {},
  policy: null,
  goals: {},
  goalsLoaded: {},
  traces: {},
  wakeups: {},
  wakeFired: {},
  labSuites: null,
  labRuns: {},
  labCases: {},
  labLogs: {},
  labHistory: {},
  labScorecard: null,
  programs: null,
  refusals: {},
  healthAlerts: {},
  budgets: null,
  requests: {},
  programActions: [],
  harnessConnected: {},
  shares: {},
  motivations: {},
  motivationsLoaded: false,
  motivationsPartial: false,
  taskLinks: {},
  taskLinksLoaded: false,
  taskLinksPartial: false,
  linksSeq: 0,
})

export const healthAlertKey = (a: Pick<HealthAlert, 'agent_id' | 'kind'>) => `${a.agent_id}\u0000${a.kind}`

/** Mark health alerts as seen: all of them, or one mind's. Pure. */
export function resolveHealthAlerts(s: Pick<HiveData, 'healthAlerts'>, agentId?: string): Record<string, { alert: HealthAlert; at: string }> {
  if (!agentId) return Object.keys(s.healthAlerts).length ? {} : s.healthAlerts
  const next = Object.fromEntries(Object.entries(s.healthAlerts).filter(([, v]) => v.alert.agent_id !== agentId))
  return Object.keys(next).length === Object.keys(s.healthAlerts).length ? s.healthAlerts : next
}

/** Merge a fetched request list into the store's map, keeping the newest REQUEST_CAP. Pure. */
export function mergeRequests(cur: Record<string, CollabRequest>, list: CollabRequest[]): Record<string, CollabRequest> {
  const all = { ...cur }
  for (const r of list) all[r.id] = r
  const ids = Object.keys(all)
  if (ids.length <= REQUEST_CAP) return all
  const keep = Object.values(all).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, REQUEST_CAP)
  return Object.fromEntries(keep.map((r) => [r.id, r]))
}

const pulseKey = (swarmId: string, statement: string) => `${swarmId}\u0000${statement}`
export { pulseKey }

function pushActivity(s: HiveData, a: Omit<Activity, 'id'>): Pick<HiveData, 'activity' | 'activitySeq'> {
  const id = s.activitySeq + 1
  const activity = [{ ...a, id }, ...s.activity]
  if (activity.length > ACTIVITY_CAP) activity.length = ACTIVITY_CAP
  return { activity, activitySeq: id }
}

/** Insert or replace a message, keeping the list sorted by time and unique by id. */
export function upsertMessage(list: Message[] | undefined, m: Message): Message[] {
  const cur = list ?? []
  const idx = cur.findIndex((x) => x.id === m.id)
  if (idx >= 0) {
    const next = cur.slice()
    next[idx] = m
    return next
  }
  const next = [...cur, m]
  if (cur.length && cur[cur.length - 1].created_at > m.created_at) {
    next.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }
  return next.length > MESSAGE_CAP ? next.slice(next.length - MESSAGE_CAP) : next
}

export function mergeMessages(list: Message[] | undefined, incoming: Message[]): Message[] {
  const map = new Map<string, Message>()
  for (const m of list ?? []) map.set(m.id, m)
  for (const m of incoming) map.set(m.id, m)
  return [...map.values()].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

/** Insert or replace a trace, keeping the list ordered by id and capped. */
export function upsertTrace(list: Trace[] | undefined, t: Trace): Trace[] {
  const cur = list ?? []
  const idx = cur.findIndex((x) => x.id === t.id)
  if (idx >= 0) {
    const next = cur.slice()
    next[idx] = t
    return next
  }
  const next = [...cur, t]
  if (cur.length && cur[cur.length - 1].id > t.id) next.sort((a, b) => a.id - b.id)
  return next.length > TRACE_CAP ? next.slice(next.length - TRACE_CAP) : next
}

export function mergeTraces(list: Trace[] | undefined, incoming: Trace[]): Trace[] {
  const map = new Map<number, Trace>()
  for (const t of list ?? []) map.set(t.id, t)
  for (const t of incoming) map.set(t.id, t)
  const out = [...map.values()].sort((a, b) => a.id - b.id)
  return out.length > TRACE_CAP ? out.slice(out.length - TRACE_CAP) : out
}

function capApprovals(rec: Record<string, Approval>): Record<string, Approval> {
  const keys = Object.keys(rec)
  if (keys.length <= APPROVAL_CAP) return rec
  // drop the oldest decided ones; pending items are never dropped
  const decided = Object.values(rec)
    .filter((a) => a.status !== 'pending')
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
  const next = { ...rec }
  for (const a of decided.slice(0, keys.length - APPROVAL_CAP)) delete next[a.id]
  return next
}

const GOAL_TEXT: Partial<Record<Goal['status'], string>> = {
  claimed: 'claimed',
  waiting: 'delivered, waiting on you for',
  done: 'finished',
  failed: 'gave up on',
}

const STATUS_TEXT: Partial<Record<Agent['status'], string>> = {
  awake: 'woke up',
  asleep: 'fell asleep',
  stopped: 'stopped',
  error: 'hit an error',
}

/** Apply one live event. Pure: returns a new object, never mutates `s`. */
export function reduce(s: HiveData, e: HiveEvent): HiveData {
  switch (e.type) {
    case 'hello':
      return { ...s, hive: e.hive }

    case 'agent.updated': {
      const prev = s.agents[e.agent.id]
      // the event carries no per-viewer flags (Platform r2.4): keep the last read's until a fresh GET replaces them
      const next: HiveData = { ...s, agents: { ...s.agents, [e.agent.id]: keepHostFlags(prev, e.agent) } }
      if (!prev) {
        return { ...next, ...pushActivity(s, { at: e.at, kind: 'birth', agent_id: e.agent.id, swarm_id: e.agent.swarm_id, text: 'was born' }) }
      }
      if (prev.status !== e.agent.status && STATUS_TEXT[e.agent.status]) {
        const thinking = e.agent.status === 'awake' ? s.thinking : omit(s.thinking, e.agent.id)
        return {
          ...next,
          thinking,
          ...pushActivity(s, {
            at: e.at,
            kind: e.agent.status === 'error' ? 'error' : 'status',
            agent_id: e.agent.id,
            swarm_id: e.agent.swarm_id,
            text: STATUS_TEXT[e.agent.status]!,
          }),
        }
      }
      return next
    }

    case 'agent.deleted': {
      if (!s.agents[e.agent_id]) return s
      return {
        ...s,
        agents: omit(s.agents, e.agent_id),
        thinking: omit(s.thinking, e.agent_id),
        refusals: omit(s.refusals, e.agent_id),
        swarms: Object.fromEntries(
          Object.entries(s.swarms).map(([id, sw]) => [
            id,
            sw.member_ids.includes(e.agent_id) ? { ...sw, member_ids: sw.member_ids.filter((m) => m !== e.agent_id) } : sw,
          ]),
        ),
      }
    }

    case 'swarm.updated':
      return { ...s, swarms: { ...s.swarms, [e.swarm.id]: e.swarm } }

    case 'swarm.deleted': {
      const swarms = { ...s.swarms }
      delete swarms[e.swarm_id]
      return { ...s, swarms }
    }

    case 'message': {
      const m = e.message
      const known = s.messages[m.agent_id]?.some((x) => x.id === m.id)
      const next = { ...s, messages: { ...s.messages, [m.agent_id]: upsertMessage(s.messages[m.agent_id], m) } }
      if (known) return next
      const fromPeer = m.sender.startsWith('agent:') && m.sender !== `agent:${m.agent_id}`
      return {
        ...next,
        ...pushActivity(s, {
          at: e.at,
          kind: 'message',
          agent_id: m.direction === 'out' ? m.agent_id : fromPeer ? m.sender.slice(6) : m.agent_id,
          swarm_id: s.agents[m.agent_id]?.swarm_id ?? null,
          text: m.direction === 'out' ? 'said something' : fromPeer ? `messaged ${s.agents[m.agent_id]?.name ?? 'a mind'}` : 'received a message',
        }),
      }
    }

    case 'agent.thinking':
      return {
        ...s,
        thinking: e.phase === 'idle' ? omit(s.thinking, e.agent_id) : { ...s.thinking, [e.agent_id]: e.phase },
      }

    case 'belief.published':
      return {
        ...s,
        ...pushActivity(s, {
          at: e.at,
          kind: 'belief',
          agent_id: e.assertion.agent_id,
          swarm_id: e.swarm_id,
          text: e.assertion.outcome,
          statement: e.assertion.statement,
          outcome: e.assertion.outcome,
        }),
      }

    case 'belief.updated': {
      const b = e.belief
      const swarmBeliefs = s.beliefs[b.swarm_id] ?? {}
      const isNew = !swarmBeliefs[b.statement]
      const hive = s.hive && isNew && s.beliefsLoaded[b.swarm_id] ? { ...s.hive, beliefs: s.hive.beliefs + 1 } : s.hive
      return {
        ...s,
        hive,
        beliefs: { ...s.beliefs, [b.swarm_id]: { ...swarmBeliefs, [b.statement]: b } },
        beliefPulse: { ...s.beliefPulse, [pulseKey(b.swarm_id, b.statement)]: Date.parse(e.at) || Date.now() },
      }
    }

    case 'usage': {
      const usage = s.usage.length >= USAGE_CAP ? [...s.usage.slice(1), e.usage] : [...s.usage, e.usage]
      // a billed call means the mind is spending again
      return { ...s, usage, refusals: omit(s.refusals, e.usage.agent_id) }
    }

    case 'log': {
      const cur = s.logs[e.agent_id] ?? []
      const next = cur.length >= LOG_CAP ? [...cur.slice(cur.length - LOG_CAP + 1), e.line] : [...cur, e.line]
      return { ...s, logs: { ...s.logs, [e.agent_id]: next } }
    }

    case 'approval.created':
    case 'approval.updated': {
      const a = e.approval
      const prev = s.approvals[a.id]
      const next = { ...s, approvals: capApprovals({ ...s.approvals, [a.id]: a }) }
      if (prev || a.status !== 'pending') return next
      return {
        ...next,
        ...pushActivity(s, { at: e.at, kind: 'approval', agent_id: a.agent_id, swarm_id: s.agents[a.agent_id]?.swarm_id ?? null, text: `asks to run ${a.skill}` }),
      }
    }

    case 'policy.updated':
      return { ...s, policy: e.rules }

    case 'goal.updated': {
      const g = e.goal
      const prev = s.goals[g.id]
      const next = { ...s, goals: { ...s.goals, [g.id]: g } }
      const verb = prev?.status !== g.status ? GOAL_TEXT[g.status] : undefined
      if (!verb || !g.claimed_by) return next
      return {
        ...next,
        ...pushActivity(s, { at: e.at, kind: 'goal', agent_id: g.claimed_by, swarm_id: g.swarm_id, text: `${verb} “${g.title}”` }),
      }
    }

    case 'agent.trace':
      return { ...s, traces: { ...s.traces, [e.trace.agent_id]: upsertTrace(s.traces[e.trace.agent_id], e.trace) } }

    case 'wakeup.updated':
      return { ...s, wakeups: { ...s.wakeups, [e.wakeup.id]: e.wakeup } }

    case 'wakeup.fired':
      return {
        ...s,
        wakeFired: { ...s.wakeFired, [e.wakeup_id]: Date.parse(e.at) || Date.now() },
        ...pushActivity(s, { at: e.at, kind: 'wakeup', agent_id: e.agent_id, swarm_id: s.agents[e.agent_id]?.swarm_id ?? null, text: 'woke on schedule' }),
      }

    case 'lab.run': {
      const run = e.run
      const labSuites = s.labSuites?.map((x) =>
        x.id === run.suite && (!x.last_run || x.last_run.id === run.id || x.last_run.started_at <= run.started_at) ? { ...x, last_run: run } : x,
      ) ?? null
      const next: HiveData = { ...s, labRuns: { ...s.labRuns, [run.id]: run }, labSuites }
      const h = s.labHistory[run.suite]
      if (!h || run.status === 'running') return next
      return { ...next, labHistory: { ...s.labHistory, [run.suite]: foldRunIntoHistory(h, run, s.labCases[run.id] ?? []) } }
    }

    case 'lab.case':
      return { ...s, labCases: { ...s.labCases, [e.case.run_id]: upsertCase(s.labCases[e.case.run_id], e.case) } }

    case 'lab.log': {
      const cur = s.labLogs[e.run_id] ?? []
      const next = cur.length >= LAB_LOG_CAP ? [...cur.slice(cur.length - LAB_LOG_CAP + 1), e.text] : [...cur, e.text]
      return { ...s, labLogs: { ...s.labLogs, [e.run_id]: next } }
    }

    case 'program.updated': {
      const list = s.programs ?? []
      const has = list.some((p) => p.id === e.program.id)
      const programs = has ? list.map((p) => (p.id === e.program.id ? e.program : p)) : [...list, e.program].sort((a, b) => a.name.localeCompare(b.name))
      return { ...s, programs }
    }

    case 'budget.refused': {
      const prev = s.refusals[e.agent_id]
      const next: HiveData = { ...s, refusals: { ...s.refusals, [e.agent_id]: { code: e.code, count: e.count, at: e.at } } }
      if (prev) return next
      return {
        ...next,
        ...pushActivity(s, { at: e.at, kind: 'error', agent_id: e.agent_id, swarm_id: s.agents[e.agent_id]?.swarm_id ?? null, text: 'paused: spending limit reached' }),
      }
    }

    case 'health.alert': {
      if (!e.alert?.agent_id) return s
      return { ...s, healthAlerts: { ...s.healthAlerts, [healthAlertKey(e.alert)]: { alert: e.alert, at: e.at } } }
    }

    case 'budgets.updated':
      return Array.isArray(e.budgets) ? { ...s, budgets: e.budgets } : s

    case 'request.updated':
      return e.request?.id ? { ...s, requests: mergeRequests(s.requests, [e.request]) } : s

    case 'program.action': {
      if (!e.record?.id) return s
      const list = [e.record, ...s.programActions.filter((r) => r.id !== e.record.id)]
      if (list.length > PROGRAM_ACTION_CAP) list.length = PROGRAM_ACTION_CAP
      return { ...s, programActions: list }
    }

    case 'harness.connected':
      return e.invite?.id ? { ...s, harnessConnected: { ...s.harnessConnected, [e.invite.id]: e.invite } } : s

    case 'share.updated':
      return e.share?.id ? { ...s, shares: { ...s.shares, [e.share.id]: e.share } } : s

    case 'motivation.updated':
      return applyMotivation(s, e.motivation)

    case 'motivation.links':
      return applyMotivationLinks(s, e.motivation_id, e.linked, e.unlinked)

    default:
      return s
  }
}

/**
 * A motivation as the hive now shows it (motivation.updated carries the reader view, which has no `editable`; what this
 * viewer may do is kept from the last full read). Its title and status follow onto every task chip, including a chip
 * that showed the unread placeholder. Pure.
 */
export function applyMotivation(s: HiveData, m: Motivation | undefined): HiveData {
  if (!m?.id || typeof m.title !== 'string') return s
  const prev = s.motivations[m.id]
  if (prev && prev.updated_at > m.updated_at) return s
  const next: Motivation = { ...m, editable: m.editable ?? prev?.editable ?? false }
  const shared = m.shared_with ?? prev?.shared_with
  const version = m.links_version ?? prev?.links_version
  if (shared) next.shared_with = shared
  if (version !== undefined) next.links_version = version
  // a task's ref shows the title a motivations read delivered (a first delivery replaces the unread placeholder)
  let taskLinks = s.taskLinks
  const stale = (r: MotivationRef) => r.id === m.id && (r.title !== m.title || r.status !== m.status)
  if (Object.values(s.taskLinks).some((refs) => refs.some(stale))) {
    taskLinks = Object.fromEntries(Object.entries(s.taskLinks).map(([g, refs]) => [g, refs.some(stale) ? refs.map((r) => (r.id === m.id ? { id: m.id, title: m.title, status: m.status } : r)) : refs]))
  }
  return { ...s, motivations: { ...s.motivations, [m.id]: next }, taskLinks }
}

/** A committed link change the hive told this viewer about (it can read the motivation and see the swarm). Pure. */
export function applyMotivationLinks(s: HiveData, motivationId: string, linked: string[] = [], unlinked: string[] = []): HiveData {
  if (!motivationId) return s
  const m = s.motivations[motivationId]
  const taskLinks = { ...s.taskLinks }
  for (const g of unlinked) if (taskLinks[g]) taskLinks[g] = taskLinks[g].filter((r) => r.id !== motivationId)
  if (m) {
    const ref: MotivationRef = { id: m.id, title: m.title, status: m.status }
    for (const g of linked) taskLinks[g] = [...(taskLinks[g] ?? []).filter((r) => r.id !== motivationId), ref].sort((a, b) => a.id.localeCompare(b.id))
  }
  return { ...s, taskLinks, linksSeq: s.linksSeq + 1 }
}

export const isTerminal = (r: Pick<LabRunSummary, 'status'>) => r.status !== 'running'

export function upsertCase(list: LabCase[] | undefined, c: LabCase): LabCase[] {
  const cur = list ?? []
  const idx = cur.findIndex((x) => x.id === c.id)
  if (idx < 0) return [...cur, c]
  const next = cur.slice()
  next[idx] = c
  return next
}

/** Add (or replace) a finished run and its metric values in a suite's history. Pure. */
export function foldRunIntoHistory(h: LabHistory, run: LabRunSummary, cases: LabCase[]): LabHistory {
  const runs = [...h.runs.filter((r) => r.id !== run.id), run].sort((a, b) => a.started_at.localeCompare(b.started_at))
  const metrics = h.metrics.map((m) => ({ ...m, points: m.points.filter((p) => p.run_id !== run.id) }))
  for (const c of cases) {
    for (const mt of c.metrics) {
      let entry = metrics.find((m) => m.case_id === c.id && m.metric === mt.name)
      if (!entry) {
        entry = { case_id: c.id, case: c.name, metric: mt.name, unit: mt.unit, better: mt.better, target: mt.target, points: [] }
        metrics.push(entry)
      }
      entry.points.push({ run_id: run.id, at: run.started_at, value: mt.value, ok: mt.ok })
      entry.points.sort((a, b) => a.at.localeCompare(b.at))
    }
  }
  return { ...h, runs, metrics }
}

/** Overall Lab health from each suite's last run. */
export function labHealth(suites: LabSuite[] | null): { state: 'unknown' | 'running' | 'passing' | 'failing'; passing: number; total: number; ran: number } {
  if (!suites?.length) return { state: 'unknown', passing: 0, total: 0, ran: 0 }
  let passing = 0
  let ran = 0
  let failing = false
  let running = false
  for (const x of suites) {
    const r = x.last_run
    if (!r) continue
    if (r.status === 'running') running = true
    else ran++
    if (r.status === 'passed') passing++
    if (r.status === 'failed' || r.status === 'error') failing = true
  }
  return { state: failing ? 'failing' : running ? 'running' : ran ? 'passing' : 'unknown', passing, total: suites.length, ran }
}

function omit<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

// ---------------------------------------------------------------- derived

export function pendingApprovals(approvals: Record<string, Approval>): Approval[] {
  return Object.values(approvals)
    .filter((a) => a.status === 'pending')
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
}

/** Unresolved health alerts (one per mind and failure pattern). */
export const countHealthAlerts = (alerts: HiveData['healthAlerts']): number => Object.keys(alerts).length

/** Cross-swarm requests, newest first. */
export function requestList(requests: Record<string, CollabRequest>): CollabRequest[] {
  return Object.values(requests).sort((a, b) => b.created_at.localeCompare(a.created_at))
}

export const countPending = (approvals: Record<string, Approval>): number => {
  let n = 0
  for (const id in approvals) if (approvals[id].status === 'pending') n++
  return n
}

/** Goals a mind holds (claimed or waiting) per agent, for the task glyphs orbiting minds in the scene. */
export function claimedByAgent(goals: Record<string, Goal>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id in goals) {
    const g = goals[id]
    if ((g.status === 'claimed' || g.status === 'waiting') && g.claimed_by) out[g.claimed_by] = (out[g.claimed_by] ?? 0) + 1
  }
  return out
}

/** Pending approvals per agent (an amber "asking" halo in the scene). */
export function askingByAgent(approvals: Record<string, Approval>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id in approvals) {
    const a = approvals[id]
    if (a.status === 'pending') out[a.agent_id] = (out[a.agent_id] ?? 0) + 1
  }
  return out
}

export interface HiveStats {
  agents: number
  awake: number
  beliefs: number
  spent: number
  swarms: number
}

export function computeStats(s: Pick<HiveData, 'agents' | 'beliefs' | 'hive' | 'beliefsLoaded' | 'swarms'>): HiveStats {
  const agents = Object.values(s.agents)
  let beliefs = 0
  let anyLoaded = false
  for (const id of Object.keys(s.beliefs)) {
    if (s.beliefsLoaded[id]) anyLoaded = true
    beliefs += Object.keys(s.beliefs[id]).length
  }
  return {
    agents: agents.length,
    awake: agents.filter((a) => a.status === 'awake').length,
    beliefs: anyLoaded ? beliefs : s.hive?.beliefs ?? beliefs,
    spent: agents.reduce((sum, a) => sum + a.spent_usd, 0),
    swarms: Object.keys(s.swarms).length,
  }
}
