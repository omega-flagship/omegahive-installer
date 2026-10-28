/**
 * SIM ONLY. The host side of the routes Surface's missing-UI batch 1 gives a screen (UI_BACKEND_PARITY_AUDIT_20261007),
 * played in the browser as the release host does them: the same shapes, the same refusals and the same who-may rules
 * (hive/core/mcp.py harness list, goals.py attempts, programs.py revoke/restore_grants, collab.py capability_catalogue,
 * flows.py list/read/revoke, explore.py groups). Every id, name, note and digest here is INVENTED.
 */
import { ApiError } from '../client'
import type { ExploreGroupDef, Goal, HiveEvent, Swarm } from '../types'
import type {
  CapabilityCatalogue,
  CatalogueOffer,
  ExploreGroupDeleted,
  FlowAdoption,
  FlowListRow,
  FlowRevisionRead,
  GoalAttempt,
  HarnessInviteRow,
  ProgramGrantsRestored,
  ProgramGrantsRevoked,
} from '../missingUi'

const ago = (ms: number) => new Date(Date.now() - ms).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T
const fakeDigest = (seed: string) => {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  const part = (h >>> 0).toString(16).padStart(8, '0')
  return part.repeat(8)
}

/** Who the sim's visitor is, as the host's session/viewer would say. */
export interface SimViewer {
  principal: string
  admin: boolean
  /** a named signed-in person (SSO), not the hive password */
  person: boolean
  /** signed in with the hive password on its own machine (break-glass for app access) */
  localOperator: boolean
}

export interface SimMissingUiDeps {
  viewer: () => SimViewer
  goals: () => Goal[]
  swarms: () => Swarm[]
  programIds: () => string[]
  /** what each swarm offers (SimMoneyWork's services table) */
  services: () => Record<string, { kinds: string[]; connection_only_kinds: string[] }>
  emit: (e: HiveEvent) => void
  now: () => string
}

const LABEL: Record<HarnessInviteRow['harness'], string> = { 'claude-code': 'Claude Code', codex: 'Codex', hermes: 'Hermes Agent', mcp: 'Any MCP client' }

/** host: `HiveError(403, "admin_only", ...)` from app.py admin() */
export const adminOnly = () => new ApiError(403, 'admin_only', 'only a hive admin can do that')

export class SimMissingUi {
  constructor(private d: SimMissingUiDeps) {}
  private seq = 0

  private mustAdmin() {
    if (!this.d.viewer().admin) throw adminOnly()
  }

  // ---- goals.py attempts: every done-result attempt on a goal with a result schema, verbatim, ordered by at ----------
  private attempts = new Map<string, GoalAttempt[]>()
  private attemptsSeeded = false
  private seedAttempts() {
    if (this.attemptsSeeded) return
    this.attemptsSeeded = true
    // a top-level task, so its detail (the open task card) shows them; subtasks have no detail of their own on the board
    const kept = (x: Goal) => x.status === 'submitted' || x.status === 'done'
    const g = this.d.goals().find((x) => kept(x) && !x.parent_id) ?? this.d.goals().find(kept) ?? this.d.goals()[0]
    if (!g) return
    const by = g.claimed_by ?? 'a_vega01'
    this.attempts.set(g.id, [
      { id: 'ga_sim1', goal_id: g.id, agent_id: by, at: ago(3 * HOUR), ok: false, errors: ["$.summary: required property is missing", '$.score: 1.4 is greater than the maximum of 1'], raw: '{"score":1.4}', digest: `sha256:${fakeDigest('ga1')}` },
      { id: 'ga_sim2', goal_id: g.id, agent_id: by, at: ago(2 * HOUR), ok: true, errors: [], raw: '{"score":0.82,"summary":"Invented: three calibration offsets were wrong by one step; fixed and re-checked."}', digest: `sha256:${fakeDigest('ga2')}` },
    ])
  }
  goalAttempts(goalId: string): GoalAttempt[] {
    this.seedAttempts()
    if (!this.d.goals().some((g) => g.id === goalId)) throw new ApiError(404, 'not_found', `no task ${goalId}`)
    return clone(this.attempts.get(goalId) ?? [])
  }

