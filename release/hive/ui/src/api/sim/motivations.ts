/**
 * Motivations above Tasks in the simulator (INVENTED data; the rules of the built host, hive/core/motivations.py and
 * hive/API.md "Motivations and the Tasks query (phase 1)"). Additive: the sim's goals, goal routes and goal.updated stay
 * exactly as they were; links live here, beside them, as the host keeps them in their own table.
 *
 * - readable/editable are the only predicates (admins; a person's row by its visibility; a team or mind row only if the
 *   viewer sees the swarm, then public, or shared and named, or the swarm's current owner). Hidden = missing (404).
 * - rev moves on content edits only; links move links_version; motivation.links goes out per (motivation, swarm).
 * - Links: one atomic operation, idempotent on (principal, operation_id) bound to a digest of the whole request.
 * - GET /api/tasks: one filter for items and counts; Unsorted = no link to a motivation this viewer can read.
 * Not here, as not on the host yet: summaries (progress, minds, money), subtask link inheritance, the OmegaEvolve mirror.
 */
import { ApiError, type Me } from '../client'
import type {
  CreateMotivationBody,
  Goal,
  HiveEvent,
  Motivation,
  MotivationLinkBody,
  MotivationLinkResult,
  MotivationList,
  MotivationStatus,
  PatchMotivationBody,
  Swarm,
  TaskItem,
  TaskList,
  TaskQuery,
  TaskRequestRef,
  Visibility,
} from '../types'

type Row = Omit<Motivation, 'editable' | 'shared_with' | 'links_version'> & { shared_with: string[]; links_version: number }
interface Viewer {
  principal: string
  admin: boolean
}

export const MOTIVATION_STATES: MotivationStatus[] = ['active', 'paused', 'achieved', 'retired']
const LINKABLE: MotivationStatus[] = ['active', 'paused']
const GOAL_STATUSES = ['open', 'claimed', 'waiting', 'submitted', 'stalled', 'done', 'failed', 'cancelled']
const OP_ID = /^[A-Za-z0-9_.:-]{8,120}$/
const READER: (keyof Row)[] = ['id', 'title', 'why', 'owner', 'swarm_id', 'status', 'visibility', 'rev', 'parent_id', 'created_by', 'created_at', 'updated_at', 'status_changed_at']

export interface SimMotivationsDeps {
  me: () => Me
  swarms: () => Map<string, Swarm>
  goals: () => Map<string, Goal>
  /** The goal as the swarm goal list shows it (review_by included as the sim's rows carry it). */
  goalRow: (g: Goal) => Goal
  requestsFor: (goalId: string) => TaskRequestRef[]
  emit: (e: HiveEvent) => void
  now: () => string
}

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x))
const notFound = () => new ApiError(404, 'not_found', 'not found')

export class SimMotivations {
  private rows = new Map<string, Row>()
  /** motivation id -> goal id -> who linked it and when. */
  private links = new Map<string, Map<string, { by: string; at: string }>>()
  private ops = new Map<string, { digest: string; destination: string; source: string | null; outcome: { applied: string[]; unchanged: string[] } }>()

  /** Its own id sequence, so the living sim's random stream (and every seeded test that relies on it) is untouched. */
  private seq = 0
  constructor(private d: SimMotivationsDeps) {}

  // ---------------------------------------------------------------- predicates

