import { personStartedProgramAct } from '../lib/personSwarmAct'
import { useMemo } from 'react'
import { create } from 'zustand'
import { ApiError, Emitter, type ConnectionState, type HiveClient } from '../api/client'
import { approvalRefusalWords, noteRefusal } from '../lib/approvalRefusal'
import type {
  Agent,
  AgentAction,
  Approval,
  Catalog,
  CreateAgentBody,
  KeyInfo,
  CreatedAgent,
  CreateGoalBody,
  CreatePolicyBody,
  CreateWakeupBody,
  Goal,
  HiveEvent,
  LabRun,
  Message,
  ModelEndpoint,
  ModelOption,
  PatchAgentBody,
  PatchGoalBody,
  PatchWakeupBody,
  ProgramDetail,
  ProviderStatus,
  Wakeup,
} from '../api/types'
import type { IconName } from '../ui/Icon'
import { readContext } from '../lib/readContext'
import { readResult, resultWords } from '../features/power/api'
import { shown } from '../lib/displayName'
import { canRemindNow, canSleepNow, hasHostFlags, remindRefusalNow, remindRefusal, remindWait, sleepRefusal } from '../api/idleMinds'
import {
  applyResult,
  backStep,
  currentStep,
  goTo,
  jumpTo,
  loadTrail,
  newSession,
  notice,
  pushStep,
  receiveView,
  saveTrail,
  sessionKey,
  type ProgramSession,
  type TrailStep,
} from './programSession'
import {
  countHealthAlerts,
  emptyData,
  isTerminal,
  mergeMessages,
  mergeRequests,
  mergeTraces,
  reduce,
  requestList,
  resolveHealthAlerts,
  upsertCase,
  upsertMessage,
  type HiveData,
} from './reducer'

export interface PendingMessage {
  tempId: string
  agent_id: string
  text: string
  status: 'sending' | 'failed'
  created_at: string
  error?: string
}

export interface Toast {
  id: number
  tone: 'info' | 'success' | 'error'
  title: string
  body?: string
  icon?: IconName
  /** Identity colour (e.g. the mind that is asking). */
  hue?: number
  /** Tapping the toast runs this. */
  action?: { label: string; run: () => void }
  /** Override the auto-dismiss delay (ms). */
  ttl?: number
  /** A newer toast of the same group replaces the one on screen (approval asks: one card, never a pile; audit P2 #11). */
  group?: string
}

/** The owner's five answers: Once (approve), For a time (for), Always (remember), No (deny), Never (never). */
export type Decision = 'approve' | 'for' | 'remember' | 'deny' | 'never'

export const atomKey = (agentId: string, space: string, atom: string) => `${agentId}\u0000${space}\u0000${atom}`

export interface UIState {
  client: HiveClient | null
  /**
   * Surface R (O-B1): the identity of the hive session this store holds: the client instance (K1/L1 readContext) plus
   * the init that bound it. Everything client-scoped in the store was read under this session; a read or action that
   * started under another session never writes here, and a decision inspected under another session is refused.
   */
  session: string
  /**
   * Kimi K3: bumped by every init, including one that keeps the same client (and so the same session). What waits on
   * the earlier init (the approval-toast queue) empties when it moves.
   */
  inits: number
  connection: ConnectionState
  ready: boolean
  bootError: string | null
  models: ModelOption[]
  pending: Record<string, PendingMessage[]>
  /** Message ids that arrived live in this session (they get a streamed reveal). */
  freshMessages: Record<string, true>
  messagesLoaded: Record<string, true>
  logsLoaded: Record<string, true>
  paletteOpen: boolean
  /** What the palette opens with already typed (openPalette(query)); '' for an empty search. */
  paletteQuery: string
  reveal: { agent: Agent; token: string } | null
  toasts: Toast[]
  /** Set while the create flow is waiting for a mind to be born in the scene. */
  focusBirth: string | null
  // ---- Phase 2
  approvalsLoaded: boolean
  /** Decisions in flight, for the confirmation motion. */
  deciding: Record<string, Decision>
  /**
   * Review B1 (next22): goals whose last write got no answer and whose re-read has not yet settled what happened.
   * No further write is sent for them until reconcileGoal reads them again.
   */
  goalsUnsure: Record<string, true>
  tracesLoaded: Record<string, true>
  wakeupsLoaded: Record<string, true>
  /** Atoms queued for retirement (atomKey). */
  retired: Record<string, true>
  resetQueued: Record<string, true>
  /** Health's Remind, by mind id: when this session last asked (ms). Off for a minute after, wherever it was asked from. */
  remindedAt: Record<string, number>
  /** Health idle r1.3: how many shown cards watch each mind's host flags */
  flagWatch: Record<string, number>
  /** Health idle r1.4: when this session last read each mind's host flags fresh (ms, this browser's clock) */
  flagsAt: Record<string, number>
  stopAllOpen: boolean
  // ---- Lab
  labLoaded: boolean
  /** The stored stdout tail of finished runs (GET /api/lab/runs/{id}). */
  labRunLog: Record<string, string>
  /** "Run everything": suites still to start, one after another. */
  labQueue: string[]
  /** Runs started or watched in this session (they toast when they finish). */
  labWatched: Record<string, true>
  // ---- Hive programs
  programsError: string | null
  /** GET /api/programs/{id}, with describe(). */
  programDetails: Record<string, ProgramDetail>
  /** Open sessions by sessionKey(program, swarm): graph, trail, selection, notices, tasks. Kept when you leave. */
  programSessions: Record<string, ProgramSession>
  // ---- Providers and the model catalogue
  /** null until fetched (or on a server without providers). */
  providers: ProviderStatus[] | null
  catalog: Catalog | null
  catalogState: 'idle' | 'loading' | 'error'
  catalogError: string | null
  /** OpenRouter upstreams per model id, once asked for. */
  endpoints: Record<string, ModelEndpoint[]>
  endpointsLoading: Record<string, true>
  /** The keyring (GET /api/keys); null until fetched. */
  keys: KeyInfo[] | null
  /** The role library; null until fetched (and while unsupported or failed: see rolesState). */
  roles: import('../api/types').Role[] | null
  /** Where loading the role library stands, so a page never waits on `roles` forever. */
  rolesState: 'idle' | 'loading' | 'ready' | 'error' | 'unsupported'
  rolesError: unknown
  /** True once GET /api/requests answered (false on hives without cross-swarm requests). */
  requestsLoaded: boolean
}