  // ---- mcp.py harness invitations (admins) ---------------------------------------------------------------------
  private invites: HarnessInviteRow[] = []
  private invitesSeeded = false
  private seedInvites() {
    if (this.invitesSeeded) return
    this.invitesSeeded = true
    const sw = this.d.swarms()[0]?.id ?? 's_lyra'
    const row = (id: string, harness: HarnessInviteRow['harness'], name: string, age: number, ttlH: number, extra: Partial<HarnessInviteRow>): HarnessInviteRow => {
      const created = Date.now() - age
      const base: HarnessInviteRow = { id, harness, harness_label: LABEL[harness], name, swarm_id: sw, role_id: null, created_by: 'user:operator', created_at: new Date(created).toISOString(), expires_at: (created + ttlH * HOUR) / 1000, redeemed_at: null, agent_id: null, revoked_at: null, status: 'waiting' }
      return { ...base, ...extra }
    }
    this.invites = [
      row('hi_sim4', 'codex', 'Codex 2', 20 * MIN, 24, {}),
      row('hi_sim3', 'claude-code', 'Claude', 5 * HOUR, 24, { status: 'connected', redeemed_at: ago(4 * HOUR), agent_id: 'a_vega01' }),
      row('hi_sim2', 'mcp', 'Guest', 3 * 24 * HOUR, 1, {}),
      row('hi_sim1', 'hermes', 'Hermes', 6 * 24 * HOUR, 24, { revoked_at: ago(5 * 24 * HOUR) }),
    ]
  }
  /** mcp.py view: the status is derived (revoked, connected, expired, waiting) */
  private inviteView(r: HarnessInviteRow): HarnessInviteRow {
    const status = r.revoked_at ? 'revoked' : r.redeemed_at ? 'connected' : r.expires_at * 1000 <= Date.now() ? 'expired' : 'waiting'
    return { ...r, status }
  }
  harnessInvites(): HarnessInviteRow[] {
    this.mustAdmin()
    this.seedInvites()
    return this.invites.map((r) => this.inviteView(r)).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 200)
  }
  harnessInvite(id: string): HarnessInviteRow {
    this.mustAdmin()
    this.seedInvites()
    const r = this.invites.find((x) => x.id === id)
    if (!r) throw new ApiError(404, 'not_found', `no invitation ${id}`)
    return this.inviteView(r)
  }
  createHarnessInvite(body: { harness: string; name: string; swarm_id: string; role_id?: string | null; ttl_minutes?: number }) {
    this.mustAdmin()
    this.seedInvites()
    if (!(body.harness in LABEL)) throw new ApiError(400, 'bad_request', 'harness is claude-code, codex, hermes or mcp')
    if (!this.d.swarms().some((s) => s.id === body.swarm_id)) throw new ApiError(404, 'not_found', 'no such swarm')
    const ttl = Math.max(5, Math.min(7 * 24 * 60, body.ttl_minutes ?? 24 * 60))
    const r: HarnessInviteRow = { id: `hi_sim${++this.seq + 10}`, harness: body.harness as HarnessInviteRow['harness'], harness_label: LABEL[body.harness as HarnessInviteRow['harness']], name: body.name.trim() || 'Guest', swarm_id: body.swarm_id, role_id: body.role_id ?? null, created_by: this.d.viewer().principal, created_at: this.d.now(), expires_at: Date.now() / 1000 + ttl * 60, redeemed_at: null, agent_id: null, revoked_at: null, status: 'waiting' }
    this.invites.push(r)
    return { ...this.inviteView(r), code: `ohj_SIM-INVENTED-${r.id}`, mcp_url: 'https://hive.example.invalid/mcp', local_url: 'http://127.0.0.1:8700/mcp' }
  }
  revokeHarnessInvite(id: string): HarnessInviteRow {
    this.mustAdmin()
    this.seedInvites()
    const r = this.invites.find((x) => x.id === id)
    if (!r) throw new ApiError(404, 'not_found', `no invitation ${id}`)
    if (!r.revoked_at) r.revoked_at = this.d.now()
    return this.inviteView(r)
  }

  // ---- programs.py revoke_grants / restore_grants ----------------------------------------------------------------
  /** program id → { owner recorded at start, revoked } (only apps with host-managed grants are here) */
  private appGrants = new Map<string, { owner: string; revoked: boolean }>()
  private grantsSeeded = false
  private seedGrants() {
    if (this.grantsSeeded) return
    this.grantsSeeded = true
    const ids = this.d.programIds()
    const id = ids.find((x) => x === 'commons-explorer') ?? ids[0]
    // INVENTED: the person the sim plays as `person` (Ada) owns this app's grants
    if (id) this.appGrants.set(id, { owner: 'user:p_ada', revoked: false })
  }
  /** SIM ONLY: which app has host-managed grants here, and whether they are paused (for tests and the demo). */
  simAppGrants(id: string): { owner: string; revoked: boolean } | null {
    this.seedGrants()
    const g = this.appGrants.get(id)
    return g ? { ...g } : null
  }
  revokeProgramGrants(id: string): ProgramGrantsRevoked {
    this.seedGrants()
    if (!this.d.programIds().includes(id)) throw new ApiError(404, 'not_found', `no program ${id}`)
    const g = this.appGrants.get(id)
    if (!g) throw new ApiError(404, 'no_grants', `${id} has no host-managed grants`)
    const v = this.d.viewer()
    if (!(v.localOperator || (v.person && v.principal === g.owner))) throw new ApiError(403, 'owner_required', "only the app's owner can revoke its grants")
    g.revoked = true
    this.emitAdmin({ type: 'app.grants_revoked', at: this.d.now(), program: id, by: v.principal })
    return { program: id, grants_revoked: true }
  }
  restoreProgramGrants(id: string): ProgramGrantsRestored {
    this.seedGrants()
    if (!this.d.programIds().includes(id)) throw new ApiError(404, 'not_found', `no program ${id}`)
    const g = this.appGrants.get(id)
    const v = this.d.viewer()
    if (!g || !v.person || v.localOperator || v.principal !== g.owner) throw new ApiError(403, 'owner_required', "only the app's owner can restore its grants")
    g.revoked = false
    this.emitAdmin({ type: 'app.grants_restored', at: this.d.now(), program: id, by: v.principal })
    return { program: id, grants_revoked: false, takes_effect: 'next restart' }
  }
  /** visibility.py: app.* events go to admins only */
  private emitAdmin(e: HiveEvent) {
    if (this.d.viewer().admin) this.d.emit(e)
  }

  // ---- collab.py capability_catalogue (a person: scope required; admin or the swarm's owner) --------------------
  capabilityCatalogue(scope: string): CapabilityCatalogue {
    if (!scope) throw new ApiError(400, 'scope_required', 'choose a requester swarm')
    const v = this.d.viewer()
    const sw = this.d.swarms().find((s) => s.id === scope)
    if (!sw || (!v.admin && sw.owner !== v.principal)) throw new ApiError(404, 'not_found', 'no requester swarm')
    const offers: CatalogueOffer[] = []
    for (const [swarmId, s] of Object.entries(this.d.services())) {
      if (swarmId === scope || !this.d.swarms().some((x) => x.id === swarmId)) continue
      for (const k of s.kinds) offers.push(this.offer({ kind: 'swarm', id: swarmId }, k, 'service', { visibility: 'hive', connection_only: false }))
      for (const k of s.connection_only_kinds) offers.push(this.offer({ kind: 'swarm', id: swarmId }, k, 'service', { visibility: 'hive', connection_only: true }))
    }
    const app = this.d.programIds()[0]
    if (app) offers.push(this.offer({ kind: 'program', id: app }, 'compare', 'program.action', { visibility: 'hive', connection_only: false, swarm_id: scope }))
    offers.sort((a, b) => a.id.localeCompare(b.id))
    return {
      requester_swarm: scope,
      offers,
      sources: { services: `sha256:${fakeDigest('svc')}`, roles: `sha256:${fakeDigest('roles')}`, skills: null, programs: `sha256:${fakeDigest('apps')}`, code: null },
      truncated: true,
      unknowns: ['skills-not-projected', 'code-not-projected', 'performance-evidence-not-derived', 'semantic-witnesses-unavailable'],
      catalogue_digest: `sha256:${fakeDigest(scope + offers.length)}`,
      generated_at: this.d.now(),
    }
  }
  private offer(provider: CatalogueOffer['provider'], name: string, source: CatalogueOffer['capability']['source'], scope: CatalogueOffer['scope']): CatalogueOffer {
    return {
      id: `offer:${JSON.stringify([provider.kind, provider.id, source, name])}`,
      provider,
      capability: { name, source },
      scope,
      tier: 'advertised',
      evidence: [{ kind: 'config', ref: `${source}:${provider.id}:${name}`, digest: `sha256:${fakeDigest(provider.id + name)}`, at: null }],
      unknowns: ['performance-evidence-not-derived'],
    }
  }

  // ---- flows.py list / read / revoke (a current named person who is an admin or the swarm's owner) ---------------
  private flows: { artifact_id: string; swarm_id: string; title: string; revisions: number; created_at: string }[] = []
  private adoptions: FlowAdoption[] = []
  private flowsSeeded = false
  private seedFlows() {
    if (this.flowsSeeded) return
    this.flowsSeeded = true
    const sw = this.d.swarms()[0]?.id
    if (!sw) return
    this.flows = [
      { artifact_id: 'art_simflow1', swarm_id: sw, title: 'Invented: weekly calibration review', revisions: 3, created_at: ago(9 * 24 * HOUR) },
      { artifact_id: 'art_simflow2', swarm_id: sw, title: 'Invented: lead handoff', revisions: 1, created_at: ago(2 * 24 * HOUR) },
    ]
    this.adoptions = [
      { artifact_id: 'art_simflow1', revision: 3, digest: `sha256:${fakeDigest('f1r3')}`, adopted_by: 'user:p_ada', adopted_at: ago(20 * HOUR) },
      { artifact_id: 'art_simflow1', revision: 2, digest: `sha256:${fakeDigest('f1r2')}`, adopted_by: 'user:p_ada', adopted_at: ago(4 * 24 * HOUR) },
    ]
  }
  /** flows.py access(): read needs a visible swarm; changes need a named person who is an admin or the swarm's owner */
  private access(swarmId: string, change: boolean) {
    const v = this.d.viewer()
    const sw = this.d.swarms().find((s) => s.id === swarmId)
    if (!sw) throw new ApiError(404, 'not_found', 'no such flow scope')
    if (!change) return
    if (!v.person) throw new ApiError(401, 'named_person_required', 'a current named person session is required')
    if (!v.admin && sw.owner !== v.principal) throw new ApiError(403, 'flow_owner_required', 'only the swarm owner or a named admin may change or run flows')
  }
  flowList(swarmId: string): FlowListRow[] {
    this.seedFlows()
    this.access(swarmId, false)
    return this.flows.filter((f) => f.swarm_id === swarmId).sort((a, b) => b.created_at.localeCompare(a.created_at)).map((f) => ({ artifact_id: f.artifact_id, title: f.title, revision: f.revisions }))
  }
  private source(id: string, n: number) {
    this.seedFlows()
    const f = this.flows.find((x) => x.artifact_id === id)
    if (!f) throw new ApiError(404, 'not_found', `no artifact ${id}`)
    if (!Number.isInteger(n) || n < 1 || n > f.revisions) throw new ApiError(404, 'not_found', 'no such flow revision')
    return f
  }
  flowRevision(id: string, n: number): FlowRevisionRead {
    const f = this.source(id, n)
    this.access(f.swarm_id, false)
    const d = fakeDigest(`${id}r${n}`)
    const adopted = this.adoptions.find((a) => a.artifact_id === id && a.revision === n) ?? null
    return { artifact_id: id, swarm_id: f.swarm_id, revision: n, body: { elements: [] }, digest: d, host_digest: `sha256:${d}`, layout: {}, layout_version: 1, adoption: adopted ? { ...adopted } : null }
  }
  unadoptFlow(id: string, n: number): { revoked: boolean } {
    const g = this.source(id, n)
    this.access(g.swarm_id, true)
    // idempotent: nothing adopted is not an error (flows.py revoke)
    this.adoptions = this.adoptions.filter((a) => !(a.artifact_id === id && a.revision === n))
    return { revoked: true }
  }

  // ---- explore.py groups: private to their owner; a group that is not yours is "no such group" ---------------------
  private groups: (ExploreGroupDef & { owner: string; created_at: string; updated_at: string })[] = []
  private groupsSeeded = false
  private seedGroups() {
    if (this.groupsSeeded) return
    this.groupsSeeded = true
    const p = this.d.viewer().principal
    this.groups = [
      { id: 'grp_sim1', owner: p, name: 'Invented: night shift', members: ['a_vega01'], created_at: ago(3 * 24 * HOUR), updated_at: ago(3 * 24 * HOUR) },
      { id: 'grp_sim2', owner: p, name: 'Invented: review crew', members: [], created_at: ago(26 * HOUR), updated_at: ago(26 * HOUR) },
      { id: 'grp_simother', owner: 'user:someone_else', name: 'Not yours', members: [], created_at: ago(HOUR), updated_at: ago(HOUR) },
    ]
  }
  private mine(id: string) {
    this.seedGroups()
    const g = this.groups.find((x) => x.id === id && x.owner === this.d.viewer().principal)
    if (!g) throw new ApiError(404, 'not_found', 'no such group')
    return g
  }
  private groupName(raw: unknown, except?: string) {
    const name = typeof raw === 'string' ? raw.trim().slice(0, 60) : ''
    if (!name) throw new ApiError(400, 'bad_request', 'a group needs a name')
    const p = this.d.viewer().principal
    if (this.groups.some((g) => g.owner === p && g.id !== except && g.name.toLowerCase() === name.toLowerCase())) throw new ApiError(409, 'exists', 'you already have a group with that name')
    return name
  }
  private groupView(g: (typeof this.groups)[number]) {
    return { id: g.id, owner: g.owner, name: g.name, members: [...g.members], created_at: g.created_at, updated_at: g.updated_at }
  }
  exploreGroups(): ExploreGroupDef[] {
    this.seedGroups()
    const p = this.d.viewer().principal
    return this.groups.filter((g) => g.owner === p).sort((a, b) => a.name.localeCompare(b.name)).map((g) => this.groupView(g))
  }
  createExploreGroup(name: string): ExploreGroupDef {
    this.seedGroups()
    const n = this.groupName(name)
    const g = { id: `grp_sim${++this.seq + 10}`, owner: this.d.viewer().principal, name: n, members: [], created_at: this.d.now(), updated_at: this.d.now() }
    this.groups.push(g)
    return this.groupView(g)
  }
  exploreGroupMembers(id: string, body: { add?: string[]; remove?: string[] }): ExploreGroupDef {
    const g = this.mine(id)
    g.members = [...new Set([...g.members, ...(body.add ?? [])])].filter((m) => !(body.remove ?? []).includes(m))
    g.updated_at = this.d.now()
    return this.groupView(g)
  }
  renameExploreGroup(id: string, name: string): ExploreGroupDef {
    const g = this.mine(id)
    g.name = this.groupName(name, id)
    g.updated_at = this.d.now()
    return this.groupView(g)
  }
  deleteExploreGroup(id: string): ExploreGroupDeleted {
    const g = this.mine(id)
    this.groups = this.groups.filter((x) => x !== g)
    return { id, deleted: true }
  }
}