  private viewer(): Viewer {
    const m = this.d.me()
    return { principal: m.principal, admin: m.role === 'admin' || m.kind === 'password' }
  }
  /** Viewer.sees: admin, owner, public (or unset), or shared and named. */
  private sees(v: Viewer, thing: { owner?: string | null; visibility?: Visibility | string | null; shared_with?: string[] }): boolean {
    if (v.admin) return true
    if (thing.owner && thing.owner === v.principal) return true
    const vis = thing.visibility ?? 'public'
    return vis === 'public' || (vis === 'shared' && (thing.shared_with ?? []).includes(v.principal))
  }
  private swarm(id: string | null | undefined): Swarm | undefined {
    return id ? this.d.swarms().get(id) : undefined
  }
  private teamSwarm(row: Row): Swarm | undefined {
    if (!row.swarm_id || !(row.owner.startsWith('swarm:') || row.owner.startsWith('agent:'))) return undefined
    if (row.owner.startsWith('swarm:') && row.owner.slice(6) !== row.swarm_id) return undefined
    return this.swarm(row.swarm_id)
  }
  readable(v: Viewer, row: Row | undefined): boolean {
    if (!row) return false
    if (v.admin) return true
    if (row.owner.startsWith('user:')) return this.sees(v, row)
    const s = this.teamSwarm(row)
    if (!s || !this.sees(v, s)) return false
    if (s.owner && s.owner === v.principal) return true
    return row.visibility === 'public' || (row.visibility === 'shared' && row.shared_with.includes(v.principal))
  }
  editable(v: Viewer, row: Row | undefined): boolean {
    if (!row || !this.readable(v, row)) return false
    if (v.admin) return true
    if (row.owner.startsWith('user:')) return row.owner === v.principal
    const s = this.teamSwarm(row)
    return !!(s?.owner && s.owner === v.principal)
  }
  private seesSwarmId(v: Viewer, id: string): boolean {
    const s = this.swarm(id)
    return !!s && this.sees(v, s)
  }
  private readableIds(v: Viewer): Set<string> {
    return new Set([...this.rows.values()].filter((r) => this.readable(v, r)).map((r) => r.id))
  }

  // ---------------------------------------------------------------- views

  private reader(row: Row): Motivation {
    const out: Record<string, unknown> = {}
    for (const k of READER) out[k] = row[k]
    return out as unknown as Motivation
  }
  private view(v: Viewer, row: Row): Motivation {
    const out = this.reader(row)
    if (this.editable(v, row)) return { ...out, shared_with: [...row.shared_with], links_version: row.links_version, editable: true }
    return { ...out, editable: false }
  }
  private emitUpdated(row: Row) {
    // the host delivers motivation.updated to people who can read the stored row now; the sim has one viewer
    if (this.readable(this.viewer(), row)) this.d.emit({ type: 'motivation.updated', at: row.updated_at, motivation: this.reader(row) })
  }

  // ---------------------------------------------------------------- CRUD

  list(q: { owner?: string; swarm?: string; status?: string; cursor?: string; limit?: number } = {}): MotivationList {
    const v = this.viewer()
    const limit = this.limit(q.limit)
    const states = q.status ? q.status.split(',').map((s) => s.trim()) : null
    if (states?.some((s) => !MOTIVATION_STATES.includes(s as MotivationStatus))) throw new ApiError(400, 'bad_request', 'unknown status')
    const all = [...this.rows.values()]
      .filter((r) => this.readable(v, r) && (!q.owner || r.owner === q.owner) && (!q.swarm || r.swarm_id === q.swarm) && (!states || states.includes(r.status)))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    const digest = canon({ owner: q.owner ?? null, swarm: q.swarm ?? null, status: q.status ?? null })
    const start = q.cursor ? this.readCursor(q.cursor, v, 'created', digest) : 0
    const page = all.slice(start, start + limit)
    return { items: page.map((r) => this.view(v, r)), cursor: start + limit < all.length ? this.makeCursor(v, 'created', digest, start + limit) : null }
  }

  get(id: string): Motivation {
    const v = this.viewer()
    const row = this.rows.get(id)
    if (!this.readable(v, row)) throw notFound()
    return this.view(v, row!)
  }

  private title(t: unknown): string {
    if (typeof t !== 'string' || !t.trim() || t.trim().length > 200) throw new ApiError(400, 'bad_request', 'title is 1 to 200 characters')
    return t.trim()
  }
  private why(w: unknown): string {
    if (w === undefined) return ''
    if (typeof w !== 'string' || w.length > 4000) throw new ApiError(400, 'bad_request', 'why is at most 4000 characters')
    return w
  }
  private fields(body: object, allowed: string[]) {
    if ('parent_id' in body) throw new ApiError(400, 'parent_disabled', 'sub-motivations are switched off on this hive')
    const unknown = Object.keys(body).filter((k) => !allowed.includes(k))
    if (unknown.length) throw new ApiError(400, 'bad_request', `unknown fields: ${unknown.sort().join(', ')}`)
  }
  private visibility(vis: unknown, people: unknown, fallback: Visibility): [Visibility, string[]] {
    const v = (vis ?? fallback) as Visibility
    if (!['private', 'shared', 'public'].includes(v)) throw new ApiError(400, 'bad_visibility', 'visibility is private, shared or public')
    const list = Array.isArray(people) ? people.filter((p): p is string => typeof p === 'string') : []
    if (v === 'shared' && !list.length) throw new ApiError(400, 'bad_visibility', 'shared needs at least one person')
    // as the host keeps them (hive/core/visibility.py clean): unique and sorted, so what is sent reads back unchanged
    return [v, v === 'shared' ? [...new Set(list)].sort() : []]
  }