export interface Actions {
  init(client: HiveClient): Promise<void>
  hydrate(): Promise<void>
  loadBeliefs(swarmId: string, force?: boolean): Promise<void>
  loadMessages(agentId: string): Promise<void>
  loadLogs(agentId: string): Promise<void>
  sendMessage(agentId: string, text: string): Promise<void>
  retryMessage(agentId: string, tempId: string): Promise<void>
  dismissPending(agentId: string, tempId: string): void
  /** Resolves true when the hive took it, false when it refused or there is no hive (the refusal is also toasted). */
  agentAction(agentId: string, action: AgentAction): Promise<boolean>
  /**
   * Health asks the mind its question now (Platform idle-minds r2 remind). A refusal the shapes name (409 not_awake,
   * 403 personal_mind, 404) comes back as plain words with ok false; any other error is thrown (the outcome is unknown);
   * null when the session moved on meanwhile. Within a minute of the last Remind for this mind (remindedAt) nothing is
   * sent and `held` is true: the host would count it as the same question.
   */
  remindIdle(agentId: string, name: string, who?: string): Promise<{ ok: boolean; text: string; held?: boolean } | null>
  /**
   * Health idle r1.3: the mind as the host sees it for this viewer NOW (GET /api/agents/{id}, which carries may_remind,
   * may_sleep and is_mine), written to the store; null when it could not be read or the session moved on.
   */
  refreshAgentFlags(agentId: string, who?: string): Promise<Agent | null>
  /**
   * Put a mind to sleep only if the host, read fresh at the press, still lets this viewer and the mind is awake (the one
   * rule, api/idleMinds canSleepNow). A refusal is plain words with ok false; null when the session moved on.
   */
  sleepChecked(agentId: string, name: string, who?: string): Promise<{ ok: boolean; text: string } | null>
  /** Minds whose flags a page shows (Health's idle cards): an agent.updated for one re-reads its flags. Returns unwatch. */
  watchAgentFlags(agentId: string): () => void
  patchAgent(agentId: string, body: PatchAgentBody): Promise<Agent | null>
  createAgent(body: CreateAgentBody): Promise<CreatedAgent>
  setPalette(open: boolean): void
  /** Open the command palette with `query` already typed (empty: a fresh search). */
  openPalette(query?: string): void
  clearReveal(): void
  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: number): void
  /** Apply an event (exposed for tests and for the client subscription). */
  apply(e: HiveEvent): void
  // ---- Phase 2
  loadApprovals(): Promise<void>
  /**
   * `session`: the store session the request was inspected under (approvalSeenOf / inspect stamp it). When given and
   * no longer current, nothing is dispatched: the request belongs to an earlier connection.
   */
  /** `origin`: the dialog instance answering (lib/approvalRefusal keys a refusal's words to it) */
  decide(id: string, d: Decision, minutes?: number, session?: string, origin?: object): Promise<Approval | null>
  loadPolicy(): Promise<void>
  addRule(body: CreatePolicyBody): Promise<boolean>
  deleteRule(id: string): Promise<void>
  loadGoals(swarmId: string, force?: boolean): Promise<void>
  createGoal(swarmId: string, body: CreateGoalBody): Promise<Goal | null>
  /**
   * Resolves true when the hive took the change (confirmed by its answer, or, when the answer was lost, by reading the
   * goal again), false otherwise. Callers that word the outcome use writeGoal.
   */
  patchGoal(id: string, body: PatchGoalBody, session?: string): Promise<boolean>
  /**
   * Review B1 (next22): patchGoal with its outcome kept apart: taken, refused, not taken on re-read, or unknown.
   * `quiet`: the caller shows the not-confirmed outcomes itself (GoalDecision's dialog), so they are not also toasted.
   */
  writeGoal(id: string, body: PatchGoalBody, session?: string, opts?: { quiet?: boolean }): Promise<GoalWrite>
  /** Read one goal again from the hive (after a lost answer). The goal as read, or null when it could not be read. */
  reconcileGoal(id: string): Promise<Goal | null>
  loadTraces(agentId: string): Promise<void>
  loadWakeups(agentId: string): Promise<void>
  createWakeup(agentId: string, body: CreateWakeupBody): Promise<Wakeup | null>
  patchWakeup(id: string, body: PatchWakeupBody): Promise<void>
  deleteWakeup(id: string): Promise<void>
  retireAtom(agentId: string, space: string, atom: string): Promise<boolean>
  resetMemory(agentId: string): Promise<boolean>
  stopAll(): Promise<number | null>
  setStopAll(open: boolean): void
  // ---- Lab
  loadLab(): Promise<void>
  loadLabRun(id: string): Promise<LabRun | null>
  loadLabHistory(suite: string): Promise<void>
  loadLabScorecard(): Promise<void>
  startLab(suite: string): Promise<LabRun | null>
  cancelLab(id: string): Promise<void>
  /** Queue every runnable suite (tests first) and run them one at a time. */
  runAllLab(): Promise<void>
  stopLabQueue(): void
  // ---- Hive programs
  loadPrograms(): Promise<void>
  loadProgram(id: string): Promise<ProgramDetail | null>
  setProgramEnabled(id: string, enabled: boolean): Promise<void>
  reloadPrograms(): Promise<void>
  /** Open (or return to) a program in a swarm: the trail is restored and the view refreshed. */
  openProgram(programId: string, swarmId: string): Promise<void>
  programRefresh(key: string): Promise<void>
  /** Go somewhere new (a trail step is added). */
  programGo(key: string, step: TrailStep): void
  /** Back one step. False when already at the first step. */
  programBack(key: string): boolean
  programJump(key: string, index: number): void
  programSelect(key: string, ids: string[]): void
  /** Run a program action on items; base_revision is always the revision on screen. */
  programAct(key: string, action: string, items: string[], params?: Record<string, unknown>): Promise<void>
  programDismiss(key: string, what: 'notice' | 'input' | 'source' | 'result' | 'suggestion'): void
  programCancelTask(key: string, taskId: string): Promise<void>
  // ---- Providers
  loadProviders(): Promise<void>
  /** Verifies the key upstream and stores it in the hive. Returns the provider, or null (toasted) on failure. */
  setProviderKey(name: string, key: string): Promise<ProviderStatus | null>
  removeProviderKey(name: string): Promise<boolean>
  loadCatalog(refresh?: boolean): Promise<void>
  loadEndpoints(modelId: string): Promise<ModelEndpoint[] | null>
  loadKeys(): Promise<void>
  /** r1.14b: `onError` lets the add-key form keep the hive's refusal in view (the toast alone was missed) */
  addKey(body: { provider: string; key: string; label?: string; default?: boolean }, onError?: (err: unknown) => void): Promise<KeyInfo | null>
  updateKey(id: string, body: { label?: string; default?: boolean }): Promise<KeyInfo | null>
  refreshKey(id: string): Promise<void>
  removeKey(id: string): Promise<boolean>
  loadRoles(): Promise<void>
  // ---- Live operational state
  loadRequests(): Promise<void>
  /** Cancel a cross-swarm request; its new state arrives as request.updated. */
  cancelRequest(id: string): Promise<boolean>
  /** Mark health alerts as seen (all, or one mind's): clears the Health badge. */
  resolveHealthAlerts(agentId?: string): void
  /** Hide a mind's spending-limit banner until the hive refuses it again. */
  dismissRefusal(agentId: string): void
}

export type Store = HiveData & UIState & Actions

/** Fan-out of raw events for imperative consumers (the scene). */
export const hiveBus = new Emitter<HiveEvent>()

let toastSeq = 0
let tempSeq = 0
let unsub: (() => void)[] = []
let unsubAuth: (() => void) | null = null
/** Bumped on every init that changes client, so A → B → A is still a new session for A's earlier reads. */
let epoch = 0
const NO_SESSION = readContext(null, 0)

/**
 * Surface R (O-B1): a read or action is bound to the session it started under. Capture before the first await;
 * after every await, write (or toast, or return a result) only while `ok()`: init may have switched the client
 * meanwhile, and a late answer from the earlier client must never land in the new session.
 */
/**
 * Health idle r1.4: an action bound to one identity (lib/identityEpoch's key: client, session and init). `who` is the
 * key captured when the person acted (a click, or opening a confirmation); absent: the identity now. ok() is false as
 * soon as the current identity is not that one, including before the first await.
 */
export function storeIdentity(s: Pick<UIState, 'client' | 'session' | 'inits'>): string {
  return readContext(s.client, s.session, s.inits)
}
function bindIdentity(get: () => Store, who?: string): { client: HiveClient | null; who: string; ok: () => boolean } {
  const now = get()
  const at = who ?? storeIdentity(now)
  return { client: now.client, who: at, ok: () => storeIdentity(get()) === at }
}

function bindSession(get: () => Store): { client: HiveClient | null; session: string; ok: () => boolean } {
  const { client, session } = get()
  return { client, session, ok: () => get().session === session && get().client === client }
}

/**
 * Kimi K4: a toast action that runs only while the toast it belongs to (by id) is still in the store's list. Whatever
 * holds the action (a rendered button during its exit animation, a stale closure) cannot run it once that toast was
 * replaced, dismissed or cleared.
 */
export function liveToastAction(action: { label: string; run: () => void }, id: number, toasts: () => Toast[]): { label: string; run: () => void } {
  return {
    label: action.label,
    run: () => {
      if (toasts().some((x) => x.id === id)) action.run()
    },
  }
}

/** Plain words for a decision refused because it was inspected under an earlier session. */
export const EARLIER_SESSION = 'This was opened under an earlier connection to the hive. Nothing was decided here.'

/**
 * Review B1 (next22): the outcome of a goal write. `taken`: the hive's answer (or, after a lost answer, a fresh read)
 * shows the change. `refused`: the hive answered no, or nothing was sent. `untaken`: the answer was lost, and a fresh
 * read shows the goal without the change. `unknown`: the answer was lost and the goal could not be read again; the
 * goal stays in goalsUnsure until it is.
 */
export type GoalWrite =
  | { kind: 'taken'; goal: Goal; checked: boolean }
  | { kind: 'refused'; why: string }
  | { kind: 'untaken'; goal: Goal; why: string }
  | { kind: 'unknown'; why: string }
export const NOT_CONFIRMED = 'We could not confirm whether this happened.'
export const GOAL_UNSURE = `${NOT_CONFIRMED} The task has to be checked again before anything else is sent for it.`
/**
 * The outcome is unknown (the request may or may not have taken effect): no answer came back (network loss, which the
 * live client reports as ApiError status 0, including a 2xx whose body could not be read; a timeout), or the hive
 * answered with a server error (any 5xx: a gateway that lost the answer, or a failure that may have come after the
 * change was applied; Review ed50158). A hive refusal (4xx) and a programming error in the client (e.g. a TypeError)
 * are errors, never "maybe happened" (Kimi next22b r2 nit).
 */
