import { personSwarmCardRoute, readPersonSwarmCard, type PersonSwarmShown } from './personSwarms'
import type { UiPrefs, UiPrefsResponse, UiPrefsWriteOptions } from '../shell/uiVariant'
import { figureRouteSha } from './figures'
import { FRAME_WIRE } from '../lib/frameWire'
import type { Board, Matches, Scope } from '../features/boards/types'
import {
  ApiError,
  IDENTITY_CHANGED,
  IDENTITY_CHANGED_WORDS,
  isIdentityChanged,
  type AuthMethods,
  type Invite,
  type Me,
  type Person,
  Emitter,
  type ConnectionListener,
  type ConnectionState,
  type EventListener,
  type HiveClient,
} from './client'
import { draftConflict } from './appDrafts'   // Surface: studio slice 2
import { chooseCodeTeam, parseTeamTemplates } from './askIntents'   // Surface: the Code team for a vibe request
import { checkHoldBody } from '../features/updates/updates'
import { endsHiveSession, parseErrorBody } from './relayedError'   // Surface: the hive envelope, including relayed OmegaCode errors
import { readIdleDetail, readIdleOverview } from './idleMinds'   // Surface: Health's idle minds (Platform idle-minds r2)
import { googleMindConsent } from './googleConnector'
import type {
  ActionResult,
  Catalog,
  KeyInfo,
  ModelEndpoint,
  ProviderStatus,
  Program,
  ProgramActBody,
  ProgramDetail,
  ProgramViewBody,
  WorkGraph,
  Agent,
  AgentAction,
  ApiErrorBody,
  Approval,
  ApprovalStatus,
  CreateGoalBody,
  CreatePolicyBody,
  CreateWakeupBody,
  Goal,
  MemoryAtom,
  MemorySpace,
  PatchGoalBody,
  PatchWakeupBody,
  PolicyRule,
  Trace,
  Wakeup,
  Belief,
  BeliefDetail,
  CreateAgentBody,
  CreatedAgent,
  CreateSwarmBody,
  HiveEvent,
  HiveInfo,
  LabHistory,
  LabRun,
  LabRunSummary,
  LabScorecardEntry,
  LabSuite,
  Message,
  ModelOption,
  PatchAgentBody,
  Swarm,
  Usage,
} from './types'

/**
 * Compare-and-set (platform/ui-prefs-revision r2, 6173666): the base revision a look write expects, sent as EXACTLY ONE
 * `X-UI-Base-Rev` header whose value is a bare non-negative integer, and only when one is known (no header: the host
 * writes unconditionally). The host refuses a repeated, quoted, weak, `*` or list value with 400; this never sends one.
 */
export const UI_REV_HEADER = 'X-UI-Base-Rev'
export const uiRevHeaders = (o: UiPrefsWriteOptions = {}): Record<string, string> =>
  typeof o.baseRev === 'number' && Number.isSafeInteger(o.baseRev) && o.baseRev >= 0 ? { [UI_REV_HEADER]: String(o.baseRev) } : {}

const TOKEN_KEY = 'omegadots.hive.token'

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
function writeToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable (private mode): the token lives in memory only */
  }
}

const enc = encodeURIComponent
/** `?a=1&b=2` from the defined, non-empty values (an empty object gives ''). */
const query = (q: Record<string, string | number | boolean | undefined>): string => {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v))
  const t = p.toString()
  return t ? `?${t}` : ''
}

/** REST + WebSocket client for a real `hive/core` server. */

/**
 * Read a SUCCESSFUL answer's body. The hive has already acted by the time it answers 2xx, so a body that cannot be read
 * (truncated, not JSON) is an answer lost in transit, never a refusal: it surfaces as ApiError status 0, which callers
 * treat as "outcome unknown" (store answerLost) and reconcile, instead of rolling back a committed change (Review B1).
 */
async function readOk<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T
  } catch (err) {
    throw new ApiError(0, 'answer_unreadable', `The hive answered but its answer could not be read (${err instanceof Error ? err.name : 'decode error'}).`)
  }
}

/** How long sign-out waits for the hive to end the session before this tab signs out anyway. */
export const LOGOUT_WAIT_MS = 3000

/** J1b: a local-owner hive's events frames are bounded at 4 KiB (localowner.EVENTS_FRAME_MAX). */
const LOCAL_FRAME_MAX = 4096
/**
 * scanner r1 (Kimi live-pins r1): the kind check (GET /api/auth/methods before the first socket) gives up after this many
 * failures in a row. 8 with the existing backoff (0.5 s doubling, 15 s ceiling, ±25 %) is about a minute of trying,
 * enough to ride out a hive restart; after that a visibility/online event or the next connect() starts it again.
 */
const KIND_ASK_GIVE_UP = 8

export class LiveClient implements HiveClient {
  readonly mode = 'live' as const
  private base: string
  private token: string | null
  private authIdentity: object = {}
  /** the principal `me()` last resolved under this client (null: none yet, or reset with the credential) */
  private principal: string | null = null
  private authEvents = new Emitter<void>()

  authContext = (): object => this.authIdentity
  /**
   * professional-release r1.1 (stand-in P1): a request records the sign-in it was sent under; when the sign-in changed
   * before its answer is delivered, the answer (success or failure) is not delivered: ApiError 409 `identity_changed`.
   * The session-ending 401 below is this request's own answer, so it is read before this check can see its change.
   */
  private sentUnder(at: object): void {
    if (at !== this.authIdentity) throw new ApiError(409, IDENTITY_CHANGED, IDENTITY_CHANGED_WORDS)
  }
  onAuthChange = (listener: () => void): (() => void) => this.authEvents.on(listener)

  private replaceToken(token: string | null): void {
    writeToken(token)
    this.adoptToken(token)
  }

  /** In memory only: a new credential gets a new local identity handle and tells listeners. Never writes storage. */
  private adoptToken(token: string | null): void {
    this.token = token
    this.authIdentity = {}
    this.principal = null
    this.authEvents.emit()
  }

  /**
   * Another tab signed in, signed out or cleared storage (Kimi K1; Surface confirmation notes). localStorage is shared
   * across tabs but authIdentity is not, so without this a tab would keep a dead session's identity. Same-value events
   * are ignored and nothing is written back. A cleared token ends this tab's session the way its own logout() does:
   * the socket under the dead bearer is silenced and disconnected (no reconnect), then 'unauthorized'. A changed token
   * reopens the events socket under the new bearer.
   */
  private onStorage = (e: StorageEvent): void => {
    if (e.key !== TOKEN_KEY && e.key !== null) return
    const next = e.key === null ? readToken() : e.newValue
    if (next === this.token) return
    this.adoptToken(next)
    if (next === null) {
      this.silenceSocket()
      this.disconnect()
      this.setState('unauthorized')
    } else this.reopenEvents()
  }

  /** Stop listening to this client's cross-tab storage events (for a client that is being replaced). */
  dispose(): void {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('storage', this.onStorage)
    this.dropKindWake()
  }

  /** The socket opened under the previous bearer can deliver nothing more: no frames, no open, no close, no ping. */
  private silenceSocket(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
    if (this.ws) {
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onclose = null
    }
  }

  /** Drop the socket opened under the previous bearer and open a new one if a socket is wanted. */
  private reopenEvents(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.silenceSocket()
    this.ws?.close()
    this.ws = null
    this.retry = 0
    // a sign-in change is a restart trigger: parked and failures reset together (scanner r1.1, Kimi P1-2)
    this.freshKindAsk()
    if (this.wantOpen) this.open()
  }
  private ws: WebSocket | null = null
  private wantOpen = false
  private retry = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  /**
   * J1b local-owner hive (/api/auth/methods `local_owner`): its events socket refuses a token in the address, so the
   * token goes in the first frame instead. null until the hive has said; read once, before the first socket opens.
   */
  private localOwner: boolean | null = null
  private localOwnerAsk: Promise<void> | null = null
  /**
   * scanner r1 (Kimi live-pins r1): the kind check's failures in a row. At KIND_ASK_GIVE_UP it stops asking (parked):
   * nothing is retried until the page comes back into view, the browser is back online, the sign-in changes, or
   * connect() is called again. `kindWake` holds the listeners that end the park.
   */
  private kindFailures = 0
  private kindParked = false
  /** scanner r1.1 (stand-in P1): bumped on every park and restart; a retry timer of an earlier generation does nothing */
  private kindGen = 0
  private kindWake: { online: () => void; visible: () => void } | null = null
  private events = new Emitter<HiveEvent>()
  private conn = new Emitter<ConnectionState>()
  private state: ConnectionState = 'idle'

  constructor(baseUrl: string) {
    this.base = baseUrl.replace(/\/+$/, '')
    this.token = readToken()
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') window.addEventListener('storage', this.onStorage)
  }

  flowStudioUrl(): string {
    return new URL(this.base + '/flow-studio/', location.href).href
  }

  flowRequest(operation: import('../features/flow/operations').FlowOperation, p: Record<string, unknown>): Promise<unknown> {
    const path = `/api/flows/${enc(String(p.artifact_id))}/revisions/${enc(String(p.n))}`
    switch (operation) {
      case 'templates': return this.request('GET', '/api/flows/templates')
      case 'example': return this.request('GET', '/api/flows/example')
      case 'validate': return this.request('POST', '/api/flows/validate', p)
      case 'list': return this.request('GET', `/api/swarms/${enc(String(p.swarm_id))}/flows`)
      case 'publish': return this.request('POST', `/api/swarms/${enc(String(p.swarm_id))}/flows`, p)
      case 'read': return this.request('GET', path)
      case 'layout': return this.request('PUT', path + '/layout', {layout:p.layout, expected_version:p.expected_version})
      case 'adopt': return this.request('POST', path + '/adopt', {digest:p.digest})
      case 'start': return this.request('POST', path + '/runs', {digest:p.digest, client_key:p.client_key})
      case 'run': return this.request('GET', `/api/flow-runs/${enc(String(p.run_id))}`)
      case 'cancel': return this.request('POST', `/api/flow-runs/${enc(String(p.run_id))}/cancel`)
      default: return Promise.reject(new Error('Unsupported Flow operation'))
    }
  }

  needsAuth(): boolean {
    return !this.token
  }

  async login(password: string): Promise<void> {
    const res = await this.request<{ token: string }>('POST', '/api/auth/login', { password }, false)
    this.replaceToken(res.token)
  }

  async authMethods(): Promise<AuthMethods> {
    const m = await this.request<AuthMethods>('GET', '/api/auth/methods', undefined, false)
    this.localOwner = m?.local_owner === true
    return m
  }

  async trySso(): Promise<boolean> {
    try {
      const res = await this.request<{ token: string }>('POST', '/api/auth/sso', {}, false)
      this.replaceToken(res.token)
      return true
    } catch {
      return false
    }
  }