  create(body: CreateMotivationBody): Motivation {
    const v = this.viewer()
    this.fields(body, ['title', 'why', 'owner', 'swarm_id', 'visibility', 'shared_with'])
    const title = this.title(body.title)
    const why = this.why(body.why)
    const owner = body.owner || v.principal
    let sid = body.swarm_id ?? null
    let team = false
    if (owner.startsWith('swarm:')) {
      team = true
      sid = sid || owner.slice(6)
      if (owner.slice(6) !== sid) throw new ApiError(400, 'bad_scope', 'a team motivation is scoped to its own swarm')
    } else if (owner.startsWith('user:') && owner !== 'user:operator') {
      if (owner !== v.principal && !v.admin) throw new ApiError(403, 'owner_only', 'a person creates their own motivations; an admin may create one for a person')
    } else throw new ApiError(400, 'bad_scope', 'a motivation is owned by a person (user:u_...) or a team (swarm:s_...)')
    const [visibility, shared] = this.visibility(body.visibility, body.shared_with, team ? 'public' : 'private')
    if (sid) {
      const s = this.swarm(sid)
      if (!s || !this.sees(v, s)) throw notFound()
      if (team && !v.admin && s.owner !== v.principal) throw new ApiError(403, 'owner_only', "a team's motivations are made by its owner or an admin")
      if (s.archived_at) throw new ApiError(409, 'swarm_archived', 'that swarm is archived')
    }
    const at = this.d.now()
    const row: Row = { id: `mo_n${(++this.seq).toString(36).padStart(5, '0')}`, title, why, owner, swarm_id: sid, status: 'active', visibility, shared_with: shared, rev: 1, links_version: 0, parent_id: null, created_by: v.principal, created_at: at, updated_at: at, status_changed_at: null }
    this.rows.set(row.id, row)
    this.emitUpdated(row)
    return this.view(v, row)
  }

  private editableRow(id: string): Row {
    const v = this.viewer()
    const row = this.rows.get(id)
    if (!this.editable(v, row)) throw notFound()
    if (row!.swarm_id && this.teamSwarm(row!)?.archived_at) throw new ApiError(409, 'swarm_archived', 'that swarm is archived')
    return row!
  }
  private expected(rev: unknown, row: Row) {
    if (typeof rev !== 'number' || !Number.isInteger(rev)) throw new ApiError(400, 'bad_request', 'expected_rev is required')
    if (rev !== row.rev) throw new ApiError(409, 'motivation_changed', 'this motivation changed since it was read')
  }

  patch(id: string, body: PatchMotivationBody): Motivation {
    this.fields(body, ['title', 'why', 'status', 'expected_rev'])
    const row = this.editableRow(id)
    this.expected(body.expected_rev, row)
    const title = body.title === undefined ? row.title : this.title(body.title)
    const why = body.why === undefined ? row.why : this.why(body.why)
    if (body.status !== undefined && !MOTIVATION_STATES.includes(body.status)) throw new ApiError(400, 'bad_request', 'unknown status')
    const at = this.d.now()
    if (body.status !== undefined && body.status !== row.status) row.status_changed_at = at
    Object.assign(row, { title, why, status: body.status ?? row.status, rev: row.rev + 1, updated_at: at })
    this.emitUpdated(row)
    return this.view(this.viewer(), row)
  }