const FETCH_FAILED = /^(Failed to fetch|fetch failed|NetworkError when attempting to fetch resource\.?|Load failed|Network request failed)$/
export const answerLost = (err: unknown): boolean => {
  if (err instanceof ApiError) return err.status === 0 || err.status >= 500
  if (err instanceof DOMException) return err.name === 'TimeoutError' || err.name === 'AbortError' || err.name === 'NetworkError'
  return err instanceof TypeError && FETCH_FAILED.test(err.message)   // a raw fetch failure, by the platforms' own words
}
/** Does the goal as read carry every field of the change? */
const goalHas = (g: Goal, body: PatchGoalBody): boolean => Object.entries(body).every(([k, v]) => v === undefined || g[k as keyof Goal] === v)

/**
 * Everything read from (or about) one client: the hive's data and the UI state derived from it. Cleared whenever
 * init binds a different client, so nothing from the earlier session shows in the new one. The palette is
 * client-independent and kept. Toasts are NOT: they can carry a mind's name, a skill, a host hint or a lab run and an
 * action into it (Review R-B1), so init with a different client clears them too.
 */
function clientScoped(): HiveData & Omit<UIState, 'client' | 'session' | 'inits' | 'ready' | 'bootError' | 'paletteOpen' | 'paletteQuery' | 'toasts'> {
  return {
    ...emptyData(),
    connection: 'idle',
    models: [],
    pending: {},
    freshMessages: {},
    messagesLoaded: {},
    logsLoaded: {},
    reveal: null,
    focusBirth: null,
    approvalsLoaded: false,
    deciding: {},
    goalsUnsure: {},
    tracesLoaded: {},
    wakeupsLoaded: {},
    retired: {},
    resetQueued: {},
    remindedAt: {},
    flagWatch: {},
    flagsAt: {},
    stopAllOpen: false,
    labLoaded: false,
    labRunLog: {},
    labQueue: [],
    labWatched: {},
    programsError: null,
    programDetails: {},
    programSessions: {},
    providers: null,
    catalog: null,
    catalogState: 'idle',
    catalogError: null,
    endpoints: {},
    endpointsLoading: {},
    keys: null,
    roles: null,
    rolesState: 'idle',
    rolesError: undefined,
    requestsLoaded: false,
  }
}

/** Timers that would read again on behalf of the earlier session. */
function clearSessionTimers() {
  clearTimeout(keysTimer)
  for (const t of labRefetch.values()) clearTimeout(t)
  labRefetch.clear()
  viewSeq.clear()
}

function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}

/** Listen to `client` for the store session that is current now: its events and connection write only while it is. */
function listen(client: HiveClient, get: () => Store, set: (p: Partial<Store>) => void): ReturnType<typeof bindSession> {
  unsub.forEach((u) => u())
  unsub = []
  const live = bindSession(get)
  // an event or connection change from a client this store no longer holds never writes (a late delivery after the
  // switch, or an emitter that still holds the listener)
  unsub.push(client.onConnection((connection) => live.ok() && set({ connection })))
  unsub.push(client.subscribe((e) => {
    if (!live.ok()) return
    get().apply(e)
    if (e.type === 'health.alert')
      get().toast({ tone: 'error', title: `${e.alert.name} keeps failing at ${e.alert.skill}`, body: `${e.alert.hint} Open Health (G then E) for details.` })
  }))
  return live
}