  /**
   * Sign out: always tell the hive, with or without a bearer, so a cookie-only session (hive_signin) ends too, and
   * wait for it (at most LOGOUT_WAIT_MS) before this tab treats the person as gone. The identity epoch then bumps after
   * the server has ended the session. A failed or slow answer still signs this tab out.
   */
  async logout(): Promise<void> {
    const headers: Record<string, string> = {}
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const stop = new AbortController()
    const timer = setTimeout(() => stop.abort(), LOGOUT_WAIT_MS)
    try {
      await fetch(this.base + '/api/auth/logout', { method: 'POST', headers, credentials: 'same-origin', signal: stop.signal })
    } catch {
      // network, refusal or timeout: this tab still signs out
    } finally {
      clearTimeout(timer)
    }
    this.replaceToken(null)
    this.disconnect()
    this.setState('unauthorized')
  }

  // ---------- REST ----------

  board = (scope: Scope, entityId?: string) => this.request<Board>('GET', `/api/boards/${scope}${entityId ? '?entity_id=' + encodeURIComponent(entityId) : ''}`)
  matchServices = (need: string, kind: 'mind' | 'swarm' = 'swarm') => this.request<Matches>('GET', '/api/match?need=' + encodeURIComponent(need) + '&kind=' + kind)
  private async request<T>(method: string, path: string, body?: unknown, auth = true, extra: Record<string, string> = {}, hostHeaders?: (headers: Headers) => void): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...extra }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`
    const at = this.authIdentity
    let res: Response
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (err) {
      this.sentUnder(at)
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error')
    }
    this.sentUnder(at)
    if (!res.ok) {
      // The hive's envelope (relayedError.ts); OmegaCode errors relayed by /api/code/proxy carry source + upstream_status.
      let data: unknown = null
      try {
        data = (await res.json()) as Partial<ApiErrorBody>
      } catch {
        /* non-JSON error body */
      }
      // r1.2 (stand-in r1.1 P2): an error read across a sign-in change belongs to the earlier sign-in: identity_changed,
      // checked before the session-ending 401 below (which stays for a request still current)
      this.sentUnder(at)
      const parsed = parseErrorBody(res.status, res.statusText, data)
      // next8 (live): a relayed service 401 arrives as 403 in the envelope, so a 401 always means the hive session ended.
      if (auth && endsHiveSession(res.status) && headers.Authorization === `Bearer ${this.token}`) {
        this.replaceToken(null)
        this.setState('unauthorized')
      }
      // the envelope's other fields (the host merges an error's details into it: stop_incomplete's {stopped, failed})
      const env = data && typeof data === 'object' ? (data as { error?: unknown }).error : null
      const envelope = env && typeof env === 'object' ? (env as Record<string, unknown>) : undefined
      throw new ApiError(res.status, parsed.code, parsed.message, parsed.source || envelope ? { source: parsed.source, upstreamStatus: parsed.upstreamStatus, envelope, body: data } : undefined)
    }
    const answer = await readOk<T>(res)
    this.sentUnder(at)
    hostHeaders?.(res.headers)
    return answer
  }

  getHive = () => this.request<HiveInfo>('GET', '/api/hive')
  tools = () => this.request<import('./types').ToolsCatalogue>('GET', '/api/tools')
  getModels = () => this.request<ModelOption[]>('GET', '/api/models')
  listSwarms = (opts: { archived?: boolean } = {}) => this.request<Swarm[]>('GET', opts.archived ? '/api/swarms?archived=1' : '/api/swarms')
  createSwarm = (body: CreateSwarmBody) => this.request<Swarm>('POST', '/api/swarms', body)
  setAgentVisibility = (id: string, body: { visibility?: import('./types').Visibility; shared_with?: string[] }) =>
    this.request<Agent>('PUT', `/api/agents/${enc(id)}/visibility`, body)
  setSwarmVisibility = (id: string, body: { visibility?: import('./types').Visibility; shared_with?: string[] }) =>
    this.request<Swarm>('PUT', `/api/swarms/${enc(id)}/visibility`, body)
  getSwarm = (id: string) => this.request<Swarm>('GET', `/api/swarms/${enc(id)}`)
  updateSwarm = (id: string, body: import('./types').UpdateSwarmBody) => this.request<Swarm>('PATCH', `/api/swarms/${enc(id)}`, body)
  deleteSwarm = (id: string) => this.request<{ deleted: string }>('DELETE', `/api/swarms/${enc(id)}`)
  deleteSwarmWithMinds = (id: string, confirm: string) => this.request<import('./client').SwarmDeleteResult>('DELETE', `/api/swarms/${enc(id)}`, { with_minds: true, confirm })
  deleteSwarmPreview = (id: string) => this.request<import('./client').SwarmDeletePreview>('GET', `/api/swarms/${enc(id)}/delete-preview`)
  archiveSwarm = (id: string) => this.request<Swarm>('POST', `/api/swarms/${enc(id)}/archive`, {})
  restoreSwarm = (id: string) => this.request<Swarm>('POST', `/api/swarms/${enc(id)}/restore`, {})
  listBeliefs = (id: string) => this.request<Belief[]>('GET', `/api/swarms/${enc(id)}/beliefs`)
  getBeliefDetail = (id: string, statement: string) =>
    this.request<BeliefDetail>('GET', `/api/swarms/${enc(id)}/beliefs/detail?statement=${enc(statement)}`)
  getVocab = (id: string) => this.request<string[]>('GET', `/api/swarms/${enc(id)}/vocab`)
  addVocab = (id: string, terms: string[]) =>
    this.request<string[]>('POST', `/api/swarms/${enc(id)}/vocab`, { terms })
  listAgents = () => this.request<Agent[]>('GET', '/api/agents')
  createAgent = (body: CreateAgentBody) => this.request<CreatedAgent>('POST', '/api/agents', body)
  getAgent = (id: string) => this.request<Agent>('GET', `/api/agents/${enc(id)}`)
  patchAgent = (id: string, body: PatchAgentBody) =>
    this.request<Agent>('PATCH', `/api/agents/${enc(id)}`, body)
  deleteAgent = (id: string) => this.request<{ ok: true }>('DELETE', `/api/agents/${enc(id)}`)
  agentAction = (id: string, action: AgentAction) =>
    this.request<Agent>('POST', `/api/agents/${enc(id)}/${action}`)
  listMessages = (id: string, opts: { conversation_id?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.conversation_id) q.set('conversation_id', opts.conversation_id)
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return this.request<Message[]>('GET', `/api/agents/${enc(id)}/messages${qs ? `?${qs}` : ''}`)
  }
  sendMessage = (id: string, body: { text: string; conversation_id?: string }) =>
    this.request<Message>('POST', `/api/agents/${enc(id)}/messages`, body)
  getLogs = (id: string, tail = 200) =>
    this.request<{ lines: string[] }>('GET', `/api/agents/${enc(id)}/logs?tail=${tail}`)
  listUsage = (opts: { agent_id?: string; since?: string } = {}) => {
    const q = new URLSearchParams()
    if (opts.agent_id) q.set('agent_id', opts.agent_id)
    if (opts.since) q.set('since', opts.since)
    const qs = q.toString()
    return this.request<Usage[]>('GET', `/api/usage${qs ? `?${qs}` : ''}`)
  }

  // ---------- Phase 2 ----------

  listPolicy = () => this.request<PolicyRule[]>('GET', '/api/policy')
  createPolicy = (body: CreatePolicyBody) => this.request<PolicyRule>('POST', '/api/policy', body)
  listDelegations = () => this.request<{ coordinator_id: string; specialist_id: string; created_by: string; created_at: string }[]>('GET', '/api/lifecycle/delegations')
  setDelegation = (coordinatorId: string, specialistIds: string[]) => this.request<unknown>('PUT', `/api/lifecycle/delegations/${enc(coordinatorId)}`, { specialist_ids: specialistIds })
  issueLease = (body: { coordinator: string; specialist: string; task: string; seconds: number; budget_usd: number }) =>
    this.request<{ lease: string; coordinator: string; specialist: string; task: string }>('POST', '/api/lifecycle/leases', body)
  deletePolicy = (id: string) => this.request<{ ok: true }>('DELETE', `/api/policy/${enc(id)}`)
  listApprovals = (status?: ApprovalStatus) =>
    this.request<Approval[]>('GET', `/api/approvals${status ? `?status=${enc(status)}` : ''}`)
  approve = (id: string, remember = false) =>
    this.request<Approval>('POST', `/api/approvals/${enc(id)}/approve`, { remember })
  deny = (id: string) => this.request<Approval>('POST', `/api/approvals/${enc(id)}/deny`, {})
  answerApproval = (id: string, decision: 'once' | 'for' | 'always' | 'no' | 'never', minutes?: number) =>
    this.request<Approval>('POST', `/api/approvals/${enc(id)}/decide`, { decision, minutes })
  approvalTrackRecord = (id: string) =>
    this.request<{ answers: number; positive: number; tv: { f: number; c: number } | null }>('GET', `/api/approvals/${enc(id)}/track-record`)
  listAsks = () => this.request<import('./types').PersonAsk[]>('GET', '/api/asks')
  createAsk = (body: { kind: import('./types').PersonAsk['kind']; payload: Record<string, unknown>; note?: string }) =>
    this.request<import('./types').PersonAsk>('POST', '/api/asks', body)
  answerAsk = (id: string, decision: 'once' | 'for' | 'always' | 'no' | 'never', minutes?: number) =>
    this.request<import('./types').PersonAsk>('POST', `/api/asks/${enc(id)}/decide`, { decision, minutes })
  listGoals = (swarmId: string) => this.request<Goal[]>('GET', `/api/swarms/${enc(swarmId)}/goals`)
  createGoal = (swarmId: string, body: CreateGoalBody) =>
    this.request<Goal>('POST', `/api/swarms/${enc(swarmId)}/goals`, body)
  patchGoal = (id: string, body: PatchGoalBody) => this.request<Goal>('PATCH', `/api/goals/${enc(id)}`, body)
  // Motivations above Tasks (host phase 1)
  listMotivations = (q: { owner?: string; swarm?: string; status?: string; cursor?: string; limit?: number } = {}) =>
    this.request<import('./types').MotivationList>('GET', `/api/motivations${query(q)}`)
  getMotivation = (id: string) => this.request<import('./types').Motivation>('GET', `/api/motivations/${enc(id)}`)
  createMotivation = (body: import('./types').CreateMotivationBody) => this.request<import('./types').Motivation>('POST', '/api/motivations', body)
  patchMotivation = (id: string, body: import('./types').PatchMotivationBody) =>
    this.request<import('./types').Motivation>('PATCH', `/api/motivations/${enc(id)}`, body)
  setMotivationVisibility = (id: string, body: { visibility?: import('./types').Visibility; shared_with?: string[]; expected_rev: number }) =>
    this.request<import('./types').Motivation>('PUT', `/api/motivations/${enc(id)}/visibility`, body)
  linkMotivation = (id: string, body: import('./types').MotivationLinkBody) =>
    this.request<import('./types').MotivationLinkResult>('POST', `/api/motivations/${enc(id)}/links`, body)
  listTasks = (q: import('./types').TaskQuery = {}) =>
    this.request<import('./types').TaskList>('GET', `/api/tasks${query({ ...q, top: q.top ? 'true' : undefined })}`)
  listTraces = (agentId: string, limit?: number) =>
    this.request<Trace[]>('GET', `/api/agents/${enc(agentId)}/traces${limit ? `?limit=${limit}` : ''}`)
  traceArchive = (agentId: string) =>
    this.request<import('./types').TraceArchiveIndex>('GET', `/api/agents/${enc(agentId)}/traces/archive`)
  archivedTraces = (agentId: string, day: string, limit: number, offset: number) =>
    this.request<Trace[]>('GET', `/api/agents/${enc(agentId)}/traces/archive/${enc(day)}?limit=${limit}&offset=${offset}`)
  listWakeups = (agentId: string) => this.request<Wakeup[]>('GET', `/api/agents/${enc(agentId)}/wakeups`)
  createWakeup = (agentId: string, body: CreateWakeupBody) =>
    this.request<Wakeup>('POST', `/api/agents/${enc(agentId)}/wakeups`, body)
  patchWakeup = (id: string, body: PatchWakeupBody) => this.request<Wakeup>('PATCH', `/api/wakeups/${enc(id)}`, body)
  deleteWakeup = (id: string) => this.request<{ ok: true }>('DELETE', `/api/wakeups/${enc(id)}`)
  listMemory = (agentId: string) => this.request<MemorySpace[]>('GET', `/api/agents/${enc(agentId)}/memory`)
  listAtoms = (agentId: string, space: string, opts: { q?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.q) q.set('q', opts.q)
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return this.request<MemoryAtom[]>('GET', `/api/agents/${enc(agentId)}/memory/${enc(space)}${qs ? `?${qs}` : ''}`)
  }
  retireAtom = (agentId: string, space: string, atom: string) =>
    this.request<{ queued: true }>('POST', `/api/agents/${enc(agentId)}/memory/${enc(space)}/retire`, { atom })
  resetMemory = (agentId: string) => this.request<{ queued: true }>('POST', `/api/agents/${enc(agentId)}/memory/reset`, {})
  stopAll = () => this.request<{ stopped: number }>('POST', '/api/hive/stop-all', {})
  getPower = () => this.request<unknown>('GET', '/api/hive/power')
  setPower = (body: import('../features/power/api').PowerBody) => this.request<unknown>('POST', '/api/hive/power', body)

  // ---------- Lab ----------

  listLabSuites = () => this.request<LabSuite[]>('GET', '/api/lab/suites')
  listLabRuns = (opts: { suite?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.suite) q.set('suite', opts.suite)
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return this.request<LabRunSummary[]>('GET', `/api/lab/runs${qs ? `?${qs}` : ''}`)
  }
  startLabRun = (suite: string) => this.request<LabRun>('POST', '/api/lab/runs', { suite })
  getLabRun = (id: string) => this.request<LabRun>('GET', `/api/lab/runs/${enc(id)}`)
  cancelLabRun = (id: string) => this.request<{ cancelling: true }>('POST', `/api/lab/runs/${enc(id)}/cancel`, {})
  getLabScorecard = () => this.request<LabScorecardEntry[]>('GET', '/api/lab/scorecard')
  getLabHistory = (suite: string, limit = 30) =>
    this.request<LabHistory>('GET', `/api/lab/history/${enc(suite)}?limit=${limit}`)

  // ---------- Hive programs ----------

  programs = () => this.request<Program[]>('GET', '/api/programs')
  program = (id: string) => this.request<ProgramDetail>('GET', `/api/programs/${enc(id)}`)
  programUi = (id: string) => this.request<import('./types').ProgramUiBundle>('GET', `/api/programs/${enc(id)}/ui`)
  private async appAskRequest(method: string, path: string, body?: unknown): Promise<unknown> {
    const bytes = (v: unknown) => new TextEncoder().encode(JSON.stringify(v)).byteLength
    if (body !== undefined && bytes(body) > 8192) throw new ApiError(413, 'too_large', 'This Ask request is too large.')
    const result = await this.request<unknown>(method, path, body)
    if (bytes(result) > 8192) throw new ApiError(0, 'answer_unreadable', 'This Ask answer could not be read. Its outcome is not confirmed.')
    return result
  }
  private async appLinkRequest(path: string, body: unknown, method = 'POST'): Promise<unknown> {
    const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
    if (bytes(body) > 8192) throw new ApiError(413, 'too_large', 'This app request is too large.')
    const value = await this.request<unknown>(method, path, body)
    if (bytes(value) > 262144) throw new ApiError(0, 'answer_unreadable', 'This app request is unavailable.')
    return value
  }
  appLinkFrame = (app: string, body: { swarm_id: string; frame_slot_id: string; entry_id?: string }) => this.appLinkRequest(`/api/programs/${enc(app)}/app-links/frames`, body)
  appLinkClose = (app: string, frame: string, body: { handoff?: string }) => this.appLinkRequest(`/api/programs/${enc(app)}/app-links/frames/${enc(frame)}`, body, 'DELETE')
  appLinkPrepare = (app: string, frame: string, body: { type: 'app-setup' | 'app-open'; app: string }) => this.appLinkRequest(`/api/programs/${enc(app)}/app-links/frames/${enc(frame)}/prepare`, body)
  appLinkInspect = (app: string, frame: string, review: string) => this.appLinkRequest(`/api/programs/${enc(app)}/app-links/frames/${enc(frame)}/reviews/${enc(review)}/inspect`, {})
  appLinkDecide = (app: string, frame: string, review: string, body: { approve: boolean; open_now: boolean }) => this.appLinkRequest(`/api/programs/${enc(app)}/app-links/frames/${enc(frame)}/reviews/${enc(review)}/decide`, body)
  appLinkCheckFrame = (app: string, frame: string) => this.appLinkRequest(`/api/programs/${enc(app)}/app-links/frames/${enc(frame)}/current`, {})
  appLinkPresentation = (entry: string, consume = false) => this.appLinkRequest(`/api/app-links/entries/${enc(entry)}/presentation-current`, consume ? { consume: true } : {})
  appLinkCheck = (entry: string, body: { frame_id: string }) => this.appLinkRequest(`/api/app-links/entries/${enc(entry)}/check`, body)
  appLinkEntryCard = (entry: string) => this.appLinkRequest(`/api/app-links/entries/${enc(entry)}/card`, {})
  appLinkRedeem = (entry: string, body: { release_digest: string; frame_slot_id: string }) => this.appLinkRequest(`/api/app-links/entries/${enc(entry)}/redeem`, body)
  programAskCard = (app: string) => this.appAskRequest('GET', `/api/programs/${enc(app)}/ask/consent`)
  programAskConsent = (app: string, body: { card_id: string }) => this.appAskRequest('POST', `/api/programs/${enc(app)}/ask/consent`, body)
  programAskRevoke = (app: string) => this.appAskRequest('DELETE', `/api/programs/${enc(app)}/ask/consent`, {})
  programAskFrame = (app: string, body: { release_digest: string; frame_slot_id: string; initial_operation_id?: string }) => this.appAskRequest('POST', `/api/programs/${enc(app)}/ask/frames`, body)
  programAskPresence = (app: string, generation: string) => this.appAskRequest('POST', `/api/programs/${enc(app)}/ask/frames/${enc(generation)}/presence`, {})
  programAskClose = (app: string, generation: string) => this.appAskRequest('DELETE', `/api/programs/${enc(app)}/ask/frames/${enc(generation)}`, {})
  programAskOp = (app: string, generation: string, body: import('./appAsk').AppAskOp) => this.appAskRequest('POST', `/api/programs/${enc(app)}/ask/frames/${enc(generation)}/ops`, body)
  askPresentation = (operation: string) => this.appAskRequest('GET', `/api/ask/${enc(operation)}/presentation`)
  askClaim = (operation: string, body: { expected_epoch: number }) => this.appAskRequest('POST', `/api/ask/${enc(operation)}/presentation`, { action: 'claim', ...body })
  askHandover = (operation: string, body: { generation_id: string; expected_epoch: number }) => this.appAskRequest('POST', `/api/ask/${enc(operation)}/presentation`, { action: 'handover', ...body })
  askActClaim = (operation: string, act: string, body: { owner_epoch: number }) => this.appAskRequest('POST', `/api/ask/${enc(operation)}/acts/${enc(act)}/claim`, body)
  artifactSubscription = (swarmId: string, artifactId: string) => this.request<{ artifact_id: string; swarm_id: string }>('GET', `/api/swarms/${enc(swarmId)}/artifacts/${enc(artifactId)}/subscription`)
  programHomes = (id: string) => this.request<{ program: string; homes: { swarm_id: string; why: string }[] }>('GET', `/api/programs/${enc(id)}/homes`)
  programView = (id: string, body: ProgramViewBody) => this.request<WorkGraph>('POST', `/api/programs/${enc(id)}/view`, body)
  programAct = (id: string, body: ProgramActBody) => this.request<ActionResult>('POST', `/api/programs/${enc(id)}/act`, body)
  hostProgramAct = async (id: string, body: ProgramActBody) => {
    let personSwarmConsentRequired = false
    const result = await this.request<ActionResult>('POST', `/api/programs/${enc(id)}/act`, body, true, {}, (headers) => {
      personSwarmConsentRequired = headers.get('X-Hive-Person-Swarm-Consent-Required') === '1'
    })
    return { result, personSwarmConsentRequired }
  }
  openPersonApp = (program: string) => this.request<unknown>('POST', `/api/programs/${enc(program)}/person-context`, {})
  resetPersonApp = (program: string) => this.request<unknown>('POST', `/api/programs/${enc(program)}/person-context/reset`, {})
  programInstall = (program: string) => this.request<import('./personApps').AppInstallStatus>('GET', `/api/programs/${enc(program)}/install`)
  installProgram = (program: string, body: import('./personApps').AppInstallBody) =>
    this.request<import('./personApps').AppInstallStatus>('POST', `/api/programs/${enc(program)}/install`, body)
  appSwarmCard = async (program: string, template: string) => {
    const raw = await this.request<unknown>('GET', personSwarmCardRoute(program, template))
    const card = readPersonSwarmCard(raw, program, template)
    if (!card) throw new ApiError(0, 'answer_unreadable', 'Your hive did not return a valid helpers card.')
    return card
  }
  consentAppSwarm = async (program: string, template: string, shown: PersonSwarmShown) => {
    const raw = await this.request<unknown>('POST', `${personSwarmCardRoute(program, template)}/consent`, shown)
    const card = readPersonSwarmCard(raw, program, template)
    if (!card) throw new ApiError(0, 'answer_unreadable', 'Your hive answered, but its helpers-consent answer could not be read.')
    return card
  }
  confirmAct = (id: string, swarmId: string, action: string, payload: import('../lib/confirmDigest').ConfirmPayload, payloadDigest: string) =>
    this.request<import('./types').ConfirmToken>('POST', `/api/programs/${enc(id)}/confirm`, { swarm_id: swarmId, action, payload, payload_digest: payloadDigest })
  programRead = (id: string, swarmId: string, query: string, params: Record<string, unknown> | null) =>
    this.request<import('./types').ProgramReadResult>('POST', FRAME_WIRE.read.route(id), { swarm_id: swarmId, query, ...(params ? { params } : {}) })
  programEnable = (id: string) => this.request<Program>('POST', `/api/programs/${enc(id)}/enable`, {})
  programDisable = (id: string) => this.request<Program>('POST', `/api/programs/${enc(id)}/disable`, {})
  programsReload = () => this.request<Program[]>('POST', '/api/programs/reload', {})

  // ---------- Providers ----------

  listProviders = () => this.request<ProviderStatus[]>('GET', '/api/providers')
  getProvider = (name: string) => this.request<ProviderStatus>('GET', `/api/providers/${enc(name)}`)
  setProviderKey = (name: string, key: string) => this.request<ProviderStatus>('PUT', `/api/providers/${enc(name)}/key`, { key })
  removeProviderKey = (name: string) => this.request<ProviderStatus>('DELETE', `/api/providers/${enc(name)}/key`)
  openrouterCatalog = (refresh = false) => this.request<Catalog>('GET', `/api/providers/openrouter/catalog${refresh ? '?refresh=1' : ''}`)
  openrouterEndpoints = (modelId: string) =>
    this.request<{ model: string; endpoints: ModelEndpoint[] }>('GET', `/api/providers/openrouter/endpoints/${modelId.split('/').map(enc).join('/')}`).then((r) => r.endpoints)

  listKeys = () => this.request<KeyInfo[]>('GET', '/api/keys')
  addKey = (body: { provider: string; key: string; label?: string; default?: boolean }) => this.request<KeyInfo>('POST', '/api/keys', body)
  updateKey = (id: string, body: { label?: string; default?: boolean }) => this.request<KeyInfo>('PATCH', `/api/keys/${enc(id)}`, body)
  refreshKey = (id: string) => this.request<KeyInfo>('POST', `/api/keys/${enc(id)}/refresh`, {})
  removeKey = (id: string) => this.request<{ ok: true; unassigned: number }>('DELETE', `/api/keys/${enc(id)}`)

  me = async (): Promise<Me> => {
    const context = this.authIdentity
    // its own contract (lib/readMe re-reads on auth_context_changed): request()'s identity_changed is that case here
    const result = await this.request<Me>('GET', '/api/auth/me').catch((e: unknown) => {
      if (isIdentityChanged(e)) throw new ApiError(409, 'auth_context_changed', 'Sign-in changed while reading identity')
      throw e
    })
    if (context !== this.authIdentity) throw new ApiError(409, 'auth_context_changed', 'Sign-in changed while reading identity')
    // r1.2 (Kimi r1.1 #1): the identity is the PRINCIPAL, not only the bearer. A different principal under the same
    // handle (a cookie-only hive_signin switch, which changes no token here) is a new identity: a new handle, the
    // listeners told (the store and the identity epoch drop the earlier person's state), and this read is re-made
    const principal = typeof result?.principal === 'string' ? result.principal : null
    if (principal !== null && this.principal !== null && principal !== this.principal) {
      // The update BEFORE the emit is load-bearing (re-entrancy): a listener that reacts by calling me() again reads
      // the new principal as current and does not recurse into this branch.
      this.principal = principal
      this.authIdentity = {}
      // followups-r8 (stand-in r1.2 P2): the socket opened under the earlier handle drops every frame from now on
      // (onmessage's openedUnder check), and connect() keeps it while it exists: reopen it under the new handle, as a
      // token change does, so live updates resume for the person now signed in
      if (this.ws) this.reopenEvents()
      this.authEvents.emit()
      throw new ApiError(409, 'auth_context_changed', 'Sign-in changed while reading identity')
    }
    if (principal !== null) this.principal = principal
    return result
  }
  uiPrefs = () => this.request<UiPrefsResponse>('GET', '/api/me/ui')
  // compare-and-set (platform/ui-prefs-revision): X-UI-Base-Rev carries the host rev this write expects (uiRevHeaders)
  setUiPrefs = (prefs: UiPrefs, opts: UiPrefsWriteOptions = {}) => this.request<UiPrefsResponse>('PUT', '/api/me/ui', prefs, true, uiRevHeaders(opts))
  resetUiPrefs = (opts: UiPrefsWriteOptions = {}) => this.request<UiPrefsResponse>('DELETE', '/api/me/ui', undefined, true, uiRevHeaders(opts))
  invitePreview = (token: string) => this.request<{ email_hint: string; name: string; role: string; expires_at: number }>('GET', `/api/auth/invite/${enc(token)}`, undefined, false)
  explore = (spec: import('./types').ExploreSpec) => this.request<import('./types').ExploreResult>('POST', '/api/explore', spec)
  exploreViews = () => this.request<import('./types').ExploreView[]>('GET', '/api/explore/views')
  saveExploreView = (body: { name: string; spec: import('./types').ExploreSpec; arrangement: import('./types').ExploreArrangement }, id?: string) =>
    this.request<import('./types').ExploreView>(id ? 'PUT' : 'POST', id ? `/api/explore/views/${enc(id)}` : '/api/explore/views', body)
  setNodeMeta = (id: string, body: { purpose?: string; tags?: string[] }) =>
    this.request<{ node_id: string; purpose: string; tags: string[] }>('PUT', `/api/explore/meta/${enc(id)}`, body)
  exploreGroups = () => this.request<import('./types').ExploreGroupDef[]>('GET', '/api/explore/groups')
  createExploreGroup = (name: string) => this.request<import('./types').ExploreGroupDef>('POST', '/api/explore/groups', { name })
  exploreGroupMembers = (id: string, body: { add?: string[]; remove?: string[] }) =>
    this.request<import('./types').ExploreGroupDef>('POST', `/api/explore/groups/${enc(id)}/members`, body)
  deleteExploreView = (id: string) => this.request<{ id: string }>('DELETE', `/api/explore/views/${enc(id)}`)
  reviewGoal = (id: string, decision: 'accept' | 'return', notes?: string) =>
    this.request<Goal>('POST', `/api/goals/${enc(id)}/review`, { decision, notes: notes ?? '' })
  getGoal = (id: string) => this.request<Goal>('GET', `/api/goals/${enc(id)}`)
  goalReviews = (id: string) => this.request<import('./types').GoalReview[]>('GET', `/api/goals/${enc(id)}/reviews`)
  updates = () => this.request<import('./types').UpdatesOverview>('GET', '/api/updates')
  applyUpdate = (body: { target: string; override?: boolean; confirm?: string }) =>
    this.request<{ target: string; ok: boolean; restarting?: boolean; error?: string | null }>('POST', '/api/updates/apply', body)
  releaseHold = (id: string) => this.request<{ id: string }>('DELETE', `/api/updates/holds/${enc(id)}`)
  placeHold = async (body: import('./types').PlaceHoldBody) => {
    // older hives only type-check `until` (finding d), so a malformed one would never lapse; next10 refuses one without a
    // timezone or more than 7 days ahead. The same rule is checked here, so the person gets a plain answer either way.
    const why = checkHoldBody(body)
    if (why) throw new ApiError(400, 'bad_request', why)
    return this.request<import('./types').UpdateHold>('POST', '/api/updates/holds', body)
  }
  idleMinds = async (opts: { includePersonal?: boolean } = {}) => readIdleOverview(await this.request<unknown>('GET', `/api/health/idle${opts.includePersonal ? '?include=personal' : ''}`))
  idleMind = async (agentId: string, opts: { includePersonal?: boolean } = {}) => readIdleDetail(await this.request<unknown>('GET', `/api/agents/${enc(agentId)}/health/idle${opts.includePersonal ? '?include=personal' : ''}`))
  remindIdle = async (agentId: string) => readIdleDetail(await this.request<unknown>('POST', `/api/agents/${enc(agentId)}/health/remind`))
  health = (swarmId?: string) => this.request<import('./types').HealthOverview>('GET', swarmId ? `/api/health?swarm_id=${enc(swarmId)}` : '/api/health')
  listPeople = () => this.request<{ people: Person[]; invites: Invite[]; google_ready: boolean }>('GET', '/api/people')
  rooms = () => this.request<import('./types').Room[]>('GET', '/api/rooms')
  room = (id: string) => this.request<import('./types').Room>('GET', `/api/rooms/${enc(id)}`)
  createRoom = (body: { kind: import('./types').RoomKind; name?: string; topic?: string; members: string[]; visibility?: string; origin?: import('./types').RoomOrigin }) => this.request<import('./types').Room>('POST', '/api/rooms', body)
  updateRoom = (id: string, body: Record<string, unknown>) => this.request<import('./types').Room>('PATCH', `/api/rooms/${enc(id)}`, body)
  roomMessages = (id: string, after = 0) => this.request<import('./types').RoomMessage[]>('GET', `/api/rooms/${enc(id)}/messages?after=${after}&limit=200`)
  postRoomMessage = (id: string, text: string) => this.request<import('./types').RoomMessage>('POST', `/api/rooms/${enc(id)}/messages`, { text })
  addRoomMembers = (id: string, members: string[]) => this.request<import('./types').Room>('POST', `/api/rooms/${enc(id)}/members`, { members })
  removeRoomMember = (id: string, member: string) => this.request<import('./types').Room>('DELETE', `/api/rooms/${enc(id)}/members/${enc(member)}`)
  roomBecomeSwarm = (id: string, moveMinds: string[]) => this.request<{ room: import('./types').Room; swarm: Swarm }>('POST', `/api/rooms/${enc(id)}/swarm`, { move_minds: moveMinds })
  swarmRoom = (swarmId: string) => this.request<import('./types').Room>('POST', `/api/swarms/${enc(swarmId)}/room`)
  usageMe = () => this.request<import('./types').MySpendSummary>('GET', '/api/usage/me')
  myNotices = () => this.request<unknown>('GET', '/api/me/notices')
  setNoticeSettings = (body: Partial<Pick<import('./notices').NoticePrefs, 'cap' | 'quiet_start' | 'quiet_end' | 'tz'>>) => this.request<unknown>('PUT', '/api/me/notices/settings', body)
  releaseNotices = () => this.request<unknown>('POST', '/api/me/notices/release', {})
  mySpendDays = (days: number) => this.request<unknown>('GET', `/api/me/spend?days=${days}`)
  settings = () => this.request<import('./types').HiveSettings>('GET', '/api/settings')
  googleConnector = () => this.request<unknown>('GET', '/api/connectors/google')
  startGoogleConnector = () => this.request<unknown>('POST', '/api/connectors/google/start', {})
  disconnectGoogleConnector = () => this.request<unknown>('POST', '/api/connectors/google/disconnect', {})
  setGoogleConnectorMind = (mind: string, allowed: boolean) => this.request<unknown>('PUT', `/api/connectors/google/minds/${enc(mind)}`, googleMindConsent(mind, allowed))
  configureGoogleConnector = (clientId: string, clientSecret: string) => this.request<unknown>('POST', '/api/connectors/google/config', { client_id: clientId, client_secret: clientSecret })
  rotatePassword = () => this.request<{ password: string; ended_password_sessions: number; note: string }>('POST', '/api/settings/password/rotate')
  sessions = () => this.request<import('./types').WorkSession[]>('GET', '/api/sessions')
  createSession = (body: { mind: string; title: string; detail?: string; budget_usd: number }) => this.request<import('./types').WorkSession>('POST', '/api/sessions', body)
  sessionTimeline = (id: string) => this.request<{ session: import('./types').WorkSession; items: import('./types').SessionItem[] }>('GET', `/api/sessions/${enc(id)}/timeline`)
  sessionWorkspaces = (id: string) => this.request<{ workspaces: { id: string; repository_id: string; status?: string; base_commit?: string }[] }>('GET', `/api/sessions/${enc(id)}/workspaces`)
  endSession = (id: string) => this.request<import('./types').WorkSession>('POST', `/api/sessions/${enc(id)}/end`)
  budgetLimitsView = () => this.request<unknown>('GET', '/api/budgets/limits')
  // ---- Surface universal Ask: the routes Platform built in phase 1 (platform/ask-p1 at 6100794, hive/API.md), and
  // takeover (POST /api/ask/{op}/takeover: the conductor turn ends and spends no more). Confirm is NOT wired here yet:
  // this client leaves it undefined, so the page never sends it to a live hive; the sim plays it.
  ask = async (body: import('./ask').AskBody): Promise<import('./ask').AskAccepted> => {
    const r = await this.askRequest<import('./ask').AskAccepted>('POST', '/api/ask', body)
    // Kimi K3 (2): a 2xx that parses but is not this request's acceptance is a protocol violation. The hive answered,
    // so it may have admitted it: the outcome is unknown (status 0), never a refusal and never taken as accepted.
    if (!r || typeof r !== 'object' || r.operation_id !== body.operation_id || typeof r.turn_id !== 'string') throw new ApiError(0, 'answer_unreadable', 'The hive answered, but not with this request’s acceptance, so whether it was received is not known.')
    return r
  }
  askTurn = (op: string, after = 0) => this.askRequest<import('./ask').AskTurnState>('GET', `/api/ask/${enc(op)}?after=${Math.max(0, Math.floor(after))}&limit=100`)
  askStop = (op: string) => this.askRequest<unknown>('POST', `/api/ask/${enc(op)}/stop`, {})
  askTakeover = (op: string) => this.askRequest<import('./ask').AskTakeover>('POST', `/api/ask/${enc(op)}/takeover`, { reason: 'user_took_over' })
  askSettings = () => this.askRequest<import('./ask').AskSettings>('GET', '/api/me/ask')
  setAskSettings = (body: import('./ask').AskSettingsPut) => this.askRequest<import('./ask').AskSettings>('PUT', '/api/me/ask', body)
  myMind = () => this.request<unknown>('GET', '/api/me/mind')
  // First Light R2 (features/firstlight/host.ts reads each answer strictly)
  onboarding = () => this.request<unknown>('GET', '/api/me/onboarding')
  patchOnboarding = (body: Record<string, unknown>) => this.request<unknown>('PATCH', '/api/me/onboarding', body)
  mySetup = () => this.request<unknown>('GET', '/api/me/setup')
  hiveOwn = () => this.request<unknown>('GET', '/api/hive/own')
  myKeyLimits = () => this.request<unknown>('GET', '/api/me/key-limits')
  setOwnKeyLimit = (body: Record<string, unknown>) => this.request<unknown>('PUT', '/api/me/key-limits/self', body)
  askForLimit = (body: Record<string, unknown>) => this.request<unknown>('POST', '/api/me/limit-requests', body)
  personalMindHello = (wake: boolean) => this.request<unknown>(wake ? 'POST' : 'GET', '/api/me/personal-mind/hello', wake ? {} : undefined)
  // The Ask's linkage intents (host 39c0731 app.py:1495-1527). Record and submit are §G person routes: the browser's own
  // Origin, the Bearer header and application/json; submit sends an empty object (the host accepts none or {}).
  askRecordIntent = (op: string, body: import('./askIntents').IntentRecordBody) => this.request<unknown>('POST', `/api/ask/${enc(op)}/intents`, body)
  askSubmitIntent = (id: string) => this.request<unknown>('POST', `/api/ask/intents/${enc(id)}/submit`, {})
  // J3 r4.3 O3: Platform's PROPOSED live Studio session routes (host plan §3.2–§3.3). Not on live yet: the page calls them
  // only when GET /api/me/ask says capabilities.studio_sessions (features/studioLive/api.ts studioCapable).
  studioRecordIntent = (op: string, body: { kind: 'studio.session'; request: import('../features/studioLive/api').StudioSessionRequest }) => this.request<unknown>('POST', `/api/ask/${enc(op)}/intents`, body)
  studioSession = (sid: string) => this.request<unknown>('GET', `/api/studio-sessions/${enc(sid)}`)
  studioPiece = (sid: string, body: import('../features/studioLive/api').PieceBody) => this.request<unknown>('PUT', `/api/studio-sessions/${enc(sid)}/piece`, body)
  studioOutcome = (sid: string, n: number, body: import('../features/studioLive/api').OutcomeBody) => this.request<unknown>('POST', `/api/studio-sessions/${enc(sid)}/steps/${Math.floor(n)}/outcome`, body)
  studioControl = (sid: string, body: import('../features/studioLive/api').ControlBody) => this.request<unknown>('POST', `/api/studio-sessions/${enc(sid)}/controls`, body)
  studioMount = (sid: string, body: import('../features/studioLive/api').MountBody) => this.request<unknown>('POST', `/api/studio-sessions/${enc(sid)}/mount`, body)
  studioMountHeartbeat = (sid: string, body: import('../features/studioLive/api').MountWire) => this.request<unknown>('POST', `/api/studio-sessions/${enc(sid)}/mount/heartbeat`, body)
  studioUnmount = (sid: string, body: { mount_token: string }) => this.request<unknown>('DELETE', `/api/studio-sessions/${enc(sid)}/mount`, body)
  studioMountReadback = (sid: string, attemptId: string) => this.request<unknown>('GET', `/api/studio-sessions/${enc(sid)}/mount?attempt_id=${encodeURIComponent(attemptId)}`)
  /**
   * r1.10 (host R7): the setup card from POST /api/studio/setup (named person; the page's own Origin and Bearer). The body
   * carries ONLY what the person chose; the hive derives maker, Studio home, app pin, key, model, role and tools (sending
   * those is 400). The answer's `request` is recorded unchanged; `operation_id` (the Ask turn) and `prep` (for a refresh)
   * are added here, never sent.
   */
  studioSetupProposal = async (programId: string, _swarmId: string, prep?: import('../features/studioLive/api').SetupPrep): Promise<unknown> => {
    if (!prep) throw new ApiError(0, 'setup_needs_turn', 'Studio starts from an Ask turn.')
    // r1.13: the piece is the person's picked saved canvas, exactly: its verified scene id and its exact artifact ref
    const request = { title: prep.title, detail: prep.detail, piece: { scene_id: prep.scene_id, source_ref: { artifact_id: prep.source_ref.artifact_id, revision: prep.source_ref.revision, digest: prep.source_ref.digest } }, max_steps: prep.max_steps, window_minutes: prep.window_minutes, program_id: programId }
    const answer = await this.request<Record<string, unknown>>('POST', '/api/studio/setup', { request })
    return answer && typeof answer === 'object' ? { ...answer, operation_id: prep.operation_id, prep } : answer
  }
  /** r1.13 (host R7): POST /api/studio/setup with body {}: provisions (or reuses) the person's own maker, answers {maker} */
  studioMaker = (): Promise<unknown> => this.request<unknown>('POST', '/api/studio/setup', {})
  askIntent = (id: string) => this.request<unknown>('GET', `/api/ask/intents/${enc(id)}`)
  askIntents = (q: { state?: import('./askIntents').IntentState; limit?: number } = {}) =>
    this.request<unknown>('GET', `/api/ask/intents?${new URLSearchParams({ ...(q.state ? { state: q.state } : {}), limit: String(Math.max(1, Math.min(50, Math.floor(q.limit ?? 50)))) }).toString()}`)
  /**
   * The Code team for a person's code request: the visible, in-use swarms with a coordinator that offer `code`
   * (GET /api/swarms, GET /api/swarms/{id}/services); exactly one, or the page says so rather than choose. Then that
   * team's registered templates (GET /api/teams/{swarm_id}/templates; §G: the Bearer header only), read strictly.
   */
  codeTeamOffer = async (): Promise<import('./askIntents').CodeTeamOffer> => {
    const team = await chooseCodeTeam(() => this.listSwarms(), (id) => this.swarmServices(id))
    const raw = await this.request<unknown>('GET', `/api/teams/${enc(team.id)}/templates`)
    return { to_swarm: team.id, team_name: team.name, template_ids: parseTeamTemplates(raw, team.id) }
  }
  // copy-apply consent (Platform 66312cd): §G person route (Origin, Bearer, JSON), a closed body
  proposalConsent = (requestId: string, suggestionId: string, decision: 'accept' | 'decline', suggestionDigest: string) => this.request<unknown>('POST', `/api/requests/${enc(requestId)}/proposals/${enc(suggestionId)}/${decision}`, { suggestion_digest: suggestionDigest })
  teamChildren = (swarmId: string, cursor?: string) => this.request<unknown>('GET', `/api/teams/${enc(swarmId)}/children${cursor ? `?${new URLSearchParams({ cursor }).toString()}` : ''}`)
  askEndThread = (threadId: string) => this.request<unknown>('POST', `/api/sessions/${enc(threadId)}/end`)
  askDeleteThread = (threadId: string) => this.askRequest<unknown>('DELETE', `/api/ask/threads/${enc(threadId)}`)
  askActResult = (op: string, actId: string, body: import('./ask').ActResult) => this.askRequest<unknown>('POST', `/api/ask/${enc(op)}/acts/${enc(actId)}/result`, body)
  // Workbench Map (repo-map Slice A §3): member read routes only; the admin loader (/api/admin/repo-maps) is not reachable here
  repoMapRequest = (method: 'GET' | 'POST', path: string, body?: unknown) => {
    if (!/^\/api\/repo-maps(?:[/?]|$)/.test(path)) return Promise.reject(new ApiError(0, 'bad_request', 'Not a repository map route.'))
    return this.request<unknown>(method, path, method === 'POST' ? body ?? {} : undefined)
  }
  // the person's own mind (Platform P1; versions P3/P4): owner-only routes, read with api/personalMind
  renameMyMind = (name: string) => this.request<unknown>('POST', '/api/me/mind', { name })
  myMindInbox = (after: string | null, limit: number) => this.request<unknown>('GET', `/api/me/mind/inbox?limit=${Math.max(1, Math.min(50, Math.floor(limit)))}${after ? `&after=${enc(after)}` : ''}`)
  myMindInboxAck = (ids: string[]) => this.request<unknown>('POST', '/api/me/mind/inbox/ack', { ids })
  myMindVersions = () => this.request<unknown>('GET', '/api/me/mind/versions')
  adoptMyMindVersion = (versionId: string) => this.request<unknown>('POST', '/api/me/mind/adopt', { version_id: versionId })
  rollbackMyMind = () => this.request<unknown>('POST', '/api/me/mind/rollback', {})
  // Surface conductor-live: steer IS on the host now (core/app.py ask_steer at 32afcf7), whatever the block comment
  // above says; that comment is Platform's (ask-takeover r2 rewrites it), left as is so the two patches stay separable.
  /** POST /api/ask/{op}/steer {steer_id, text, at_seq, via?} (core/app.py ask_steer → core/ask.py steer): 202 with the
   *  steer joined to the open turn, or (a closed turn) a fresh turn under a new operation_id. A 2xx that is not this
   *  steer's answer is unreadable (status 0), never taken as joined. */
  askSteer = async (op: string, body: import('./ask').AskSteerBody): Promise<import('./ask').AskSteerResult> => {
    const r = await this.askRequest<import('./ask').AskSteerResult>('POST', `/api/ask/${enc(op)}/steer`, body)
    if (!r || typeof r !== 'object' || r.steer_id !== body.steer_id || typeof r.operation_id !== 'string') throw new ApiError(0, 'answer_unreadable', 'The hive answered, but not with this steer’s answer.')
    return r
  }
  /** As request(), but a refusal keeps the host's Ask details (mind_asleep's mind, ask_busy's operation_id). */
  private async askRequest<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const at = this.authIdentity
    let res: Response
    try {
      res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (err) {
      this.sentUnder(at)
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error')
    }
    this.sentUnder(at)
    if (!res.ok) {
      let data: unknown = null
      try {
        data = await res.json()
      } catch {
        /* non-JSON error body */
      }
      // r1.2 (stand-in r1.1 P2): an error read across a sign-in change belongs to the earlier sign-in: identity_changed,
      // checked before the session-ending 401 below (which stays for a request still current)
      this.sentUnder(at)
      const parsed = parseErrorBody(res.status, res.statusText, data)
      if (endsHiveSession(res.status) && headers.Authorization === `Bearer ${this.token}`) {
        this.replaceToken(null)
        this.setState('unauthorized')
      }
      const { AskRefusal, refusalDetails } = await import('./ask')
      throw new AskRefusal(res.status, parsed.code, parsed.message, refusalDetails(data))
    }
    // Review B1 (45392df): an unreadable successful answer is a lost answer (status 0, outcome unknown), never a refusal
    const answer = await readOk<T>(res)
    this.sentUnder(at)
    return answer
  }
  invite = (body: { email: string; name?: string; role?: string; days?: number }) => this.request<Invite & { link: string }>('POST', '/api/invites', body)
  revokeInvite = (id: string) => this.request<Invite>('DELETE', `/api/invites/${enc(id)}`)
  updatePerson = (id: string, body: { role?: string; disabled?: boolean }) => this.request<Person>('PATCH', `/api/people/${enc(id)}`, body)
  clearGoogleIdentity = (id: string) => this.request<Person>('PATCH', `/api/people/${enc(id)}`, { clear_google_identity: true })
  createHarnessInvite = (body: { harness: string; name: string; swarm_id: string; role_id?: string | null; ttl_minutes?: number }) =>
    this.request<import('../features/harness/ConnectHarness').HarnessInvite>('POST', '/api/harness-invites', body)
  harnessInvite = (id: string) => this.request<import('../features/harness/ConnectHarness').HarnessInvite>('GET', `/api/harness-invites/${enc(id)}`)
  revokeHarnessInvite = (id: string) => this.request<import('../features/harness/ConnectHarness').HarnessInvite>('DELETE', `/api/harness-invites/${enc(id)}`)
  listRoles = () => this.request<import('./types').Role[]>('GET', '/api/roles')
  createRole = (body: Partial<import('./types').Role>) => this.request<import('./types').Role>('POST', '/api/roles', body)
  updateRole = (id: string, body: Partial<import('./types').Role>) => this.request<import('./types').Role>('PATCH', `/api/roles/${enc(id)}`, body)
  duplicateRole = (id: string) => this.request<import('./types').Role>('POST', `/api/roles/${enc(id)}/duplicate`, {})
  removeRole = (id: string) => this.request<{ ok: true; unassigned: number }>('DELETE', `/api/roles/${enc(id)}`)
  agentIsolation = (agentId: string) => this.request<import('./types').AgentIsolation>('GET', `/api/agents/${enc(agentId)}/isolation`)
  goalGrants = (goalId: string) => this.request<import('./types').GoalGrant[]>('GET', `/api/goals/${enc(goalId)}/grants`)
  revokeGoalGrant = (goalId: string, grantId: string) => this.request<import('./types').GoalGrant>('DELETE', `/api/goals/${enc(goalId)}/grants/${enc(grantId)}`)
  listConnections = (swarmId: string) => this.request<import('./types').ConnectionAgreement[]>('GET', `/api/connections?swarm_id=${enc(swarmId)}`)
  createConnection = (body: import('./types').CreateRequestConnection) => this.request<import('./types').ConnectionAgreement>('POST', '/api/connections', body)
  connectionAction = (id: string, action: import('./types').ConnectionAction, days?: number, reason?: string) =>
    this.request<import('./types').ConnectionAgreement>('POST', `/api/connections/${enc(id)}/${action}`, { ...(days === undefined ? {} : { days }), ...(action === 'revoke' && reason !== undefined ? { reason } : {}) })
  listRequests = () => this.request<import('./types').CollabRequest[]>('GET', '/api/requests')
  cancelRequest = (id: string) => this.request<{ cancelled: unknown; by: string }>('POST', `/api/requests/${enc(id)}/cancel`, {})
  codeTargets = () => this.request<import('../features/code/CodePage').Target[]>('GET', '/api/code/targets')
  codeAttach = (task: string, workspace: string, repository: string) => this.request<import('../features/code/CodePage').Opened>('POST', '/api/code/attach', { task_id: task, workspace_id: workspace, repository_id: repository })
  codeTree = (target: string) => this.request<{ target: string; commit: string; subdir: string; files: string[]; truncated: boolean }>('GET', `/api/code/targets/${enc(target)}/tree`)
  codeSelect = (task: string, repository: string) => this.request<import('../features/code/CodePage').Opened>('POST', '/api/code/select', { task_id: task, repository_id: repository })
  codeOpen = (target: string) => this.request<{ target: import('../features/code/CodePage').Target; task_id: string; swarm_id: string; grant_id: string; repository_id: string; base_commit: string }>('POST', '/api/code/open', { target })
  codeProxy = <T,>(method: 'GET' | 'POST', path: string, ctx: Record<string, string>, body?: unknown) =>
    this.request<T>(method, `/api/code/proxy${path}?${new URLSearchParams(ctx).toString()}`, method === 'POST' ? (body ?? {}) : undefined)
  // Retained scoped suggestions through the same authenticated relay. Relayed by hive/core/code.py PROXY_ROUTES since next7
  // (60fa650); a hive without them answers 404 not_relayed and the panel says so. No call here dispatches to a mind.
  private codeCtx = (ctx: import('./client').CodeContext) => ({ task_id: ctx.task_id, grant_id: ctx.grant_id, repository_id: ctx.repository_id })
  codeSuggestionScope = (ctx: import('./client').CodeContext, ws: string, body: import('../features/code/suggestions/contract').SuggestionScopeRequest) =>
    this.codeProxy<unknown>('POST', `/v1/workspaces/${enc(ws)}/suggestion-scopes`, this.codeCtx(ctx), body)
  codeSuggestionCreate = (ctx: import('./client').CodeContext, ws: string, body: import('../features/code/suggestions/contract').SuggestionCreateRequest) =>
    this.codeProxy<unknown>('POST', `/v1/workspaces/${enc(ws)}/suggestions`, this.codeCtx(ctx), body)
  codeSuggestionHistory = (ctx: import('./client').CodeContext, ws: string, page: { limit?: number; cursor?: string } = {}) =>
    this.codeProxy<unknown>('GET', `/v1/workspaces/${enc(ws)}/suggestions`, { ...this.codeCtx(ctx), limit: String(page.limit ?? 20), ...(page.cursor ? { cursor: page.cursor } : {}) })
  codeSuggestionRead = (ctx: import('./client').CodeContext, ws: string, id: string) =>
    this.codeProxy<unknown>('GET', `/v1/workspaces/${enc(ws)}/suggestions/${enc(id)}`, this.codeCtx(ctx))
  codeSuggestionDecide = (ctx: import('./client').CodeContext, ws: string, body: import('../features/code/suggestions/contract').SuggestionDecisionRequest) =>
    this.codeProxy<unknown>('POST', `/v1/workspaces/${enc(ws)}/suggestion-decisions`, this.codeCtx(ctx), body)

  // --- Surface: minds-side (shares, inventory, portable, health mind)
  listShares = (opts: { agent_id?: string; status?: string } = {}) =>
    this.request<import('../features/minds/types').Share[]>('GET', `/api/shares?${new URLSearchParams(Object.entries(opts).filter(([, v]) => v) as [string, string][]).toString()}`)
  shareReads = (shareId: string) => this.request<import('../features/minds/types').ShareRead[]>('GET', `/api/shares/${enc(shareId)}/reads`)
  revokeShare = (shareId: string) => this.request<import('../features/minds/types').Share>('POST', `/api/shares/${enc(shareId)}/revoke`, {})
  agentInventory = (agentId: string) => this.request<import('../features/minds/types').MindInventory>('GET', `/api/agents/${enc(agentId)}/inventory`)
  agentInventoryActivity = (agentId: string, cycles = 30) =>
    this.request<import('../features/minds/types').MindActivity>('GET', `/api/agents/${enc(agentId)}/inventory/activity?cycles=${cycles}`)
  agentHealth = (agentId: string) => this.request<import('../features/minds/types').MindHealthDetail>('GET', `/api/agents/${enc(agentId)}/health`)
  healthMind = () => this.request<import('../features/minds/types').HealthMindSetting>('GET', '/api/health/mind')
  setHealthMind = (agentId: string | null) => this.request<import('../features/minds/types').HealthMindSetting>('PUT', '/api/health/mind', { agent_id: agentId })
  hiveIdentity = () => this.request<import('../features/minds/types').HiveIdentity>('GET', '/api/hive/identity')
  setHiveIdentity = (body: { name?: string; home?: boolean }) => this.request<import('../features/minds/types').HiveIdentity>('PATCH', '/api/hive/identity', body)
  settleMind = (agentId: string, body: { to_hive: string; to_name: string; manifest_sha256: string }) => this.request<Agent>('POST', `/api/agents/${enc(agentId)}/settle`, body)
  mindMoves = (agentId: string) => this.request<import('../features/minds/types').MindMove[]>('GET', `/api/agents/${enc(agentId)}/moves`)
  convertNative = (agentId: string) => this.request<Agent>('POST', `/api/agents/${enc(agentId)}/convert-native`, {})
  /** The bundle is binary (application/gzip); its manifest digest comes in X-Manifest-Sha256. */
  exportMind = async (agentId: string): Promise<import('../features/minds/types').MindExport> => {
    const at = this.authIdentity
    const res = await this.binary('POST', `/api/agents/${enc(agentId)}/export`)
    const blob = await res.blob()
    this.sentUnder(at)
    const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? `${agentId}.omegamind.tgz`
    return { blob, filename: name, manifest_sha256: res.headers.get('X-Manifest-Sha256') ?? '', bytes: blob.size }
  }
  importMind = async (bundle: Blob, swarmId?: string): Promise<import('../features/minds/types').MindImportResult> => {
    const at = this.authIdentity
    const res = await this.binary('POST', `/api/agents/import${swarmId ? `?swarm_id=${enc(swarmId)}` : ''}`, bundle)
    const answer = await readOk<import('../features/minds/types').MindImportResult>(res)
    this.sentUnder(at)
    return answer
  }
  /** A request whose body or answer is not JSON; errors are read like request()'s. */
  private async binary(method: string, path: string, body?: Blob): Promise<Response> {
    const headers: Record<string, string> = {}
    if (body) headers['Content-Type'] = 'application/gzip'
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const at = this.authIdentity
    let res: Response
    try {
      res = await fetch(this.base + path, { method, headers, body })
    } catch (err) {
      this.sentUnder(at)
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error')
    }
    this.sentUnder(at)
    if (!res.ok) {
      let code = `http_${res.status}`
      let message = res.statusText || 'Request failed'
      try {
        const data = (await res.json()) as Partial<ApiErrorBody>
        if (data.error) ({ code, message } = data.error)
      } catch {
        /* non-JSON error body */
      }
      // r1.2 (stand-in r1.1 P2): an error read across a sign-in change belongs to the earlier sign-in: identity_changed,
      // checked before the session-ending 401 below (which stays for a request still current)
      this.sentUnder(at)
      if (res.status === 401 && headers.Authorization === `Bearer ${this.token}`) {
        this.replaceToken(null)
        this.setState('unauthorized')
      }
      throw new ApiError(res.status, code, message)
    }
    return res
  }
  listBudgets = () => this.request<import('../features/usage/Limits').BudgetRow[]>('GET', '/api/budgets')
  setBudget = (body: { scope: string; period: string; limit_usd: number; note?: string }) => this.request<unknown>('POST', '/api/budgets', body)
  removeBudget = (id: string) => this.request<unknown>('DELETE', `/api/budgets/${enc(id)}`)

  // --- Surface: money/work/apps (reservations, artifacts, assets, services, app activity)
  listReservations = () => this.request<import('./moneyWork').CostReservation[]>('GET', '/api/budgets/reservations')
  listOverruns = () => this.request<import('./moneyWork').CostOverrun[]>('GET', '/api/budgets/overruns')
  resolveReservation = (id: string, body: import('./moneyWork').ResolveBody) =>
    this.request<import('./moneyWork').ResolvedReservation>('POST', `/api/budgets/reservations/${enc(id)}/resolve`, body)
  hiveArtifacts = async (): Promise<import('./moneyWork').ArtifactList> => {
    const { composeArtifacts } = await import('../features/artifacts/artifacts')
    const missing: string[] = []
    const take = <T,>(what: string, p: Promise<T>) => p.catch(() => (missing.push(what), undefined))
    const [requests, swarms, shares, activity] = await Promise.all([
      take('reviews', this.request<import('./types').CollabRequest[]>('GET', '/api/requests')),
      take('flows', this.request<Swarm[]>('GET', '/api/swarms')),
      take('exhibits', this.request<import('../features/artifacts/artifacts').ShareRow[]>('GET', '/api/shares')),
      take('app results', this.request<import('./moneyWork').AppActivityRow[]>('GET', '/api/program-activity?limit=200')),
    ])
    const flows: Record<string, import('../features/artifacts/artifacts').FlowRow[]> = {}
    let flowGap = false
    await Promise.all((swarms ?? []).map((s) => this.request<import('../features/artifacts/artifacts').FlowRow[]>('GET', `/api/swarms/${enc(s.id)}/flows`).then((rows) => { flows[s.id] = rows }, () => { flowGap = true })))
    if (flowGap && !missing.includes('flows')) missing.push('flows in some swarms')
    return { items: composeArtifacts({ requests, flows, shares, activity }), missing }
  }
  swarmArtifacts = (swarmId: string, opts: { kind?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.kind) q.set('kind', opts.kind)
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return this.request<import('./moneyWork').SwarmArtifact[]>('GET', `/api/swarms/${enc(swarmId)}/artifacts${qs ? `?${qs}` : ''}`)
  }
  assetStores = () => this.request<import('./moneyWork').AssetStore[]>('GET', '/api/asset-stores')
  listAssets = (swarmId?: string) => this.request<import('./moneyWork').Asset[]>('GET', `/api/assets${swarmId ? `?swarm_id=${enc(swarmId)}` : ''}`)
  uploadAsset = async (file: Blob, opts: import('./moneyWork').UploadAssetOptions) => {
    const q = new URLSearchParams()
    if (opts.swarm_id) q.set('swarm_id', opts.swarm_id)
    if (opts.name) q.set('name', opts.name)
    if (opts.local_only) q.set('local_only', 'true')
    if (opts.store) q.set('store', opts.store)
    const at = this.authIdentity
    const res = await this.raw('POST', `/api/assets?${q.toString()}`, file, file.type || 'application/octet-stream')
    const answer = await readOk<import('./moneyWork').Asset>(res)
    this.sentUnder(at)
    return answer
  }
  assetBlob = async (sha: string) => { const at = this.authIdentity; const blob = await (await this.raw('GET', `/api/assets/${enc(sha)}`)).blob(); this.sentUnder(at); return blob }
  /** lab-figures r1: only the host's own figure route is read; the session goes in the header (raw()), never the URL */
  figureBlob = async (readUrl: string) => {
    if (!figureRouteSha(readUrl)) throw new ApiError(400, 'bad_figure_url', 'not a figure read route')
    return (await this.raw('GET', readUrl)).blob()
  }
  transferAsset = (sha: string, to: string, move: boolean) => this.request<import('./moneyWork').Asset>('POST', `/api/assets/${enc(sha)}/transfer`, { to, move })
  swarmServices = (swarmId: string) => this.request<import('./moneyWork').SwarmServices>('GET', `/api/swarms/${enc(swarmId)}/services`)
  setSwarmServices = (swarmId: string, body: { kinds: string[]; connection_only_kinds: string[] }) =>
    this.request<import('./moneyWork').SwarmServices>('PUT', `/api/swarms/${enc(swarmId)}/services`, body)
  registeredServices = () => this.request<import('./moneyWork').RegisteredService[]>('GET', '/api/services')
  setServiceEnabled = (id: string, enabled: boolean) => this.request<import('./moneyWork').RegisteredService>('POST', `/api/services/${enc(id)}/${enabled ? 'enable' : 'disable'}`, {})
  removeService = (id: string) => this.request<{ ok: true }>('DELETE', `/api/services/${enc(id)}`)

  // ---- Surface missing-UI batch 1 (api/missingUi.ts; routes at the audited release head)
  askHistory = (limit = 50) => this.request<import('./missingUi').AskTurnRecord[]>('GET', `/api/ask?limit=${Math.max(1, Math.min(200, Math.floor(limit)))}`)
  askAudit = (o: { limit?: number; principal?: string; before?: string } = {}) => {
    const q = new URLSearchParams({ limit: String(Math.max(1, Math.min(200, Math.floor(o.limit ?? 100)))) })
    if (o.principal) q.set('principal', o.principal)
    if (o.before) q.set('before', o.before)
    return this.request<import('./missingUi').AskAuditRow[]>('GET', `/api/ask/audit?${q}`)
  }
  askAuditTurn = (turn: string, after = 0) => this.request<import('./missingUi').AskAuditTurn>('GET', `/api/ask/audit/${enc(turn)}?after=${Math.max(0, Math.floor(after))}&limit=100`)
  goalAttempts = (goalId: string) => this.request<import('./missingUi').GoalAttempt[]>('GET', `/api/goals/${enc(goalId)}/attempts`)
  addGoalGrant = (goalId: string, body: import('./missingUi').AddGoalGrantBody) => this.request<import('./types').GoalGrant>('POST', `/api/goals/${enc(goalId)}/grants`, body)
  revokeProgramGrants = (id: string) => this.request<import('./missingUi').ProgramGrantsRevoked>('POST', `/api/programs/${enc(id)}/grants/revoke`, {})
  restoreProgramGrants = (id: string) => this.request<import('./missingUi').ProgramGrantsRestored>('POST', `/api/programs/${enc(id)}/grants/restore`, {})
  requestUpdate = (body: import('./missingUi').UpdateRequestBody) => this.request<import('./missingUi').UpdateRequestRecord>('POST', '/api/updates/requests', body)
  harnessInvites = () => this.request<import('./missingUi').HarnessInviteRow[]>('GET', '/api/harness-invites')
  capabilityCatalogue = (scope: string) => this.request<import('./missingUi').CapabilityCatalogue>('GET', `/api/match/catalogue?scope=${enc(scope)}`)
  flowList = (swarmId: string) => this.request<import('./missingUi').FlowListRow[]>('GET', `/api/swarms/${enc(swarmId)}/flows`)
  flowRevision = (id: string, n: number) => this.request<import('./missingUi').FlowRevisionRead>('GET', `/api/flows/${enc(id)}/revisions/${enc(String(n))}`)
  unadoptFlow = (id: string, n: number) => this.request<{ revoked: boolean }>('DELETE', `/api/flows/${enc(id)}/revisions/${enc(String(n))}/adoption`)
  renameExploreGroup = (id: string, name: string) => this.request<import('./types').ExploreGroupDef>('PUT', `/api/explore/groups/${enc(id)}`, { name })
  deleteExploreGroup = (id: string) => this.request<import('./missingUi').ExploreGroupDeleted>('DELETE', `/api/explore/groups/${enc(id)}`)
  cleanupAsset = (sha: string) => this.request<import('./moneyWork').Asset>('POST', `/api/assets/${enc(sha)}/cleanup`, {})
  programActivations = (programId: string) => this.request<import('./moneyWork').AppActivation[]>('GET', `/api/programs/${enc(programId)}/activations`)
  activateProgram = (programId: string, swarmId: string) => this.request<import('./moneyWork').AppActivation>('POST', `/api/programs/${enc(programId)}/activations`, { swarm_id: swarmId })
  deactivateProgram = (programId: string, swarmId: string) => this.request<import('./moneyWork').AppActivation>('DELETE', `/api/programs/${enc(programId)}/activations/${enc(swarmId)}`)
  programAttachments = (programId: string) => this.request<import('./moneyWork').AppAttachment[]>('GET', `/api/programs/${enc(programId)}/attachments`)
  offerProgram = (programId: string, mindId: string) => this.request<import('./moneyWork').AppOffer>('POST', `/api/programs/${enc(programId)}/offers`, { mind_id: mindId })
  attachProgram = (programId: string, body: import('./moneyWork').AttachBody) => this.request<import('./moneyWork').AppAttachment>('POST', `/api/programs/${enc(programId)}/attachments`, body)
  detachProgram = (programId: string, attachmentId: string) => this.request<import('./moneyWork').AppAttachment>('DELETE', `/api/programs/${enc(programId)}/attachments/${enc(attachmentId)}`)
  programActivity = (opts: { swarm_id?: string; program?: string; limit?: number } = {}) => {
    const q = new URLSearchParams()
    if (opts.swarm_id) q.set('swarm_id', opts.swarm_id)
    if (opts.program) q.set('program', opts.program)
    if (opts.limit) q.set('limit', String(opts.limit))
    const qs = q.toString()
    return this.request<import('./moneyWork').AppActivityRow[]>('GET', `/api/program-activity${qs ? `?${qs}` : ''}`)
  }
  // --- Surface: studio slice 2 (drafts, asset bytes)
  putAppDraft = (programId: string, key: string, body: import('./appDrafts').AppDraftPut) =>
    this.draftCall<import('./appDrafts').AppDraftSaved>('PUT', `/api/apps/${enc(programId)}/drafts/${enc(key)}`, body)
  listAppDrafts = (programId: string, swarmId: string) =>
    this.draftCall<{ drafts: import('./appDrafts').AppDraftSummary[] }>('GET', `/api/apps/${enc(programId)}/drafts?swarm_id=${enc(swarmId)}`)
  getAppDraft = (programId: string, key: string, swarmId: string) =>
    this.draftCall<import('./appDrafts').AppDraft>('GET', `/api/apps/${enc(programId)}/drafts/${enc(key)}?swarm_id=${enc(swarmId)}`)
  deleteAppDraft = (programId: string, key: string, swarmId: string) =>
    this.draftCall<unknown>('DELETE', `/api/apps/${enc(programId)}/drafts/${enc(key)}?swarm_id=${enc(swarmId)}`)
  /** request(), except a 409 keeps the `current_revision` the hive merges into its error object. */
  private async draftCall<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const at = this.authIdentity
    let res: Response
    try {
      res = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch (err) {
      this.sentUnder(at)
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error')
    }
    this.sentUnder(at)
    if (!res.ok) {
      let code = `http_${res.status}`
      let message = res.statusText || 'Request failed'
      let current: unknown
      try {
        const data = (await res.json()) as { error?: string | { code?: string; message?: string; current_revision?: unknown }; message?: string; current_revision?: unknown }
        if (typeof data.error === 'string') ({ error: code, message = message, current_revision: current } = data as { error: string; message?: string; current_revision?: unknown })
        else if (data.error) ({ code = code, message = message, current_revision: current } = data.error)
      } catch {
        /* non-JSON error body */
      }
      // r1.2 (stand-in r1.1 P2): an error read across a sign-in change belongs to the earlier sign-in: identity_changed,
      // checked before the session-ending 401 below (which stays for a request still current)
      this.sentUnder(at)
      if (res.status === 401 && headers.Authorization === `Bearer ${this.token}`) {
        this.replaceToken(null)
        this.setState('unauthorized')
      }
      if (res.status === 409 && code === 'draft_conflict') {
        throw draftConflict(message, typeof current === 'number' && Number.isSafeInteger(current) && current >= 1 ? current : null)
      }
      throw new ApiError(res.status, code, message)
    }
    if (res.status === 204) return undefined as T
    const answer = await readOk<T>(res)
    this.sentUnder(at)
    return answer
  }

  /** A non-JSON request (file bytes up or down), with the same errors as request(). */
  private async raw(method: string, path: string, body?: Blob, type?: string): Promise<Response> {
    const headers: Record<string, string> = {}
    if (type) headers['Content-Type'] = type
    if (this.token) headers.Authorization = `Bearer ${this.token}`
    const at = this.authIdentity
    let res: Response
    try {
      res = await fetch(this.base + path, { method, headers, body })
    } catch (err) {
      this.sentUnder(at)
      throw new ApiError(0, 'network', err instanceof Error ? err.message : 'Network error')
    }
    this.sentUnder(at)
    if (!res.ok) {
      let code = `http_${res.status}`
      let message = res.statusText || 'Request failed'
      try {
        const data = (await res.json()) as Partial<ApiErrorBody>
        if (data.error) ({ code, message } = data.error)
      } catch {
        /* non-JSON error body */
      }
      // r1.2 (stand-in r1.1 P2): an error read across a sign-in change belongs to the earlier sign-in: identity_changed,
      // checked before the session-ending 401 below (which stays for a request still current)
      this.sentUnder(at)
      throw new ApiError(res.status, code, message)
    }
    return res
  }

  // ---------- WebSocket ----------

  private setState(s: ConnectionState) {
    if (this.state === s) return
    this.state = s
    this.conn.emit(s)
  }

  connect(): void {
    this.wantOpen = true
    if (this.ws || !this.token) return
    // an explicit connect after the kind check gave up starts it again (a connect during the backoff does not reset it)
    if (this.kindParked) this.freshKindAsk()
    this.open()
  }

  /**
   * The ONE restart of the kind check (scanner r1.1, Kimi P1-2): not parked, no failures, a new generation (an earlier
   * retry timer does nothing), the wake listeners removed. Called by the restart triggers only: back in view, online,
   * a sign-in change (reopenEvents), connect() after giving up; and by disconnect(), which wants nothing open.
   */
  private freshKindAsk(): void {
    this.kindParked = false
    this.kindFailures = 0
    this.kindGen++
    this.dropKindWake()
  }

  /**
   * scanner r1: the kind check failed KIND_ASK_GIVE_UP times in a row; stop asking (no timer, no socket) until a
   * visibility (back in view) or online event, or the next connect(), starts it again.
   */
  private parkKindAsk(): void {
    this.kindParked = true
    this.kindGen++
    // scanner r1.1 (stand-in P1): no retry outlives the park (a connect() during the backoff may have left one)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.setState('idle')
    if (this.kindWake || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return
    const again = () => {
      if (!this.kindParked) return
      this.freshKindAsk()
      this.retry = 0
      if (this.wantOpen && !this.ws && this.token) this.open()
    }
    const wake = {
      online: again,
      // Kimi r1 #3: only coming into view (visible), not any other visibility change
      visible: () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') again() },
    }
    this.kindWake = wake
    window.addEventListener('online', wake.online)
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', wake.visible)
  }

  /** Remove the wake listeners (the parked flag is freshKindAsk's alone). */
  private dropKindWake(): void {
    const wake = this.kindWake
    if (!wake) return
    this.kindWake = null
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') window.removeEventListener('online', wake.online)
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') document.removeEventListener('visibilitychange', wake.visible)
  }

  private open() {
    // scanner r1.1 (Kimi P1-2): parked is one state, honoured by every way into open() (a retry timer, a socket close,
    // reopenEvents, a late answer); only freshKindAsk (the restart triggers) clears it
    if (this.kindParked) return
    if (!this.token) {
      this.setState('unauthorized')
      return
    }
    this.setState(this.retry ? 'reconnecting' : 'connecting')
    // r1.1 (stand-in P1): the bearer never goes in an address while the hive's kind is unknown. Learn it first from
    // /api/auth/methods (no credential); a failed ask retries with the same backoff and opens nothing meanwhile.
    // scanner r1 (Kimi live-pins r1): bounded. The delay keeps its ceiling (15 s, jittered), and after KIND_ASK_GIVE_UP
    // failures in a row the ask stops (parkKindAsk) until a visibility/online event or the next connect().
    // The pre-kind path sends GET /api/auth/methods and nothing else (api/identityChanged.test pins it): any other
    // request here would make `connect` a write (mutationChains.test's read pin).
    if (this.localOwner === null) {
      if (!this.localOwnerAsk) {
        this.localOwnerAsk = this.authMethods().then(
          () => { this.localOwnerAsk = null; this.kindFailures = 0; if (this.wantOpen && !this.ws && this.token) this.open() },
          () => {
            this.localOwnerAsk = null
            if (!this.wantOpen) return
            this.kindFailures++
            if (this.kindFailures >= KIND_ASK_GIVE_UP) {
              this.parkKindAsk()
              return
            }
            this.retry++
            this.setState('reconnecting')
            const delay = Math.min(15_000, 500 * 2 ** Math.min(this.retry, 5)) * (0.75 + Math.random() * 0.5)
            // one timer at a time (a connect() during the backoff may have asked already)
            if (this.retryTimer) clearTimeout(this.retryTimer)
            const gen = this.kindGen
            this.retryTimer = setTimeout(() => {
              this.retryTimer = null
              // a parked check, or one restarted since this timer was set, is not this timer's to resume
              if (this.kindParked || gen !== this.kindGen) return
              if (this.wantOpen && !this.ws) this.open()
            }, delay)
          },
        )
      }
      return
    }
    const local = this.localOwner
    const url = new URL(this.base + '/api/events', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    if (!local) url.searchParams.set('token', this.token)
    const bearer = this.token
    // r1.2 (Kimi r1.1 #2): the sign-in this socket was opened under. A frame that arrives once the identity changed (the
    // gap between a change and the socket's close) is the earlier sign-in's: dropped HERE, before any listener sees it
    const openedUnder = this.authIdentity
    const ws = new WebSocket(url)
    this.ws = ws
    // J1b: a local-owner hive signs the socket in with its first frame (within 5 s, at most 4 KiB); the socket counts as
    // open only on the hive's `hello`, never on the TCP open, so a refused sign-in can't read as connected
    let greeted = !local
    ws.onopen = () => {
      if (local) {
        const auth = JSON.stringify({ type: 'auth', token: bearer })
        // the host measures UTF-8 bytes (localowner.EVENTS_FRAME_MAX); this client only ever sends this frame and a
        // fixed ping on the events socket, so every frame it sends is within the bound (Kimi P2-6)
        if (new TextEncoder().encode(auth).length > LOCAL_FRAME_MAX) {
          ws.close(4400)
          return
        }
        ws.send(auth)
      } else {
        this.retry = 0
        this.setState('open')
      }
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }))
      }, 25_000)
    }
    ws.onmessage = (ev) => {
      if (openedUnder !== this.authIdentity) return
      try {
        const frame = JSON.parse(String(ev.data)) as HiveEvent | { type: 'pong' }
        if (frame && typeof frame === 'object' && 'type' in frame && frame.type !== 'pong') {
          if (!greeted && frame.type === 'hello') {
            greeted = true
            this.retry = 0
            this.setState('open')
          }
          this.events.emit(frame as HiveEvent)
        }
      } catch {
        /* ignore malformed frames */
      }
    }
    ws.onclose = (ev) => {
      if (this.pingTimer) clearInterval(this.pingTimer)
      this.pingTimer = null
      this.ws = null
      // Terminal session expiry for the bearer this socket was opened under, while it is still this client's credential:
      // the same invalidation as a current-bearer HTTP 401 (a new identity handle and onAuthChange, so the store and the
      // identity epoch drop everything read under it at once), then 'unauthorized'. A socket still open under an earlier
      // bearer (a re-login on this tab) ending says nothing about the current credential: it is an ordinary close.
      if ((ev.code === 4401 || ev.code === 1008) && bearer === this.token) {
        this.replaceToken(null)
        this.setState('unauthorized')
        return
      }
      if (!this.wantOpen) {
        this.setState('idle')
        return
      }
      this.retry++
      this.setState('reconnecting')
      const delay = Math.min(15_000, 500 * 2 ** Math.min(this.retry, 5)) * (0.75 + Math.random() * 0.5)
      this.retryTimer = setTimeout(() => this.open(), delay)
    }
  }

  disconnect(): void {
    this.wantOpen = false
    this.freshKindAsk()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.ws?.close()
    this.ws = null
  }

  subscribe(listener: EventListener): () => void {
    return this.events.on(listener)
  }

  onConnection(listener: ConnectionListener): () => void {
    listener(this.state)
    return this.conn.on(listener)
  }
}