  setVisibility(id: string, body: { visibility?: Visibility; shared_with?: string[]; expected_rev: number }): Motivation {
    this.fields(body, ['visibility', 'shared_with', 'expected_rev'])
    const row = this.editableRow(id)
    this.expected(body.expected_rev, row)
    const [visibility, shared] = this.visibility(body.visibility ?? row.visibility, body.shared_with ?? row.shared_with, row.visibility)
    Object.assign(row, { visibility, shared_with: shared, rev: row.rev + 1, updated_at: this.d.now() })
    this.emitUpdated(row)
    return this.view(this.viewer(), row)
  }

  // ---------------------------------------------------------------- links

  private descendants(ids: string[]): string[] {
    const goals = [...this.d.goals().values()]
    const out = new Set<string>()
    const walk = (id: string) => {
      for (const g of goals)
        if (g.parent_id === id && !out.has(g.id)) {
          out.add(g.id)
          walk(g.id)
        }
    }
    for (const id of ids) walk(id)
    for (const id of ids) out.delete(id)
    return [...out]
  }

  link(id: string, body: MotivationLinkBody): MotivationLinkResult {
    const v = this.viewer()
    const known = ['operation_id', 'op', 'goal_ids', 'cascade', 'from_motivation_id', 'expected_to_rev', 'expected_from_rev', 'expected_to_links_version', 'expected_from_links_version']
    const extra = Object.keys(body).filter((k) => !known.includes(k))
    if (extra.length) throw new ApiError(400, 'bad_request', `unknown fields: ${extra.sort().join(', ')}`)
    if (typeof body.operation_id !== 'string' || !OP_ID.test(body.operation_id)) throw new ApiError(400, 'bad_request', 'operation_id is 8 to 120 of A-Z a-z 0-9 _ . : -')
    if (!['link', 'unlink', 'move'].includes(body.op)) throw new ApiError(400, 'bad_request', 'op is link, unlink or move')
    if (!Array.isArray(body.goal_ids) || !body.goal_ids.length || body.goal_ids.length > 200 || body.goal_ids.some((g) => typeof g !== 'string')) throw new ApiError(400, 'bad_request', 'goal_ids is 1 to 200 ids')
    if (typeof body.cascade !== 'boolean') throw new ApiError(400, 'bad_request', 'cascade is required')
    if (typeof body.expected_to_rev !== 'number') throw new ApiError(400, 'bad_request', 'expected_to_rev is required')
    const move = body.op === 'move'
    const fromFields = body.from_motivation_id !== undefined || body.expected_from_rev !== undefined || body.expected_from_links_version !== undefined
    if (move && (typeof body.from_motivation_id !== 'string' || typeof body.expected_from_rev !== 'number')) throw new ApiError(400, 'bad_request', 'a move names from_motivation_id and expected_from_rev')
    if (!move && fromFields) throw new ApiError(400, 'bad_request', 'from_* fields are for a move only')
    const goalIds = [...new Set(body.goal_ids)]
    const digest = canon({ method: 'POST', domain: 'motivation.links', destination: id, op: body.op, goal_ids: [...goalIds].sort(), cascade: body.cascade, from_motivation_id: body.from_motivation_id ?? null, expected_to_rev: body.expected_to_rev, expected_from_rev: body.expected_from_rev ?? null, expected_to_links_version: body.expected_to_links_version ?? null, expected_from_links_version: body.expected_from_links_version ?? null })
    const key = `${v.principal}\u0000${body.operation_id}`
    const prior = this.ops.get(key)
    if (prior) {
      if (prior.digest !== digest) throw new ApiError(409, 'operation_conflict', 'that operation id was used for a different request')
      // a replay re-checks authority now, and otherwise answers as the first call did
      const dest = this.rows.get(id)
      if (!this.editable(v, dest)) throw notFound()
      const src = prior.source ? this.rows.get(prior.source) : undefined
      if (prior.source && !this.editable(v, src)) throw notFound()
      for (const g of [...prior.outcome.applied, ...prior.outcome.unchanged]) {
        const goal = this.d.goals().get(g)
        if (!goal || !this.seesSwarmId(v, goal.swarm_id)) throw notFound()
      }
      return { operation_id: body.operation_id, ...prior.outcome, motivation: this.view(v, dest!), ...(src ? { from_motivation: this.view(v, src) } : {}), replayed: true }
    }
    // 1. both motivations: editable (else 404), not archived, the destination open for link and move, each at its rev
    const dest = this.rows.get(id)
    if (!this.editable(v, dest)) throw notFound()
    const src = move ? this.rows.get(body.from_motivation_id!) : undefined
    if (move && !this.editable(v, src)) throw notFound()
    for (const r of [dest!, ...(src ? [src] : [])]) if (r.swarm_id && this.teamSwarm(r)?.archived_at) throw new ApiError(409, 'swarm_archived', 'that swarm is archived')
    if (body.op !== 'unlink' && !LINKABLE.includes(dest!.status)) throw new ApiError(409, 'motivation_closed', `that motivation is ${dest!.status}`)
    const stale = (r: Row, rev: number | undefined, lv: number | undefined) => r.rev !== rev || (lv !== undefined && r.links_version !== lv)
    if (stale(dest!, body.expected_to_rev, body.expected_to_links_version)) throw new ApiError(409, 'motivation_changed', 'this motivation changed since it was read')
    if (src && stale(src, body.expected_from_rev, body.expected_from_links_version)) throw new ApiError(409, 'motivation_changed', 'that motivation changed since it was read')
    // 2. each named task, then (cascade) each descendant: visible, in scope, in an open swarm
    const check = (gid: string, named: boolean) => {
      const g = this.d.goals().get(gid)
      if (!g || !this.seesSwarmId(v, g.swarm_id)) throw named ? notFound() : new ApiError(409, 'cascade_refused', 'the cascade could not be applied')
      if (dest!.swarm_id && g.swarm_id !== dest!.swarm_id) throw named ? new ApiError(400, 'scope_mismatch', "that task is in a team this motivation doesn't cover") : new ApiError(409, 'cascade_refused', 'the cascade could not be applied')
      if (this.swarm(g.swarm_id)?.archived_at) throw named ? new ApiError(409, 'swarm_archived', 'that swarm is archived') : new ApiError(409, 'cascade_refused', 'the cascade could not be applied')
    }
    for (const g of goalIds) check(g, true)
    const kids = body.cascade ? this.descendants(goalIds).filter((g) => !goalIds.includes(g)) : []
    for (const g of kids) check(g, false)
    // 3. prior state
    const destLinks = this.links.get(id) ?? new Map<string, { by: string; at: string }>()
    const srcLinks = src ? (this.links.get(src.id) ?? new Map<string, { by: string; at: string }>()) : undefined
    if (body.op === 'unlink' && goalIds.some((g) => !destLinks.has(g))) throw new ApiError(409, 'link_changed', 'a named link is not there any more')
    if (move && goalIds.some((g) => !srcLinks!.has(g))) throw new ApiError(409, 'link_changed', 'a named link is not there any more')
    // 4. commit
    const at = this.d.now()
    const applied: string[] = []
    const unchanged: string[] = []
    const linked: string[] = []
    const unlinked: string[] = []
    const fromUnlinked: string[] = []
    for (const g of [...goalIds, ...kids]) {
      if (body.op === 'unlink') {
        if (destLinks.delete(g)) {
          applied.push(g)
          unlinked.push(g)
        } else unchanged.push(g)
        continue
      }
      let changed = false
      if (move && srcLinks!.delete(g)) {
        changed = true
        fromUnlinked.push(g)
      }
      if (!destLinks.has(g)) {
        destLinks.set(g, { by: v.principal, at })
        linked.push(g)
        changed = true
      }
      if (changed) applied.push(g)
      else unchanged.push(g)
    }
    this.links.set(id, destLinks)
    if (src && srcLinks) this.links.set(src.id, srcLinks)
    if (linked.length || unlinked.length) dest!.links_version += 1
    if (src && fromUnlinked.length) src.links_version += 1
    this.ops.set(key, { digest, destination: id, source: src?.id ?? null, outcome: { applied, unchanged } })
    this.emitLinks(dest!, linked, unlinked)
    if (src) this.emitLinks(src, [], fromUnlinked)
    return { operation_id: body.operation_id, applied, unchanged, motivation: this.view(v, dest!), ...(src ? { from_motivation: this.view(v, src) } : {}) }
  }