export const useHive = create<Store>()((set, get) => ({
  ...clientScoped(),
  client: null,
  session: NO_SESSION,
  inits: 0,
  ready: false,
  bootError: null,
  paletteOpen: false,
  paletteQuery: '',
  toasts: [],

  apply(e) {
    set((s) => {
      const data = reduce(s, e)
      if (e.type === 'message' && !s.messages[e.message.agent_id]?.some((m) => m.id === e.message.id)) {
        return { ...data, freshMessages: { ...s.freshMessages, [e.message.id]: true } }
      }
      if (e.type === 'providers.updated') return { ...data, providers: e.providers }
      return data
    })
    if (e.type === 'providers.updated') {
      const live = bindSession(get)
      void live.client?.getModels().then((models) => live.ok() && set({ models })).catch(() => undefined)
      if (get().keys) void get().loadKeys().catch(() => undefined)
    }
    // r1.3: an agent.updated carries no per-viewer flags; for a mind a page shows, read them fresh (debounced, bound
    // to this session)
    if (e.type === 'agent.updated' && !hasHostFlags(e.agent) && get().flagWatch[e.agent.id]) scheduleFlagRefresh(e.agent.id)
    // who a key pays for and what it spent follow the minds
    if ((e.type === 'agent.updated' || e.type === 'agent.deleted' || e.type === 'usage') && get().keys) scheduleKeysReload()
    hiveBus.emit(e)
    if (e.type === 'lab.run' && isTerminal(e.run)) onLabRunFinished(e.run.id)
  },

  async init(client) {
    unsub.forEach((u) => u())
    unsub = []
    if (client !== get().client) {
      // Surface R (O-B1): a different client is a new session; nothing read under the earlier one is kept
      clearSessionTimers()
      set({ ...clientScoped(), toasts: [], client, session: readContext(client, ++epoch), inits: get().inits + 1, ready: false, bootError: null })
    } else set({ inits: get().inits + 1, ready: false, bootError: null })
    unsubAuth?.()
    unsubAuth = null
    const live = listen(client, get, set)
    // Platform person-session (439efb9): a client that reports credential changes starts a new store session on every
    // one, the same way a different client does. A re-login without a logout, or another tab's sign-in or sign-out,
    // drops everything read under the earlier sign-in, and nothing still in flight for it writes. When a credential is
    // then present the store reads the hive again: the one sign-in path (the Login form relies on it too), so a sign-in
    // in another tab resumes this one without pressing sign-in again. The client never connects on its own; hydrate does.
    if (client.onAuthChange) {
      const inits = get().inits
      unsubAuth = client.onAuthChange(() => {
        // only for the init that subscribed (a later init, or another client, has its own)
        if (get().client !== client || get().inits !== inits) return
        clearSessionTimers()
        set({ ...clientScoped(), toasts: [], session: readContext(client, ++epoch), ready: false, bootError: null })
        listen(client, get, set)
        if (!client.needsAuth()) void get().hydrate()
      })
    }
    if (client.needsAuth() && !(client.trySso && (await client.trySso()))) return
    if (!live.ok()) return
    await get().hydrate()
  },

  async hydrate() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    try {
      const [hive, agents, swarms, models] = await Promise.all([
        client.getHive(),
        client.listAgents(),
        client.listSwarms(),
        client.getModels(),
      ])
      if (!live.ok()) return
      set({
        hive,
        models,
        agents: Object.fromEntries(agents.map((a) => [a.id, a])),
        swarms: Object.fromEntries(swarms.map((s) => [s.id, s])),
        ready: true,
        bootError: null,
      })
      client.connect()
      // Commons are small in Phase 1: load all of them so the scene can show belief motes.
      await Promise.all(swarms.map((s) => get().loadBeliefs(s.id)))
      if (!live.ok()) return
      // Phase 2 surfaces are optional: a Phase 1 server simply leaves them empty.
      await Promise.allSettled([get().loadApprovals(), ...swarms.map((s) => get().loadGoals(s.id)), get().loadLab(), get().loadPrograms(), get().loadProviders(), get().loadRoles(), get().loadRequests()])
    } catch (err) {
      if (!live.ok()) return
      if (err instanceof ApiError && err.status === 401) {
        set({ ready: false, bootError: null })
        return
      }
      set({ bootError: errText(err) })
    }
  },

  async loadBeliefs(swarmId, force = false) {
    const live = bindSession(get)
    const client = live.client
    if (!client || (!force && get().beliefsLoaded[swarmId])) return
    const list = await client.listBeliefs(swarmId)
    if (!live.ok()) return
    set((s) => ({
      beliefs: { ...s.beliefs, [swarmId]: { ...Object.fromEntries(list.map((b) => [b.statement, b])), ...pickNewer(s.beliefs[swarmId], list) } },
      beliefsLoaded: { ...s.beliefsLoaded, [swarmId]: true },
    }))
  },

  async loadMessages(agentId) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const list = await client.listMessages(agentId, { limit: 100 })
    if (!live.ok()) return
    set((s) => ({
      messages: { ...s.messages, [agentId]: mergeMessages(s.messages[agentId], list) },
      messagesLoaded: { ...s.messagesLoaded, [agentId]: true },
    }))
  },

  async loadLogs(agentId) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const { lines } = await client.getLogs(agentId, 200)
    if (!live.ok()) return
    set((s) => {
      // Live lines that arrived while the request was in flight are appended after the tail.
      const live = s.logs[agentId] ?? []
      const tailSet = new Set(lines)
      const extra = live.filter((l) => !tailSet.has(l))
      return { logs: { ...s.logs, [agentId]: [...lines, ...extra] }, logsLoaded: { ...s.logsLoaded, [agentId]: true } }
    })
  },

  async sendMessage(agentId, text) {
    const tempId = `tmp_${++tempSeq}`
    const p: PendingMessage = { tempId, agent_id: agentId, text, status: 'sending', created_at: new Date().toISOString() }
    set((s) => ({ pending: { ...s.pending, [agentId]: [...(s.pending[agentId] ?? []), p] }, chattedAt: { ...s.chattedAt, [agentId]: p.created_at } }))
    await deliver(agentId, p)
  },

  async retryMessage(agentId, tempId) {
    const p = get().pending[agentId]?.find((x) => x.tempId === tempId)
    if (!p) return
    patchPending(agentId, tempId, { status: 'sending', error: undefined })
    await deliver(agentId, { ...p, status: 'sending' })
  },

  dismissPending(agentId, tempId) {
    set((s) => ({ pending: { ...s.pending, [agentId]: (s.pending[agentId] ?? []).filter((x) => x.tempId !== tempId) } }))
  },

  async agentAction(agentId, action) {
    const live = bindSession(get)
    const client = live.client
    if (!client) {
      get().toast({ tone: 'error', title: `Could not ${action}`, body: 'Not connected to the hive.' })
      return false
    }
    try {
      const agent = await client.agentAction(agentId, action)
      if (!live.ok()) return false
      set((s) => ({ agents: { ...s.agents, [agent.id]: agent } }))
      return true
    } catch (err) {
      if (!live.ok()) return false
      get().toast({ tone: 'error', title: `Could not ${action}`, body: errText(err) })
      return false
    }
  },

  async remindIdle(agentId, name, who) {
    // r1.4: bound to the identity the person clicked under (`who`, lib/identityEpoch identityKey), not the one current
    // now: a person changed since the click hears nothing, and nothing is read or sent for them
    const live = bindIdentity(get, who)
    if (!live.ok()) return null
    const client = live.client
    if (!client?.remindIdle) return { ok: false, text: `Not connected to the hive, so Health did not remind ${name}.` }
    const now = Date.now()
    const before = get().remindedAt[agentId]
    if (remindWait(before, now) > 0) return { ok: false, held: true, text: `Health asked ${name} less than a minute ago; a second Remind now would be the same question.` }
    // held at once, so a second click while the check below runs is the same question
    set((s) => ({ remindedAt: { ...s.remindedAt, [agentId]: now } }))
    // r1.3: the host's flag, read fresh at the press (an event never carries it); unreadable is no
    const fresh = await get().refreshAgentFlags(agentId, live.who)
    if (!live.ok()) return null
    if (!canRemindNow(fresh)) {
      set((s) => ({ remindedAt: before === undefined ? omitKey(s.remindedAt, agentId) : { ...s.remindedAt, [agentId]: before } }))
      return { ok: false, text: fresh ? remindRefusalNow(name, fresh) : `Could not check with the hive whether you may remind ${name}, so nothing was sent.` }
    }
    try {
      await client.remindIdle(agentId)
      if (!live.ok()) return null
      return { ok: true, text: `Health asked ${name} its question now. Its answer shows on Health › Idle minds.` }
    } catch (err) {
      if (!live.ok()) return null
      const why = remindRefusal(err, name)
      if (why === null) throw err
      return { ok: false, text: why }
    }
  },

  async refreshAgentFlags(agentId, who) {
    const live = bindIdentity(get, who)
    if (!live.ok() || !live.client?.getAgent) return null
    try {
      const a = await live.client.getAgent(agentId)
      if (!live.ok() || !a || a.id !== agentId) return null
      // r1.4: when these flags were read, so a newer idle row can win over them (features/health/idleCard cardView)
      set((s) => ({ agents: { ...s.agents, [agentId]: a }, flagsAt: { ...s.flagsAt, [agentId]: Date.now() } }))
      return a
    } catch {
      return null
    }
  },

  async sleepChecked(agentId, name, who) {
    // r1.4: bound to the identity the confirmation was OPENED under: a person changed while it was open sends nothing
    const live = bindIdentity(get, who)
    if (!live.ok()) return null
    if (!live.client) return { ok: false, text: `Not connected to the hive, so ${name} was not put to sleep.` }
    // r1.3: read fresh at the press, after any confirmation: flags and status as the host has them now
    const fresh = await get().refreshAgentFlags(agentId, live.who)
    if (!live.ok()) return null
    if (!fresh) return { ok: false, text: `Could not check with the hive whether you may put ${name} to sleep, so nothing was sent.` }
    if (!canSleepNow(fresh)) return { ok: false, text: sleepRefusal(name, fresh) }
    const done = await get().agentAction(agentId, 'sleep')
    if (!live.ok()) return null
    return done ? { ok: true, text: `${name} is going to sleep.` } : { ok: false, text: `Not confirmed: the hive did not say yes to putting ${name} to sleep. Look at ${name} before trying again.` }
  },

  watchAgentFlags(agentId) {
    set((s) => ({ flagWatch: { ...s.flagWatch, [agentId]: (s.flagWatch[agentId] ?? 0) + 1 } }))
    let on = true
    return () => {
      if (!on) return
      on = false
      set((s) => {
        const n = (s.flagWatch[agentId] ?? 1) - 1
        return { flagWatch: n > 0 ? { ...s.flagWatch, [agentId]: n } : omitKey(s.flagWatch, agentId) }
      })
    }
  },

  async patchAgent(agentId, body) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    try {
      const agent = await client.patchAgent(agentId, body)
      if (!live.ok()) return null
      set((s) => ({ agents: { ...s.agents, [agent.id]: agent } }))
      return agent
    } catch (err) {
      if (!live.ok()) return null
      get().toast({ tone: 'error', title: 'Could not save', body: errText(err) })
      return null
    }
  },

  async createAgent(body) {
    const live = bindSession(get)
    const client = live.client
    if (!client) throw new Error('Not connected')
    const created = await client.createAgent(body)
    // made on the earlier connection: its token belongs to that session and is not shown in this one
    if (!live.ok()) throw new Error('The connection to the hive changed while the mind was being made; it is not shown here.')
    const { token, ...agent } = created
    set((s) => ({ agents: { ...s.agents, [agent.id]: s.agents[agent.id] ?? agent }, focusBirth: agent.id }))
    return { ...agent, token }
  },

  setPalette(open) {
    set(open ? { paletteOpen: true } : { paletteOpen: false, paletteQuery: '' })
  },
  openPalette(query = '') {
    set({ paletteOpen: true, paletteQuery: query })
  },
  clearReveal() {
    set({ reveal: null, focusBirth: null })
  },
  toast(t) {
    const id = ++toastSeq
    // Kimi K4: a toast's action runs only while that very toast is still shown. A replaced copy (below), a dismissed,
    // expired or dropped toast, or one cleared by a session switch can still be on screen for its exit animation; a
    // press on it then does nothing. The newest copy carries its own action.
    const action = t.action && liveToastAction(t.action, id, () => get().toasts)
    // the same message again (a retrying loader) replaces its earlier copy rather than stacking four of it
    set((s) => ({ toasts: [...s.toasts.filter((x) => !(x.title === t.title && x.body === t.body && x.tone === t.tone) && !(t.group && x.group === t.group)).slice(-3), { ...t, id, ...(action ? { action } : {}) }] }))
    setTimeout(() => get().dismissToast(id), t.ttl ?? (t.tone === 'error' ? 6000 : 3500))
  },

  // ------------------------------------------------------------ Phase 2

  async loadApprovals() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const list = await client.listApprovals()
    if (!live.ok()) return
    set((s) => {
      const next: Record<string, Approval> = {}
      for (const a of list) next[a.id] = a
      // a live decision that raced the snapshot wins
      for (const [id, a] of Object.entries(s.approvals)) if (!next[id] || (next[id].status === 'pending' && a.status !== 'pending')) next[id] = a
      return { approvals: next, approvalsLoaded: true }
    })
  },

  async decide(id, d, minutes, session, origin) {
    const live = bindSession(get)
    const client = live.client
    // inspected under an earlier session: never dispatched against this client
    if (session !== undefined && session !== live.session) {
      get().toast({ tone: 'error', title: d === 'deny' || d === 'never' ? 'Not refused' : 'Not approved', body: EARLIER_SESSION })
      return null
    }
    if (!client || get().deciding[id]) return null
    set((s) => ({ deciding: { ...s.deciding, [id]: d } }))
    try {
      const a = d === 'for' || d === 'never'
        ? await client.answerApproval!(id, d, minutes)
        : d === 'deny' ? await client.deny(id) : await client.approve(id, d === 'remember')
      if (!live.ok()) return null
      set((s) => ({ approvals: { ...s.approvals, [a.id]: a } }))
      if (d !== 'approve' && d !== 'deny') void get().loadPolicy().catch(() => undefined)
      return a
    } catch (err) {
      if (!live.ok()) return null
      // host-identity r1: the host's lock (403 owner_only, 404 not_found) is said in plain words, never a generic error; the dialog shows it too
      const refused = approvalRefusalWords(err, d)
      if (refused) noteRefusal(id, refused, origin)
      get().toast({ tone: 'error', title: refused ? (d === 'deny' || d === 'never' ? 'Not refused' : 'Not approved') : d === 'deny' || d === 'never' ? 'Could not refuse' : 'Could not approve', body: refused ?? errText(err) })
      return null
    } finally {
      // the new session's own in-flight answer for a reused id is not ours to clear
      if (live.ok()) set((s) => ({ deciding: omitKey(s.deciding, id) }))
    }
  },

  async loadPolicy() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const rules = await client.listPolicy()
    if (!live.ok()) return
    set({ policy: rules })
  },

  async addRule(body) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return false
    try {
      const rule = await client.createPolicy(body)
      if (!live.ok()) return false
      set((s) => ({ policy: s.policy?.some((r) => r.id === rule.id) ? s.policy : [...(s.policy ?? []), rule] }))
      return true
    } catch (err) {
      if (!live.ok()) return false
      get().toast({ tone: 'error', title: 'Could not add the rule', body: errText(err) })
      return false
    }
  },

  async deleteRule(id) {
    const live = bindSession(get)
    const client = live.client
    const before = get().policy
    if (!client || !before) return
    set({ policy: before.filter((r) => r.id !== id) })
    try {
      await client.deletePolicy(id)
    } catch (err) {
      if (!live.ok()) return
      set({ policy: before })
      get().toast({ tone: 'error', title: 'Could not delete the rule', body: errText(err) })
    }
  },

  async loadGoals(swarmId, force = false) {
    const live = bindSession(get)
    const client = live.client
    if (!client || (!force && get().goalsLoaded[swarmId])) return
    const list = await client.listGoals(swarmId)
    if (!live.ok()) return
    set((s) => {
      const goals = { ...s.goals }
      for (const g of list) if (!goals[g.id] || goals[g.id].updated_at <= g.updated_at) goals[g.id] = g
      return { goals, goalsLoaded: { ...s.goalsLoaded, [swarmId]: true } }
    })
  },

  async createGoal(swarmId, body) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    try {
      const g = await client.createGoal(swarmId, body)
      if (!live.ok()) return null
      set((s) => ({ goals: { ...s.goals, [g.id]: s.goals[g.id] ?? g } }))
      return g
    } catch (err) {
      if (!live.ok()) return null
      get().toast({ tone: 'error', title: 'Could not create the task', body: errText(err) })
      return null
    }
  },

  async patchGoal(id, body, session) {
    return (await get().writeGoal(id, body, session)).kind === 'taken'
  },

  async writeGoal(id, body, session, opts) {
    const live = bindSession(get)
    const client = live.client
    const refuse = (why: string): GoalWrite => (get().toast({ tone: 'error', title: 'Could not update the task', body: why }), { kind: 'refused', why })
    // a goal decision inspected under an earlier session: never dispatched against this client
    if (session !== undefined && session !== live.session) return refuse(EARLIER_SESSION)
    const before = get().goals[id]
    if (!client || !before) return refuse(client ? 'That task is not loaded.' : 'Not connected to the hive.')
    // Review B1: an earlier write's answer was lost and not yet settled: read the goal again before sending another
    if (get().goalsUnsure[id]) return refuse(GOAL_UNSURE)
    // optimistic: the card moves columns at once
    const optimistic = { ...before, ...body }
    set((s) => ({ goals: { ...s.goals, [id]: optimistic } }))
    const lostSession: GoalWrite = { kind: 'unknown', why: 'The connection to the hive changed before it answered.' }
    // What a fresh read says about a write whose answer was lost (also reached from the toast's "Check again").
    const settle = (g: Goal | null): GoalWrite => {
      if (!g) {
        const why = `${NOT_CONFIRMED} The task could not be read again; check it before asking again.`
        if (!opts?.quiet) get().toast({ tone: 'error', title: 'Not confirmed', body: why, action: { label: 'Check again', run: () => void get().reconcileGoal(id).then((r) => live.ok() && settle(r)) } })
        return { kind: 'unknown', why }
      }
      if (goalHas(g, body)) {
        get().toast({ tone: 'success', title: 'The task was updated', body: 'The hive’s answer was lost, so the task was read again: the change is there.' })
        return { kind: 'taken', goal: g, checked: true }
      }
      const why = g.updated_at === before.updated_at
        ? `${NOT_CONFIRMED} The task was read again and is unchanged.`
        : `${NOT_CONFIRMED} The task was read again: it is ${g.status} now and changed since you saw it.`
      if (!opts?.quiet) get().toast({ tone: 'error', title: 'Not confirmed', body: `${why} Look at it, then ask again if you still want it.` })
      return { kind: 'untaken', goal: g, why }
    }
    try {
      const g = await client.patchGoal(id, body)
      if (!live.ok()) return lostSession
      set((s) => ({ goals: { ...s.goals, [g.id]: g } }))
      return { kind: 'taken', goal: g, checked: false }
    } catch (err) {
      if (!live.ok()) return lostSession
      // Kimi #1: put `before` back only while the store still holds this call's own optimistic value; a goal.updated
      // that landed meanwhile (identity differs) is the hive's word and newer than both
      set((s) => (s.goals[id] === optimistic ? { goals: { ...s.goals, [id]: before } } : {}))
      if (!answerLost(err)) return refuse(errText(err))
      // Review B1: no answer is not a refusal. Hold further writes, read the goal again, and say what the read shows.
      set((s) => ({ goalsUnsure: { ...s.goalsUnsure, [id]: true } }))
      const g = await get().reconcileGoal(id)
      if (!live.ok()) return lostSession
      return settle(g)
    }
  },

  async reconcileGoal(id) {
    const live = bindSession(get)
    const client = live.client
    const known = get().goals[id]
    if (!client || !known) return null
    try {
      const g = client.getGoal ? await client.getGoal(id) : (await client.listGoals(known.swarm_id)).find((x) => x.id === id)
      if (!live.ok() || !g) return null
      set((s) => ({ goals: { ...s.goals, [id]: g }, goalsUnsure: omitKey(s.goalsUnsure, id) }))
      return g
    } catch {
      return null
    }
  },

  async loadTraces(agentId) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const list = await client.listTraces(agentId, 60)
    if (!live.ok()) return
    set((s) => ({ traces: { ...s.traces, [agentId]: mergeTraces(s.traces[agentId], list) }, tracesLoaded: { ...s.tracesLoaded, [agentId]: true } }))
  },

  async loadWakeups(agentId) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const list = await client.listWakeups(agentId)
    if (!live.ok()) return
    set((s) => {
      const wakeups = { ...s.wakeups }
      for (const [id, w] of Object.entries(wakeups)) if (w.agent_id === agentId) delete wakeups[id]
      for (const w of list) wakeups[w.id] = w
      return { wakeups, wakeupsLoaded: { ...s.wakeupsLoaded, [agentId]: true } }
    })
  },

  async createWakeup(agentId, body) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    try {
      const w = await client.createWakeup(agentId, body)
      if (!live.ok()) return null
      set((s) => ({ wakeups: { ...s.wakeups, [w.id]: w } }))
      return w
    } catch (err) {
      if (!live.ok()) return null
      get().toast({ tone: 'error', title: 'Could not schedule the wakeup', body: errText(err) })
      return null
    }
  },

  async patchWakeup(id, body) {
    const live = bindSession(get)
    const client = live.client
    const before = get().wakeups[id]
    if (!client || !before) return
    set((s) => ({ wakeups: { ...s.wakeups, [id]: { ...before, ...body } } }))
    try {
      const w = await client.patchWakeup(id, body)
      if (!live.ok()) return
      set((s) => ({ wakeups: { ...s.wakeups, [w.id]: w } }))
    } catch (err) {
      if (!live.ok()) return
      set((s) => ({ wakeups: { ...s.wakeups, [id]: before } }))
      get().toast({ tone: 'error', title: 'Could not update the wakeup', body: errText(err) })
    }
  },

  async deleteWakeup(id) {
    const live = bindSession(get)
    const client = live.client
    const before = get().wakeups[id]
    if (!client || !before) return
    set((s) => ({ wakeups: omitKey(s.wakeups, id) }))
    try {
      await client.deleteWakeup(id)
    } catch (err) {
      if (!live.ok()) return
      set((s) => ({ wakeups: { ...s.wakeups, [id]: before } }))
      get().toast({ tone: 'error', title: 'Could not delete the wakeup', body: errText(err) })
    }
  },

  async retireAtom(agentId, space, atom) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return false
    try {
      await client.retireAtom(agentId, space, atom)
      if (!live.ok()) return false
      set((s) => ({ retired: { ...s.retired, [atomKey(agentId, space, atom)]: true } }))
      return true
    } catch (err) {
      if (!live.ok()) return false
      get().toast({ tone: 'error', title: 'Could not retire the atom', body: errText(err) })
      return false
    }
  },

  async resetMemory(agentId) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return false
    try {
      await client.resetMemory(agentId)
      if (!live.ok()) return false
      set((s) => ({ resetQueued: { ...s.resetQueued, [agentId]: true } }))
      return true
    } catch (err) {
      if (!live.ok()) return false
      get().toast({ tone: 'error', title: 'Could not reset memory', body: errText(err) })
      return false
    }
  },

  async stopAll() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    try {
      const { stopped } = await client.stopAll()
      return live.ok() ? stopped : null
    } catch (err) {
      if (!live.ok()) return null
      // the rest stopped, but some minds did not (host 500 stop_incomplete): say so by name, not as a plain failure
      if (err instanceof ApiError && err.code === 'stop_incomplete') {
        const r = readResult('off', err.envelope ?? {})
        const w = resultWords(r, (id) => (get().agents[id] ? shown(get().agents[id].name) : undefined))
        set({ stopAllOpen: false })
        // without the host's list, its own message (which names the minds) is the honest account
        const body = r.kind === 'off' && r.failed.count ? [w.headline, ...w.detail].join(' ') : err.message
        get().toast({ tone: 'error', title: 'Stop all did not stop every mind', body, ttl: 20_000 })
        return null
      }
      get().toast({ tone: 'error', title: 'Stop all failed', body: errText(err) })
      return null
    }
  },

  setStopAll(open) {
    set({ stopAllOpen: open })
  },

  // ------------------------------------------------------------ Lab

  async loadLab() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const [suites, runs] = await Promise.all([client.listLabSuites(), client.listLabRuns({ limit: 200 })])
    if (!live.ok()) return
    set((s) => {
      const labRuns = { ...s.labRuns }
      // a live update newer than the snapshot wins
      for (const r of runs) if (!labRuns[r.id] || !(labRuns[r.id].status !== 'running' && r.status === 'running')) labRuns[r.id] = r
      for (const x of suites) if (x.last_run && !labRuns[x.last_run.id]) labRuns[x.last_run.id] = x.last_run
      return {
        labSuites: suites.map((x) => (x.last_run && labRuns[x.last_run.id] ? { ...x, last_run: labRuns[x.last_run.id] } : x)),
        labRuns,
        labLoaded: true,
      }
    })
    void get().loadLabScorecard().catch(() => undefined)
  },

  async loadLabScorecard() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const labScorecard = await client.getLabScorecard()
    if (live.ok()) set({ labScorecard })
  },

  async loadLabRun(id) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    const run = await client.getLabRun(id)
    if (!live.ok()) return null
    const { log, cases, ...summary } = run
    set((s) => {
      // cases that streamed in while the request was in flight are kept
      let merged = cases
      for (const c of s.labCases[id] ?? []) if (!merged.some((x) => x.id === c.id)) merged = upsertCase(merged, c)
      const cur = s.labRuns[id]
      const keep = cur && cur.status !== 'running' && summary.status === 'running'
      return {
        labRuns: { ...s.labRuns, [id]: keep ? cur : summary },
        labCases: { ...s.labCases, [id]: merged },
        labRunLog: { ...s.labRunLog, [id]: log },
      }
    })
    return run
  },

  async loadLabHistory(suite) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const h = await client.getLabHistory(suite, 30)
    if (!live.ok()) return
    set((s) => {
      const labRuns = { ...s.labRuns }
      for (const r of h.runs) if (!labRuns[r.id]) labRuns[r.id] = r
      return { labHistory: { ...s.labHistory, [suite]: h }, labRuns }
    })
  },

  async startLab(suite) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    try {
      const run = await client.startLabRun(suite)
      if (!live.ok()) return null
      const { log: _log, cases, ...summary } = run
      void _log
      set((s) => ({
        labRuns: { ...s.labRuns, [run.id]: s.labRuns[run.id] && isTerminal(s.labRuns[run.id]) ? s.labRuns[run.id] : summary },
        labCases: { ...s.labCases, [run.id]: s.labCases[run.id] ?? cases },
        labSuites: s.labSuites?.map((x) => (x.id === suite && (!x.last_run || x.last_run.started_at <= run.started_at) ? { ...x, last_run: s.labRuns[run.id] ?? summary } : x)) ?? null,
        labWatched: { ...s.labWatched, [run.id]: true },
      }))
      return run
    } catch (err) {
      if (!live.ok()) return null
      const title = get().labSuites?.find((x) => x.id === suite)?.title ?? suite
      get().toast({ tone: 'error', title: `Could not run ${title}`, body: errText(err) })
      return null
    }
  },

  async cancelLab(id) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    set({ labQueue: [] })
    try {
      await client.cancelLabRun(id)
    } catch (err) {
      if (!live.ok()) return
      get().toast({ tone: 'error', title: 'Could not cancel the run', body: errText(err) })
    }
  },

  async runAllLab() {
    const suites = get().labSuites ?? []
    const order = [...suites.filter((x) => x.kind === 'tests'), ...suites.filter((x) => x.kind === 'bench')]
    const todo = order.filter((x) => x.runnable && x.last_run?.status !== 'running').map((x) => x.id)
    if (!todo.length) return
    set({ labQueue: todo.slice(1) })
    await get().startLab(todo[0])
  },

  stopLabQueue() {
    set({ labQueue: [] })
  },
  dismissToast(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  // ------------------------------------------------------------ Hive programs

  async loadPrograms() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    try {
      const list = await client.programs()
      if (!live.ok()) return
      set({ programs: list, programsError: null })
    } catch (err) {
      if (!live.ok()) return
      set({ programsError: errText(err) })
      throw err
    }
  },

  async loadProgram(id) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    try {
      const d = await client.program(id)
      if (!live.ok()) return null
      set((s) => ({ programDetails: { ...s.programDetails, [id]: d } }))
      return d
    } catch (err) {
      if (!live.ok()) return null
      get().toast({ tone: 'error', title: 'Could not load the program', body: errText(err) })
      return null
    }
  },

  async setProgramEnabled(id, enabled) {
    const live = bindSession(get)
    const client = live.client
    const before = get().programs
    if (!client) return
    set((s) => ({ programs: s.programs?.map((p) => (p.id === id ? { ...p, enabled: enabled && !p.error } : p)) ?? null }))
    try {
      const p = enabled ? await client.programEnable(id) : await client.programDisable(id)
      if (!live.ok()) return
      set((s) => ({ programs: s.programs?.map((x) => (x.id === p.id ? p : x)) ?? [p] }))
      if (enabled) {
        // sessions that hit "disabled" can try again
        for (const k of Object.keys(get().programSessions)) if (get().programSessions[k].programId === id && get().programSessions[k].error) void get().programRefresh(k)
      }
    } catch (err) {
      if (!live.ok()) return
      set({ programs: before })
      get().toast({ tone: 'error', title: enabled ? 'Could not enable the program' : 'Could not disable the program', body: errText(err) })
    }
  },

  async reloadPrograms() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    try {
      const list = await client.programsReload()
      if (!live.ok()) return
      set({ programs: list, programDetails: {}, programsError: null })
      get().toast({ tone: 'success', icon: 'reset', title: 'Programs reloaded', body: `${list.length} found, ${list.filter((p) => p.error).length} with errors` })
    } catch (err) {
      if (!live.ok()) return
      get().toast({ tone: 'error', title: 'Could not reload programs', body: errText(err) })
    }
  },

  async openProgram(programId, swarmId) {
    const key = sessionKey(programId, swarmId)
    if (!get().programSessions[key]) {
      set((s) => ({ programSessions: { ...s.programSessions, [key]: newSession(programId, swarmId, loadTrail(key) ?? undefined) } }))
    } else if (get().programSessions[key].result) {
      // coming back to the app: an earlier action's returned data is not shown again as if just returned
      patchSession(key, (s) => ({ ...s, result: null }))
    }
    if (!get().programDetails[programId]) void get().loadProgram(programId)
    await get().programRefresh(key)
  },

  async programRefresh(key) {
    const live = bindSession(get)
    const client = live.client
    const s0 = get().programSessions[key]
    if (!client || !s0) return
    const seq = (viewSeq.get(key) ?? 0) + 1
    viewSeq.set(key, seq)
    const step = currentStep(s0)
    patchSession(key, (s) => ({ ...s, loading: true }))
    try {
      const graph = await client.programView(s0.programId, { swarm_id: s0.swarmId, focus: step.focus, stage: step.stage })
      if (!live.ok() || viewSeq.get(key) !== seq) return
      patchSession(key, (s) => receiveView(s, graph))
    } catch (err) {
      if (!live.ok() || viewSeq.get(key) !== seq) return
      const code = err instanceof ApiError ? err.code : 'error'
      patchSession(key, (s) => ({ ...s, loading: false, error: { code, message: errText(err) } }))
    }
  },

  programGo(key, step) {
    if (!get().programSessions[key]) return
    patchSession(key, (s) => goTo(s, pushStep(s.trail, step)))
    void get().programRefresh(key)
  },

  programBack(key) {
    const s0 = get().programSessions[key]
    if (!s0 || s0.trail.length <= 1) return false
    patchSession(key, (s) => goTo(s, backStep(s.trail)))
    void get().programRefresh(key)
    return true
  },

  programJump(key, index) {
    const s0 = get().programSessions[key]
    if (!s0 || index >= s0.trail.length - 1) return
    patchSession(key, (s) => goTo(s, jumpTo(s.trail, index)))
    void get().programRefresh(key)
  },

  programSelect(key, ids) {
    patchSession(key, (s) => ({ ...s, selection: [...new Set(ids)] }))
  },

  async programAct(key, action, items, params = {}) {
    const live = bindSession(get)
    const client = live.client
    const s0 = get().programSessions[key]
    if (!client || !s0 || s0.busy) return
    const def = get().programDetails[s0.programId]?.describe?.actions.find((a) => a.id === action)
    const origin = storeIdentity(get())
    patchSession(key, (s) => ({ ...s, busy: action, notice: null, result: null }))
    try {
      // Contract 0.1 clarification: the person's step rides along so a stale result can show their own view.
      const here = s0.trail[s0.trail.length - 1]
      const sent = { focus: here?.focus ?? null, stage: here?.stage ?? 'unfold', ...params }
      const r = await personStartedProgramAct(client, s0.programId, { swarm_id: s0.swarmId, action, items, params: sent, base_revision: s0.graph?.revision ?? null }, () => live.ok() && storeIdentity(get()) === origin)
      if (!live.ok() || storeIdentity(get()) !== origin) return
      let refresh = false
      patchSession(key, (s) => {
        const out = applyResult(s, r, { action, items, params, def, baseRevision: s0.graph?.revision ?? null })
        refresh = out.refresh
        return out.session
      })
      if (r.status === 'started') void get().loadGoals(s0.swarmId, true).catch(() => undefined)
      if (refresh) void get().programRefresh(key)
    } catch (err) {
      if (!live.ok() || storeIdentity(get()) !== origin) return
      const label = def?.label ?? action
      const code = err instanceof ApiError ? ` (${err.code})` : ''
      patchSession(key, (s) => ({ ...s, busy: null, notice: notice({ kind: 'error', tone: 'bad', title: `${label} failed${code}`, body: errText(err) }) }))
    }
  },

  programDismiss(key, what) {
    patchSession(key, (s) => (what === 'notice' ? { ...s, notice: null } : what === 'input' ? { ...s, input: null } : what === 'source' ? { ...s, sourceDetail: null } : what === 'result' ? { ...s, result: null } : { ...s, suggestion: null }))
  },

  async programCancelTask(key, taskId) {
    const live = bindSession(get)
    await get().patchGoal(taskId, { status: 'cancelled' }, live.session)
    if (!live.ok()) return
    patchSession(key, (s) => ({ ...s, tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, status: get().goals[taskId]?.status ?? 'cancelled' } : t)) }))
  },

  // ------------------------------------------------------------ Providers

  async loadProviders() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const providers = await client.listProviders()
    if (live.ok()) set({ providers })
  },

  async setProviderKey(name, key) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    try {
      const p = await client.setProviderKey(name, key)
      if (!live.ok()) return null
      set((s) => ({ providers: (s.providers ?? []).some((x) => x.name === name) ? (s.providers ?? []).map((x) => (x.name === name ? p : x)) : [...(s.providers ?? []), p] }))
      void client.getModels().then((models) => live.ok() && set({ models })).catch(() => undefined)
      if (name === 'openrouter') void get().loadCatalog(true)
      get().toast({ tone: 'success', icon: 'link', title: `${p.label} connected`, body: p.account?.label ? `Key ${p.key_hint} · ${p.account.label}` : `Key ${p.key_hint} stays in the hive.` })
      return p
    } catch (err) {
      if (!live.ok()) return null
      get().toast({ tone: 'error', title: 'Could not connect', body: errText(err) })
      return null
    }
  },

  async removeProviderKey(name) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return false
    try {
      const p = await client.removeProviderKey(name)
      if (!live.ok()) return false
      set((s) => ({ providers: (s.providers ?? []).map((x) => (x.name === name ? p : x)) }))
      void client.getModels().then((models) => live.ok() && set({ models })).catch(() => undefined)
      return true
    } catch (err) {
      if (!live.ok()) return false
      get().toast({ tone: 'error', title: 'Could not remove the key', body: errText(err) })
      return false
    }
  },

  async loadCatalog(refresh = false) {
    const live = bindSession(get)
    const client = live.client
    if (!client || (get().catalogState === 'loading' && !refresh)) return
    set({ catalogState: 'loading', catalogError: null })
    try {
      const catalog = await client.openrouterCatalog(refresh)
      if (!live.ok()) return
      set({ catalog, catalogState: 'idle', catalogError: catalog.error })
    } catch (err) {
      if (!live.ok()) return
      set({ catalogState: 'error', catalogError: errText(err) })
    }
  },

  async loadRoles() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    if (!client.listRoles) {
      set({ rolesState: 'unsupported', rolesError: undefined })
      return
    }
    // keep a loaded library on screen while refreshing; only the first load shows as loading
    if (!get().roles) set({ rolesState: 'loading', rolesError: undefined })
    try {
      const roles = await client.listRoles()
      if (!live.ok()) return
      set({ roles, rolesState: 'ready', rolesError: undefined })
    } catch (err) {
      if (!live.ok()) return
      set({ rolesState: get().roles ? 'ready' : 'error', rolesError: err })
      throw err
    }
  },

  async loadRequests() {
    const live = bindSession(get)
    const client = live.client
    if (!client?.listRequests) return
    const list = await client.listRequests()
    if (!live.ok()) return
    set((s) => ({ requests: mergeRequests(s.requests, list), requestsLoaded: true }))
  },

  async cancelRequest(id) {
    const live = bindSession(get)
    const client = live.client
    if (!client?.cancelRequest) {
      get().toast({ tone: 'error', title: 'This hive cannot cancel requests' })
      return false
    }
    try {
      await client.cancelRequest(id)
      return live.ok()
    } catch (err) {
      if (!live.ok()) return false
      get().toast({ tone: 'error', title: 'Could not cancel the request', body: errText(err) })
      return false
    }
  },

  resolveHealthAlerts(agentId) {
    set((s) => {
      const healthAlerts = resolveHealthAlerts(s, agentId)
      return healthAlerts === s.healthAlerts ? s : { healthAlerts }
    })
  },

  dismissRefusal(agentId) {
    set((s) => (s.refusals[agentId] ? { refusals: omitKey(s.refusals, agentId) } : s))
  },

  async loadKeys() {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    const keys = await client.listKeys()
    if (live.ok()) set({ keys })
  },

  async addKey(body, onError) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    try {
      const k = await client.addKey(body)
      if (!live.ok()) return null
      await Promise.allSettled([get().loadKeys(), get().loadProviders(), client.getModels().then((models) => live.ok() && set({ models }))])
      if (!live.ok()) return null
      if (k.provider === 'openrouter' && !get().catalog) void get().loadCatalog(true)
      get().toast({ tone: 'success', icon: 'token', title: `${k.label} added`, body: `${k.provider_label} key ${k.hint}${k.default ? ' · hive default' : ''}` })
      return k
    } catch (err) {
      if (!live.ok()) return null
      get().toast({ tone: 'error', title: 'Could not add the key', body: errText(err) })
      onError?.(err)
      return null
    }
  },

  async updateKey(id, body) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    try {
      const k = await client.updateKey(id, body)
      if (!live.ok()) return null
      await get().loadKeys()
      return live.ok() ? k : null
    } catch (err) {
      if (!live.ok()) return null
      get().toast({ tone: 'error', title: 'Could not update the key', body: errText(err) })
      return null
    }
  },

  async refreshKey(id) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return
    try {
      const k = await client.refreshKey(id)
      if (!live.ok()) return
      set((s) => ({ keys: s.keys?.map((x) => (x.id === id ? { ...x, ...k } : x)) ?? null }))
    } catch (err) {
      if (!live.ok()) return
      get().toast({ tone: 'error', title: 'Could not check the key', body: errText(err) })
    }
  },

  async removeKey(id) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return false
    try {
      const { unassigned } = await client.removeKey(id)
      if (!live.ok()) return false
      await Promise.allSettled([get().loadKeys(), get().loadProviders(), client.getModels().then((models) => live.ok() && set({ models }))])
      if (!live.ok()) return false
      get().toast({ tone: 'success', title: 'Key removed', body: unassigned ? `${unassigned} mind${unassigned === 1 ? '' : 's'} now use the hive default.` : undefined })
      return true
    } catch (err) {
      if (!live.ok()) return false
      get().toast({ tone: 'error', title: 'Could not remove the key', body: errText(err) })
      return false
    }
  },

  async loadEndpoints(modelId) {
    const live = bindSession(get)
    const client = live.client
    if (!client) return null
    const cached = get().endpoints[modelId]
    if (cached) return cached
    if (get().endpointsLoading[modelId]) return null
    set((s) => ({ endpointsLoading: { ...s.endpointsLoading, [modelId]: true } }))
    try {
      const list = await client.openrouterEndpoints(modelId)
      if (!live.ok()) return null
      set((s) => ({ endpoints: { ...s.endpoints, [modelId]: list } }))
      return list
    } catch (err) {
      if (!live.ok()) return null
      get().toast({ tone: 'error', title: 'Could not list providers for that model', body: errText(err) })
      return null
    } finally {
      if (live.ok()) set((s) => ({ endpointsLoading: omitKey(s.endpointsLoading, modelId) }))
    }
  },
}))