  private emitLinks(row: Row, linked: string[], unlinked: string[]) {
    const v = this.viewer()
    if (!this.readable(v, row)) return
    const bySwarm = new Map<string, { linked: string[]; unlinked: string[] }>()
    const add = (gid: string, which: 'linked' | 'unlinked') => {
      const sid = this.d.goals().get(gid)?.swarm_id
      if (!sid) return
      const e = bySwarm.get(sid) ?? { linked: [], unlinked: [] }
      e[which].push(gid)
      bySwarm.set(sid, e)
    }
    for (const g of linked) add(g, 'linked')
    for (const g of unlinked) add(g, 'unlinked')
    for (const [sid, e] of bySwarm) if (this.seesSwarmId(v, sid)) this.d.emit({ type: 'motivation.links', at: this.d.now(), motivation_id: row.id, swarm_id: sid, ...e })
  }

  // ---------------------------------------------------------------- GET /api/tasks

  tasks(q: TaskQuery = {}): TaskList {
    const v = this.viewer()
    const limit = this.limit(q.limit)
    const readable = this.readableIds(v)
    const statuses = q.status ? q.status.split(',').map((s) => s.trim()).filter(Boolean) : null
    if (statuses?.some((s) => !GOAL_STATUSES.includes(s))) throw new ApiError(400, 'bad_request', 'unknown status')
    if (q.q && q.q.length > 100) throw new ApiError(400, 'bad_request', 'q is at most 100 characters')
    const sort = q.sort ?? 'priority'
    if (q.motivation && q.motivation !== 'none' && !readable.has(q.motivation)) throw notFound()
    if (q.swarm && !this.seesSwarmId(v, q.swarm)) throw new ApiError(404, 'not_found', 'no such swarm')
    const linkedTo = (gid: string) => [...readable].filter((m) => this.links.get(m)?.has(gid))
    const needle = q.q?.toLowerCase()
    const match = (g: Goal) =>
      this.seesSwarmId(v, g.swarm_id) &&
      (!q.motivation || (q.motivation === 'none' ? linkedTo(g.id).length === 0 : !!this.links.get(q.motivation)?.has(g.id))) &&
      (!q.swarm || g.swarm_id === q.swarm) &&
      (!q.mind || g.assignee === q.mind || g.claimed_by === q.mind || g.created_by === `agent:${q.mind}`) &&
      (!statuses || statuses.includes(g.status)) &&
      (!needle || `${g.title}\n${g.detail}`.toLowerCase().includes(needle)) &&
      (!q.top || !g.parent_id)
    const all = [...this.d.goals().values()].filter(match)
    all.sort(sort === 'priority' ? (a, b) => b.priority - a.priority || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id) : (a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id))
    const digest = canon({ motivation: q.motivation ?? null, swarm: q.swarm ?? null, mind: q.mind ?? null, status: statuses, q: q.q ?? null, top: !!q.top, sort })
    const start = q.cursor ? this.readCursor(q.cursor, v, sort, digest) : 0
    const page = all.slice(start, start + limit)
    const by: Record<string, number> = Object.fromEntries(GOAL_STATUSES.map((s) => [s, 0]))
    for (const g of all) by[g.status] = (by[g.status] ?? 0) + 1
    const items: TaskItem[] = page.map((g) => ({
      ...this.d.goalRow(g),
      motivations: linkedTo(g.id).map((m) => this.rows.get(m)!).sort((a, b) => a.id.localeCompare(b.id)).map((m) => ({ id: m.id, title: m.title, status: m.status })),
      requests: this.d.requestsFor(g.id),
    }))
    return { items, counts: { total: all.length, by_status: by }, cursor: start + limit < all.length ? this.makeCursor(v, sort, digest, start + limit) : null }
  }

  // ---------------------------------------------------------------- cursors (opaque, bound to sort, filter and principal)

  private limit(n: unknown): number {
    if (n === undefined) return 50
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 200) throw new ApiError(400, 'bad_request', 'limit is 1 to 200')
    return n
  }
  private makeCursor(v: Viewer, sort: string, digest: string, at: number): string {
    return btoa(canon({ v: 1, sort, filter: digest, principal: v.principal, at, tag: 'sim' }))
  }
  private readCursor(token: string, v: Viewer, sort: string, digest: string): number {
    try {
      const c = JSON.parse(atob(token)) as { v: number; sort: string; filter: string; principal: string; at: number; tag: string }
      if (c.v === 1 && c.tag === 'sim' && c.sort === sort && c.filter === digest && c.principal === v.principal && Number.isInteger(c.at) && c.at >= 0) return c.at
    } catch {
      /* fall through */
    }
    throw new ApiError(400, 'cursor_invalid', 'that cursor is not valid for this request')
  }

  // ---------------------------------------------------------------- INVENTED seeds

  /** Motivations of every kind, so the views have something true to the contract to show: a team's, a mind's, a
   *  person's spanning teams (shared with the sim's member), a paused one, and tasks under more than one. */
  seed(at: (hoursAgo: number) => string) {
    const goals = [...this.d.goals().values()].filter((g) => !g.parent_id)
    const of = (sid: string) => goals.filter((g) => g.swarm_id === sid).sort((a, b) => a.created_at.localeCompare(b.created_at))
    const lyra = of('s_lyra')
    const kelp = of('s_kelp')
    const forge = of('s_forge')
    const put = (r: Omit<Row, 'rev' | 'links_version' | 'parent_id' | 'status_changed_at' | 'updated_at'> & { status_changed_at?: string | null }, goalIds: string[], by: string) => {
      const row: Row = { rev: 1, links_version: 0, parent_id: null, updated_at: r.created_at, ...r, status_changed_at: r.status_changed_at ?? null }
      this.rows.set(row.id, row)
      const ids = [...goalIds, ...this.descendants(goalIds)]
      if (ids.length) {
        this.links.set(row.id, new Map(ids.map((g) => [g, { by, at: r.created_at }])))
        row.links_version = 1
      }
    }
    put({ id: 'mo_sky001', title: 'Know the variable sky well enough to predict it', why: 'Every claim the survey makes should come with a forecast someone can check. If we can predict a star, we understand it.', owner: 'swarm:s_lyra', swarm_id: 's_lyra', status: 'active', visibility: 'public', shared_with: [], created_by: 'user:p_ada', created_at: at(24 * 9) }, lyra.slice(0, 3).map((g) => g.id), 'user:p_ada')
    put({ id: 'mo_disk02', title: 'Find out why Vega’s dust disk is lopsided', why: 'The disk does not match any model I hold. I want the reason, not a fit.', owner: 'agent:a_vega01', swarm_id: 's_lyra', status: 'active', visibility: 'public', shared_with: [], created_by: 'agent:a_vega01', created_at: at(24 * 4) }, lyra.slice(1, 2).map((g) => g.id), 'user:p_ada')
    put({ id: 'mo_teach3', title: 'Explain the hive’s science to newcomers', why: 'I want anyone who joins to be able to follow what the swarms found, in plain words, within a day.', owner: 'user:p_ada', swarm_id: null, status: 'active', visibility: 'shared', shared_with: ['user:p_rowan'], created_by: 'user:p_ada', created_at: at(24 * 6) }, [...lyra.slice(2, 3), ...kelp.slice(0, 1)].map((g) => g.id), 'user:p_ada')
    put({ id: 'mo_kelp04', title: 'Keep the kelp forest census honest', why: 'Counts we cannot reproduce are not counts.', owner: 'swarm:s_kelp', swarm_id: 's_kelp', status: 'active', visibility: 'public', shared_with: [], created_by: 'user:operator', created_at: at(24 * 12) }, kelp.slice(0, 2).map((g) => g.id), 'user:operator')
    put({ id: 'mo_forge5', title: 'Ship tools the other swarms actually use', why: 'A tool nobody calls is a cost.', owner: 'swarm:s_forge', swarm_id: 's_forge', status: 'paused', visibility: 'public', shared_with: [], created_by: 'user:operator', created_at: at(24 * 15), status_changed_at: at(30) }, forge.slice(0, 1).map((g) => g.id), 'user:operator')
  }
}