const viewSeq = new Map<string, number>()

let keysTimer: ReturnType<typeof setTimeout> | undefined
const flagTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** One fresh GET /api/agents/{id} per mind per burst of events; dropped if the session moved on (refreshAgentFlags). */
export const FLAG_REFRESH_MS = 400
function scheduleFlagRefresh(id: string) {
  clearTimeout(flagTimers.get(id))
  const session = useHive.getState().session
  flagTimers.set(id, setTimeout(() => {
    flagTimers.delete(id)
    if (useHive.getState().session === session) void useHive.getState().refreshAgentFlags(id)
  }, FLAG_REFRESH_MS))
}

function scheduleKeysReload() {
  clearTimeout(keysTimer)
  keysTimer = setTimeout(() => void useHive.getState().loadKeys().catch(() => undefined), 800)
}

/** Update one program session; the trail is persisted when it changes. */
function patchSession(key: string, fn: (s: ProgramSession) => ProgramSession) {
  const before = useHive.getState().programSessions[key]
  if (!before) return
  const after = fn(before)
  if (after === before) return
  useHive.setState((st) => ({ programSessions: { ...st.programSessions, [key]: after } }))
  if (after.trail !== before.trail) saveTrail(key, after.trail)
}

const labRefetch = new Map<string, ReturnType<typeof setTimeout>>()

/** A run finished: toast it if this session watched it, start the next queued suite, resync history. */
function onLabRunFinished(runId: string) {
  const s = useHive.getState()
  const run = s.labRuns[runId]
  if (!run) return
  const suite = s.labSuites?.find((x) => x.id === run.suite)
  if (s.labWatched[runId]) {
    useHive.setState((st) => {
      const next = { ...st.labWatched }
      delete next[runId]
      return { labWatched: next }
    })
    const total = run.passed + run.failed + run.skipped + run.errors
    const good = run.status === 'passed'
    s.toast({
      tone: good ? 'success' : run.status === 'cancelled' ? 'info' : 'error',
      icon: 'flask',
      title: `${suite?.title ?? run.suite} ${run.status === 'cancelled' ? 'cancelled' : good ? 'passed' : run.status}`,
      body: run.status === 'cancelled' ? undefined : `${run.passed}/${total} passed${run.failed ? ` · ${run.failed} failed` : ''}${run.errors ? ` · ${run.errors} errors` : ''}`,
      action: { label: 'Open the run', run: () => (window.location.hash = `#/lab/run/${encodeURIComponent(runId)}`) },
    })
  }
  // "Run everything": the next suite starts when nothing from the queue is running
  if (s.labQueue.length) {
    const busy = Object.values(useHive.getState().labRuns).some((r) => r.status === 'running')
    if (!busy) {
      const [next, ...rest] = s.labQueue
      useHive.setState({ labQueue: rest })
      void s.startLab(next)
    }
  }
  clearTimeout(labRefetch.get('__scorecard'))
  labRefetch.set('__scorecard', setTimeout(() => void useHive.getState().loadLabScorecard().catch(() => undefined), 500))
  if (s.labHistory[run.suite]) {
    clearTimeout(labRefetch.get(run.suite))
    labRefetch.set(run.suite, setTimeout(() => void useHive.getState().loadLabHistory(run.suite).catch(() => undefined), 600))
  }
}

function pickNewer(cur: Record<string, import('../api/types').Belief> | undefined, list: { statement: string; updated_at: string }[]) {
  // Keep any live update that is newer than what the REST snapshot returned.
  const out: Record<string, import('../api/types').Belief> = {}
  if (!cur) return out
  const snap = new Map(list.map((b) => [b.statement, b.updated_at]))
  for (const [k, b] of Object.entries(cur)) {
    const at = snap.get(k)
    if (!at || b.updated_at > at) out[k] = b
  }
  return out
}

function omitKey<T>(rec: Record<string, T>, key: string): Record<string, T> {
  if (!(key in rec)) return rec
  const next = { ...rec }
  delete next[key]
  return next
}

function patchPending(agentId: string, tempId: string, patch: Partial<PendingMessage>) {
  useHive.setState((s) => ({
    pending: {
      ...s.pending,
      [agentId]: (s.pending[agentId] ?? []).map((x) => (x.tempId === tempId ? { ...x, ...patch } : x)),
    },
  }))
}

async function deliver(agentId: string, p: PendingMessage) {
  const live = bindSession(useHive.getState)
  const client = live.client
  // never leave it on "Sending…": with no hive it failed, and Retry is offered
  if (!client) return patchPending(agentId, p.tempId, { status: 'failed', error: 'Not connected to the hive.' })
  try {
    const m: Message = await client.sendMessage(agentId, { text: p.text })
    if (!live.ok()) return
    useHive.setState((s) => ({
      messages: { ...s.messages, [agentId]: upsertMessage(s.messages[agentId], m) },
      pending: { ...s.pending, [agentId]: (s.pending[agentId] ?? []).filter((x) => x.tempId !== p.tempId) },
    }))
  } catch (err) {
    if (!live.ok()) return
    patchPending(agentId, p.tempId, { status: 'failed', error: errText(err) })
  }
}

// ---------------------------------------------------------------- selectors

/** Unresolved health alerts, for the Health navigation badge. */
export const useHealthAlertCount = (): number => useHive((s) => countHealthAlerts(s.healthAlerts))

/** Why a mind's model calls are being refused for spending, if they are. */
export const useRefusal = (agentId: string | null | undefined) => useHive((s) => (agentId ? s.refusals[agentId] : undefined))

/** Cross-swarm requests, newest first. */
export function useRequestList() {
  const requests = useHive((s) => s.requests)
  return useMemo(() => requestList(requests), [requests])
}
